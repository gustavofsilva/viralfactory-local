import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentSettingsSchema } from '@viralfactory/shared';
import { db } from './db.js';
import { getAgentSettings, tickAgent, isAutomaticallyPublishable, publicationTimesForDay } from './agent.js';
import { tiktokBrowser, observedPostLinks } from './tiktok-browser.js';
import { retryJob, activeStatuses, cancelJob } from './queue.js';
import { extensionBridge, extensionDirectory } from './extension-bridge.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

const idParam = z.object({ id: z.string().min(1).max(100) });
const pausedBrowser = { state: 'LOGIN_PAUSED', account: null, detail: 'Conexão pausada. Foi informado um limite de tentativas de login; isso não confirma a causa do bloqueio. Aguarde antes de tentar novamente. Retomar conexão apenas libera os controles, sem tentar entrar automaticamente.' };
async function requireLoginAvailable() {
  if ((await getAgentSettings()).loginPaused) throw Object.assign(new Error('Conexão pausada. Use Retomar conexão quando estiver pronto para uma nova tentativa manual.'), { statusCode: 409 });
}
export async function registerAgentRoutes(app: FastifyInstance) {
  app.get('/api/agent', async () => {
    const settings = await getAgentSettings();
    const slots = await db.agentSlot.findMany({ orderBy: { scheduledFor: 'desc' }, take: 100, include: { video: true } });
    const directory = extensionDirectory();
    return { settings, extension: { directory, prepared: existsSync(path.join(directory, 'manifest.json')) && existsSync(path.join(directory, 'config.js')) }, slots: slots.map(slot => ({ ...slot, video: slot.video ? { ...slot.video, script: slot.video.scriptJson ? JSON.parse(slot.video.scriptJson) : null, artifacts: slot.video.artifactJson ? JSON.parse(slot.video.artifactJson) : null } : null })), browser: settings.loginPaused ? pausedBrowser : settings.browserMode === 'extension' ? extensionBridge.status(settings.accountHandle) : tiktokBrowser.status() };
  });
  app.put('/api/agent/settings', async request => {
    const settings = agentSettingsSchema.parse(request.body);
    const previous = await getAgentSettings();
    if (settings.browserMode !== previous.browserMode || settings.accountHandle !== previous.accountHandle) settings.publicationEnabled = false;
    if (settings.loginPaused) settings.publicationEnabled = false;
    if (settings.publicationEnabled && (!settings.enabled || !settings.accountHandle)) throw Object.assign(new Error('Ative o agente e informe o @ antes de habilitar a publicação.'), { statusCode: 400 });
    await db.setting.upsert({ where: { key: 'agent' }, create: { key: 'agent', value: JSON.stringify(settings) }, update: { value: JSON.stringify(settings) } });
    const pending = await db.agentSlot.findMany({ where: { status: { notIn: ['PUBLISHED', 'SENDING', 'UNKNOWN', 'SKIPPED'] } } });
    for (const slot of pending) if (!publicationTimesForDay(settings, slot.slotKey.slice(0, 10)).includes(slot.slotKey.slice(-5))) {
      const job = await db.job.findUnique({ where: { dedupeKey: `tiktok:${slot.id}` } });
      if (job && activeStatuses.includes(job.status)) await cancelJob(job.id);
      await db.agentSlot.update({ where: { id: slot.id }, data: { status: 'SKIPPED', lastError: 'Horário alterado nas preferências.' } });
    }
    if (!settings.enabled || !settings.publicationEnabled) {
      const active = await db.job.findMany({ where: { kind: 'TIKTOK_PUBLISH', status: { in: activeStatuses } } });
      for (const job of active) await cancelJob(job.id);
    }
    await tickAgent();
    return settings;
  });
  app.post('/api/agent/prepare', async () => {
    if (!(await getAgentSettings()).enabled) throw Object.assign(new Error('Ative a produção do agente primeiro.'), { statusCode: 409 });
    await tickAgent({ forcePrepare: true });
    return { ok: true };
  });
  app.post('/api/agent/browser/open', async () => { await requireLoginAvailable(); const settings = await getAgentSettings(); if (settings.browserMode === 'extension') return extensionBridge.status(settings.accountHandle); await tiktokBrowser.open(); return tiktokBrowser.status(); });
  app.post('/api/agent/browser/check', async () => {
    await requireLoginAvailable(); const settings = await getAgentSettings();
    if (settings.browserMode === 'extension') {
      const current = extensionBridge.snapshot();
      if (current && new URL(current.url).pathname !== '/tiktokstudio/upload') await extensionBridge.request('NAVIGATE', { account: settings.accountHandle, url: 'https://www.tiktok.com/tiktokstudio/upload' }, AbortSignal.timeout(85000));
      await extensionBridge.request('REVEAL_ACCOUNT', { account: settings.accountHandle }, AbortSignal.timeout(85000));
      return extensionBridge.status(settings.accountHandle);
    }
    return tiktokBrowser.inspect(settings.accountHandle);
  });
  app.get('/api/agent/browser/view', async () => (await getAgentSettings()).browserMode === 'extension' ? { ...extensionBridge.status((await getAgentSettings()).accountHandle), page: extensionBridge.snapshot() || null } : tiktokBrowser.view());
  app.post('/api/agent/browser/close', async () => {
    if (await db.job.count({ where: { kind: 'TIKTOK_PUBLISH', status: 'RUNNING' } })) throw Object.assign(new Error('Pause a publicação antes de fechar o navegador.'), { statusCode: 409 });
    const settings = await getAgentSettings();
    if (settings.browserMode === 'extension') { extensionBridge.disconnect(); return extensionBridge.status(settings.accountHandle); }
    await tiktokBrowser.close(); return tiktokBrowser.status();
  });
  app.post('/api/agent/slots/:id/retry', async request => {
    const { id } = idParam.parse(request.params);
    const slot = await db.agentSlot.findUniqueOrThrow({ where: { id } });
    if (slot.submissionStartedAt || slot.postUrl) throw Object.assign(new Error('O envio já começou. Confira o TikTok e registre a URL; não repetir automaticamente.'), { statusCode: 409 });
    const job = await db.job.findUnique({ where: { dedupeKey: `tiktok:${id}` } });
    if (job) {
      await db.agentSlot.update({ where: { id }, data: { status: 'QUEUED', lastError: null } });
      await retryJob(job.id);
    } else if (slot.videoId) {
      const failed = await db.job.findFirst({ where: { videoId: slot.videoId, status: { in: ['FAILED', 'CANCELED'] } }, orderBy: { createdAt: 'desc' } });
      if (failed) await retryJob(failed.id);
      await db.agentSlot.update({ where: { id }, data: { status: 'GENERATING', lastError: null } });
    } else await db.agentSlot.update({ where: { id }, data: { status: 'PLANNED', lastError: null } });
    return { ok: true };
  });
  app.post('/api/agent/slots/:id/publish-now', async request => {
    const { id } = idParam.parse(request.params);
    const settings = await getAgentSettings();
    if (!settings.enabled || !settings.publicationEnabled || settings.loginPaused || !settings.accountHandle) throw Object.assign(new Error('Retome a conexão, configure a conta e ative a publicação primeiro.'), { statusCode: 409 });
    const slot = await db.agentSlot.findUniqueOrThrow({ where: { id }, include: { video: true } });
    if (slot.submissionStartedAt || slot.postUrl || !slot.video || !isAutomaticallyPublishable(slot.video, settings)) throw Object.assign(new Error('Este horário não está disponível para um teste de envio.'), { statusCode: 409 });
    await db.agentSlot.update({ where: { id }, data: { scheduledFor: new Date(), status: 'READY', lastError: null } });
    await tickAgent();
    return { ok: true };
  });
  app.post('/api/agent/slots/:id/confirm', async request => {
    const { id } = idParam.parse(request.params);
    const { postUrl, confirmed } = z.object({ postUrl: z.url(), confirmed: z.literal(true) }).parse(request.body);
    const settings = await getAgentSettings();
    if (!observedPostLinks([postUrl], settings.accountHandle).length) throw Object.assign(new Error('Use a URL de um vídeo da conta configurada.'), { statusCode: 400 });
    const slot = await db.agentSlot.findUniqueOrThrow({ where: { id } });
    if (slot.status !== 'UNKNOWN' || !slot.videoId || !confirmed) throw Object.assign(new Error('Só um envio incerto pode receber confirmação manual.'), { statusCode: 409 });
    await db.$transaction(async tx => {
      await tx.agentSlot.update({ where: { id }, data: { status: 'PUBLISHED', postUrl, lastError: 'Publicação conferida manualmente pelo usuário.' } });
      await tx.video.update({ where: { id: slot.videoId! }, data: { state: 'PUBLISHED' } });
    });
    return { ok: true };
  });
}
