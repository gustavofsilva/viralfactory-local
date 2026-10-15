import { agentSettingsSchema, scriptSchema, type AgentSettings } from '@viralfactory/shared';
import { db, getSettings, type Db } from './db.js';
import { activeStatuses, enqueueDiscovery, retryJob } from './queue.js';
import { listTrends } from './trends.js';
import { productionRevision } from './production.js';
import { scriptRisk, sensitiveText } from './content-risk.js';
import { randomUUID } from 'node:crypto';

export async function getAgentSettings(client: Db = db) {
  const row = await client.setting.findUnique({ where: { key: 'agent' } });
  return agentSettingsSchema.parse(row ? JSON.parse(row.value) : {});
}
export async function pausePublicationAfterUncertain(client: Db = db) {
  const settings = await getAgentSettings(client);
  if (!settings.publicationEnabled) return;
  await client.setting.upsert({ where: { key: 'agent' }, create: { key: 'agent', value: JSON.stringify({ ...settings, publicationEnabled: false }) }, update: { value: JSON.stringify({ ...settings, publicationEnabled: false }) } });
}
export function localDay(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
export function scheduledInstant(day: string, time: string) {
  const target = Date.parse(`${day}T${time}:00Z`);
  let value = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let pass = 0; pass < 3; pass++) {
    const p = formatter.formatToParts(new Date(value));
    const part = (type: string) => p.find(item => item.type === type)!.value;
    const represented = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
    value += target - represented;
  }
  return new Date(value);
}
function hourlyPublicationTimesForDay(settings: AgentSettings, day: string) {
  if (settings.continuousHourly) {
    if (settings.burstTarget > settings.burstSuccesses) return [];
    const minute = settings.hourlyResumeAt ? new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }).format(new Date(settings.hourlyResumeAt)) : '00';
    return Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:${minute}`).filter(time => !settings.hourlyResumeAt || scheduledInstant(day, time).getTime() >= Date.parse(settings.hourlyResumeAt));
  }
  if (settings.hourlyStartAt && settings.hourlyEndAt) {
    const start = Date.parse(settings.hourlyStartAt), end = Date.parse(settings.hourlyEndAt);
    return Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`).filter(time => {
      const instant = scheduledInstant(day, time).getTime();
      return instant >= start && instant < end;
    });
  }
  return [];
}
export function publicationTimesForDay(settings: AgentSettings, day: string) {
  const hourly = hourlyPublicationTimesForDay(settings, day);
  if (settings.continuousHourly) return hourly;
  if (hourly.length) return hourly;
  return [...new Set([...settings.times, ...(settings.extraPublicationDay === day ? settings.extraPublicationTimes : [])])];
}
export function publicationLimitForDay(settings: AgentSettings, day: string) {
  if (settings.continuousHourly) return 30; // 24 hourly slots plus the initial three-post test.
  const hourly = hourlyPublicationTimesForDay(settings, day);
  if (hourly.length) return hourly.length;
  return 2 + (settings.extraPublicationDay === day ? settings.extraPublicationCount : 0);
}
export function isHourlyCampaignAt(settings: AgentSettings, now: Date) {
  if (settings.continuousHourly) return settings.burstTarget <= settings.burstSuccesses && (!settings.hourlyResumeAt || now.getTime() >= Date.parse(settings.hourlyResumeAt));
  return !!settings.hourlyStartAt && !!settings.hourlyEndAt && now.getTime() >= Date.parse(settings.hourlyStartAt) && now.getTime() < Date.parse(settings.hourlyEndAt);
}
export function isAutomaticallyPublishable(video: { state: string; outputPath: string | null; scriptJson: string | null; scriptReviewedAt: Date | null }, settings: AgentSettings) {
  if (!video.outputPath || !video.scriptJson) return false;
  let value: unknown;
  try { value = JSON.parse(video.scriptJson); } catch { return false; }
  const parsed = scriptSchema.safeParse(value);
  if (!parsed.success) return false;
  if (video.state === 'APPROVED') return true;
  const risk = scriptRisk(parsed.data);
  return parsed.data.origin === 'ollama' && video.state === 'REVIEW_PENDING' && (risk === 'sensitive' ? settings.autoPublishSensitive : settings.autoPublishNormal || settings.hourlyAutoPublishNormal && isHourlyCampaignAt(settings, new Date()));
}
async function reuseShortNarration(client: Db, slotId: string, now: Date) {
  const candidates = await client.video.findMany({ where: { state: 'FAILED', lastError: { startsWith: 'A narração tem' }, scriptJson: { not: null }, outputPath: null, agentSlot: { is: null }, createdAt: { gte: new Date(now.getTime() - 72 * 3600000) } }, orderBy: { createdAt: 'desc' }, take: 20 });
  const reusable = candidates.find(item => {
    const duration = Number(item.lastError?.match(/^A narração tem (\d+(?:\.\d+)?) segundos/)?.[1]);
    if (!Number.isFinite(duration) || duration < 13.5 || duration >= 15 || !item.scriptJson) return false;
    try { return scriptSchema.safeParse(JSON.parse(item.scriptJson)).success; } catch { return false; }
  });
  if (!reusable) return null;
  return client.$transaction(async tx => {
    const video = await tx.video.update({ where: { id: reusable.id }, data: { state: 'SCRIPTED', lastError: null } });
    await tx.agentSlot.update({ where: { id: slotId }, data: { videoId: video.id, status: 'GENERATING', lastError: null, selectionAttempts: { increment: 1 } } });
    return video;
  });
}
let ticking = false;
export async function tickAgent(options: { now?: Date; forcePrepare?: boolean; client?: Db } = {}) {
  if (ticking && !options.client) return;
  if (!options.client) ticking = true;
  const client = options.client || db, now = options.now || new Date();
  try {
    const settings = await getAgentSettings(client);
    if (!settings.enabled) return;
    if (settings.hourlyEndAt && now.getTime() >= Date.parse(settings.hourlyEndAt)) {
      settings.hourlyStartAt = undefined;
      settings.hourlyEndAt = undefined;
      settings.hourlyAutoPublishNormal = false;
      await client.setting.upsert({ where: { key: 'agent' }, create: { key: 'agent', value: JSON.stringify(settings) }, update: { value: JSON.stringify(settings) } });
    }
    await enqueueDiscovery(`agent:research:${Math.floor(now.getTime()/3600000)}`, client);
    if (settings.burstTarget > settings.burstSuccesses && settings.burstRunId && settings.publicationEnabled && !settings.loginPaused) {
      const keyPrefix = `burst:${settings.burstRunId}:`;
      const current = await client.agentSlot.findFirst({ where: { slotKey: { startsWith: keyPrefix }, status: { notIn: ['PUBLISHED', 'SKIPPED', 'BLOCKED'] } } });
      if (!current) {
        const failed = await client.agentSlot.count({ where: { slotKey: { startsWith: keyPrefix }, status: 'BLOCKED' } });
        if (failed < 12) await client.agentSlot.create({ data: { slotKey: `${keyPrefix}${settings.burstSuccesses + 1}:${randomUUID()}`, scheduledFor: now } });
        else { settings.publicationEnabled = false; await client.setting.upsert({ where: { key: 'agent' }, create: { key: 'agent', value: JSON.stringify(settings) }, update: { value: JSON.stringify(settings) } }); }
      }
    }
    const horizon = Math.max(now.getTime() + 86400000, settings.hourlyEndAt ? Date.parse(settings.hourlyEndAt) : 0);
    const days = [...new Set(Array.from({ length: Math.ceil((horizon - now.getTime()) / 86400000) + 2 }, (_, offset) => localDay(new Date(now.getTime() + offset * 86400000))))];
    for (const day of days) for (const time of publicationTimesForDay(settings, day)) {
      const scheduledFor = scheduledInstant(day, time);
      if (scheduledFor < now || scheduledFor.getTime() > horizon) continue;
      await client.agentSlot.upsert({ where: { slotKey: `${day}:${time}` }, create: { slotKey: `${day}:${time}`, scheduledFor }, update: {} });
    }
    await client.agentSlot.updateMany({ where: { status: { in: ['PLANNED', 'WAITING_SOURCE', 'READY', 'WAITING_LOGIN', 'WAITING_REVIEW'] }, scheduledFor: { lt: new Date(now.getTime()-2*3600000) }, NOT: { slotKey: { startsWith: 'burst:' } } }, data: { status: 'SKIPPED', lastError: 'Horário expirou. O agente não acumula publicações atrasadas.' } });
    // A browser submission is never retried after a crash: its outcome may be unknown.
    const uncertain = await client.agentSlot.findMany({ where: { status: 'SENDING' } });
    for (const slot of uncertain) {
      const active = await client.job.findFirst({ where: { dedupeKey: `tiktok:${slot.id}`, status: { in: activeStatuses } } });
      if (!active) {
        await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'UNKNOWN', lastError: 'Envio interrompido. Confira a conta antes de qualquer nova tentativa.' } });
        await pausePublicationAfterUncertain(client);
        settings.publicationEnabled = false;
      }
    }
    await client.agentSlot.updateMany({ where: { status: 'BLOCKED', selectionAttempts: { lt: 3 }, submissionStartedAt: null, video: { is: { state: 'FAILED' } } }, data: { status: 'WAITING_SOURCE' } });
    const slots = await client.agentSlot.findMany({ where: { status: { notIn: ['PUBLISHED', 'SKIPPED', 'UNKNOWN', 'BLOCKED', 'SENDING', 'QUEUED'] } }, include: { video: true }, orderBy: { scheduledFor: 'asc' } });
    const preferences = await getSettings(client);
    const queued = await client.agentSlot.findMany({ where: { status: 'QUEUED' } });
    for (const slot of queued) {
      const job = await client.job.findUnique({ where: { dedupeKey: `tiktok:${slot.id}` } });
      if (job && ['FAILED', 'CANCELED'].includes(job.status)) {
        await client.agentSlot.update({ where: { id: slot.id }, data: { status: slot.submissionStartedAt ? 'UNKNOWN' : 'BLOCKED', lastError: job.lastError || 'Envio cancelado ou bloqueado.' } });
        if (slot.submissionStartedAt) { await pausePublicationAfterUncertain(client); settings.publicationEnabled = false; }
      }
    }
    for (const slot of slots) {
      if (settings.burstTarget > settings.burstSuccesses && !slot.slotKey.startsWith(`burst:${settings.burstRunId}:`)) continue;
      let video = slot.video;
      if (video?.state === 'FAILED' || (video?.scriptJson && JSON.parse(video.scriptJson).risk === 'sensitive' && !video.scriptReviewedAt && !settings.autoPublishSensitive)) {
        if (slot.selectionAttempts < 3) {
          await client.agentSlot.update({ where: { id: slot.id }, data: { videoId: null, status: 'WAITING_SOURCE', lastError: 'Assunto anterior não passou na geração automática. Buscando outra fonte; o histórico foi preservado.' } });
          video = null;
        }
      }
      if (!video && (options.forcePrepare || slot.selectionAttempts > 0 || slot.scheduledFor.getTime()-now.getTime() <= settings.prepareHours*3600000)) {
        if (slot.slotKey.startsWith('burst:')) video = await reuseShortNarration(client, slot.id, now);
        if (!video) {
        const candidates = await listTrends(client);
        const eligible = candidates.filter(trend => !trend.videoId && trend.publishedAt && Date.parse(trend.publishedAt) <= now.getTime()+300000 && now.getTime()-Date.parse(trend.publishedAt) <= 72*3600000 && trend.sources.some(source => !source.url.includes('news.google.com/') && source.summary.length >= 350 && source.publishedAt));
        const trustedArticle = (trend: typeof eligible[number]) => trend.sources.some(source => {
          const host = new URL(source.url).hostname;
          return host.endsWith('tse.jus.br') || host === 'agenciabrasil.ebc.com.br';
        });
        const electionTopic = (trend: typeof eligible[number]) => {
          const lead = trend.summary.split(/Notícias relacionadas:/i, 1)[0].slice(0, 500);
          const text = `${trend.title} ${lead}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          return trustedArticle(trend) && /\b(eleic[a-z]*|reeleic[a-z]*|segundo turno|2[ºo] turno|urnas?|eleitor[a-z]*|votac[a-z]*|plebiscit[a-z]*|justica eleitoral|tse|presidenci[a-z]*|campanha eleitoral)\b/.test(text);
        };
        // RSS articles often append unrelated headlines after "Notícias relacionadas".
        // Classify the lead; the finished script still passes the full risk check.
        const generalTopic = (trend: typeof eligible[number]) => {
          const lead = trend.summary.split(/Notícias relacionadas:/i, 1)[0].slice(0, 500);
          return !sensitiveText(`${trend.title} ${lead}`);
        };
        const fallback = eligible.find(generalTopic) || (settings.autoPublishSensitive ? eligible.find(trustedArticle) : undefined);
        const candidate = settings.topicFocus === 'elections' ? eligible.find(electionTopic) || (isHourlyCampaignAt(settings, slot.scheduledFor) || settings.continuousHourly ? fallback : undefined) : fallback;
        if (!candidate) { await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'WAITING_SOURCE', lastError: 'Aguardando matéria recente com texto suficiente e fonte verificável.' } }); continue; }
        video = await client.$transaction(async tx => {
          const attached = await tx.agentSlot.findUniqueOrThrow({ where: { id: slot.id } });
          if (attached.videoId) return tx.video.findUniqueOrThrow({ where: { id: attached.videoId } });
          const result = await tx.video.upsert({ where: { trendId: candidate.id }, create: { trendId: candidate.id, title: candidate.title }, update: {} });
          await tx.agentSlot.update({ where: { id: slot.id }, data: { videoId: result.id, status: 'GENERATING', lastError: null, selectionAttempts: { increment: 1 } } });
          await tx.job.upsert({ where: { dedupeKey: `script:${result.id}` }, create: { kind: 'SCRIPT', payload: JSON.stringify({ videoId: result.id }), dedupeKey: `script:${result.id}`, videoId: result.id }, update: {} });
          return result;
        });
        }
      }
      if (!video) continue;
      if (['FAILED', 'CANCELED'].includes(video.state)) { await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'BLOCKED', lastError: video.lastError || 'Produção não concluída. Verifique a fila.' } }); continue; }
      if (video.scriptJson && !video.outputPath) {
        const script = scriptSchema.parse(JSON.parse(video.scriptJson));
        if (script.risk === 'sensitive' && !video.scriptReviewedAt && !settings.autoPublishSensitive) { await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'WAITING_REVIEW', lastError: 'Roteiro sensível exige revisão humana.' } }); continue; }
        const active = await client.job.count({ where: { videoId: video.id, status: { in: activeStatuses } } });
        if (!active) {
          const revision = productionRevision(script, preferences);
          const dedupeKey = `produce:${video.id}:${revision}`;
          const previous = await client.job.findUnique({ where: { dedupeKey } });
          if (previous?.status === 'FAILED') await retryJob(previous.id, client);
          else await client.job.upsert({ where: { dedupeKey }, create: { kind: 'PRODUCE', payload: JSON.stringify({ videoId: video.id }), dedupeKey, videoId: video.id }, update: {} });
        }
      }
      if (!video.outputPath) continue;
      if (!isAutomaticallyPublishable(video, settings)) { await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'WAITING_REVIEW', lastError: 'Este vídeo precisa ser aprovado no Estúdio.' } }); continue; }
      await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'READY', lastError: null } });
      if (now < slot.scheduledFor || !settings.publicationEnabled || settings.loginPaused) continue;
      if (!settings.accountHandle) { await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'WAITING_LOGIN', lastError: 'Configure a conta e faça login no navegador local.' } }); continue; }
      await client.$transaction(async tx => {
        const changed = await tx.agentSlot.updateMany({ where: { id: slot.id, status: 'READY', submissionStartedAt: null }, data: { status: 'QUEUED' } });
        if (changed.count) await tx.job.upsert({ where: { dedupeKey: `tiktok:${slot.id}` }, create: { kind: 'TIKTOK_PUBLISH', payload: JSON.stringify({ slotId: slot.id }), dedupeKey: `tiktok:${slot.id}`, maxAttempts: 1, videoId: video.id }, update: {} });
      });
    }
  } finally { if (!options.client) ticking = false; }
}
