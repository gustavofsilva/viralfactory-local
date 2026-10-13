import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from './db.js';
import { getAgentSettings } from './agent.js';
import { bridgeForAccount, extensionDirectory, prepareExtension } from './extension-bridge.js';

const handleSchema = z.string().trim().transform(value => value.replace(/^@/, '').toLowerCase()).pipe(z.string().regex(/^[a-z0-9_.]{1,24}$/));
const idSchema = z.object({ id: z.string().min(1).max(100) });
export async function registerAccountRoutes(app: FastifyInstance) {
  app.get('/api/accounts', async () => {
    const primary = (await getAgentSettings()).accountHandle;
    const accounts = await db.tikTokAccount.findMany({ orderBy: { createdAt: 'asc' } });
    return accounts.map(account => ({ ...account, primary: account.handle.toLowerCase() === primary.toLowerCase(), connection: bridgeForAccount(account.handle, primary).status(account.handle), extensionDirectory: extensionDirectory(account.handle.toLowerCase() === primary.toLowerCase() ? undefined : account.handle) }));
  });
  app.post('/api/accounts', async request => {
    const value = z.object({ handle: handleSchema, label: z.string().trim().min(2).max(80).optional() }).parse(request.body);
    return db.tikTokAccount.create({ data: { handle: value.handle, label: value.label || `@${value.handle}` } });
  });
  app.patch('/api/accounts/:id', async request => {
    const { id } = idSchema.parse(request.params);
    const value = z.object({ label: z.string().trim().min(2).max(80).optional(), enabled: z.boolean().optional() }).parse(request.body);
    return db.tikTokAccount.update({ where: { id }, data: value });
  });
  app.post('/api/accounts/:id/extension/setup', async request => {
    const { id } = idSchema.parse(request.params);
    const account = await db.tikTokAccount.findUniqueOrThrow({ where: { id } });
    const primary = (await getAgentSettings()).accountHandle;
    return prepareExtension(account.handle.toLowerCase() === primary.toLowerCase() ? undefined : account.handle);
  });
  app.post('/api/accounts/:id/browser/check', async request => {
    const { id } = idSchema.parse(request.params);
    const account = await db.tikTokAccount.findUniqueOrThrow({ where: { id } });
    const bridge = bridgeForAccount(account.handle, (await getAgentSettings()).accountHandle);
    const current = bridge.snapshot();
    if (!current) return bridge.status(account.handle);
    if (new URL(current.url).pathname !== '/tiktokstudio/upload') await bridge.request('NAVIGATE', { account: account.handle, url: 'https://www.tiktok.com/tiktokstudio/upload' }, AbortSignal.timeout(85000));
    await bridge.request('REVEAL_ACCOUNT', { account: account.handle }, AbortSignal.timeout(85000));
    return bridge.status(account.handle);
  });
}
