import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { dataDir, rootDir, apiPort } from './config.js';

export const extensionSnapshotSchema = z.object({
  connectorVersion: z.number().int().min(1).max(5).default(1),
  url: z.url().max(2000), title: z.string().max(200),
  accountHandles: z.array(z.string().regex(/^[A-Za-z0-9_.]{1,24}$/)).max(12),
  profileLinks: z.array(z.string().regex(/^[A-Za-z0-9_.]{1,24}$/)).max(12).default([]),
  visibleHandles: z.array(z.string().regex(/^[A-Za-z0-9_.]{1,24}$/)).max(12).default([]),
  avatarImages: z.array(z.object({
    alt: z.string().max(80), parentTag: z.string().max(20), parentRole: z.string().max(40),
    parentAria: z.string().max(80), parentTitle: z.string().max(80), parentTestId: z.string().max(80),
    x: z.number().int(), y: z.number().int()
  })).max(16).default([]),
  fileInputs: z.number().int().min(0).max(20),
  postLinks: z.array(z.url().max(2000)).max(30),
  hasVideo: z.boolean(), captionMatches: z.boolean().default(false),
  postEnabled: z.boolean().default(false), alerts: z.array(z.string().max(300)).max(5).default([])
});
export type ExtensionSnapshot = z.infer<typeof extensionSnapshotSchema>;
export type ExtensionAction = 'INSPECT' | 'REVEAL_ACCOUNT' | 'NAVIGATE' | 'UPLOAD' | 'CAPTION' | 'READY' | 'SUBMIT' | 'VERIFY_POST';
export function validTikTokTab(value: string) {
  try { const url = new URL(value); return url.origin === 'https://www.tiktok.com'; } catch { return false; }
}
export function extensionIdentity(snapshot: ExtensionSnapshot, account: string, requireInput = true) {
  return validTikTokTab(snapshot.url) && new URL(snapshot.url).pathname.startsWith('/tiktokstudio') &&
    snapshot.accountHandles.length === 1 && snapshot.accountHandles[0].toLowerCase() === account.toLowerCase() && (!requireInput || snapshot.fileInputs > 0);
}
let keyPromise: Promise<string> | undefined;
export function extensionKey() {
  return keyPromise ||= (async () => {
    const directory = path.join(dataDir, 'runtime'); await mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'chrome-extension.key');
    try { const key = (await readFile(filename, 'utf8')).trim(); if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Chave local da extensão inválida.'); return key; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const key = randomBytes(32).toString('hex'); await writeFile(filename, key, { flag: 'wx', mode: 0o600 }); return key;
    }
  })();
}
export async function authenticExtension(authorization?: string) {
  const supplied = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return !!supplied && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(await extensionKey(), 'hex'));
}
export function extensionDirectory(account?: string) {
  return path.resolve(process.env.TOOLS_DIR || path.join(dataDir, '../tools'), account ? `chrome-extension-${account}` : 'chrome-extension');
}
export async function prepareExtension(account?: string) {
  const directory = extensionDirectory(account);
  await mkdir(directory, { recursive: true });
  for (const filename of ['manifest.json', 'background.js', 'connector.js', 'popup.html', 'popup.js', 'popup.css']) await copyFile(path.join(rootDir, 'extensions/chrome', filename), path.join(directory, filename));
  await writeFile(path.join(directory, 'config.js'), `export const API_BASE = ${JSON.stringify(`http://127.0.0.1:${apiPort}`)};\nexport const BRIDGE_TOKEN = ${JSON.stringify(await extensionKey())};\nexport const ACCOUNT_HANDLE = ${JSON.stringify(account || '')};\n`, { mode: 0o600 });
  return { directory, instructions: 'No Chrome habitual, abra chrome://extensions, ative Modo do desenvolvedor, clique em Carregar sem compactação e selecione esta pasta. Na aba de envio do TikTok, abra ViralFactory e clique em Conectar esta aba.' };
}
type Command = { id: string; action: ExtensionAction; args: Record<string, unknown>; expiresAt: number };
type Pending = { command: Command; connectionId: string; delivered: boolean; file?: string; authorize?: () => Promise<void>; beforeDelivery?: () => Promise<void>; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
export class ExtensionBridge {
  private connection?: { id: string; clientId: string; seenAt: number; snapshot: ExtensionSnapshot };
  private pending = new Map<string, Pending>();
  private claiming = false;
  connect(clientId: string, snapshot: ExtensionSnapshot) {
    if (snapshot.connectorVersion !== 5) throw Object.assign(new Error('Extensão antiga. Recarregue ViralFactory em chrome://extensions e atualize a aba do TikTok Studio.'), { statusCode: 409 });
    if (!validTikTokTab(snapshot.url)) throw Object.assign(new Error('Selecione uma aba de www.tiktok.com.'), { statusCode: 400 });
    if (this.connection && this.connection.clientId !== clientId && Date.now()-this.connection.seenAt < 90000) throw Object.assign(new Error('Outra extensão já está conectada. Desconecte-a no painel primeiro.'), { statusCode: 409 });
    if (this.connection?.clientId === clientId && this.connection.id) {
      this.connection.snapshot = snapshot; this.connection.seenAt = Date.now(); return this.connection.id;
    }
    this.disconnect();
    this.connection = { id: randomUUID(), clientId, seenAt: Date.now(), snapshot }; return this.connection.id;
  }
  snapshot() { return this.connection && Date.now()-this.connection.seenAt < 90000 ? this.connection.snapshot : undefined; }
  ownsConnection(id: string) { return this.connection?.id === id; }
  status(account: string) {
    const snapshot = this.snapshot();
    if (!snapshot) return { state: 'EXTENSION_OFFLINE', account: null, detail: 'Carregue a extensão no Chrome habitual e conecte a aba de envio do TikTok. Mantenha essa aba aberta.' };
    const matched = extensionIdentity(snapshot, account);
    return { state: matched ? 'CONNECTED' : 'NEEDS_ATTENTION', account: matched ? account : null, detail: matched ? 'Conta identificada pela extensão na aba selecionada. Publicação real ainda precisa de validação.' : 'Extensão conectada. Abra o envio do TikTok e deixe seu @ visível no cabeçalho ou menu de perfil para confirmar a conta.' };
  }
  private requireConnection(id: string) {
    if (!this.connection || id !== this.connection.id) throw Object.assign(new Error('Conexão expirou. Reconecte a aba pela extensão.'), { statusCode: 409 });
    return this.connection;
  }
  async poll(id: string, snapshot: ExtensionSnapshot) {
    const connection = this.requireConnection(id);
    if (snapshot.connectorVersion !== 5) { this.disconnect(); throw Object.assign(new Error('Extensão antiga. Recarregue a extensão.'), { statusCode: 409 }); }
    if (!validTikTokTab(snapshot.url)) { this.disconnect(); throw Object.assign(new Error('A aba saiu do TikTok.'), { statusCode: 409 }); }
    connection.snapshot = snapshot; connection.seenAt = Date.now();
    if (this.claiming) return null;
    this.claiming = true;
    try {
      const pending = [...this.pending.values()].find(value => value.connectionId === id && !value.delivered);
      if (!pending) return null;
      try { await pending.authorize?.(); await pending.beforeDelivery?.(); }
      catch (error) { this.fail(pending.command.id, error instanceof Error ? error : new Error(String(error))); return null; }
      if (!this.pending.has(pending.command.id) || pending.command.expiresAt <= Date.now() || this.connection?.id !== id) return null;
      pending.delivered = true; // Never redeliver a command, especially SUBMIT.
      return pending.command;
    } finally { this.claiming = false; }
  }
  request(action: ExtensionAction, args: Record<string, unknown>, signal: AbortSignal, options: { file?: string; authorize?: () => Promise<void>; beforeDelivery?: () => Promise<void>; timeout?: number } = {}) {
    signal.throwIfAborted();
    if (!this.snapshot() || !this.connection) return Promise.reject(new Error('Extensão desconectada. Reconecte a aba do TikTok.'));
    const id = randomUUID(), connectionId = this.connection.id, timeout = options.timeout || 90000;
    return new Promise<unknown>((resolve, reject) => {
      const aborted = () => this.fail(id, new Error('Comando cancelado.'));
      const timer = setTimeout(() => this.fail(id, new Error('A extensão não confirmou o comando no prazo. Confira a aba.')), timeout);
      this.pending.set(id, { command: { id, action, args, expiresAt: Date.now()+timeout }, connectionId, delivered: false, ...options, timer,
        resolve: value => { signal.removeEventListener('abort', aborted); resolve(value); }, reject: error => { signal.removeEventListener('abort', aborted); reject(error); } });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  async permit(connectionId: string, id: string) {
    this.requireConnection(connectionId);
    const pending = this.pending.get(id);
    if (!pending || !pending.delivered || pending.connectionId !== connectionId || pending.command.expiresAt <= Date.now()) throw Object.assign(new Error('Comando expirou ou foi cancelado.'), { statusCode: 409 });
    await pending.authorize?.();
  }
  result(connectionId: string, id: string, result: unknown, error?: string) {
    const connection = this.requireConnection(connectionId);
    const pending = this.pending.get(id);
    if (!pending) return; // Late acknowledgements cannot start or repeat anything.
    if (pending.connectionId !== connectionId || !pending.delivered) throw Object.assign(new Error('Comando não pertence a esta conexão.'), { statusCode: 409 });
    if (error) this.fail(id, new Error(error));
    else {
      const parsed = extensionSnapshotSchema.safeParse(result);
      if (!parsed.success || !validTikTokTab(parsed.data.url)) { this.fail(id, new Error('A extensão devolveu uma página ou resultado inválido.')); return; }
      connection.snapshot = parsed.data; connection.seenAt = Date.now();
      clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(parsed.data);
    }
  }
  async uploadFile(connectionId: string, id: string) {
    await this.permit(connectionId, id);
    const pending = this.pending.get(id);
    if (!pending || !pending.delivered || pending.connectionId !== connectionId || pending.command.action !== 'UPLOAD' || !pending.file) throw Object.assign(new Error('Arquivo não autorizado para este comando.'), { statusCode: 403 });
    const info = await stat(pending.file);
    if (info.size > 40*1024*1024) throw new Error('Vídeo excede o limite de 40 MB desta extensão.');
    return pending.file;
  }
  private fail(id: string, error: Error) { const pending = this.pending.get(id); if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); } }
  disconnect() { for (const id of this.pending.keys()) this.fail(id, new Error('Extensão desconectada.')); this.connection = undefined; }
}
export const extensionBridge = new ExtensionBridge();
const extraBridges = new Map<string, ExtensionBridge>();
export function bridgeForAccount(handle: string, primaryHandle: string) {
  if (handle.toLowerCase() === primaryHandle.toLowerCase()) return extensionBridge;
  const key = handle.toLowerCase();
  let bridge = extraBridges.get(key);
  if (!bridge) { bridge = new ExtensionBridge(); extraBridges.set(key, bridge); }
  return bridge;
}
export function bridgeForConnection(id: string) {
  if (extensionBridge.ownsConnection(id)) return extensionBridge;
  const bridge = [...extraBridges.values()].find(value => value.ownsConnection(id));
  if (!bridge) throw Object.assign(new Error('Conexão expirada. Reconecte a extensão.'), { statusCode: 409 });
  return bridge;
}
export function disconnectAllBridges() {
  extensionBridge.disconnect();
  for (const bridge of extraBridges.values()) bridge.disconnect();
}
