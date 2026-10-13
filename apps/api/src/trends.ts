import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { db, type Db } from './db.js';
import { fetchPublicText } from './http.js';
import type { Trend } from '@viralfactory/shared';
import { eventSignals } from './event-signals.js';

export const fingerprint = (title: string) => createHash('sha256').update(title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+[-–|]\s+[^-–|]+$/, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()).digest('hex');
function plain(value: unknown): string {
  if (typeof value !== 'string') return typeof value === 'number' ? String(value) : '';
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
export type FeedItem = { title: string; url: string; summary: string; publishedAt: Date | null; sourceName: string };
export function parseFeed(xml: string, fallbackName: string): FeedItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feeds com entidades externas não são aceitos.');
  const document = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(xml);
  const rss = document.rss?.channel;
  const feed = document.feed;
  if (!rss && !feed) throw new Error('A URL não retornou um feed RSS ou Atom válido.');
  const entries = rss?.item || feed?.entry || [];
  return (Array.isArray(entries) ? entries : [entries]).slice(0, 100).flatMap((item: Record<string, any>) => {
    const title = plain(item.title?.['#text'] ?? item.title).slice(0, 500);
    const links = Array.isArray(item.link) ? item.link : [item.link];
    const link = links.find((value: any) => typeof value === 'string' || !value?.['@_rel'] || value?.['@_rel'] === 'alternate');
    const url = typeof link === 'string' ? link : link?.['@_href'];
    if (!title || typeof url !== 'string') return [];
    try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return []; } catch { return []; }
    const date = new Date(item.pubDate || item.published || item.updated || '');
    return [{ title, url, summary: plain(item.description || item.summary?.['#text'] || item.summary || item.content?.['#text'] || item.content).slice(0, 12000), publishedAt: Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 3600000 ? null : date, sourceName: plain(item.source?.['#text'] || item.source) || fallbackName }];
  });
}
export async function ingest(items: FeedItem[], source: { url: string; category: string }, client: Db = db) {
  const bucket = new Date().toISOString().slice(0, 13);
  let count = 0;
  for (const item of items) {
    const trend = await client.trend.upsert({
      where: { fingerprint: fingerprint(item.title) },
      create: { fingerprint: fingerprint(item.title), title: item.title, summary: item.summary, category: source.category, publishedAt: item.publishedAt },
      update: {}
    });
    await client.observation.upsert({
      where: { trendId_articleUrl_bucket: { trendId: trend.id, articleUrl: item.url, bucket } },
      create: { trendId: trend.id, sourceName: item.sourceName, sourceUrl: source.url, articleUrl: item.url, summary: item.summary, publishedAt: item.publishedAt, bucket }, update: {}
    });
    count++;
  }
  return count;
}
export async function discover(signal: AbortSignal, log: (message: string) => Promise<void>, client: Db = db, sourceId?: string) {
  const sources = await client.source.findMany({ where: sourceId ? { id: sourceId } : { enabled: true } });
  if (!sources.length) throw new Error('Nenhuma fonte habilitada. Configure pelo menos um feed RSS.');
  let total = 0, succeeded = 0;
  for (const source of sources) {
    signal.throwIfAborted();
    try {
      const items = parseFeed(await fetchPublicText(source.url, signal), source.name);
      total += await ingest(items, source, client);
      await client.source.update({ where: { id: source.id }, data: { lastFetchedAt: new Date(), lastError: null, itemCount: items.length } });
      await log(`${source.name}: ${items.length} assuntos recebidos.`);
      succeeded++;
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      await client.source.update({ where: { id: source.id }, data: { lastError: message } });
      await log(`${source.name}: ${message}`);
    }
  }
  if (!succeeded) throw new Error('Todas as fontes falharam. Consulte os erros nas configurações.');
  await log(`Pesquisa concluída: ${total} observações processadas em ${succeeded} fontes.`);
}
export async function listTrends(client: Db = db): Promise<Trend[]> {
  const page = (skip: number, take: number) => client.trend.findMany({ skip, take, orderBy: [{ discoveredAt: 'desc' }, { id: 'desc' }], include: { observations: { orderBy: { observedAt: 'desc' }, take: 200 }, videos: { select: { id: true } } } });
  // Prisma loads relations using an IN list of parent ids. Keep each batch
  // below SQLite's parameter limit as the trend collection grows.
  const rows = await page(0, 250);
  for (const skip of [250, 500, 750]) {
    const batch = await page(skip, 250);
    rows.push(...batch);
    if (batch.length < 250) break;
  }
  return rows.map(row => {
    const unique = [...new Map(row.observations.map(item => [item.articleUrl, item])).values()];
    const count = new Set(unique.map(item => item.sourceName)).size;
    const age = row.publishedAt ? Math.max(0, (Date.now() - row.publishedAt.getTime()) / 3600000) : null;
    const recency = age === null ? 0 : Math.max(0, 30 * (1 - age / 72));
    const coverage = Math.min(15, count * 7.5);
    const localText = `${row.title} ${row.summary.slice(0, 400)}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const brazil = /\b(brasil|brasileir[oa]s?|brasilia|tse|eleicoes|sao paulo|rio de janeiro)\b/.test(localText) ? 20 : 0;
    const evidence = Math.min(20, unique.filter(item => item.summary.length >= 80 && item.publishedAt).length * 6.67);
    const eventSignal = eventSignals(row.title, row.summary, row.publishedAt);
    const buckets = new Set(row.observations.map(item => item.bucket));
    let growth: number | null = null;
    if (buckets.size >= 2) {
      const ordered = [...buckets].sort();
      const previous = new Set(row.observations.filter(item => item.bucket === ordered[ordered.length - 2]).map(item => item.articleUrl)).size;
      const current = new Set(row.observations.filter(item => item.bucket === ordered[ordered.length - 1]).map(item => item.articleUrl)).size;
      growth = previous ? Math.round((current - previous) / previous * 100) : null;
    }
    return { id: row.id, title: row.title, summary: row.summary, category: row.category, score: Math.round(recency + coverage + brazil + evidence + eventSignal.event), factors: { recency: Math.round(recency), coverage: Math.round(coverage), brazil, evidence: Math.round(evidence), event: eventSignal.event, growth, popularity: null }, publishedAt: row.publishedAt?.toISOString() ?? null, discoveredAt: row.discoveredAt.toISOString(), eventDate: row.eventDate || eventSignal.eventDate, sources: unique.map(item => ({ name: item.sourceName, url: item.articleUrl, publishedAt: item.publishedAt?.toISOString() ?? null, summary: item.summary })), videoId: row.videos[0]?.id };
  }).sort((a, b) => b.score - a.score);
}
