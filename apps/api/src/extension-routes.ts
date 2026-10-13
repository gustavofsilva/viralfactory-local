import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { extensionBridge, extensionSnapshotSchema, prepareExtension, bridgeForAccount, bridgeForConnection } from './extension-bridge.js';
import { getAgentSettings } from './agent.js';
import { db } from './db.js';
import { activeStatuses, cancelJob } from './queue.js';

const connectionSchema = z.object({ connectionId: z.uuid() });
async function disconnectExtension(connectionId?: string) {
  if (connectionId && !extensionBridge.ownsConnection(connectionId)) { bridgeForConnection(connectionId).disconnect(); return { ok: true }; }
  const settings = await getAgentSettings(); settings.publicationEnabled = false;
  await db.setting.upsert({ where: { key: 'agent' }, create: { key: 'agent', value: JSON.stringify(settings) }, update: { value: JSON.stringify(settings) } });
  for (const job of await db.job.findMany({ where: { kind: 'TIKTOK_PUBLISH', status: { in: activeStatuses } } })) await cancelJob(job.id);
  extensionBridge.disconnect(); return { ok: true };
}
export async function registerExtensionRoutes(app: FastifyInstance) {
  app.post('/api/agent/extension/setup', async () => prepareExtension());
  app.post('/api/agent/extension/disconnect', async () => disconnectExtension());
  app.post('/api/agent/extension/bridge/disconnect', async request => disconnectExtension(z.object({ connectionId: z.uuid().optional() }).parse(request.body).connectionId));
  app.get('/api/agent/extension/bridge/configuration', async request => {
    const settings = await getAgentSettings();
    const requested = z.object({ account: z.string().regex(/^[A-Za-z0-9_.]{1,24}$/).optional() }).parse(request.query).account;
    if (requested && !(await db.tikTokAccount.findUnique({ where: { handle: requested } }))) throw Object.assign(new Error('Conta não cadastrada.'), { statusCode: 404 });
    return { account: requested || settings.accountHandle, paused: requested ? false : settings.loginPaused, selected: requested ? true : settings.browserMode === 'extension' };
  });
  app.post('/api/agent/extension/bridge/connect', async request => {
    const value = z.object({ clientId: z.string().min(16).max(100), account: z.string().regex(/^[A-Za-z0-9_.]{1,24}$/).optional(), snapshot: extensionSnapshotSchema }).parse(request.body);
    const settings = await getAgentSettings();
    const account = value.account || settings.accountHandle;
    if (value.account && !(await db.tikTokAccount.findUnique({ where: { handle: account } }))) throw Object.assign(new Error('Conta não cadastrada.'), { statusCode: 404 });
    return { connectionId: bridgeForAccount(account, settings.accountHandle).connect(value.clientId, value.snapshot), account };
  });
  app.post('/api/agent/extension/bridge/heartbeat', async request => {
    const { connectionId, snapshot } = connectionSchema.extend({ snapshot: extensionSnapshotSchema }).parse(request.body);
    return { command: await bridgeForConnection(connectionId).poll(connectionId, snapshot) };
  });
  app.post('/api/agent/extension/bridge/result', async request => {
    const value = connectionSchema.extend({ commandId: z.uuid(), result: z.unknown().optional(), error: z.string().max(600).optional() }).parse(request.body);
    bridgeForConnection(value.connectionId).result(value.connectionId, value.commandId, value.result, value.error); return { ok: true };
  });
  app.post('/api/agent/extension/bridge/permit', async request => {
    const { connectionId, commandId } = connectionSchema.extend({ commandId: z.uuid() }).parse(request.body);
    await bridgeForConnection(connectionId).permit(connectionId, commandId); return { ok: true };
  });
  app.get('/api/agent/extension/bridge/file/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { connectionId } = connectionSchema.parse(request.query);
    const filename = await bridgeForConnection(connectionId).uploadFile(connectionId, id);
    return reply.type('video/mp4').header('cache-control', 'no-store').send(createReadStream(filename));
  });
}
