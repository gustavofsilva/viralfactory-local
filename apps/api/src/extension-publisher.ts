import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extensionBridge, extensionSnapshotSchema, extensionIdentity, type ExtensionBridge } from './extension-bridge.js';
import { observedPostLinks } from './tiktok-browser.js';

export class ExtensionNeedsAttention extends Error {}
export async function publishByExtension(options: {
  file: string; caption: string; account: string; evidenceDirectory: string; signal: AbortSignal;
  beforeSubmit: () => Promise<void>; authorize: () => Promise<void>;
  confirmCaptionPersistence?: () => Promise<boolean>;
  allowUnverifiedCaption?: boolean;
  knownPostLinks?: string[];
}, bridge: ExtensionBridge = extensionBridge) {
  // The account owner may explicitly accept a source-only caption whose
  // persistence cannot be checked before clicking Publish.
  if (!options.confirmCaptionPersistence && !options.allowUnverifiedCaption) throw new ExtensionNeedsAttention('Envio automático pausado: o TikTok ignorou a legenda no teste real. A extensão ainda não consegue confirmar que a legenda foi salva pelo site antes de publicar.');
  const command = async (action: Parameters<typeof extensionBridge.request>[0], args: Record<string, unknown> = {}, extra: { file?: string; beforeDelivery?: () => Promise<void> } = {}) => {
    try {
      const result = await bridge.request(action, { account: options.account, ...args }, options.signal,
        { authorize: options.authorize, ...extra });
      return extensionSnapshotSchema.parse(result);
    } catch (error) { throw new ExtensionNeedsAttention(error instanceof Error ? error.message : String(error)); }
  };
  const current = await command('INSPECT');
  if (new URL(current.url).pathname !== '/tiktokstudio/upload') await command('NAVIGATE', { url: 'https://www.tiktok.com/tiktokstudio/upload' });
  const initial = await command('REVEAL_ACCOUNT');
  if (!extensionIdentity(initial, options.account)) throw new ExtensionNeedsAttention('A extensão não confirmou a conta na tela de envio. Abra o menu de perfil para exibir seu @.');
  const oldLinks = new Set(observedPostLinks([...initial.postLinks, ...(options.knownPostLinks || [])], options.account));
  const filename = `brasil-gerais-${options.caption.split(/\r?\n/, 1)[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70)}.mp4`;
  await command('UPLOAD', { filename }, { file: options.file });
  await command('CAPTION', { caption: options.caption });
  const ready = await command('READY', { caption: options.caption });
  if (!extensionIdentity(ready, options.account, false) || !ready.captionMatches || !ready.postEnabled) throw new ExtensionNeedsAttention('A aba não confirmou conta, legenda e botão de publicação. Confira o TikTok.');
  if (options.confirmCaptionPersistence && !await options.confirmCaptionPersistence()) throw new ExtensionNeedsAttention('O TikTok não confirmou que salvou a legenda. O vídeo não foi publicado.');
  await mkdir(options.evidenceDirectory, { recursive: true });
  await writeFile(path.join(options.evidenceDirectory, 'extension-before-submit.json'), JSON.stringify(ready, null, 2));
  let started = false;
  let submittedAt = 0;
  let submitted;
  try {
    submitted = await command('SUBMIT', { caption: options.caption }, { beforeDelivery: async () => { await options.beforeSubmit(); submittedAt = Date.now(); started = true; } });
  } catch (error) {
    if (!started) throw error;
    submitted = bridge.snapshot();
    if (!submitted) throw error;
  }
  const deadline = Date.now()+120000;
  let snapshot = submitted;
  while (Date.now() < deadline) {
    options.signal.throwIfAborted();
    const postUrl = observedPostLinks([...snapshot.postLinks, snapshot.url], options.account).find(value => !oldLinks.has(value));
    if (postUrl && options.allowUnverifiedCaption && snapshot.hasVideo && new URL(snapshot.url).pathname === new URL(postUrl).pathname) {
      await writeFile(path.join(options.evidenceDirectory, 'extension-post-unverified-caption.json'), JSON.stringify(snapshot, null, 2));
      return { postUrl, captionVerified: false };
    }
    if (postUrl && options.allowUnverifiedCaption && new URL(snapshot.url).pathname === '/tiktokstudio/content' && observedPostLinks(snapshot.postLinks.slice(0, 1), options.account)[0] === postUrl) {
      const identifier = postUrl.split('/').at(-1)!;
      const postedAt = Number(BigInt(identifier) >> 32n) * 1000;
      if (postedAt >= submittedAt - 120000 && postedAt <= Date.now() + 60000) {
        await writeFile(path.join(options.evidenceDirectory, 'extension-content-confirmed.json'), JSON.stringify(snapshot, null, 2));
        return { postUrl, captionVerified: false };
      }
    }
    if (postUrl && !options.allowUnverifiedCaption) {
      const verified = await command('VERIFY_POST', { url: postUrl, caption: options.caption });
      if (observedPostLinks([verified.url], options.account)[0] !== postUrl || !verified.hasVideo || !verified.captionMatches) throw new ExtensionNeedsAttention('A página encontrada não confirmou o vídeo e a legenda. Confira o resultado manualmente.');
      await writeFile(path.join(options.evidenceDirectory, 'extension-confirmed-post.json'), JSON.stringify(verified, null, 2));
      return { postUrl, captionVerified: true };
    }
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(new Error('Conferência cancelada.')); };
      const timer = setTimeout(() => { options.signal.removeEventListener('abort', aborted); resolve(); }, 2000);
      options.signal.addEventListener('abort', aborted, { once: true });
      if (options.signal.aborted) aborted();
    });
    snapshot = await command('INSPECT');
  }
  await writeFile(path.join(options.evidenceDirectory, 'extension-unconfirmed-submit.json'), JSON.stringify(snapshot, null, 2));
  throw new ExtensionNeedsAttention('Envio iniciado sem URL verificável. Confira sua conta; o agente não repetirá a publicação.');
}
