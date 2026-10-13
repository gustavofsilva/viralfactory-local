import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDb, type Db } from '../src/db.js';
import { dataDir, rootDir } from '../src/config.js';
import { cancelJob, claim, enqueue, enqueueDiscovery, recoverExpired, retryJob, Worker, PermanentError } from '../src/queue.js';
import { generateScript } from '../src/ollama.js';
import { narrationMetadata, unsupportedMonth } from '../src/script-compose.js';
import { eventSignals } from '../src/event-signals.js';
import { sensitiveText } from '../src/content-risk.js';
import { roundScoreFalsePositive } from '../src/evidence-audit.js';
import { fingerprint, ingest, listTrends, parseFeed } from '../src/trends.js';
import { isPrivateAddress } from '../src/http.js';
import { buildApp } from '../src/app.js';

async function fixture(run: (first: Db, second: Db) => Promise<void>) {
  const directory = await mkdtemp(path.join(dataDir, 'test-'));
  const filename = path.join(directory, 'test.db');
  const migrations = await readdir(path.join(rootDir, 'apps/api/prisma/migrations'));
  const native = new DatabaseSync(filename);
  for (const migration of migrations.filter(value => !value.endsWith('.toml')).sort()) {
    native.exec(await readFile(path.join(rootDir, 'apps/api/prisma/migrations', migration, 'migration.sql'), 'utf8'));
  }
  native.close();
  const first = createDb(`file:${filename.replaceAll('\\', '/')}`);
  const second = createDb(`file:${filename.replaceAll('\\', '/')}`);
  try { await run(first, second); }
  finally {
    await first.$disconnect(); await second.$disconnect();
    for (const suffix of ['', '-wal', '-shm', '-journal']) await unlink(`${filename}${suffix}`).catch(() => {});
    const { rmdir } = await import('node:fs/promises');
    await rmdir(directory);
  }
}
test('metadados automáticos não acrescentam fatos à narração auditada', () => {
  const narration = 'A dupla venceu a final em dois sets. O resultado foi de seis a um e seis a dois.';
  const metadata = narrationMetadata(narration);
  assert.equal(metadata.title, 'A dupla venceu a final em dois sets.');
  assert.equal(metadata.coverText, metadata.title);
  assert.equal(metadata.description, narration);
  assert.deepEqual(metadata.hashtags, ['#Entenda', '#Resumo']);
});
test('mês do evento precisa aparecer no texto da fonte', () => {
  assert.equal(unsupportedMonth('A prova aconteceu em outubro.', [{ text: 'A prova ocorreu em Paris.' }]), 'outubro');
  assert.equal(unsupportedMonth('A prova aconteceu em outubro.', [{ text: 'A prova ocorreu em Paris, em outubro.' }]), null);
});
test('acontecimentos atuais e datas futuras pontuam sem manter uma pauta antiga para sempre', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const fresh = new Date('2026-10-11T18:00:00Z');
  assert.deepEqual(eventSignals('Eleições 2026', 'Segundo turno em 25 de outubro de 2026.', fresh, now), { eventDate: '2026-10-25', event: 6 });
  assert.deepEqual(eventSignals('Faltam 13 dias para a votação', '', now, now), { eventDate: '2026-10-25', event: 6 });
  assert.equal(eventSignals('Apuração ao vivo', 'Atualização em andamento.', fresh, now).event, 15);
  assert.equal(eventSignals('Níveis ao vivo de ações', 'Análise de preços de mercado.', fresh, now).event, 0);
  assert.equal(eventSignals('Apuração ao vivo', 'Atualização em andamento.', new Date('2026-09-01T12:00:00Z'), now).event, 0);
  assert.equal(eventSignals('Agenda', 'Evento em 31 de fevereiro de 2026.', fresh, now).eventDate, null);
  assert.equal(sensitiveText('Feriado tem alerta para tempestades'), true);
  assert.equal(sensitiveText('Atleta voltou após cirurgia'), true);
});
test('placar por rounds não é confundido com pontos dentro de cada round', () => {
  const excerpt = 'O brasileiro venceu Jasurbek Jaysunov por dois rounds a zero na final da categoria até 80 quilos.';
  const reason = 'Pontuações de 10-9 e 4-2 contradizem dois rounds a zero.';
  assert.equal(roundScoreFalsePositive('O atleta venceu Jasurbek Jaysunov por dois rounds a zero na final até 80 quilos.', excerpt, reason), true);
  assert.equal(roundScoreFalsePositive('O atleta venceu Jasurbek Jaysunov por dois rounds a zero na final em 11 de outubro até 80 quilos.', excerpt, reason), false);
});
test('uma chave de tarefa mantém a mesma tarefa após reabrir o banco', async () => fixture(async (first, second) => {
  const before = await enqueue('DISCOVER', {}, 'scheduled:one', first);
  await first.$disconnect();
  const after = await enqueue('DISCOVER', {}, 'scheduled:one', second);
  assert.equal(after.id, before.id);
  assert.equal(await second.job.count(), 1);
}));
test('pesquisa manual e agendada reutilizam a tarefa ativa', async () => fixture(async first => {
  const initial = await enqueueDiscovery('manual:a', first);
  const repeated = await enqueueDiscovery('scheduled:b', first);
  assert.equal(initial.id, repeated.id);
  assert.equal(await first.job.count(), 1);
}));
test('retomada preserva roteiro salvo e restaura o estado sem chamar Ollama', async () => fixture(async first => {
  const trend = await first.trend.create({ data: { title: 'Assunto do teste isolado', summary: '', category: 'Teste', fingerprint: 'isolated-test' } });
  const savedJson = JSON.stringify({ title: 'Resultado já persistido do teste' });
  const video = await first.video.create({ data: { trendId: trend.id, title: trend.title, state: 'RETRY_PENDING', scriptJson: savedJson } });
  await enqueue('SCRIPT', { videoId: video.id }, `script:${video.id}`, first, video.id);
  const job = (await claim(first))!;
  await generateScript(video.id, job.leaseOwner!, job.id, new AbortController().signal, async () => {}, first);
  const restored = await first.video.findUniqueOrThrow({ where: { id: video.id } });
  assert.equal(restored.state, 'SCRIPTED'); assert.equal(restored.scriptJson, savedJson);
}));
test('dois workers concorrentes não adquirem a mesma tarefa', async () => fixture(async (first, second) => {
  await enqueue('DISCOVER', {}, 'concurrent', first);
  const results = await Promise.all([claim(first), claim(second)]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.find(Boolean)!;
  assert.equal(winner.attempts, 1);
  assert.ok(winner.leaseOwner);
}));
test('lease expirado é recuperado e o antigo dono não pode concluir', async () => fixture(async (first, second) => {
  await enqueue('DISCOVER', {}, 'restart', first);
  const old = (await claim(first))!;
  await first.job.update({ where: { id: old.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  await recoverExpired(second);
  const next = (await claim(second))!;
  assert.equal(next.id, old.id);
  assert.notEqual(next.leaseOwner, old.leaseOwner);
  assert.equal(next.attempts, 2);
  const stale = await first.job.updateMany({ where: { id: old.id, leaseOwner: old.leaseOwner, status: 'RUNNING' }, data: { status: 'COMPLETED' } });
  assert.equal(stale.count, 0);
}));
test('recuperação marca FAILED após o limite e preserva logs', async () => fixture(async first => {
  const job = await enqueue('DISCOVER', {}, 'exhausted', first);
  await first.job.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: 3, leaseOwner: 'old', leaseExpiresAt: new Date(0) } });
  await recoverExpired(first);
  assert.equal((await first.job.findUniqueOrThrow({ where: { id: job.id } })).status, 'FAILED');
  assert.equal(await first.jobLog.count({ where: { jobId: job.id } }), 1);
}));
test('cancelamento remove exclusividade e repetição reabre a mesma tarefa', async () => fixture(async first => {
  const job = await enqueue('DISCOVER', {}, 'cancel', first);
  await claim(first);
  assert.equal(await cancelJob(job.id, first), 1);
  const canceled = await first.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(canceled.status, 'CANCELED'); assert.equal(canceled.leaseOwner, null);
  assert.equal(await retryJob(job.id, first), 1);
  const next = (await claim(first))!;
  assert.equal(next.id, job.id); assert.equal(next.attempts, 1);
}));
test('worker salva erro temporário com backoff e não repete erro permanente', async () => fixture(async first => {
  const transient = await enqueue('DISCOVER', {}, 'transient', first);
  await new Worker(async () => { throw new Error('Falha temporária'); }, first).tick();
  const retried = await first.job.findUniqueOrThrow({ where: { id: transient.id } });
  assert.equal(retried.status, 'RETRY_PENDING'); assert.ok(retried.availableAt.getTime() > Date.now());
  const permanent = await enqueue('SCRIPT', {}, 'permanent', first);
  await new Worker(async () => { throw new PermanentError('Dependência ausente'); }, first).tick();
  assert.equal((await first.job.findUniqueOrThrow({ where: { id: permanent.id } })).status, 'FAILED');
}));
test('worker concluído salva resultado e não altera cancelamento concorrente', async () => fixture(async first => {
  const successful = await enqueue('DISCOVER', {}, 'done', first);
  await new Worker(async (_, __, log) => { await log('Resultado real do handler salvo.'); }, first).tick();
  assert.equal((await first.job.findUniqueOrThrow({ where: { id: successful.id } })).status, 'COMPLETED');
  const canceled = await enqueue('DISCOVER', {}, 'canceled-during-run', first);
  await new Worker(async job => { await cancelJob(job.id, first); }, first).tick();
  assert.equal((await first.job.findUniqueOrThrow({ where: { id: canceled.id } })).status, 'CANCELED');
}));
test('RSS e Atom preservam autoria, data e texto; entidades externas são recusadas', () => {
  const rss = parseFeed('<rss><channel><item><title>Um fato &amp; contexto</title><link>https://example.com/a</link><description><![CDATA[<b>Evidência</b> registrada.]]></description><pubDate>Sun, 11 Oct 2026 12:00:00 GMT</pubDate><source>Fonte independente</source></item></channel></rss>', 'Feed');
  assert.equal(rss[0].title, 'Um fato & contexto'); assert.equal(rss[0].summary, 'Evidência registrada.'); assert.equal(rss[0].sourceName, 'Fonte independente'); assert.ok(rss[0].publishedAt);
  const atom = parseFeed('<feed><entry><title>Assunto</title><link rel="alternate" href="https://example.com/b"/><summary>Resumo</summary></entry></feed>', 'Atom');
  assert.equal(atom[0].url, 'https://example.com/b'); assert.equal(atom[0].publishedAt, null);
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY a SYSTEM "file:///x">]><rss/>', 'Feed'));
  assert.throws(() => parseFeed('<html>Sem feed</html>', 'Feed'));
});
test('ingestão repetida não duplica o acontecimento e não inventa crescimento', async () => fixture(async first => {
  const item = { title: 'Assunto original - Portal', url: 'https://example.com/article', summary: 'Uma descrição verificável e suficientemente longa para registrar os fatos disponíveis nesta fonte independente.', sourceName: 'Portal', publishedAt: new Date() };
  const source = { url: 'https://example.com/feed', category: 'Ciência' };
  await ingest([item], source, first); await ingest([item], source, first);
  assert.equal(await first.trend.count(), 1); assert.equal(await first.observation.count(), 1);
  const trends = await listTrends(first);
  assert.equal(trends[0].factors.growth, null); assert.equal(trends[0].factors.popularity, null);
  assert.ok(trends[0].score >= 0 && trends[0].score <= 100);
  assert.equal(fingerprint('Assunto original - Portal'), fingerprint('Assunto original - Outro portal'));
}));
test('ranking deixa recência desconhecida sem pontuação e distingue cobertura', async () => fixture(async first => {
  await ingest([{ title: 'Título sem data', url: 'https://example.com/unknown', summary: '', sourceName: 'Feed', publishedAt: null }], { url: 'https://example.com/feed', category: 'Todas' }, first);
  const row = (await listTrends(first))[0]; assert.equal(row.factors.recency, 0); assert.equal(row.factors.evidence, 0); assert.equal(row.publishedAt, null);
}));
test('fontes externas não podem usar endereços locais ou privados', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.3.2', '192.168.0.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});
test('API bloqueia origem externa, host desconhecido e contrato inválido', async () => {
  const app = await buildApp();
  try {
    const origin = await app.inject({ method: 'POST', url: '/api/discover', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: {} }); assert.equal(origin.statusCode, 403);
    const host = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } }); assert.equal(host.statusCode, 403);
    const invalid = await app.inject({ method: 'POST', url: '/api/trends/import', payload: { title: 'x', url: 'file:///x' } }); assert.equal(invalid.statusCode, 400);
    const preferences = await app.inject('/api/settings'); assert.equal(preferences.statusCode, 200); assert.equal(preferences.json().language, 'pt-BR');
  } finally { await app.close(); }
});
