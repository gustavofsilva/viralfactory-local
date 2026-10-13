import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { extensionBridge, extensionSnapshotSchema, prepareExtension } from './extension-bridge.js';
import { getAgentSettings } from './agent.js';
import { db } from './db.js';
import { activeStatuses, cancelJob } from './queue.js';

const connectionSchema = z.object({ connectionId: z.uuid() });
async function disconnectExtension() {
  const settings = await getAgentSettings(); settings.publicationEnabled = false;
  await db.setting.upsert({ where: { key: 'agent' }, create: { key: 'agent', value: JSON.stringify(settings) }, update: { value: JSON.stringify(settings) } });
  for (const job of await db.job.findMany({ where: { kind: 'TIKTOK_PUBLISH', status: { in: activeStatuses } } })) await cancelJob(job.id);
  extensionBridge.disconnect(); return { ok: true };
}
export async function registerExtensionRoutes(app: FastifyInstance) {
  app.post('/api/agent/extension/setup', async () => prepareExtension());
  app.post('/api/agent/extension/disconnect', async () => disconnectExtension());
  app.post('/api/agent/extension/bridge/disconnect', async () => disconnectExtension());
  app.get('/api/agent/extension/bridge/configuration', async () => {
    const settings = await getAgentSettings();
    return { account: settings.accountHandle, paused: settings.loginPaused, selected: settings.browserMode === 'extension' };
  });
  app.post('/api/agent/extension/bridge/connect', async request => {
    const value = z.object({ clientId: z.string().min(16).max(100), snapshot: extensionSnapshotSchema }).parse(request.body);
    const settings = await getAgentSettings();
    return { connectionId: extensionBridge.connect(value.clientId, value.snapshot), account: settings.accountHandle };
  });
  app.post('/api/agent/extension/bridge/heartbeat', async request => {
    const { connectionId, snapshot } = connectionSchema.extend({ snapshot: extensionSnapshotSchema }).parse(request.body);
    return { command: await extensionBridge.poll(connectionId, snapshot) };
  });
  app.post('/api/agent/extension/bridge/result', async request => {
    const value = connectionSchema.extend({ commandId: z.uuid(), result: z.unknown().optional(), error: z.string().max(600).optional() }).parse(request.body);
    extensionBridge.result(value.connectionId, value.commandId, value.result, value.error); return { ok: true };
  });
  app.post('/api/agent/extension/bridge/permit', async request => {
    const { connectionId, commandId } = connectionSchema.extend({ commandId: z.uuid() }).parse(request.body);
    await extensionBridge.permit(connectionId, commandId); return { ok: true };
  });
  app.get('/api/agent/extension/bridge/file/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { connectionId } = connectionSchema.parse(request.query);
    const filename = await extensionBridge.uploadFile(connectionId, id);
    return reply.type('video/mp4').header('cache-control', 'no-store').send(createReadStream(filename));
  });
}
