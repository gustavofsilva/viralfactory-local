import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { MediaAsset } from '@viralfactory/shared';
import { dataDir } from './config.js';
import { fetchPublicText, validatePublicUrl } from './http.js';
const stripHtml = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export function allowedLicense(value: string) {
  return /^(CC0|Public domain|CC BY (1\.0|2\.0|2\.5|3\.0|4\.0))$/i.test(value.trim());
}
export function relevantImageTitle(title: string, query: string) {
  const tokens = (value: string) => value.toLowerCase().replace(/^file:/, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !['the', 'and', 'with', 'for', 'from', 'image', 'photo', 'jpg', 'png', 'webp'].includes(word)).map(word => word.replace(/s$/, ''));
  const requested = [...new Set(tokens(query))], found = new Set(tokens(title));
  return requested.length > 0 && requested.filter(word => found.has(word)).length >= Math.min(2, requested.length);
}
export function agencyArticleImage(html: string, articleUrl: string) {
  if (new URL(articleUrl).hostname !== 'agenciabrasil.ebc.com.br') return null;
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]?.replace(/&amp;/g, '&');
  const image = metas.find(tag => attribute(tag, 'property') === 'og:image');
  const imageUrl = image && attribute(image, 'content');
  if (!imageUrl) return null;
  const parsed = new URL(imageUrl, articleUrl);
  if (parsed.protocol !== 'https:' || !['imagens.ebc.com.br', 'agenciabrasil.ebc.com.br'].includes(parsed.hostname)) return null;
  const creditTag = (html.match(/<figcaption\b[^>]*class=["'][^"']*credito-foto[^"']*["'][^>]*>[\s\S]*?<\/figcaption>/i) || [])[0];
  const author = stripHtml(creditTag || '').replace(/^©\s*/, '').trim();
  if (!/\/\s*Ag[eê]ncia Brasil$/i.test(author) || /Reuters|Associated Press|\bAFP\b|Proibid[ao] reprodu[cç][aã]o/i.test(author)) return null;
  return { url: parsed.href, author };
}
export async function sourceImageAsset(articleUrl: string, signal: AbortSignal): Promise<MediaAsset | null> {
  if (new URL(articleUrl).hostname !== 'agenciabrasil.ebc.com.br') return null;
  const image = agencyArticleImage(await fetchPublicText(articleUrl, signal), articleUrl);
  if (!image) return null;
  await validatePublicUrl(image.url);
  const key = createHash('sha256').update(`${articleUrl}\n${image.url}`).digest('hex');
  const directory = path.join(dataDir, 'cache/media');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${key}.jpg`), manifest = `${file}.json`;
  try { await access(file); return JSON.parse(await readFile(manifest, 'utf8')) as MediaAsset; } catch {}
  const response = await fetch(image.url, { redirect: 'manual', headers: { 'User-Agent': 'ViralFactoryLocal/0.2 (journalistic image with credit)' }, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  if (!response.ok || response.status >= 300 || !/^image\/(jpeg|png|webp)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); return null; }
  if (Number(response.headers.get('content-length') || 0) > 12_000_000) { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 12_000_000) throw new Error('Imagem da fonte excede 12 MB.');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 500 || !(bytes[0] === 0xff && bytes[1] === 0xd8 || bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')) return null;
  await writeFile(file, bytes);
  const asset: MediaAsset = { originUrl: articleUrl, author: image.author, license: 'Agência Brasil — reprodução jornalística com crédito', attribution: `${image.author} — ${articleUrl}`, restrictions: 'Para fins comerciais, consulte o licenciamento da EBC. Não reproduzir imagens de agências parceiras.', acquiredAt: new Date().toISOString(), path: file, kind: 'source' };
  await writeFile(manifest, JSON.stringify(asset, null, 2), 'utf8');
  return asset;
}
export async function commonsAsset(query: string, signal: AbortSignal): Promise<MediaAsset | null> {
  const endpoint = new URL('https://commons.wikimedia.org/w/api.php');
  endpoint.search = new URLSearchParams({ action: 'query', generator: 'search', gsrsearch: `${query.slice(0, 120)} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '5', prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: '1200', format: 'json', origin: '*' }).toString();
  const response = await fetch(endpoint, { headers: { 'User-Agent': 'ViralFactoryLocal/0.2 (local video studio; educational media search)' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error(`Wikimedia Commons respondeu HTTP ${response.status}.`);
  const result = await response.json() as { query?: { pages?: Record<string, any> } };
  for (const page of Object.values(result.query?.pages || {})) {
    if (!relevantImageTitle(page.title || '', query)) continue;
    const info = page.imageinfo?.[0];
    const metadata = info?.extmetadata;
    const license = metadata?.LicenseShortName?.value || '';
    if (!info || !metadata || !allowedLicense(license) || !['image/jpeg', 'image/png', 'image/webp'].includes(info.mime)) continue;
    if (metadata.Restrictions?.value && !/attribution|share-alike/i.test(metadata.Restrictions.value)) continue;
    const author = stripHtml(metadata.Artist?.value || '');
    if (!author || /unknown|anonymous|desconhecid|an[oô]nim/i.test(author)) continue;
    const url = info.thumburl || info.url;
    const parsed = new URL(url);
    if (parsed.hostname !== 'upload.wikimedia.org' || parsed.protocol !== 'https:') continue;
    const key = createHash('sha256').update(url).digest('hex');
    const directory = path.join(dataDir, 'cache/media');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${key}${info.mime === 'image/png' ? '.png' : info.mime === 'image/webp' ? '.webp' : '.jpg'}`);
    const manifest = `${file}.json`;
    try { await access(file); return JSON.parse(await readFile(manifest, 'utf8')) as MediaAsset; } catch {}
    const download = await fetch(url, { headers: { 'User-Agent': 'ViralFactoryLocal/0.2 (licensed media acquisition)' }, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
    if (!download.ok) continue;
    if (Number(download.headers.get('content-length') || 0) > 12_000_000) { await download.body?.cancel(); continue; }
    const reader = download.body?.getReader();
    if (!reader) continue;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 12_000_000) throw new Error('Imagem excede 12 MB.'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    if (size < 500) continue;
    await writeFile(file, Buffer.concat(chunks));
    const asset: MediaAsset = { originUrl: info.descriptionurl, author, license, attribution: `${page.title} — ${author} — ${license} — ${info.descriptionurl}`, restrictions: stripHtml(metadata.Restrictions?.value || 'Verifique direitos de imagem, marcas e eventuais exigências de compartilhamento sob a mesma licença.'), acquiredAt: new Date().toISOString(), path: file, kind: 'commons' };
    await writeFile(manifest, JSON.stringify(asset, null, 2), 'utf8');
    return asset;
  }
  return null;
}
