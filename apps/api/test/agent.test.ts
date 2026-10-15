import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agentSettingsSchema, scriptSchema } from '@viralfactory/shared';
import { createDb, getSettings, type Db } from '../src/db.js';
import { dataDir, rootDir } from '../src/config.js';
import { tickAgent, localDay, scheduledInstant, isAutomaticallyPublishable, isHourlyCampaignAt, getAgentSettings, publicationTimesForDay, publicationLimitForDay } from '../src/agent.js';
import { visibleAccountMatches, observedPostLinks, publicationCaption } from '../src/tiktok-browser.js';
import { productionRevision } from '../src/production.js';
import { narrationScenes, chooseEvidence } from '../src/script-compose.js';
import { Worker, PermanentError } from '../src/queue.js';
import { sensitiveText, scriptRisk } from '../src/content-risk.js';

test('pauta geral ignora manchetes relacionadas no filtro inicial', async () => fixture(async client => {
  const now = new Date('2026-10-13T13:30:00.000Z');
  const settings = agentSettingsSchema.parse({ enabled: true, topicFocus: 'elections', hourlyStartAt: '2026-10-13T04:00:00.000Z', hourlyEndAt: '2026-10-15T03:00:00.000Z' });
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(settings) } });
  const summary = `${'A equipe venceu a rodada em casa. '.repeat(15)} Notícias relacionadas: A Justiça Eleitoral anuncia calendário.`;
  await client.trend.create({ data: { fingerprint: 'sports-related-headlines', title: 'Equipe vence rodada do campeonato', summary, category: 'Esportes', publishedAt: now, observations: { create: { sourceName: 'Agência de teste', sourceUrl: 'https://example.com/feed', articleUrl: 'https://example.com/sports', summary, publishedAt: now, bucket: 'test' } } } });
  await tickAgent({ client, now });
  const slot = await client.agentSlot.findUniqueOrThrow({ where: { slotKey: '2026-10-13:11:00' } });
  assert.equal(slot.status, 'GENERATING');
  assert.ok(slot.videoId);
}));

async function fixture(run: (client: Db, reopened: Db) => Promise<void>) {
  const directory = await mkdtemp(path.join(dataDir, 'agent-test-'));
  const filename = path.join(directory, 'test.db');
  const native = new DatabaseSync(filename);
  for (const migration of (await readdir(path.join(rootDir, 'apps/api/prisma/migrations'))).filter(value => !value.endsWith('.toml')).sort()) native.exec(await readFile(path.join(rootDir, 'apps/api/prisma/migrations', migration, 'migration.sql'), 'utf8'));
  native.close();
  const client = createDb(`file:${filename.replaceAll('\\', '/')}`), reopened = createDb(`file:${filename.replaceAll('\\', '/')}`);
  try { await run(client, reopened); }
  finally { await client.$disconnect(); await reopened.$disconnect(); for (const suffix of ['', '-wal', '-shm', '-journal']) await unlink(filename+suffix).catch(() => {}); await rmdir(directory); }
}
const script = scriptSchema.parse({ origin: 'ollama', title: 'Um assunto verificável', hook: 'Vamos conhecer este assunto?', narration: 'Uma narração original de teste com evidências verificáveis na fonte fornecida.', description: 'Uma descrição suficiente para testar a política.', hashtags: [], coverText: 'Assunto', scenes: [{ text: 'Uma narração original.', visualQuery: 'graphics' }], sourceUrls: ['https://example.com/source'], claims: [{ text: 'Um fato na fonte', sourceUrl: 'https://example.com/source', evidence: 'O trecho original que sustenta esse fato.' }], risk: 'normal', estimatedDurationSeconds: 40 });
test('dois horários de São Paulo respeitam virada de dia em UTC', () => {
  assert.equal(localDay(new Date('2026-10-12T01:00:00Z')), '2026-10-11');
  assert.equal(scheduledInstant('2026-10-12', '12:00').toISOString(), '2026-10-12T15:00:00.000Z');
  assert.equal(scheduledInstant('2026-10-12', '19:00').toISOString(), '2026-10-12T22:00:00.000Z');
  assert.equal(agentSettingsSchema.safeParse({ times: ['12:00', '12:00'] }).success, false);
});
test('horários extras e limite maior valem somente no dia autorizado', () => {
  const settings = agentSettingsSchema.parse({ extraPublicationDay: '2026-10-12', extraPublicationTimes: ['18:30', '21:00'], extraPublicationCount: 1 });
  assert.deepEqual(publicationTimesForDay(settings, '2026-10-12'), ['12:00', '19:00', '18:30', '21:00']);
  assert.equal(publicationLimitForDay(settings, '2026-10-12'), 3);
  assert.deepEqual(publicationTimesForDay(settings, '2026-10-13'), ['12:00', '19:00']);
  assert.equal(publicationLimitForDay(settings, '2026-10-13'), 2);
});

test('agenda por hora cobre apenas a janela solicitada e volta a dois horários depois', () => {
  const settings = agentSettingsSchema.parse({ hourlyStartAt: '2026-10-13T04:00:00.000Z', hourlyEndAt: '2026-10-15T03:00:00.000Z' });
  assert.deepEqual(publicationTimesForDay(settings, '2026-10-13'), Array.from({ length: 23 }, (_, index) => `${String(index + 1).padStart(2, '0')}:00`));
  assert.equal(publicationLimitForDay(settings, '2026-10-13'), 23);
  assert.equal(publicationTimesForDay(settings, '2026-10-14').length, 24);
  assert.equal(publicationLimitForDay(settings, '2026-10-14'), 24);
  assert.deepEqual(publicationTimesForDay(settings, '2026-10-15'), ['12:00', '19:00']);
  assert.equal(publicationLimitForDay(settings, '2026-10-15'), 2);
  assert.equal(agentSettingsSchema.safeParse({ hourlyStartAt: '2026-10-13T04:00:00.000Z' }).success, false);
});
test('retomar agente preserva dois horários sem duplicar tarefas de pesquisa', async () => fixture(async (client, reopened) => {
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(agentSettingsSchema.parse({ enabled: true })) } });
  const now = new Date('2026-10-12T10:00:00Z');
  await tickAgent({ client, now }); await tickAgent({ client: reopened, now });
  assert.equal(await reopened.agentSlot.count(), 2);
  assert.equal(await reopened.job.count({ where: { kind: 'DISCOVER' } }), 1);
}));

test('agenda temporária grava os 47 horários sem criar posts duplicados', async () => fixture(async (client, reopened) => {
  const settings = agentSettingsSchema.parse({ enabled: true, hourlyStartAt: '2026-10-13T04:00:00.000Z', hourlyEndAt: '2026-10-15T03:00:00.000Z' });
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(settings) } });
  const now = new Date('2026-10-13T03:30:00.000Z');
  await tickAgent({ client, now });
  await tickAgent({ client: reopened, now });
  assert.equal(await reopened.agentSlot.count(), 47);
  assert.equal(await reopened.agentSlot.count({ where: { slotKey: '2026-10-14:23:00' } }), 1);
}));

test('teste de três posts cria um envio por vez e depois agenda cada hora', async () => fixture(async (client, reopened) => {
  const now = new Date('2026-10-15T03:30:00.000Z');
  const settings = agentSettingsSchema.parse({ enabled: true, publicationEnabled: true, accountHandle: 'brasilgerais', continuousHourly: true, autoPublishNormal: true, autoPublishSensitive: true, burstRunId: 'fb3b6cf7-e482-4c5c-b9e1-a05f57f243a9', burstTarget: 3, burstSuccesses: 0 });
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(settings) } });
  assert.deepEqual(publicationTimesForDay(settings, '2026-10-15'), []);
  await tickAgent({ client, now });
  await tickAgent({ client: reopened, now });
  assert.equal(await reopened.agentSlot.count({ where: { slotKey: { startsWith: `burst:${settings.burstRunId}:` } } }), 1);
  const first = await reopened.agentSlot.findFirstOrThrow({ where: { slotKey: { startsWith: `burst:${settings.burstRunId}:` } } });
  await reopened.agentSlot.update({ where: { id: first.id }, data: { status: 'BLOCKED' } });
  await tickAgent({ client: reopened, now });
  assert.equal(await reopened.agentSlot.count({ where: { slotKey: { startsWith: `burst:${settings.burstRunId}:` } } }), 2);
  const finished = { ...settings, burstSuccesses: 3, hourlyResumeAt: '2026-10-15T04:30:00.000Z' };
  assert.deepEqual(publicationTimesForDay(finished, '2026-10-15').slice(0, 2), ['01:30', '02:30']);
  assert.equal(publicationTimesForDay(finished, '2026-10-14').length, 0);
  assert.equal(publicationLimitForDay(finished, '2026-10-15'), 30);
}));

test('teste encontra matéria sobre urnas e 2º turno em fonte completa', async () => fixture(async client => {
  const now = new Date();
  const settings = agentSettingsSchema.parse({ enabled: true, publicationEnabled: true, accountHandle: 'brasilgerais', continuousHourly: true, autoPublishSensitive: true, topicFocus: 'elections', burstRunId: '6b8a8f88-dba7-4656-a53e-cbd38746442f', burstTarget: 3 });
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(settings) } });
  const summary = 'A Justiça Eleitoral prepara urnas para o segundo turno. '.repeat(15);
  await client.trend.create({ data: { fingerprint: 'ballot-fixture', title: 'Estado prepara urnas para o 2º turno', summary, category: 'Política', publishedAt: now, observations: { create: { sourceName: 'Agência Brasil', sourceUrl: 'https://agenciabrasil.ebc.com.br/rss/politica', articleUrl: 'https://agenciabrasil.ebc.com.br/politica/noticia/2026-10/urnas', summary, publishedAt: now, bucket: 'test' } } } });
  await tickAgent({ client, now });
  const slot = await client.agentSlot.findFirstOrThrow({ where: { slotKey: { startsWith: `burst:${settings.burstRunId}:` } } });
  assert.equal(slot.status, 'GENERATING');
  assert.ok(slot.videoId);
}));

test('teste reaproveita roteiro auditado cuja narração ficou pouco abaixo de 15 segundos', async () => fixture(async client => {
  const now = new Date();
  const settings = agentSettingsSchema.parse({ enabled: true, publicationEnabled: true, accountHandle: 'brasilgerais', continuousHourly: true, burstRunId: '338e9867-041b-4f83-8a30-4f055280842c', burstTarget: 3 });
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(settings) } });
  const trend = await client.trend.create({ data: { fingerprint: 'short-audio', title: script.title, summary: '', category: 'Teste' } });
  const video = await client.video.create({ data: { trendId: trend.id, title: script.title, scriptJson: JSON.stringify(script), state: 'FAILED', lastError: 'A narração tem 14.4 segundos. Edite o roteiro ou a velocidade para ficar entre 15 e 90 segundos.' } });
  const dedupeKey = `produce:${video.id}:${productionRevision(script, await getSettings(client))}`;
  await client.job.create({ data: { kind: 'PRODUCE', dedupeKey, payload: JSON.stringify({ videoId: video.id }), videoId: video.id, status: 'FAILED' } });
  await tickAgent({ client, now });
  const slot = await client.agentSlot.findFirstOrThrow({ where: { slotKey: { startsWith: `burst:${settings.burstRunId}:` } } });
  assert.equal(slot.videoId, video.id);
  assert.equal((await client.job.findUniqueOrThrow({ where: { dedupeKey } })).status, 'RETRY_PENDING');
}));

test('roteiro eleitoral auditado pode seguir sem revisão manual quando autorizado', () => {
  const settings = agentSettingsSchema.parse({ autoPublishNormal: true, autoPublishSensitive: true });
  const video = { state: 'REVIEW_PENDING', outputPath: 'test.mp4', scriptJson: JSON.stringify({ ...script, title: 'A Justiça Eleitoral publica o calendário', risk: 'sensitive' }), scriptReviewedAt: null };
  assert.equal(isAutomaticallyPublishable(video, settings), true);
  assert.equal(isAutomaticallyPublishable(video, { ...settings, autoPublishSensitive: false }), false);
  assert.equal(isAutomaticallyPublishable({ ...video, scriptJson: JSON.stringify({ ...script, origin: 'edited' }) }, settings), false);
});

test('fim da agenda por hora remove a permissão temporária', async () => fixture(async client => {
  const settings = agentSettingsSchema.parse({ enabled: true, autoPublishNormal: false, hourlyAutoPublishNormal: true, hourlyStartAt: '2026-10-13T04:00:00.000Z', hourlyEndAt: '2026-10-15T03:00:00.000Z' });
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(settings) } });
  await tickAgent({ client, now: new Date('2026-10-15T03:01:00.000Z') });
  const saved = await getAgentSettings(client);
  assert.equal(saved.hourlyStartAt, undefined);
  assert.equal(saved.hourlyEndAt, undefined);
  assert.equal(saved.hourlyAutoPublishNormal, false);
  assert.equal(saved.autoPublishNormal, false);
  assert.deepEqual(publicationTimesForDay(saved, '2026-10-15'), ['12:00', '19:00']);
}));
test('roteiro editado ou sensível não recebe aprovação humana simulada', () => {
  const settings = agentSettingsSchema.parse({ enabled: true, autoPublishNormal: true });
  const video = { state: 'REVIEW_PENDING', outputPath: 'test.mp4', scriptJson: JSON.stringify(script), scriptReviewedAt: null };
  assert.equal(isAutomaticallyPublishable(video, settings), true);
  assert.equal(isAutomaticallyPublishable({ ...video, scriptJson: JSON.stringify({ ...script, origin: 'edited' }) }, settings), false);
  assert.equal(isAutomaticallyPublishable({ ...video, scriptJson: JSON.stringify({ ...script, risk: 'sensitive' }), scriptReviewedAt: new Date() }, settings), false);
  assert.equal(isAutomaticallyPublishable({ ...video, scriptJson: '{invalid' }, settings), false);
  assert.equal(isAutomaticallyPublishable({ ...video, state: 'APPROVED' }, settings), true);
  assert.equal(isAutomaticallyPublishable(video, { ...settings, autoPublishNormal: false }), false);
});

test('publicação automática de pauta normal termina junto com a agenda por hora', () => {
  const now = Date.now();
  const settings = agentSettingsSchema.parse({ autoPublishNormal: false, hourlyStartAt: new Date(now - 3600000).toISOString(), hourlyEndAt: new Date(now + 3600000).toISOString(), hourlyAutoPublishNormal: true });
  const video = { state: 'REVIEW_PENDING', outputPath: 'test.mp4', scriptJson: JSON.stringify(script), scriptReviewedAt: null };
  assert.equal(isHourlyCampaignAt(settings, new Date(now)), true);
  assert.equal(isAutomaticallyPublishable(video, settings), true);
  assert.equal(isAutomaticallyPublishable({ ...video, scriptJson: JSON.stringify({ ...script, risk: 'sensitive' }) }, settings), false);
  const finished = { ...settings, hourlyEndAt: new Date(now - 1000).toISOString() };
  assert.equal(isHourlyCampaignAt(finished, new Date(now)), false);
  assert.equal(isAutomaticallyPublishable(video, finished), false);
});
test('pausa de login persiste no reinício e impede envio sem parar a pesquisa', async () => fixture(async (client, reopened) => {
  const settings = agentSettingsSchema.parse({ enabled: true, publicationEnabled: true, loginPaused: true, accountHandle: 'conta_teste' });
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(settings) } });
  const trend = await client.trend.create({ data: { fingerprint: 'login-paused', title: 'Assunto isolado', summary: '', category: 'Teste' } });
  const video = await client.video.create({ data: { trendId: trend.id, title: script.title, scriptJson: JSON.stringify(script), state: 'REVIEW_PENDING', outputPath: 'fixture.mp4' } });
  await client.agentSlot.create({ data: { slotKey: '2026-10-12:12:00', scheduledFor: new Date('2026-10-12T15:00:00Z'), videoId: video.id } });
  const now = new Date('2026-10-12T15:01:00Z');
  await tickAgent({ client, now });
  await tickAgent({ client: reopened, now });
  assert.equal(await reopened.job.count({ where: { kind: 'TIKTOK_PUBLISH' } }), 0);
  assert.equal(await reopened.job.count({ where: { kind: 'DISCOVER' } }), 1);
  const saved = await reopened.setting.findUniqueOrThrow({ where: { key: 'agent' } });
  assert.equal(agentSettingsSchema.parse(JSON.parse(saved.value)).loginPaused, true);
  assert.equal(agentSettingsSchema.parse({}).loginPaused, false);
}));
test('classificação normal do modelo não libera um roteiro judicial', () => {
  assert.equal(scriptRisk({ ...script, narration: 'O corregedor anulou a decisão da Justiça Eleitoral.' }), 'sensitive');
  assert.equal(sensitiveText('Luisa Stefani conquista título de tênis'), false);
  assert.equal(isAutomaticallyPublishable({ state: 'REVIEW_PENDING', outputPath: 'fixture.mp4', scriptReviewedAt: null, scriptJson: JSON.stringify({ ...script, title: 'Uma decisão judicial' }) }, agentSettingsSchema.parse({ autoPublishNormal: true })), false);
});
test('postagem é enfileirada uma vez e envio interrompido permanece incerto', async () => fixture(async client => {
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(agentSettingsSchema.parse({ enabled: true, publicationEnabled: true, accountHandle: 'test_account' })) } });
  const trend = await client.trend.create({ data: { fingerprint: 'publication-fixture', title: 'Assunto isolado', summary: 'Teste', category: 'Teste' } });
  const video = await client.video.create({ data: { trendId: trend.id, title: script.title, scriptJson: JSON.stringify(script), state: 'REVIEW_PENDING', outputPath: 'fixture.mp4' } });
  const slot = await client.agentSlot.create({ data: { slotKey: '2026-10-12:12:00', scheduledFor: new Date('2026-10-12T15:00:00Z'), videoId: video.id } });
  const now = new Date('2026-10-12T15:01:00Z');
  await tickAgent({ client, now }); await tickAgent({ client, now });
  assert.equal(await client.job.count({ where: { kind: 'TIKTOK_PUBLISH' } }), 1);
  const job = await client.job.findUniqueOrThrow({ where: { dedupeKey: `tiktok:${slot.id}` } });
  assert.equal(job.maxAttempts, 1);
  await client.agentSlot.update({ where: { id: slot.id }, data: { status: 'SENDING', submissionStartedAt: now } });
  await client.job.update({ where: { id: job.id }, data: { status: 'FAILED' } });
  await tickAgent({ client, now });
  assert.equal((await client.agentSlot.findUniqueOrThrow({ where: { id: slot.id } })).status, 'UNKNOWN');
  assert.equal((await getAgentSettings(client)).publicationEnabled, false);
  assert.equal(await client.job.count({ where: { kind: 'TIKTOK_PUBLISH' } }), 1);
  assert.equal((await client.video.findUniqueOrThrow({ where: { id: video.id } })).state, 'REVIEW_PENDING');
}));
test('falha de publicação não destrói o estado do vídeo pronto', async () => fixture(async client => {
  const trend = await client.trend.create({ data: { fingerprint: 'failed-post', title: 'Assunto', summary: '', category: 'Teste' } });
  const video = await client.video.create({ data: { trendId: trend.id, title: 'Vídeo pronto', state: 'REVIEW_PENDING', outputPath: 'fixture.mp4' } });
  await client.job.create({ data: { kind: 'TIKTOK_PUBLISH', dedupeKey: 'post-fixture', payload: '{}', videoId: video.id, maxAttempts: 1 } });
  const worker = new Worker(async () => { throw new PermanentError('Login necessário'); }, client);
  await worker.tick();
  assert.equal((await client.video.findUniqueOrThrow({ where: { id: video.id } })).state, 'REVIEW_PENDING');
  assert.equal((await client.job.findUniqueOrThrow({ where: { dedupeKey: 'post-fixture' } })).status, 'FAILED');
}));
test('identidade e URL não confundem contas parecidas ou sites externos', () => {
  assert.equal(visibleAccountMatches('Perfil @nome.da_conta', 'nome.da_conta'), true);
  assert.equal(visibleAccountMatches('@nome_da_conta_extra', 'nome_da_conta'), false);
  assert.deepEqual(observedPostLinks(['https://www.tiktok.com/@nome/video/123?lang=pt', 'https://tiktok.com/@nome/video/123?lang=en', 'https://evil.example/@nome/video/123', 'https://www.tiktok.com/@outro/video/123', 'https://www.tiktok.com/@nome'], 'nome'), ['https://www.tiktok.com/@nome/video/123']);
});
test('todas as palavras da narração aparecem nas cenas na mesma ordem', () => {
  const narration = Array.from({ length: 101 }, (_, index) => `palavra${index}`).join(' ');
  const scenes = narrationScenes(narration);
  assert.equal(scenes.map(scene => scene.text).join(' '), narration);
  assert.ok(scenes.length <= 8);
});
test('evidência escolhida corresponde aos fatos da frase e continua literal', () => {
  const exact = 'A dupla conquistou o quinto título do ano no torneio de Pequim.';
  const sources = [{ url: 'https://example.com/tennis', text: `A dupla vai disputar o próximo torneio em Wuhan. ${exact}` }];
  const selected = chooseEvidence('A dupla conquistou seu quinto título em Pequim.', sources);
  assert.equal(selected.evidence, exact);
  assert.equal(selected.sourceUrl, sources[0].url);
  assert.throws(() => chooseEvidence('Uma afirmação', []), /Nenhuma evidência/);
});
test('legenda de publicação preserva créditos de imagens e URLs das fontes', () => {
  const caption = publicationCaption(script, { revision: 'fixture', media: { template: 'Viral', cards: [], assets: [{ originUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.jpg', author: 'Autor de teste', license: 'CC BY 4.0', attribution: 'Fixture — Autor de teste — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:Fixture.jpg', restrictions: '', acquiredAt: new Date().toISOString(), path: 'fixture.jpg', kind: 'commons' }] } });
  assert.ok(caption.includes('CC BY 4.0'));
  assert.ok(caption.includes('Autor de teste'));
  assert.ok(caption.includes(script.sourceUrls[0]));
  const sourceOnly = publicationCaption(script, null, 'source');
  assert.equal(sourceOnly, `Fonte: ${new URL(script.sourceUrls[0]).hostname}\n${script.sourceUrls[0]}`);
});
test('agente troca um assunto que falhou e limita a três seleções por horário', async () => fixture(async client => {
  const now = new Date('2026-10-12T10:00:00Z');
  await client.setting.create({ data: { key: 'agent', value: JSON.stringify(agentSettingsSchema.parse({ enabled: true })) } });
  const oldTrend = await client.trend.create({ data: { fingerprint: 'old-failed', title: 'Assunto anterior', summary: '', category: 'Teste' } });
  const oldVideo = await client.video.create({ data: { trendId: oldTrend.id, title: 'Assunto anterior', state: 'FAILED', lastError: 'Contrato rejeitado' } });
  const slot = await client.agentSlot.create({ data: { slotKey: '2026-10-12:12:00', scheduledFor: new Date('2026-10-12T15:00:00Z'), videoId: oldVideo.id, status: 'BLOCKED', selectionAttempts: 2 } });
  await client.trend.create({ data: { fingerprint: 'new-source', title: 'Uma pesquisa de estudo', summary: '', category: 'Teste', publishedAt: now, observations: { create: { sourceName: 'Fonte do teste', sourceUrl: 'https://example.com/feed', articleUrl: 'https://example.com/article', summary: 'Texto substancial para o teste de seleção. '.repeat(20), publishedAt: now, bucket: 'test' } } } });
  await tickAgent({ client, now });
  const selected = await client.agentSlot.findUniqueOrThrow({ where: { id: slot.id } });
  assert.notEqual(selected.videoId, oldVideo.id);
  assert.equal(selected.selectionAttempts, 3);
  assert.equal((await client.video.findUniqueOrThrow({ where: { id: oldVideo.id } })).state, 'FAILED');
  await client.video.update({ where: { id: selected.videoId! }, data: { state: 'FAILED' } });
  await tickAgent({ client, now });
  assert.equal((await client.agentSlot.findUniqueOrThrow({ where: { id: slot.id } })).status, 'BLOCKED');
  assert.equal(await client.job.count({ where: { kind: 'SCRIPT' } }), 1);
}));
