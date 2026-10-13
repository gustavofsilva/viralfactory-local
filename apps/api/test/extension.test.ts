import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionBridge, extensionSnapshotSchema, extensionIdentity, validTikTokTab, extensionKey, bridgeForAccount, bridgeForConnection, extensionBridge } from '../src/extension-bridge.js';
import { buildApp } from '../src/app.js';
import { readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../src/config.js';
import { publishByExtension } from '../src/extension-publisher.js';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const snapshot = extensionSnapshotSchema.parse({ connectorVersion: 5, url: 'https://www.tiktok.com/tiktokstudio/upload', title: 'Fixture de teste', accountHandles: ['conta_teste'], fileInputs: 1, postLinks: [], hasVideo: false });
test('perfis adicionais usam pontes isoladas da conta principal e entre si', () => {
  const first = bridgeForAccount('canal_um', 'brasilgerais');
  const second = bridgeForAccount('canal_dois', 'brasilgerais');
  assert.equal(bridgeForAccount('brasilgerais', 'brasilgerais'), extensionBridge);
  assert.notEqual(first, second);
  assert.notEqual(first, extensionBridge);
  const one = first.connect('fixture-canal-um', { ...snapshot, accountHandles: ['canal_um'] });
  const two = second.connect('fixture-canal-dois', { ...snapshot, accountHandles: ['canal_dois'] });
  assert.equal(bridgeForConnection(one), first);
  assert.equal(bridgeForConnection(two), second);
  first.disconnect();
  assert.equal(second.status('canal_dois').state, 'CONNECTED');
  second.disconnect();
});
test('publicador por extensão preserva a tela aberta e registra intenção antes do clique', async () => {
  const bridge = new ExtensionBridge(), connection = bridge.connect('publisher-fixture-client', snapshot);
  const directory = await mkdtemp(path.join(dataDir, 'extension-publish-test-'));
  const controller = new AbortController(); let finished = false, intents = 0, current = { ...snapshot };
  const actions: string[] = [], postUrl = 'https://www.tiktok.com/@conta_teste/video/123';
  const promise = publishByExtension({ file: 'fixture.mp4', caption: 'Legenda de teste', account: 'conta_teste', evidenceDirectory: directory, signal: controller.signal,
    authorize: async () => {}, beforeSubmit: async () => { intents++; }, confirmCaptionPersistence: async () => true }, bridge).finally(() => { finished = true; });
  try {
    while (!finished) {
      const command = await bridge.poll(connection, current);
      if (!command) { await new Promise(resolve => setTimeout(resolve, 1)); continue; }
      actions.push(command.action);
      if (command.action === 'CAPTION') current = { ...current, captionMatches: true };
      if (command.action === 'READY') current = { ...current, postEnabled: true };
      if (command.action === 'SUBMIT') { assert.equal(intents, 1); current = { ...current, postLinks: [postUrl] }; }
      if (command.action === 'VERIFY_POST') current = { ...current, url: postUrl, hasVideo: true };
      bridge.result(connection, command.id, current);
    }
    assert.equal((await promise).postUrl, postUrl);
    assert.deepEqual(actions, ['INSPECT', 'REVEAL_ACCOUNT', 'UPLOAD', 'CAPTION', 'READY', 'SUBMIT', 'VERIFY_POST']);
    assert.equal(intents, 1);
  } finally {
    controller.abort(); bridge.disconnect(); await promise.catch(() => {});
    for (const file of ['extension-before-submit.json', 'extension-confirmed-post.json', 'extension-unconfirmed-submit.json']) await unlink(path.join(directory, file)).catch(() => {});
    await rmdir(directory);
  }
});
test('legenda não verificada aceita somente post observado após um único envio', async () => {
  const bridge = new ExtensionBridge(), connection = bridge.connect('source-only-fixture-client', snapshot);
  const directory = await mkdtemp(path.join(dataDir, 'extension-source-test-'));
  const controller = new AbortController(); let finished = false, intents = 0, current = { ...snapshot };
  const actions: string[] = [], postUrl = 'https://www.tiktok.com/@conta_teste/video/456';
  const promise = publishByExtension({ file: 'fixture.mp4', caption: 'Fonte: tse.jus.br', account: 'conta_teste', evidenceDirectory: directory, signal: controller.signal,
    authorize: async () => {}, beforeSubmit: async () => { intents++; }, allowUnverifiedCaption: true }, bridge).finally(() => { finished = true; });
  try {
    while (!finished) {
      const command = await bridge.poll(connection, current);
      if (!command) { await new Promise(resolve => setTimeout(resolve, 1)); continue; }
      actions.push(command.action);
      if (command.action === 'CAPTION') current = { ...current, captionMatches: true };
      if (command.action === 'READY') current = { ...current, postEnabled: true };
      if (command.action === 'SUBMIT') current = { ...current, url: postUrl, postLinks: [postUrl], hasVideo: true };
      bridge.result(connection, command.id, current);
    }
    assert.deepEqual(await promise, { postUrl, captionVerified: false });
    assert.equal(intents, 1);
    assert.deepEqual(actions, ['INSPECT', 'REVEAL_ACCOUNT', 'UPLOAD', 'CAPTION', 'READY', 'SUBMIT']);
  } finally {
    controller.abort(); bridge.disconnect(); await promise.catch(() => {});
    for (const file of ['extension-before-submit.json', 'extension-post-unverified-caption.json']) await unlink(path.join(directory, file)).catch(() => {});
    await rmdir(directory);
  }
});
test('lista de conteúdo confirma post novo sem exigir legenda persistida', async () => {
  const bridge = new ExtensionBridge(), connection = bridge.connect('content-fixture-client', snapshot);
  const directory = await mkdtemp(path.join(dataDir, 'extension-content-test-'));
  const controller = new AbortController(); let finished = false, intents = 0, current = { ...snapshot };
  const oldUrl = 'https://www.tiktok.com/@conta_teste/video/123';
  const postUrl = `https://www.tiktok.com/@conta_teste/video/${(BigInt(Math.floor(Date.now()/1000)) << 32n) + 123n}`;
  const promise = publishByExtension({ file: 'fixture.mp4', caption: 'Fonte: TSE', account: 'conta_teste', evidenceDirectory: directory, signal: controller.signal,
    authorize: async () => {}, beforeSubmit: async () => { intents++; }, allowUnverifiedCaption: true, knownPostLinks: [oldUrl] }, bridge).finally(() => { finished = true; });
  try {
    while (!finished) {
      const command = await bridge.poll(connection, current);
      if (!command) { await new Promise(resolve => setTimeout(resolve, 1)); continue; }
      if (command.action === 'CAPTION') current = { ...current, captionMatches: true };
      if (command.action === 'READY') current = { ...current, postEnabled: true };
      if (command.action === 'SUBMIT') current = { ...current, url: 'https://www.tiktok.com/tiktokstudio/content', postLinks: [postUrl, oldUrl], hasVideo: false };
      bridge.result(connection, command.id, current);
    }
    assert.deepEqual(await promise, { postUrl, captionVerified: false });
    assert.equal(intents, 1);
  } finally {
    controller.abort(); bridge.disconnect(); await promise.catch(() => {});
    for (const file of ['extension-before-submit.json', 'extension-content-confirmed.json']) await unlink(path.join(directory, file)).catch(() => {});
    await rmdir(directory);
  }
});
test('sem prova de persistência da legenda nenhum comando chega à extensão', async () => {
  const bridge = new ExtensionBridge(), connection = bridge.connect('caption-safety-fixture', snapshot);
  let intents = 0;
  await assert.rejects(publishByExtension({ file: 'fixture.mp4', caption: 'Legenda correta', account: 'conta_teste',
    evidenceDirectory: dataDir, signal: new AbortController().signal,
    authorize: async () => {}, beforeSubmit: async () => { intents++; } }, bridge), /Envio automático pausado/);
  assert.equal(await bridge.poll(connection, snapshot), null);
  assert.equal(intents, 0);
  bridge.disconnect();
});
test('extensão confirma somente conta exata na tela de envio autorizada', () => {
  assert.equal(extensionIdentity(snapshot, 'conta_teste'), true);
  assert.equal(extensionIdentity(snapshot, 'conta'), false);
  assert.equal(extensionIdentity({ ...snapshot, url: 'https://example.com/tiktokstudio/upload' }, 'conta_teste'), false);
  assert.equal(extensionIdentity({ ...snapshot, url: 'https://www.tiktok.com/login', fileInputs: 0 }, 'conta_teste'), false);
  assert.equal(validTikTokTab('https://www.tiktok.com.evil.test/'), false);
});
test('ponte recusa uma instância antiga antes de reservar a conexão', () => {
  const bridge = new ExtensionBridge();
  assert.throws(() => bridge.connect('old-fixture-client', { ...snapshot, connectorVersion: 1 }), /Extensão antiga/);
  assert.equal(bridge.connect('current-fixture-client', snapshot).length > 0, true);
});
test('comando de publicação é entregue uma vez, com autorização antes da entrega', async () => {
  const bridge = new ExtensionBridge(); const connection = bridge.connect('fixture-client-one', snapshot); let authorized = 0;
  const result = bridge.request('SUBMIT', { account: 'conta_teste' }, new AbortController().signal, { authorize: async () => { authorized++; } });
  const command = await bridge.poll(connection, snapshot);
  assert.ok(command); assert.equal(command.action, 'SUBMIT');
  assert.equal(await bridge.poll(connection, snapshot), null);
  assert.equal(authorized, 1);
  bridge.result(connection, command.id, { ...snapshot, postLinks: ['https://www.tiktok.com/@conta_teste/video/123'] });
  assert.deepEqual((await result as typeof snapshot).postLinks, ['https://www.tiktok.com/@conta_teste/video/123']);
  bridge.result(connection, command.id, snapshot); // Late acknowledgement has no new side effect.
  assert.equal(await bridge.poll(connection, snapshot), null);
  bridge.disconnect();
});
test('pausar antes da entrega e cancelar comandos impede ações na aba', async () => {
  const bridge = new ExtensionBridge(); const connection = bridge.connect('fixture-client-two', snapshot);
  const denied = bridge.request('UPLOAD', {}, new AbortController().signal, { authorize: async () => { throw new Error('Publicação pausada'); } });
  const rejected = assert.rejects(denied, /pausada/);
  assert.equal(await bridge.poll(connection, snapshot), null); await rejected;
  const controller = new AbortController(); const aborted = bridge.request('SUBMIT', {}, controller.signal);
  const canceled = assert.rejects(aborted, /cancelado/); controller.abort(); await canceled;
  assert.equal(await bridge.poll(connection, snapshot), null);
  bridge.disconnect();
});
test('permissão é conferida novamente após entrega sem repetir a intenção de envio', async () => {
  const bridge = new ExtensionBridge(); const connection = bridge.connect('fixture-client-permit', snapshot);
  let allowed = true, intents = 0;
  const promise = bridge.request('SUBMIT', {}, new AbortController().signal, { authorize: async () => { if (!allowed) throw new Error('Pausado'); }, beforeDelivery: async () => { intents++; } });
  const rejected = assert.rejects(promise, /desconectada/);
  const command = await bridge.poll(connection, snapshot); assert.ok(command);
  await bridge.permit(connection, command.id); assert.equal(intents, 1);
  allowed = false; await assert.rejects(bridge.permit(connection, command.id), /Pausado/);
  assert.equal(intents, 1); bridge.disconnect(); await rejected;
});
test('conexão diferente não pode obter arquivo ou confirmar comando pendente', async () => {
  const bridge = new ExtensionBridge(); const connection = bridge.connect('fixture-client-three', snapshot);
  const result = bridge.request('UPLOAD', {}, new AbortController().signal);
  const rejected = assert.rejects(result, /desconectada/);
  const command = await bridge.poll(connection, snapshot); assert.ok(command);
  await assert.rejects(bridge.uploadFile('wrong-connection', command.id), /expirou/);
  assert.throws(() => bridge.result('wrong-connection', command.id, snapshot), /expirou/);
  assert.throws(() => bridge.connect('different-fixture-client', snapshot), /Outra extensão/);
  bridge.disconnect(); await rejected;
});
test('origem de site e token incorreto não acessam a ponte da extensão', async () => {
  const app = await buildApp();
  try {
    const endpoint = '/api/agent/extension/bridge/configuration';
    assert.equal((await app.inject({ method: 'GET', url: endpoint })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: endpoint, headers: { authorization: `Bearer ${'0'.repeat(64)}` } })).statusCode, 401);
    const authorization = `Bearer ${await extensionKey()}`;
    assert.equal((await app.inject({ method: 'GET', url: endpoint, headers: { authorization, origin: 'https://www.tiktok.com' } })).statusCode, 403);
    const origin = `chrome-extension://${'a'.repeat(32)}`;
    assert.equal((await app.inject({ method: 'GET', url: endpoint, headers: { authorization, origin } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization, origin, 'content-type': 'application/json' }, payload: '{}' })).statusCode, 403);
  } finally { await app.close(); }
});
test('worker da extensão reenvia só o recibo após falha de rede, sem clicar outra vez', async () => {
  const bridge = new ExtensionBridge(); let listener: Function; let submitted = 0, failReceipt = true;
  const memory: Record<string, any> = {};
  const runtimeId = 'a'.repeat(32);
  const context = vm.createContext({ URL, AbortSignal, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, crypto: { randomUUID }, btoa,
    fetch: async (address: string, options: { body?: string } = {}) => {
      const route = new URL(address).pathname.split('/').at(-1);
      const body = JSON.parse(options.body || '{}'); let result: unknown;
      if (route === 'configuration') result = { account: 'conta_teste' };
      else if (route === 'connect') result = { connectionId: bridge.connect(body.clientId, body.snapshot), account: 'conta_teste' };
      else if (route === 'heartbeat') result = { command: await bridge.poll(body.connectionId, body.snapshot) };
      else if (route === 'permit') { await bridge.permit(body.connectionId, body.commandId); result = { ok: true }; }
      else if (route === 'result') {
        if (failReceipt) { failReceipt = false; throw new Error('Falha simulada de rede'); }
        bridge.result(body.connectionId, body.commandId, body.result, body.error); result = { ok: true };
      } else throw new Error('Endpoint inesperado no teste');
      return { ok: true, json: async () => result };
    },
    chrome: {
      storage: { session: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, memory[key]])), set: async (value: object) => Object.assign(memory, value), remove: async (keys: string[]) => keys.forEach(key => delete memory[key]) } },
      runtime: { id: runtimeId, getURL: (filename: string) => `chrome-extension://${runtimeId}/${filename}`, onMessage: { addListener: (value: Function) => { listener = value; } }, onStartup: { addListener: () => {} } },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } },
      tabs: { query: async () => [{ id: 7, url: snapshot.url }], get: async () => ({ id: 7, url: snapshot.url }), sendMessage: async (_: number, message: { action: string }) => { if (message.action === 'SUBMIT') submitted++; return { snapshot }; } },
      scripting: { executeScript: async () => {} }
    }
  });
  const source = (await readFile('extensions/chrome/background.js', 'utf8')).replace(/^import .*?;\s*/, "const localConfig = { API_BASE: 'http://127.0.0.1:4310', BRIDGE_TOKEN: 'fixture-key', ACCOUNT_HANDLE: '' };\n");
  vm.runInContext(source, context);
  await new Promise(resolve => listener!({ action: 'CONNECT' }, { id: runtimeId, url: `chrome-extension://${runtimeId}/popup.html` }, resolve));
  await vm.runInContext('(async () => { while (busy) await new Promise(r => setTimeout(r, 1)); })()', context);
  const result = bridge.request('SUBMIT', {}, new AbortController().signal);
  await vm.runInContext('tick()', context);
  assert.equal(submitted, 1); assert.equal(memory.receipts.length, 1);
  await vm.runInContext('tick()', context); await result;
  assert.equal(submitted, 1); assert.equal(memory.receipts.length, 0);
  bridge.disconnect();
});
