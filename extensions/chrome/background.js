import * as localConfig from './config.js';
const { API_BASE, BRIDGE_TOKEN } = localConfig;
const ACCOUNT_HANDLE = localConfig.ACCOUNT_HANDLE || '';

const base = new URL(API_BASE);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('A conexão da extensão deve ser local.');
let busy = false;
const allowedTab = value => { try { return new URL(value).origin === 'https://www.tiktok.com'; } catch { return false; } };
async function api(route, body) {
  const response = await fetch(`${API_BASE}/api/agent/extension/bridge/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), credentials: 'omit', cache: 'no-store'
  });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'O aplicativo local não respondeu.'); error.status = response.status; throw error; }
  return result;
}
async function tabMessage(tabId, message) {
  const tab = await chrome.tabs.get(tabId);
  if (!allowedTab(tab.url)) throw new Error('A aba selecionada saiu do TikTok. Conecte uma aba do TikTok novamente.');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['connector.js'] });
  const result = await chrome.tabs.sendMessage(tabId, { channel: 'viralfactory-local', ...message });
  if (!result || result.error) throw new Error(result?.error || 'A aba não respondeu.');
  return result.snapshot;
}
async function inspect(tabId, account, caption) { return tabMessage(tabId, { action: 'INSPECT', account, caption }); }
async function connect(tabId, existingClientId) {
  const config = await api(`configuration${ACCOUNT_HANDLE ? `?account=${encodeURIComponent(ACCOUNT_HANDLE)}` : ''}`);
  const snapshot = await inspect(tabId, config.account);
  const clientId = existingClientId || crypto.randomUUID();
  const result = await api('connect', { clientId, account: ACCOUNT_HANDLE || undefined, snapshot });
  await chrome.storage.session.set({ tabId, clientId, connectionId: result.connectionId, account: result.account, detail: 'Aba conectada. Confira a identificação da conta no painel.', receipts: [] });
  await chrome.alarms.create('viralfactory-heartbeat', { periodInMinutes: 0.5 });
  return result;
}
async function execute(tabId, connectionId, command) {
  if (!command || command.expiresAt <= Date.now()) throw new Error('Comando expirou antes de executar.');
  const actions = ['INSPECT', 'REVEAL_ACCOUNT', 'NAVIGATE', 'UPLOAD', 'CAPTION', 'READY', 'SUBMIT', 'VERIFY_POST'];
  if (!actions.includes(command.action)) throw new Error('Comando não reconhecido.');
  const state = await chrome.storage.session.get('connectionId');
  if (state.connectionId !== connectionId) throw new Error('A aba foi desconectada.');
  await api('permit', { connectionId, commandId: command.id });
  const args = command.args || {};
  if (['NAVIGATE', 'VERIFY_POST'].includes(command.action)) {
    const url = new URL(args.url);
    const expected = command.action === 'NAVIGATE' ? url.href === 'https://www.tiktok.com/tiktokstudio/upload' :
      url.origin === 'https://www.tiktok.com' && new RegExp(`^/@${String(args.account).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/video/\\d+$`, 'i').test(url.pathname);
    if (!expected) throw new Error('Navegação não autorizada.');
    const tab = await chrome.tabs.get(tabId);
    if (!allowedTab(tab.url)) throw new Error('A aba selecionada não está no TikTok.');
    await chrome.tabs.update(tabId, { url: url.href });
    const deadline = Math.min(command.expiresAt, Date.now()+60000);
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tabId);
      if (!allowedTab(current.url)) throw new Error('A navegação saiu do TikTok.');
      if (current.status === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  let fileBase64;
  if (command.action === 'UPLOAD') {
    const response = await fetch(`${API_BASE}/api/agent/extension/bridge/file/${encodeURIComponent(command.id)}?connectionId=${encodeURIComponent(connectionId)}`, {
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}` }, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error('O aplicativo não autorizou o arquivo do vídeo.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 40*1024*1024 || !bytes.length) throw new Error('Arquivo inválido ou maior que 40 MB.');
    const parts = []; for (let index = 0; index < bytes.length; index += 32768) parts.push(String.fromCharCode(...bytes.subarray(index, index+32768)));
    fileBase64 = btoa(parts.join(''));
  }
  if ((await chrome.storage.session.get('connectionId')).connectionId !== connectionId) throw new Error('A aba foi desconectada durante o preparo.');
  await api('permit', { connectionId, commandId: command.id });
  return tabMessage(tabId, { action: command.action, ...args, expiresAt: command.expiresAt, commandId: command.id, fileBase64 });
}
async function tick() {
  if (busy) return;
  busy = true;
  try {
    let state = await chrome.storage.session.get(['tabId', 'connectionId', 'clientId', 'account', 'receipts']);
    if (!Number.isInteger(state.tabId) || !state.connectionId) return;
    for (const receipt of state.receipts || []) {
      try { await api('result', { connectionId: state.connectionId, ...receipt }); }
      catch (error) { if (error.status !== 409) throw error; await connect(state.tabId, state.clientId); return; }
      await chrome.storage.session.set({ receipts: (await chrome.storage.session.get('receipts')).receipts.filter(value => value.commandId !== receipt.commandId) });
    }
    const snapshot = await inspect(state.tabId, state.account);
    let command;
    try { ({ command } = await api('heartbeat', { connectionId: state.connectionId, snapshot })); }
    catch (error) {
      if (error.status !== 409) throw error;
      await connect(state.tabId, state.clientId); // Reuse only the user-selected tab; never log in.
      return;
    }
    if (command) {
      const keepAlive = setInterval(() => void chrome.tabs.get(state.tabId).catch(() => {}), 20000);
      let receipt;
      try { receipt = { commandId: command.id, result: await execute(state.tabId, state.connectionId, command) }; }
      catch (error) { receipt = { commandId: command.id, error: String(error.message || error).slice(0, 600) }; }
      finally { clearInterval(keepAlive); }
      await chrome.storage.session.set({ receipts: [receipt] });
      await api('result', { connectionId: state.connectionId, ...receipt });
      await chrome.storage.session.set({ receipts: [], detail: receipt.error || 'Aba conectada ao aplicativo local.' });
    } else await chrome.storage.session.set({ detail: 'Aba conectada ao aplicativo local.' });
  } catch (error) { await chrome.storage.session.set({ detail: String(error.message || error).slice(0, 600) }); }
  finally { busy = false; }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab || !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) return;
  const run = async () => {
    if (message.action === 'CONNECT') {
      if (busy) throw new Error('A conexão está processando um comando. Aguarde antes de conectar outra aba.');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !allowedTab(tab.url)) throw new Error('Abra a aba do TikTok e clique novamente na extensão.');
      const previous = await chrome.storage.session.get(['tabId', 'clientId']);
      await connect(tab.id, previous.tabId === tab.id ? previous.clientId : undefined); void tick(); return { ok: true };
    }
    if (message.action === 'DISCONNECT') {
      const { connectionId } = await chrome.storage.session.get('connectionId');
      try { if (connectionId) await api('disconnect', { connectionId }); }
      finally { await chrome.storage.session.remove(['connectionId', 'tabId', 'receipts']); await chrome.alarms.clear('viralfactory-heartbeat'); }
      return { ok: true };
    }
    if (message.action === 'STATUS') return { ...await chrome.storage.session.get(['tabId', 'detail', 'connectionId', 'account']), configuredAccount: ACCOUNT_HANDLE };
    throw new Error('Ação não reconhecida.');
  };
  run().then(sendResponse).catch(error => sendResponse({ error: String(error.message || error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'viralfactory-heartbeat') void tick(); });
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('viralfactory-heartbeat', { periodInMinutes: 0.5 }); });
setInterval(() => void tick(), 5000); // Alarms also resume the worker after suspension.
