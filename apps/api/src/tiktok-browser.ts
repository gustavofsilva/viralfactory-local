import { chromium, type BrowserContext, type Page } from 'playwright';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './config.js';
import { db } from './db.js';
import { getAgentSettings, isAutomaticallyPublishable, localDay, scheduledInstant, pausePublicationAfterUncertain, publicationLimitForDay } from './agent.js';
import { agentSettingsSchema, type Artifacts, type Script } from '@viralfactory/shared';
import { PermanentError } from './queue.js';
import { publishByExtension, ExtensionNeedsAttention } from './extension-publisher.js';

const studioUrl = 'https://www.tiktok.com/tiktokstudio/upload';
export class BrowserNeedsAttention extends Error {}
export function publicationCaption(script: Script, artifacts: Artifacts | null, mode: 'full' | 'source' = 'full') {
  if (mode === 'source') {
    const sources = [...new Set(script.sourceUrls)];
    return `Fonte: ${sources.map(url => new URL(url).hostname).join(', ')}\n${sources.join('\n')}`;
  }
  const credits = [...new Set(artifacts?.media?.assets.filter(asset => asset.kind === 'commons' || asset.kind === 'source').map(asset => asset.attribution) || [])];
  return `${script.title}\nNarração gerada por IA.\n\n${script.description}\n\n${script.hashtags.join(' ')}\n\nFontes: ${script.sourceUrls.join(' ')}${credits.length ? `\n\nImagens: ${credits.join('\n')}` : ''}`;
}
export function visibleAccountMatches(text: string, handle: string) {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !!handle && new RegExp(`(^|[^\\w.])@${escaped}(?![\\w.])`, 'i').test(text);
}
export function observedPostLinks(links: string[], account: string) {
  return [...new Set(links.flatMap(value => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || !new RegExp(`^/@${account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/video/\\d+$`, 'i').test(url.pathname)) return [];
      return [`https://www.tiktok.com/@${account.toLowerCase()}/video/${url.pathname.split('/').at(-1)}`];
    } catch { return []; }
  }))];
}
export class TikTokBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private opening?: Promise<Page>;
  private sending = false;
  private current = { state: 'CLOSED', account: null as string | null, detail: 'Abra o navegador local e entre na conta. O envio pelo site ainda requer validação com uma conta real.' };
  status() { return { ...this.current }; }
  async view() {
    if (!this.page || this.page.isClosed()) return { ...this.status(), page: null };
    return { ...this.status(), page: {
      url: this.page.url(), title: await this.page.title(),
      buttons: await this.page.getByRole('button').evaluateAll(elements => elements.map(element => ({ text: (element.textContent || '').trim().slice(0, 120), label: element.getAttribute('aria-label'), disabled: element.hasAttribute('disabled') }))),
      fileInputs: await this.page.locator('input[type=file]').count(),
      editableFields: await this.page.locator('[contenteditable=true]').count(),
      profileLinks: await this.page.locator('a[href]').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href).filter(value => /^https:\/\/(www\.)?tiktok\.com\/@/.test(value)).slice(0, 20))
    } };
  }
  async open() {
    if (this.page && !this.page.isClosed()) { await this.page.bringToFront(); return this.page; }
    if (this.opening) return this.opening;
    this.opening = this.launch();
    try { return await this.opening; } finally { this.opening = undefined; }
  }
  private async launch() {
    const executablePath = process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    await access(executablePath);
    const profile = path.join(dataDir, 'browser/tiktok');
    await mkdir(profile, { recursive: true });
    this.context = await chromium.launchPersistentContext(profile, { executablePath, headless: false, viewport: { width: 1280, height: 900 }, downloadsPath: path.join(dataDir, 'browser/downloads') });
    this.context.on('close', () => { this.context = undefined; this.page = undefined; this.current = { state: 'CLOSED', account: null, detail: 'Navegador fechado. A sessão local poderá ser reutilizada ao abrir novamente.' }; });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.current = { state: 'LOGIN_REQUIRED', account: null, detail: 'Faça login pessoalmente. O aplicativo não lê nem pede sua senha.' };
    await this.page.goto(studioUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return this.page;
  }
  async inspect(account: string, requireInput = true) {
    if (!this.page || this.page.isClosed()) return this.status();
    const body = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const upload = this.page.locator('input[type=file]');
    const verified = this.page.url().startsWith('https://www.tiktok.com/tiktokstudio') && (!requireInput || await upload.count() > 0) && visibleAccountMatches(body, account);
    this.current = verified ? { state: 'CONNECTED', account, detail: 'Conta identificada na página de envio. Isso ainda não confirma um teste de postagem.' } : { state: 'NEEDS_ATTENTION', account: null, detail: 'Faça login e deixe a tela de envio exibindo seu @. Se a conta não puder ser identificada na página, o agente não publicará.' };
    return this.status();
  }
  async close() { await this.context?.close(); }
  async publish(options: { file: string; caption: string; account: string; evidenceDirectory: string; signal: AbortSignal; beforeSubmit: () => Promise<void> }) {
    if (this.sending) throw new BrowserNeedsAttention('Outro envio está usando o navegador.');
    this.sending = true;
    try {
      const page = await this.open();
      options.signal.throwIfAborted();
      await page.goto(studioUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => { throw new BrowserNeedsAttention('A tela exige login, verificação ou intervenção.'); });
      const inspected = await this.inspect(options.account);
      if (inspected.state !== 'CONNECTED') throw new BrowserNeedsAttention(inspected.detail);
      const oldLinks = new Set(observedPostLinks(await page.locator('a[href]').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href)), options.account));
      const acceptedVideo = page.locator('input[type=file][accept*="video"],input[type=file][accept*=".mp4"],input[type=file][accept*=".webm"]');
      const allInputs = page.locator('input[type=file]');
      const acceptedCount = await acceptedVideo.count();
      const uploadInput = acceptedCount > 0 ? acceptedVideo : page.locator('input[type=file]:not([accept]),input[type=file][accept=""]');
      if (await uploadInput.count() !== 1) throw new BrowserNeedsAttention('Campo de vídeo não identificado de forma única.');
      await uploadInput.setInputFiles(options.file);
      const namedCaption = page.getByRole('textbox', { name: /caption|legenda|descri[cç][aã]o|description/i });
      let caption = namedCaption;
      if (await caption.count() !== 1) caption = page.locator('[contenteditable=true]:visible');
      await caption.first().waitFor({ state: 'visible', timeout: 60000 });
      if (await caption.count() !== 1) throw new BrowserNeedsAttention('Campo da legenda não identificado de forma única. Nenhum envio foi confirmado.');
      await caption.fill(options.caption);
      const post = page.getByRole('button', { name: /^(Post|Publish|Publicar|Postar)$/i });
      await post.waitFor({ state: 'visible', timeout: 90000 });
      const deadline = Date.now()+180000;
      while (!(await post.isEnabled())) {
        options.signal.throwIfAborted();
        if (Date.now() > deadline) throw new BrowserNeedsAttention('O upload não liberou o botão de publicação. Confira a página.');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if ((await this.inspect(options.account, false)).state !== 'CONNECTED') throw new BrowserNeedsAttention('A identidade da conta não foi confirmada antes de publicar.');
      await mkdir(options.evidenceDirectory, { recursive: true });
      await page.screenshot({ path: path.join(options.evidenceDirectory, 'before-submit.png'), fullPage: false });
      options.signal.throwIfAborted();
      await options.beforeSubmit(); // Durable intent before the external side effect.
      await post.click({ timeout: 10000 });
      const confirmDeadline = Date.now()+90000;
      while (Date.now() < confirmDeadline) {
        options.signal.throwIfAborted();
        const links = observedPostLinks(await page.locator('a[href]').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href)), options.account);
        const postUrl = links.find(value => !oldLinks.has(value));
        if (postUrl) {
          const verify = await this.context!.newPage();
          try {
            await verify.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await verify.locator('video').first().waitFor({ state: 'attached', timeout: 20000 });
            const text = await verify.locator('body').innerText();
            if (!text.includes(options.caption.slice(0, 45))) throw new BrowserNeedsAttention('A página encontrada não confirmou a legenda enviada.');
            await verify.screenshot({ path: path.join(options.evidenceDirectory, 'confirmed-post.png'), fullPage: false });
            return { postUrl };
          } finally { await verify.close(); }
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      await page.screenshot({ path: path.join(options.evidenceDirectory, 'unconfirmed-submit.png'), fullPage: false }).catch(() => {});
      throw new BrowserNeedsAttention('Envio iniciado, mas a página não forneceu uma URL verificável do novo vídeo. Confira a conta; não será repetido automaticamente.');
    } finally { this.sending = false; }
  }
}
export const tiktokBrowser = new TikTokBrowser();
export async function publishSlot(slotId: string, jobId: string, owner: string, signal: AbortSignal, log: (message: string) => Promise<void>) {
  const slot = await db.agentSlot.findUniqueOrThrow({ where: { id: slotId }, include: { video: true } });
  const settings = await getAgentSettings();
  if (!settings.enabled || !settings.publicationEnabled || settings.loginPaused) throw new PermanentError('Publicação ou conexão do agente está pausada.');
  if (!slot.slotKey.startsWith('burst:') && Date.now() > slot.scheduledFor.getTime()+2*3600000) {
    await db.agentSlot.update({ where: { id: slotId }, data: { status: 'SKIPPED', lastError: 'Horário de envio expirou.' } });
    throw new PermanentError('Horário de envio expirou; não acumular posts atrasados.');
  }
  if (slot.submissionStartedAt || slot.postUrl) throw new PermanentError('Envio anterior existe. Não repetir para evitar duplicações.');
  if (!slot.video || !isAutomaticallyPublishable(slot.video, settings)) throw new PermanentError('O vídeo não atende à política de publicação configurada.');
  const video = slot.video, script = JSON.parse(video.scriptJson!);
  const caption = publicationCaption(script, video.artifactJson ? JSON.parse(video.artifactJson) : null, settings.captionMode);
  if (caption.length > 2200) throw new PermanentError('Legenda com fontes excede 2200 caracteres. Edite antes de publicar.');
  const directory = path.join(dataDir, 'publications', slot.id);
  const beforeSubmit = async () => {
    signal.throwIfAborted();
    const latest = await getAgentSettings();
    if (!slot.slotKey.startsWith('burst:') && Date.now() > slot.scheduledFor.getTime()+2*3600000) throw new PermanentError('Horário expirou durante o upload.');
    if (!latest.enabled || !latest.publicationEnabled || latest.loginPaused || latest.browserMode !== settings.browserMode || latest.accountHandle !== settings.accountHandle) throw new PermanentError('Configuração de publicação alterada durante o preparo.');
    await db.$transaction(async tx => {
      const active = await tx.job.findFirst({ where: { id: jobId, status: 'RUNNING', leaseOwner: owner } });
      const currentVideo = await tx.video.findUniqueOrThrow({ where: { id: video.id } });
      if (!active || currentVideo.outputPath !== video.outputPath || currentVideo.scriptJson !== video.scriptJson || !isAutomaticallyPublishable(currentVideo, latest)) throw new PermanentError('Tarefa ou vídeo mudou durante o upload.');
      const dayStart = scheduledInstant(localDay(new Date()), '00:00');
      const submitted = await tx.agentSlot.count({ where: { submissionStartedAt: { gte: dayStart, lt: new Date(dayStart.getTime()+86400000) } } });
      if (submitted >= publicationLimitForDay(latest, localDay(new Date()))) throw new PermanentError('Limite de envios do dia atingido, incluindo resultados incertos.');
      const marked = await tx.agentSlot.updateMany({ where: { id: slot.id, status: 'QUEUED', submissionStartedAt: null }, data: { status: 'SENDING', submissionStartedAt: new Date(), evidencePath: directory } });
      if (!marked.count) throw new PermanentError('Envio já iniciado ou cancelado.');
    });
    await writeFile(path.join(directory, 'intent.json'), JSON.stringify({ slotId, videoId: video.id, account: settings.accountHandle, outputPath: video.outputPath, caption, automated: video.state !== 'APPROVED', startedAt: new Date().toISOString() }, null, 2));
    await log('Intenção de envio salva. A publicação não será repetida se o resultado ficar incerto.');
  };
  const authorizeExtension = async () => {
    signal.throwIfAborted();
    const latest = await getAgentSettings();
    const active = await db.job.findFirst({ where: { id: jobId, status: 'RUNNING', leaseOwner: owner, leaseExpiresAt: { gt: new Date() } } });
    const currentVideo = await db.video.findUniqueOrThrow({ where: { id: video.id } });
    if (!active || !latest.enabled || !latest.publicationEnabled || latest.loginPaused || latest.browserMode !== 'extension' || latest.accountHandle !== settings.accountHandle || currentVideo.outputPath !== video.outputPath || currentVideo.scriptJson !== video.scriptJson || !isAutomaticallyPublishable(currentVideo, latest) || !slot.slotKey.startsWith('burst:') && Date.now() > slot.scheduledFor.getTime()+2*3600000) throw new PermanentError('A publicação foi pausada, expirou ou a tarefa mudou.');
  };
  try {
    const options = { file: video.outputPath!, caption, account: settings.accountHandle, signal, evidenceDirectory: directory, beforeSubmit };
    const knownPostLinks = settings.browserMode === 'extension' ? (await db.agentSlot.findMany({ where: { postUrl: { not: null } }, select: { postUrl: true } })).flatMap(item => item.postUrl ? [item.postUrl] : []) : [];
    const result = settings.browserMode === 'extension' ? await publishByExtension({ ...options, authorize: authorizeExtension, allowUnverifiedCaption: settings.allowUnverifiedCaption, knownPostLinks }) : await tiktokBrowser.publish(options);
    await db.$transaction(async tx => {
      await tx.agentSlot.update({ where: { id: slot.id }, data: { status: 'PUBLISHED', postUrl: result.postUrl, lastError: 'captionVerified' in result && !result.captionVerified ? 'Legenda não verificada no TikTok; modo de fonte autorizado pelo proprietário.' : null } });
      await tx.video.update({ where: { id: video.id }, data: { state: 'PUBLISHED' } });
      const currentSettings = agentSettingsSchema.parse(JSON.parse((await tx.setting.findUniqueOrThrow({ where: { key: 'agent' } })).value));
      if (currentSettings.burstRunId && slot.slotKey.startsWith(`burst:${currentSettings.burstRunId}:`) && currentSettings.burstSuccesses < currentSettings.burstTarget) {
        const burstSuccesses = currentSettings.burstSuccesses + 1;
        const updated = { ...currentSettings, burstSuccesses, ...(burstSuccesses === currentSettings.burstTarget ? { hourlyResumeAt: new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString() } : {}) };
        await tx.setting.update({ where: { key: 'agent' }, data: { value: JSON.stringify(updated) } });
      }
    });
    await log(`Publicação confirmada pela página: ${result.postUrl}`);
  } catch (error) {
    const current = await db.agentSlot.findUniqueOrThrow({ where: { id: slot.id } });
    const message = error instanceof Error ? error.message : String(error);
    await db.agentSlot.update({ where: { id: slot.id }, data: { status: current.submissionStartedAt ? 'UNKNOWN' : error instanceof BrowserNeedsAttention || error instanceof ExtensionNeedsAttention ? 'WAITING_LOGIN' : 'BLOCKED', lastError: message } });
    if (current.submissionStartedAt) await pausePublicationAfterUncertain();
    throw new PermanentError(message);
  }
}
