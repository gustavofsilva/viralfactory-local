import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { db } from './db.js';
import { bridgeForAccount } from './extension-bridge.js';
import { getAgentSettings } from './agent.js';
import { probeFile } from './production.js';
import { retryJob } from './queue.js';

const episodeRoot = path.resolve(process.env.EPISODE_LIBRARY_DIR || 'D:/ViralFactoryLocal/videos');
const videoExtensions = new Set(['.mkv', '.mp4', '.mov']);
const active = ['QUEUED', 'RUNNING', 'RETRY_PENDING'];
export const episodeBatchInput = z.object({ accountId: z.string().min(1), intervalMinutes: z.number().int().min(60).max(1440), rightsConfirmed: z.literal(true) });
export function episodeTitle(filename: string) {
  const match = filename.match(/s(\d{1,2})e(\d{1,3})/i);
  return match ? `Naruto S${match[1].padStart(2, '0')}E${match[2].padStart(2, '0')}` : path.parse(filename).name.replace(/[._-]+/g, ' ').slice(0, 120);
}
async function libraryFiles() {
  const root = await realpath(episodeRoot);
  const found: { filename: string; size: number; modifiedAt: Date }[] = [];
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase())) {
        const resolved = await realpath(filename);
        if (!resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep.toLowerCase())) continue;
        const info = await stat(resolved);
        if (info.size > 0 && info.size <= 1024 * 1024 * 1024) found.push({ filename: resolved, size: info.size, modifiedAt: info.mtime });
      }
    }
  }
  await visit(root);
  return { root, found: found.sort((a, b) => a.filename.localeCompare(b.filename, 'pt-BR', { numeric: true })) };
}
export async function createEpisodeBatch(input: z.infer<typeof episodeBatchInput>) {
  const account = await db.tikTokAccount.findUniqueOrThrow({ where: { id: input.accountId } });
  if (!account.enabled) throw new Error('Conta desativada.');
  const { root, found } = await libraryFiles();
  if (!found.length) throw new Error('Nenhum MKV, MP4 ou MOV encontrado na biblioteca.');
  const batch = await db.$transaction(async tx => {
    const created = await tx.episodeBatch.create({ data: { accountId: account.id, sourceRoot: root, intervalMinutes: input.intervalMinutes, rightsConfirmedAt: new Date(), enabled: false } });
    await tx.clip.createMany({ data: found.map(item => {
      const title = episodeTitle(item.filename);
      return { batchId: created.id, accountId: account.id, title, caption: `${title} | Melhores momentos.\n#Naruto #Anime #Cortes`, sourceName: path.basename(item.filename), sourcePath: item.filename, sourceBytes: item.size, sourceModifiedAt: item.modifiedAt, status: 'IMPORTED' };
    }) });
    return created;
  });
  return { batchId: batch.id, count: found.length, root };
}
export async function episodeBatchOverview() {
  const batches = await db.episodeBatch.findMany({ include: { account: true }, orderBy: { createdAt: 'desc' } });
  return Promise.all(batches.map(async batch => ({ ...batch, counts: await db.clip.groupBy({ by: ['status'], where: { batchId: batch.id }, _count: { _all: true } }) })));
}
let advancing = false;
export async function tickEpisodeBatches() {
  if (advancing) return;
  advancing = true;
  try {
    if (await db.job.count({ where: { status: { in: active } } })) return;
    const primary = (await getAgentSettings()).accountHandle;
    for (const batch of await db.episodeBatch.findMany({ where: { enabled: true }, include: { account: true }, orderBy: { createdAt: 'asc' } })) {
      if (!batch.account.enabled) continue;
      const interrupted = await db.clip.findFirst({ where: { batchId: batch.id, status: { in: ['ANALYZING', 'APPROVED', 'RENDERING', 'QUEUED'] } }, orderBy: { sourceName: 'asc' } });
      if (interrupted) {
        const kind = interrupted.status === 'ANALYZING' ? 'analyze' : interrupted.status === 'QUEUED' ? 'publish' : 'render';
        const job = await db.job.findUnique({ where: { dedupeKey: `clip-${kind}:${interrupted.id}` } });
        if (job?.status === 'FAILED' && !interrupted.submissionStartedAt) await retryJob(job.id);
        else if (!job || job.status === 'COMPLETED') await db.clip.update({ where: { id: interrupted.id }, data: { status: 'FAILED', lastError: 'Etapa interrompida sem tarefa ativa. Confira este episódio.' } });
        return;
      }
      const blocked = await db.clip.findFirst({ where: { batchId: batch.id, status: 'BLOCKED' }, orderBy: { sourceName: 'asc' } });
      if (blocked && !blocked.submissionStartedAt && !blocked.postUrl) {
        const job = await db.job.findUnique({ where: { dedupeKey: `clip-publish:${blocked.id}` } });
        if (job?.status === 'FAILED' && job.attempts < job.maxAttempts) {
          await db.$transaction(async tx => {
            const changed = await tx.clip.updateMany({ where: { id: blocked.id, status: 'BLOCKED', submissionStartedAt: null, postUrl: null }, data: { status: 'QUEUED', lastError: null } });
            if (!changed.count) return;
            await tx.job.update({ where: { id: job.id }, data: { status: 'RETRY_PENDING', availableAt: new Date(Date.now() + Math.min(60000, 5000 * 2 ** job.attempts)), leaseOwner: null, leaseExpiresAt: null, lastError: null } });
            await tx.jobLog.create({ data: { jobId: job.id, level: 'warning', message: `Falha antes da publicação; nova tentativa automática ${job.attempts + 1}/${job.maxAttempts}.` } });
          });
          return;
        }
      }
      const problem = await db.clip.findFirst({ where: { batchId: batch.id, status: { in: ['UNKNOWN', 'BLOCKED', 'FAILED', 'QUEUED', 'SENDING'] } }, orderBy: { sourceName: 'asc' } });
      if (problem) { await db.episodeBatch.update({ where: { id: batch.id }, data: { enabled: false, lastError: `${problem.sourceName}: ${problem.status}. Confira antes de continuar.` } }); continue; }
      const clip = await db.clip.findFirst({ where: { batchId: batch.id, status: { in: ['IMPORTED', 'SUGGESTED', 'READY'] } }, orderBy: { sourceName: 'asc' } });
      if (!clip) continue;
      if (clip.status === 'READY') {
        if (batch.nextPublishAt > new Date() || bridgeForAccount(batch.account.handle, primary).status(batch.account.handle).state !== 'CONNECTED') continue;
        await db.$transaction(async tx => {
          const changed = await tx.clip.updateMany({ where: { id: clip.id, status: 'READY', submissionStartedAt: null }, data: { status: 'QUEUED' } });
          if (!changed.count) return;
          await tx.job.create({ data: { kind: 'CLIP_PUBLISH', dedupeKey: `clip-publish:${clip.id}`, payload: JSON.stringify({ clipId: clip.id, allowUnverifiedCaption: true }), maxAttempts: 3 } });
          await tx.episodeBatch.update({ where: { id: batch.id }, data: { nextPublishAt: new Date(Date.now() + batch.intervalMinutes * 60000), lastError: null } });
        });
        return;
      }
      if (clip.status === 'SUGGESTED') {
        await db.$transaction(async tx => {
          const changed = await tx.clip.updateMany({ where: { id: clip.id, status: 'SUGGESTED' }, data: { status: 'APPROVED' } });
          if (changed.count) await tx.job.create({ data: { kind: 'CLIP_RENDER', dedupeKey: `clip-render:${clip.id}`, payload: JSON.stringify({ clipId: clip.id }), maxAttempts: 1 } });
        });
        return;
      }
      try {
        const info = await stat(clip.sourcePath!);
        if (info.size !== clip.sourceBytes || Math.abs(info.mtime.getTime() - (clip.sourceModifiedAt?.getTime() || 0)) > 1000) throw new Error('O episódio de origem mudou desde a importação.');
        const probe = await probeFile(clip.sourcePath!);
        const duration = Number(probe.format.duration);
        if (!Number.isFinite(duration) || duration < 60 || duration > 1800 || !probe.streams.some(stream => stream.codec_type === 'video') || !probe.streams.some(stream => stream.codec_type === 'audio')) throw new Error('Episódio sem vídeo/áudio ou duração fora de 1 a 30 minutos.');
        await db.$transaction(async tx => {
          await tx.clip.update({ where: { id: clip.id }, data: { durationSeconds: duration } });
          await tx.job.create({ data: { kind: 'CLIP_ANALYZE', dedupeKey: `clip-analyze:${clip.id}`, payload: JSON.stringify({ clipId: clip.id }), maxAttempts: 1 } });
        });
      } catch (error) {
        await db.clip.update({ where: { id: clip.id }, data: { status: 'FAILED', lastError: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
  } finally { advancing = false; }
}
