import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { manualTrendSchema, scriptSchema, settingsSchema, sourceSchema } from '@viralfactory/shared';
import { db, getSettings } from './db.js';
import { rootDir, apiPort, webPort } from './config.js';
import { activeStatuses, cancelJob, enqueueDiscovery, retryJob } from './queue.js';
import { diagnose } from './doctor.js';
import { ingest, listTrends, parseFeed } from './trends.js';
import { fetchPublicText, validatePublicUrl } from './http.js';
import { productionRevision } from './production.js';
import { dataDir } from './config.js';
import { registerAgentRoutes } from './agent-routes.js';
import { scriptRisk } from './content-risk.js';
import { authenticExtension } from './extension-bridge.js';
import { registerExtensionRoutes } from './extension-routes.js';
import { composeReviewedScripts } from './compilation.js';
import { registerAccountRoutes } from './account-routes.js';
import { registerClipRoutes } from './clip-routes.js';
import { registerEpisodeBatchRoutes } from './episode-batch-routes.js';

const paramId = z.object({ id: z.string().min(1).max(100) });
export function serializeVideo(video: { scriptJson: string | null } & Record<string, any>) {
  const { scriptJson, researchJson, artifactJson, ...rest } = video;
  return { ...rest, script: scriptJson ? JSON.parse(scriptJson) : null, research: researchJson ? JSON.parse(researchJson) : null, artifacts: artifactJson ? JSON.parse(artifactJson) : null };
}
export async function buildApp() {
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization'] }, bodyLimit: 100000 });
  const allowedOrigins = new Set([`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`, `http://127.0.0.1:${apiPort}`, `http://localhost:${apiPort}`]);
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host || '')) return reply.code(403).send({ error: 'A aplicação aceita apenas acesso local.' });
    const bridgeRoute = request.url.split('?')[0].startsWith('/api/agent/extension/bridge/');
    const extensionOrigin = request.headers.origin && /^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin);
    if (bridgeRoute) {
      if (request.headers.origin && !extensionOrigin) return reply.code(403).send({ error: 'Origem da extensão não autorizada.' });
      if (request.method === 'OPTIONS' && extensionOrigin) return reply.header('access-control-allow-origin', request.headers.origin!).header('access-control-allow-methods', 'GET,POST,OPTIONS').header('access-control-allow-headers', 'authorization,content-type').code(204).send();
      if (!(await authenticExtension(request.headers.authorization))) return reply.code(401).send({ error: 'Conexão local da extensão não autorizada.' });
      if (extensionOrigin) reply.header('access-control-allow-origin', request.headers.origin!);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin) && !(bridgeRoute && extensionOrigin)) return reply.code(403).send({ error: 'Origem não autorizada.' });
      const clipChunk = request.method === 'PUT' && /^\/api\/clips\/[^/]+\/chunk$/.test(request.url.split('?')[0]);
      if (!request.headers['content-type']?.startsWith(clipChunk ? 'application/octet-stream' : 'application/json')) return reply.code(415).send({ error: clipChunk ? 'Envie parte binária do vídeo.' : 'Envie os dados como JSON.' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    if ((error as { code?: string }).code === 'P2025') return reply.code(404).send({ error: 'Registro não encontrado.' });
    if ((error as { code?: string }).code === 'P2002') return reply.code(409).send({ error: 'Este registro já existe.' });
    request.log.error(error);
    reply.code((error as { statusCode?: number }).statusCode || 500).send({ error: error instanceof Error ? error.message : 'Erro interno.' });
  });
  app.get('/api/health', async () => {
    await db.$queryRawUnsafe('SELECT 1');
    return { status: 'ok', version: '0.1.0', database: 'sqlite', time: new Date().toISOString() };
  });
  app.get('/api/overview', async () => {
    const [trends, videos, jobs, settings, sources] = await Promise.all([
      listTrends(), db.video.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      db.job.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }), getSettings(), db.source.findMany()
    ]);
    return { trends: trends.slice(0, 6), trendCount: trends.length, videoCount: await db.video.count(), renderedCount: await db.video.count({ where: { state: { in: ['RENDERED', 'REVIEW_PENDING', 'APPROVED', 'PUBLISHED'] }, outputPath: { not: null } } }), videos: videos.map(serializeVideo), jobs, settings, lastDiscovery: sources.reduce<string | null>((latest, source) => source.lastFetchedAt && (!latest || source.lastFetchedAt.toISOString() > latest) ? source.lastFetchedAt.toISOString() : latest, null), activeJobs: jobs.filter(job => activeStatuses.includes(job.status)).length, sourceErrors: sources.filter(source => source.enabled && source.lastError).length };
  });
  app.get('/api/settings', async () => getSettings());
  app.put('/api/settings', async request => {
    const settings = settingsSchema.parse(request.body);
    await db.setting.upsert({ where: { key: 'preferences' }, create: { key: 'preferences', value: JSON.stringify(settings) }, update: { value: JSON.stringify(settings) } });
    return settings;
  });
  app.get('/api/doctor', async request => diagnose((request.query as { fresh?: string }).fresh === 'true'));
  app.get('/api/trends', async () => listTrends());
  app.post('/api/trends/import', async request => {
    const value = manualTrendSchema.parse(request.body);
    const sourceName = new URL(value.url).hostname;
    await ingest([{ title: value.title, summary: value.summary, url: value.url, publishedAt: new Date(value.publishedAt), sourceName }], { url: value.url, category: value.category });
    if (value.eventDate) {
      const { fingerprint } = await import('./trends.js');
      await db.trend.update({ where: { fingerprint: fingerprint(value.title) }, data: { eventDate: value.eventDate } });
    }
    return { imported: true };
  });
  app.post('/api/discover', async () => {
    return enqueueDiscovery(`discover:manual:${randomUUID()}`);
  });
  app.get('/api/sources', async () => db.source.findMany({ orderBy: { createdAt: 'asc' } }));
  app.post('/api/sources', async request => {
    const value = sourceSchema.parse(request.body);
    await validatePublicUrl(value.url);
    return db.source.create({ data: value });
  });
  app.patch('/api/sources/:id', async request => {
    const { id } = paramId.parse(request.params);
    const value = sourceSchema.partial().parse(request.body);
    if (value.url) await validatePublicUrl(value.url);
    return db.source.update({ where: { id }, data: value });
  });
  app.post('/api/sources/:id/test', async request => {
    const { id } = paramId.parse(request.params);
    const source = await db.source.findUniqueOrThrow({ where: { id } });
    try {
      const items = parseFeed(await fetchPublicText(source.url), source.name);
      await db.source.update({ where: { id }, data: { lastError: null } });
      return { ok: true, items: items.length, message: `Conexão confirmada: ${items.length} entradas no feed.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.source.update({ where: { id }, data: { lastError: message } });
      return { ok: false, message };
    }
  });
  app.get('/api/jobs', async () => db.job.findMany({ take: 100, orderBy: { createdAt: 'desc' }, include: { logs: { orderBy: { createdAt: 'desc' }, take: 30 } } }));
  app.post('/api/jobs/:id/cancel', async request => ({ changed: await cancelJob(paramId.parse(request.params).id) }));
  app.post('/api/jobs/:id/retry', async request => ({ changed: await retryJob(paramId.parse(request.params).id) }));
  app.get('/api/videos', async () => (await db.video.findMany({ orderBy: { createdAt: 'desc' } })).map(serializeVideo));
  app.post('/api/videos/compilations', async (request, reply) => {
    const { videoIds } = z.object({ videoIds: z.array(z.string().min(1)).min(2).max(3).refine(ids => new Set(ids).size === ids.length) }).parse(request.body);
    const found = await db.video.findMany({ where: { id: { in: videoIds } }, include: { trend: { include: { observations: true } } } });
    const byId = new Map(found.map(video => [video.id, video]));
    if (found.length !== videoIds.length) throw Object.assign(new Error('Um dos roteiros não foi encontrado.'), { statusCode: 404 });
    const selected = videoIds.map(id => byId.get(id)!);
    if (selected.some(video => !video.scriptJson || !video.scriptReviewedAt || ['FAILED', 'CANCELED'].includes(video.state))) throw Object.assign(new Error('Selecione apenas roteiros revisados e válidos.'), { statusCode: 409 });
    const parts = selected.map(video => {
      const script = scriptSchema.parse(JSON.parse(video.scriptJson!));
      const artifacts = video.artifactJson ? JSON.parse(video.artifactJson) : null;
      return { id: video.id, title: video.title, script, reviewedAt: video.scriptReviewedAt!, durationSeconds: artifacts?.audio?.duration || script.estimatedDurationSeconds };
    });
    const script = composeReviewedScripts(parts);
    const fingerprint = createHash('sha256').update(JSON.stringify(selected.map(video => [video.id, video.scriptJson]))).digest('hex');
    const settings = await getSettings();
    const result = await db.$transaction(async tx => {
      const existing = await tx.trend.findUnique({ where: { fingerprint }, include: { videos: true } });
      if (existing?.videos[0]) return existing.videos[0];
      const trend = existing || await tx.trend.create({ data: { fingerprint, title: script.title, summary: script.description, category: 'Compilado', publishedAt: new Date() } });
      const observations = selected.flatMap(video => scriptSchema.parse(JSON.parse(video.scriptJson!)).sourceUrls.map(url => ({
        trendId: trend.id, sourceName: new URL(url).hostname, sourceUrl: url, articleUrl: url,
        summary: video.trend.summary || video.title, publishedAt: video.trend.publishedAt, bucket: `compilation:${video.id}`
      })));
      if (!existing) await tx.observation.createMany({ data: observations });
      const created = await tx.video.create({ data: { trendId: trend.id, title: script.title, scriptJson: JSON.stringify(script), researchJson: JSON.stringify({ kind: 'compilation', sourceVideoIds: videoIds }), state: 'SCRIPTED', scriptReviewedAt: new Date(), reviewRequired: true } });
      const revision = productionRevision(script, settings);
      await tx.job.create({ data: { kind: 'PRODUCE', payload: JSON.stringify({ videoId: created.id }), videoId: created.id, dedupeKey: `produce:${created.id}:${revision}` } });
      return created;
    });
    return reply.code(201).send(serializeVideo(result));
  });
  app.post('/api/videos', async (request, reply) => {
    const { trendId } = z.object({ trendId: z.string().min(1) }).parse(request.body);
    const settings = await getSettings();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const dayStart = new Date(`${today}T00:00:00-03:00`);
    const video = await db.$transaction(async tx => {
      const existing = await tx.video.findUnique({ where: { trendId } });
      if (existing) return existing;
      const count = await tx.video.count({ where: { createdAt: { gte: dayStart }, state: { notIn: ['FAILED', 'CANCELED'] } } });
      if (count >= settings.dailyVideos) throw Object.assign(new Error('O limite diário de produções foi atingido. Ajuste nas configurações.'), { statusCode: 409 });
      const trend = await tx.trend.findUniqueOrThrow({ where: { id: trendId } });
      const created = await tx.video.create({ data: { trendId, title: trend.title } });
      await tx.job.create({ data: { kind: 'SCRIPT', payload: JSON.stringify({ videoId: created.id }), videoId: created.id, dedupeKey: `script:${created.id}` } });
      return created;
    });
    return reply.code(201).send(serializeVideo(video));
  });
  app.put('/api/videos/:id/script', async request => {
    const { id } = paramId.parse(request.params);
    const supplied = scriptSchema.parse(request.body);
    const script = { ...supplied, origin: 'edited' as const, risk: scriptRisk(supplied) };
    return db.$transaction(async tx => {
      const running = await tx.job.count({ where: { videoId: id, status: { in: activeStatuses } } });
      if (running) throw Object.assign(new Error('Aguarde ou cancele a tarefa antes de editar o roteiro.'), { statusCode: 409 });
      const video = await tx.video.findUniqueOrThrow({ where: { id }, include: { trend: { include: { observations: true } } } });
      const sources = new Set(video.trend.observations.map(item => item.articleUrl));
      if (script.sourceUrls.some(url => !sources.has(url)) || script.claims.some(claim => !sources.has(claim.sourceUrl))) throw Object.assign(new Error('O roteiro deve citar as fontes coletadas para este assunto.'), { statusCode: 400 });
      return serializeVideo(await tx.video.update({ where: { id }, data: { scriptJson: JSON.stringify(script), title: script.title, state: 'SCRIPTED', reviewRequired: true, scriptReviewedAt: null, artifactJson: null, outputPath: null, lastError: null } }));
    });
  });
  app.post('/api/videos/:id/review-script', async request => {
    const { id } = paramId.parse(request.params);
    const { confirmed } = z.object({ confirmed: z.literal(true) }).parse(request.body);
    const video = await db.video.findUniqueOrThrow({ where: { id } });
    if (!video.scriptJson) throw Object.assign(new Error('Não há roteiro para revisar.'), { statusCode: 409 });
    return serializeVideo(await db.video.update({ where: { id }, data: { scriptReviewedAt: new Date() } }));
  });
  app.post('/api/videos/:id/produce', async request => {
    const { id } = paramId.parse(request.params);
    const settings = await getSettings();
    return db.$transaction(async tx => {
      const video = await tx.video.findUniqueOrThrow({ where: { id } });
      if (!video.scriptJson) throw Object.assign(new Error('Gere ou salve o roteiro primeiro.'), { statusCode: 409 });
      const script = scriptSchema.parse(JSON.parse(video.scriptJson));
      if (script.risk === 'sensitive' && !video.scriptReviewedAt) throw Object.assign(new Error('Revise o roteiro sensível e confirme a revisão antes da produção.'), { statusCode: 409 });
      const active = await tx.job.findFirst({ where: { videoId: id, status: { in: activeStatuses } } });
      if (active) return active;
      const revision = productionRevision(script, settings);
      const artifacts = video.artifactJson ? JSON.parse(video.artifactJson) : null;
      if (artifacts && artifacts.revision !== revision) await tx.video.update({ where: { id }, data: { artifactJson: null, outputPath: null, reviewRequired: true, state: 'SCRIPTED' } });
      const key = `produce:${id}:${revision}`;
      const previous = await tx.job.findUnique({ where: { dedupeKey: key } });
      if (previous && ['FAILED', 'CANCELED'].includes(previous.status)) {
        await tx.video.update({ where: { id }, data: { state: 'RETRY_PENDING', lastError: null } });
        return tx.job.update({ where: { id: previous.id }, data: { status: 'RETRY_PENDING', attempts: 0, availableAt: new Date(), lastError: null } });
      }
      return tx.job.upsert({ where: { dedupeKey: key }, create: { kind: 'PRODUCE', payload: JSON.stringify({ videoId: id }), videoId: id, dedupeKey: key }, update: {} });
    });
  });
  app.post('/api/videos/:id/approve', async request => {
    const { id } = paramId.parse(request.params);
    z.object({ confirmed: z.literal(true) }).parse(request.body);
    const video = await db.video.findUniqueOrThrow({ where: { id } });
    if (!video.outputPath || !['REVIEW_PENDING', 'RENDERED'].includes(video.state)) throw Object.assign(new Error('O vídeo precisa estar pronto para revisão.'), { statusCode: 409 });
    return serializeVideo(await db.video.update({ where: { id }, data: { state: 'APPROVED', reviewRequired: false } }));
  });
  app.get('/api/videos/:id/file/:kind', async (request, reply) => {
    const { id, kind } = z.object({ id: z.string().min(1).max(100), kind: z.enum(['video', 'audio', 'cover', 'metadata', 'subtitles']) }).parse(request.params);
    const video = await db.video.findUniqueOrThrow({ where: { id } });
    const artifacts = video.artifactJson ? JSON.parse(video.artifactJson) : {};
    const file = kind === 'video' ? video.outputPath : kind === 'audio' ? artifacts.audio?.path : kind === 'cover' ? artifacts.render?.coverPath : kind === 'subtitles' ? artifacts.subtitles?.path : artifacts.render?.path ? path.join(path.dirname(artifacts.render.path), 'metadata.json') : null;
    if (!file) return reply.code(404).send({ error: 'O arquivo ainda não está disponível.' });
    const resolved = path.resolve(file), allowed = path.resolve(dataDir, 'videos', id) + path.sep;
    if (!resolved.startsWith(allowed)) return reply.code(403).send({ error: 'Arquivo fora da produção.' });
    const info = await stat(resolved);
    const mime = { video: 'video/mp4', audio: 'audio/wav', cover: 'image/png', metadata: 'application/json', subtitles: 'text/plain; charset=utf-8' }[kind];
    reply.header('content-type', mime).header('accept-ranges', 'bytes');
    if ((request.query as { download?: string }).download === 'true') reply.header('content-disposition', `attachment; filename="viralfactory-${id}.${kind === 'video' ? 'mp4' : kind === 'audio' ? 'wav' : kind === 'cover' ? 'png' : kind === 'metadata' ? 'json' : 'ass'}"`);
    const range = request.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [left, right] = range.slice(6).split('-');
      const start = left ? Number(left) : Math.max(0, info.size - Number(right));
      const end = left && right ? Math.min(info.size-1, Number(right)) : info.size-1;
      if (start >= info.size || end < start) return reply.code(416).header('content-range', `bytes */${info.size}`).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${info.size}`).header('content-length', end-start+1).send(createReadStream(resolved, { start, end }));
    }
    return reply.header('content-length', info.size).send(createReadStream(resolved));
  });
  app.get('/api/connectors', async () => [
    { name: 'RSS / Google News', status: 'available', detail: 'Leitura real de feeds públicos configurados.' },
    { name: 'Importação manual', status: 'available', detail: 'Link, resumo verificável e data informados por você.' },
    { name: 'Wikimedia Commons', status: 'available', detail: 'Busca de imagens com metadados de autoria e licença. Grafismos próprios quando não houver resultado adequado.' },
    { name: 'TikTok pelo navegador', status: 'experimental', detail: 'Extensão para uma aba do Chrome habitual ou perfil separado. Comunicação e envio implementados; conexão na conta real e postagem ainda requerem validação.' },
    ...['GDELT', 'Wikimedia Pageviews', 'YouTube Data API', 'Reddit', 'Google Trends', 'Pexels', 'Pixabay'].map(name => ({ name, status: 'planned', detail: 'Conector ainda não implementado.' }))
  ]);
  const dist = path.join(rootDir, 'apps', 'web', 'dist');
  await registerAgentRoutes(app);
  await registerExtensionRoutes(app);
  await registerAccountRoutes(app);
  await registerClipRoutes(app);
  await registerEpisodeBatchRoutes(app);
  if (existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Rota não encontrada.' }) : reply.sendFile('index.html'));
  }
  return app;
}
