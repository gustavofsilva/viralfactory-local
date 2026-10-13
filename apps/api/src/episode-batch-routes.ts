import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from './db.js';
import { createEpisodeBatch, episodeBatchInput, episodeBatchOverview, tickEpisodeBatches } from './episode-batches.js';

const idSchema = z.object({ id: z.string().min(1).max(100) });
export async function registerEpisodeBatchRoutes(app: FastifyInstance) {
  app.get('/api/episode-batches', episodeBatchOverview);
  app.post('/api/episode-batches', async request => createEpisodeBatch(episodeBatchInput.parse(request.body)));
  app.patch('/api/episode-batches/:id', async request => {
    const { id } = idSchema.parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    const batch = await db.episodeBatch.findUniqueOrThrow({ where: { id } });
    if (enabled && !(await db.tikTokAccount.findUniqueOrThrow({ where: { id: batch.accountId } })).enabled) throw Object.assign(new Error('Conta de destino desativada.'), { statusCode: 409 });
    const updated = await db.episodeBatch.update({ where: { id }, data: { enabled, lastError: enabled ? null : batch.lastError } });
    if (enabled) void tickEpisodeBatches().catch(error => app.log.error(error));
    return updated;
  });
  app.post('/api/episode-batches/:id/retry-failed', async request => {
    const { id } = idSchema.parse(request.params);
    await db.episodeBatch.findUniqueOrThrow({ where: { id } });
    const clip = await db.clip.findFirst({ where: { batchId: id, status: 'FAILED', submissionStartedAt: null }, orderBy: { sourceName: 'asc' } });
    if (!clip) throw Object.assign(new Error('Nenhum episódio com falha segura para retomar.'), { statusCode: 409 });
    const render = !!clip.transcriptJson && !!clip.segmentsJson;
    const job = await db.job.findUnique({ where: { dedupeKey: `clip-${render ? 'render' : 'analyze'}:${clip.id}` } });
    if (job && job.status !== 'FAILED') throw Object.assign(new Error('A tarefa ainda está ativa ou já foi concluída.'), { statusCode: 409 });
    await db.$transaction(async tx => {
      await tx.clip.update({ where: { id: clip.id }, data: { status: render ? 'APPROVED' : 'IMPORTED', lastError: null } });
      if (job) await tx.job.update({ where: { id: job.id }, data: { status: 'RETRY_PENDING', attempts: 0, availableAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null } });
      await tx.episodeBatch.update({ where: { id }, data: { lastError: null } });
    });
    if (!job) void tickEpisodeBatches().catch(error => app.log.error(error));
    return { clipId: clip.id, resumed: true };
  });
}
