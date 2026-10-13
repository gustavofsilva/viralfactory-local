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
}
