import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { db } from './db.js';
import { clipDirectory, clipSegmentsSchema, validateClipSegments } from './clips.js';
import { probeFile } from './production.js';
import { observedPostLinks } from './tiktok-browser.js';

const idSchema = z.object({ id: z.string().min(1).max(100) });
const locks = new Set<string>();
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const serialize = (clip: Record<string, any>) => ({ ...clip, segments: clip.segmentsJson ? JSON.parse(clip.segmentsJson) : null, transcriptJson: undefined, segmentsJson: undefined, sourcePath: undefined });
export async function registerClipRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 4_300_000 }, (_request, body, done) => done(null, body));
  app.get('/api/clips', async () => (await db.clip.findMany({ include: { account: true }, orderBy: { createdAt: 'desc' }, take: 100 })).map(serialize));
  app.post('/api/clips', async request => {
    const value = z.object({ accountId: z.string().min(1), title: z.string().trim().min(3).max(120), caption: z.string().trim().min(1).max(2200), sourceName: z.string().trim().min(1).max(180).regex(/\.(mp4|mov)$/i), sourceBytes: z.number().int().min(1).max(MAX_SOURCE_BYTES) }).parse(request.body);
    const account = await db.tikTokAccount.findUniqueOrThrow({ where: { id: value.accountId } });
    if (!account.enabled) throw Object.assign(new Error('Conta desativada.'), { statusCode: 409 });
    const clip = await db.clip.create({ data: { accountId: value.accountId, title: value.title, caption: value.caption, sourceName: path.basename(value.sourceName), sourceBytes: value.sourceBytes } });
    const directory = clipDirectory(clip.id);
    await mkdir(directory, { recursive: true });
    const sourcePath = path.join(directory, 'source' + path.extname(value.sourceName).toLowerCase());
    await writeFile(sourcePath, Buffer.alloc(0));
    return serialize(await db.clip.update({ where: { id: clip.id }, data: { sourcePath } }));
  });
  app.put('/api/clips/:id/chunk', { bodyLimit: 4_300_000 }, async request => {
    const { id } = idSchema.parse(request.params);
    const offset = z.coerce.number().int().min(0).parse(request.headers['x-upload-offset']);
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 4_194_304) throw Object.assign(new Error('Parte do arquivo inválida.'), { statusCode: 400 });
    if (locks.has(id)) throw Object.assign(new Error('Outra parte está sendo gravada. Aguarde.'), { statusCode: 409 });
    locks.add(id);
    try {
      const clip = await db.clip.findUniqueOrThrow({ where: { id } });
      if (clip.status !== 'UPLOADING' || !clip.sourcePath || clip.uploadOffset !== offset || offset + bytes.length > clip.sourceBytes) throw Object.assign(new Error('Posição ou tamanho de upload inválido.'), { statusCode: 409 });
      const file = await open(clip.sourcePath, 'r+');
      try { await file.write(bytes, 0, bytes.length, offset); } finally { await file.close(); }
      await db.clip.update({ where: { id }, data: { uploadOffset: offset + bytes.length } });
      return { offset: offset + bytes.length };
    } finally { locks.delete(id); }
  });
  app.post('/api/clips/:id/complete', async request => {
    const { id } = idSchema.parse(request.params);
    const clip = await db.clip.findUniqueOrThrow({ where: { id } });
    if (clip.status !== 'UPLOADING' || !clip.sourcePath || clip.uploadOffset !== clip.sourceBytes || (await stat(clip.sourcePath)).size !== clip.sourceBytes) throw Object.assign(new Error('Upload incompleto.'), { statusCode: 409 });
    const info = await probeFile(clip.sourcePath);
    const duration = Number(info.format.duration);
    if (!Number.isFinite(duration) || duration < 60 || duration > 1800 || !info.streams.some(stream => stream.codec_type === 'video') || !info.streams.some(stream => stream.codec_type === 'audio')) throw Object.assign(new Error('Use um vídeo com áudio de 1 a 30 minutos.'), { statusCode: 400 });
    await db.$transaction(async tx => {
      const changed = await tx.clip.updateMany({ where: { id, status: 'UPLOADING', uploadOffset: clip.sourceBytes }, data: { status: 'IMPORTED', durationSeconds: duration } });
      if (!changed.count) throw Object.assign(new Error('Upload já concluído.'), { statusCode: 409 });
      await tx.job.create({ data: { kind: 'CLIP_ANALYZE', dedupeKey: `clip-analyze:${id}`, payload: JSON.stringify({ clipId: id }), maxAttempts: 1 } });
    });
    return { ok: true };
  });
  app.put('/api/clips/:id/segments', async request => {
    const { id } = idSchema.parse(request.params);
    const value = z.object({ segments: clipSegmentsSchema, title: z.string().trim().min(3).max(120), caption: z.string().trim().min(1).max(2200) }).parse(request.body);
    const clip = await db.clip.findUniqueOrThrow({ where: { id } });
    if (!['SUGGESTED', 'FAILED'].includes(clip.status) || !clip.durationSeconds || !clip.transcriptJson || clip.submissionStartedAt) throw Object.assign(new Error('Este clipe não está disponível para edição.'), { statusCode: 409 });
    const segments = validateClipSegments(value.segments, clip.durationSeconds);
    return serialize(await db.clip.update({ where: { id }, data: { title: value.title, caption: value.caption, segmentsJson: JSON.stringify(segments), outputPath: null, status: 'SUGGESTED', lastError: null } }));
  });
  app.post('/api/clips/:id/render', async request => {
    const { id } = idSchema.parse(request.params);
    const clip = await db.clip.findUniqueOrThrow({ where: { id } });
    if (clip.status !== 'SUGGESTED' || !clip.durationSeconds || !clip.segmentsJson || !clip.transcriptJson) throw Object.assign(new Error('Revise os trechos antes de gerar.'), { statusCode: 409 });
    validateClipSegments(JSON.parse(clip.segmentsJson), clip.durationSeconds);
    await db.$transaction(async tx => {
      const changed = await tx.clip.updateMany({ where: { id, status: 'SUGGESTED' }, data: { status: 'APPROVED' } });
      if (!changed.count) throw Object.assign(new Error('Renderização já solicitada.'), { statusCode: 409 });
      await tx.job.create({ data: { kind: 'CLIP_RENDER', dedupeKey: `clip-render:${id}:${Date.now()}`, payload: JSON.stringify({ clipId: id }), maxAttempts: 1 } });
    });
    return { ok: true };
  });
  app.post('/api/clips/:id/publish', async request => {
    const { id } = idSchema.parse(request.params);
    const { allowUnverifiedCaption } = z.object({ allowUnverifiedCaption: z.literal(true) }).parse(request.body);
    const clip = await db.clip.findUniqueOrThrow({ where: { id }, include: { account: true } });
    if (clip.status !== 'READY' || !clip.outputPath || clip.submissionStartedAt || !clip.account.enabled) throw Object.assign(new Error('Clipe não está pronto para publicar.'), { statusCode: 409 });
    await db.$transaction(async tx => {
      const changed = await tx.clip.updateMany({ where: { id, status: 'READY', submissionStartedAt: null }, data: { status: 'QUEUED' } });
      if (!changed.count) throw Object.assign(new Error('Envio já solicitado.'), { statusCode: 409 });
      await tx.job.create({ data: { kind: 'CLIP_PUBLISH', dedupeKey: `clip-publish:${id}`, payload: JSON.stringify({ clipId: id, allowUnverifiedCaption }), maxAttempts: 1 } });
    });
    return { ok: true };
  });
  app.post('/api/clips/:id/confirm', async request => {
    const { id } = idSchema.parse(request.params);
    const { postUrl, confirmed } = z.object({ postUrl: z.url(), confirmed: z.literal(true) }).parse(request.body);
    const clip = await db.clip.findUniqueOrThrow({ where: { id }, include: { account: true } });
    if (clip.status !== 'UNKNOWN' || !observedPostLinks([postUrl], clip.account.handle).length) throw Object.assign(new Error('Confira a URL pública da conta antes de confirmar.'), { statusCode: 409 });
    return serialize(await db.clip.update({ where: { id }, data: { status: 'PUBLISHED', postUrl, lastError: 'Publicação conferida manualmente.' } }));
  });
  app.get('/api/clips/:id/file/:kind', async (request, reply) => {
    const { id, kind } = z.object({ id: z.string().min(1).max(100), kind: z.enum(['source', 'video']) }).parse(request.params);
    const clip = await db.clip.findUniqueOrThrow({ where: { id }, include: { batch: true } });
    const filename = kind === 'source' ? clip.sourcePath : clip.outputPath;
    if (!filename) return reply.code(404).send({ error: 'Arquivo ainda não disponível.' });
    const root = path.resolve(kind === 'source' && clip.batch ? clip.batch.sourceRoot : clipDirectory(id)) + path.sep;
    if (!path.resolve(filename).toLowerCase().startsWith(root.toLowerCase())) return reply.code(403).send({ error: 'Arquivo fora da pasta do clipe.' });
    const info = await stat(filename);
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    reply.header('accept-ranges', 'bytes').type(kind === 'source' && path.extname(filename).toLowerCase() === '.mkv' ? 'video/x-matroska' : 'video/mp4');
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (start >= info.size || end < start) return reply.code(416).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${info.size}`).header('content-length', end - start + 1).send(createReadStream(filename, { start, end }));
    }
    return reply.header('content-length', info.size).send(createReadStream(filename));
  });
}
