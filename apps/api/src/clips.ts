import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { db } from './db.js';
import { dataDir, ffmpegPath, ollamaUrl, whisperModel } from './config.js';
import { mediaTask, probeFile } from './production.js';
import { runProcess } from './subprocess.js';
import { PermanentError } from './queue.js';
import { bridgeForAccount } from './extension-bridge.js';
import { getAgentSettings } from './agent.js';
import { publishByExtension } from './extension-publisher.js';

export const clipSegmentSchema = z.object({ start: z.number().min(0), end: z.number().positive(), text: z.string().max(1200).default('') });
export const clipSegmentsSchema = z.array(clipSegmentSchema).min(1).max(8);
export type ClipSegment = z.infer<typeof clipSegmentSchema>;
export type ClipWord = { text: string; start: number; end: number };
export function clipDirectory(id: string) { return path.join(dataDir, 'clips', id); }

export function validateClipSegments(segments: ClipSegment[], duration: number) {
  const parsed = clipSegmentsSchema.parse(segments);
  const ordered = parsed.map(segment => ({ ...segment, start: Number(segment.start.toFixed(2)), end: Number(segment.end.toFixed(2)) }));
  let total = 0;
  for (const [index, segment] of ordered.entries()) {
    if (segment.end - segment.start < 3 || segment.end > duration + 0.1) throw new Error(`Trecho ${index + 1} fora da duração do vídeo ou menor que 3 s.`);
    if (ordered.some((other, otherIndex) => otherIndex !== index && segment.start < other.end && other.start < segment.end)) throw new Error('Os trechos não podem se sobrepor.');
    total += segment.end - segment.start;
  }
  if (total < 60 || total > 90) throw new Error('A seleção deve somar de 60 a 90 segundos.');
  return ordered;
}

export function candidateSegments(words: ClipWord[], duration: number) {
  const chunks: ClipSegment[] = [];
  let first = 0;
  while (first < words.length) {
    let last = first;
    while (last + 1 < words.length && words[last].end - words[first].start < 16) last++;
    while (last + 1 < words.length && words[last].end - words[first].start < 24 && !/[.!?]$/.test(words[last].text)) last++;
    const start = Math.max(chunks.at(-1)?.end ?? 0, words[first].start - 0.15);
    const gap = words[last + 1] ? Math.max(0, words[last + 1].start - words[last].end) : 0.4;
    const end = Math.min(duration, words[last].end + Math.min(0.2, gap / 2));
    if (end - start >= 3) chunks.push({ start, end, text: words.slice(first, last + 1).map(word => word.text).join(' ') });
    first = last + 1;
  }
  return chunks;
}

function narrativeScore(segment: ClipSegment) {
  const words = segment.text.split(/\s+/).filter(Boolean);
  return Math.min(words.length, 65) + (/[!?]/.test(segment.text) ? 12 : 0) + (/[.:]/.test(segment.text) ? 4 : 0) + new Set(words.map(word => word.toLowerCase())).size / 4;
}
export function narrativeCandidates(chunks: ClipSegment[], duration: number) {
  const interior = chunks.filter(chunk => chunk.start >= 90 && chunk.end <= duration - 75);
  const pool = interior.length >= 4 ? interior : chunks;
  return [...pool].sort((a, b) => narrativeScore(b) - narrativeScore(a)).slice(0, 24).sort((a, b) => a.start - b.start);
}
async function selectHighlights(chunks: ClipSegment[], model: string, signal: AbortSignal, narrative = false) {
  const schema = z.object({ ids: z.array(z.number().int().min(0).max(chunks.length - 1)).min(1).max(8) });
  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), body: JSON.stringify({ model, stream: false, think: false, format: z.toJSONSchema(schema), options: { temperature: 0.1, num_predict: 400 }, messages: [
      { role: 'system', content: narrative ? 'Escolha apenas IDs de trechos existentes para um clipe narrativo de 60 a 90 segundos. Busque a cena de maior tensão, virada ou emoção que tenha contexto suficiente para ser entendida. Evite abertura, encerramento, recapitulação e falas soltas. Mantenha a ordem original. Retorne somente JSON.' : 'Escolha apenas IDs de trechos existentes para um clipe informativo e coerente de 60 a 90 segundos. Priorize momentos importantes, concretos e compreensíveis, sem publicidade, repetições ou frases cortadas. Preserve a ordem cronológica. Retorne somente JSON.' },
      { role: 'user', content: JSON.stringify(chunks.map((chunk, id) => ({ id, seconds: Math.round(chunk.end - chunk.start), text: chunk.text.slice(0, narrative ? 350 : 750) }))) }
    ] }) });
    if (!response.ok) throw new Error('Modelo indisponível');
    const result = await response.json() as { message?: { content?: string } };
    return [...new Set(schema.parse(JSON.parse(result.message?.content || '{}')).ids)].sort((a, b) => a - b);
  } catch { signal.throwIfAborted(); return chunks.map((_, id) => id).sort((a, b) => narrative ? narrativeScore(chunks[b]) - narrativeScore(chunks[a]) : a - b); }
}

export function fitHighlights(chunks: ClipSegment[], preferred: number[], duration: number, narrative = false) {
  const ids = [...new Set([...preferred, ...chunks.map((_, id) => id)])];
  const selected: ClipSegment[] = [];
  let total = 0;
  for (const id of ids) {
    const segment = chunks[id];
    if (!segment || total >= 75 || selected.length >= 8) continue;
    const available = 88 - total;
    if (available < 3) break;
    const adjusted = { ...segment, end: Math.min(segment.end, segment.start + available) };
    if (adjusted.end - adjusted.start < 3) continue;
    selected.push(adjusted); total += adjusted.end - adjusted.start;
  }
  selected.sort((a, b) => a.start - b.start);
  if (total < 60 && duration >= 60) {
    const center = narrative && chunks.length ? [...chunks].sort((a, b) => narrativeScore(b) - narrativeScore(a))[0].start : 0;
    const start = Math.min(Math.max(0, center - 15), duration - 65);
    const fallback: ClipSegment[] = [{ start, end: Math.min(duration, start + 75), text: 'Seleção contínua: ajuste os cortes antes de gerar.' }];
    return validateClipSegments(fallback, duration);
  }
  return validateClipSegments(selected, duration);
}

export async function analyzeClip(id: string, signal: AbortSignal, log: (value: string) => Promise<void>) {
  const clip = await db.clip.findUniqueOrThrow({ where: { id } });
  if (!['IMPORTED', 'ANALYZING'].includes(clip.status) || !clip.sourcePath || !clip.durationSeconds) throw new PermanentError('Arquivo não está pronto para análise.');
  const directory = clipDirectory(id);
  try {
    await db.clip.update({ where: { id }, data: { status: 'ANALYZING', lastError: null } });
    await mkdir(directory, { recursive: true });
    const audio = path.join(directory, 'audio.wav');
    await log('Extraindo áudio e transcrevendo com Whisper local.');
    await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip.sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio], { signal, timeout: 180000 });
    const transcript = await mediaTask<{ words: ClipWord[]; text: string }>('subtitles', { audio, model: whisperModel, text: '', output: path.join(directory, 'source.ass'), duration: clip.durationSeconds }, directory, signal);
    const narrative = !!clip.batchId;
    const allChunks = candidateSegments(transcript.words, clip.durationSeconds);
    const chunks = narrative ? narrativeCandidates(allChunks, clip.durationSeconds) : allChunks;
    if (!chunks.length) throw new Error('A transcrição não encontrou fala suficiente para sugerir cortes.');
    const preferences = await db.setting.findUnique({ where: { key: 'preferences' } });
    const model = preferences ? JSON.parse(preferences.value).ollamaModel || 'qwen3:4b' : 'qwen3:4b';
    await log(`Avaliando ${chunks.length} trechos com o modelo local.`);
    const preferred = await selectHighlights(chunks, model, signal, narrative);
    const selected = fitHighlights(chunks, preferred, clip.durationSeconds, narrative);
    await db.clip.update({ where: { id }, data: { transcriptJson: JSON.stringify(transcript.words), segmentsJson: JSON.stringify(selected), status: 'SUGGESTED' } });
    await log(`Sugestão de ${selected.length} trechos pronta para revisão.`);
  } catch (error) {
    await db.clip.update({ where: { id }, data: { status: 'FAILED', lastError: error instanceof Error ? error.message : String(error) } });
    throw new PermanentError(error instanceof Error ? error.message : String(error));
  }
}

function srtTime(seconds: number) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(millis / 3600000)).padStart(2, '0')}:${String(Math.floor(millis / 60000) % 60).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')},${String(millis % 1000).padStart(3, '0')}`;
}
export function clipSubtitles(words: ClipWord[], segments: ClipSegment[]) {
  const shifted: ClipWord[] = [];
  let offset = 1;
  for (const segment of segments) {
    shifted.push(...words.filter(word => word.start >= segment.start && word.end <= segment.end).map(word => ({ ...word, start: offset + word.start - segment.start, end: offset + word.end - segment.start })));
    offset += segment.end - segment.start;
  }
  const lines: string[] = [];
  for (let index = 0; index < shifted.length; index += 6) {
    const group = shifted.slice(index, index + 6);
    lines.push(`${lines.length + 1}\n${srtTime(group[0].start)} --> ${srtTime(group.at(-1)!.end)}\n${group.map(word => word.text).join(' ')}\n`);
  }
  return lines.join('\n');
}

export async function renderClip(id: string, signal: AbortSignal, log: (value: string) => Promise<void>) {
  const clip = await db.clip.findUniqueOrThrow({ where: { id }, include: { account: true } });
  if (!['APPROVED', 'RENDERING'].includes(clip.status) || !clip.sourcePath || !clip.durationSeconds || !clip.segmentsJson || !clip.transcriptJson) throw new PermanentError('Revise os trechos antes de gerar o clipe.');
  const segments = validateClipSegments(JSON.parse(clip.segmentsJson), clip.durationSeconds);
  const directory = clipDirectory(id);
  try {
    await db.clip.update({ where: { id }, data: { status: 'RENDERING', lastError: null } });
    await mkdir(directory, { recursive: true });
    const pieces: string[] = [];
    const intro = path.join(directory, 'intro.png');
    const overlay = path.join(directory, 'overlay.png');
    await mediaTask('clip_intro', { output: intro, overlay, handle: clip.account.handle, label: clip.account.label }, directory, signal);
    const introVideo = path.join(directory, 'part-intro.mp4');
    await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-t', '1', '-i', intro, '-f', 'lavfi', '-t', '1', '-i', 'anullsrc=r=44100:cl=stereo', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2600k', '-c:a', 'aac', '-b:a', '128k', '-shortest', introVideo], { signal, timeout: 60000 });
    pieces.push(introVideo);
    for (const [index, segment] of segments.entries()) {
      const filename = path.join(directory, `part-${index}.mp4`);
      await log(`Gerando trecho ${index + 1}/${segments.length}.`);
      await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(segment.start), '-t', String(segment.end - segment.start), '-i', clip.sourcePath, '-loop', '1', '-i', overlay, '-filter_complex', '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=rgba[base];[base][1:v]overlay=0:0:shortest=1,format=yuv420p[v]', '-map', '[v]', '-map', '0:a:0', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,aformat=channel_layouts=stereo', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2600k', '-maxrate', '2800k', '-bufsize', '5600k', '-c:a', 'aac', '-b:a', '128k', filename], { signal, timeout: 300000 });
      pieces.push(filename);
    }
    const manifest = path.join(directory, 'parts.txt');
    await writeFile(manifest, pieces.map(item => `file '${item.replaceAll("'", "'\\''").replaceAll('\\', '/')}'`).join('\n'), 'utf8');
    const combined = path.join(directory, 'combined.mp4');
    await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-c', 'copy', combined], { signal, timeout: 120000 });
    const subtitles = path.join(directory, 'caption.srt');
    await writeFile(subtitles, clipSubtitles(JSON.parse(clip.transcriptJson), segments), 'utf8');
    const output = path.join(directory, 'final.mp4');
    await log('Aplicando legendas e conferindo o MP4 final.');
    await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', combined, '-vf', "subtitles=caption.srt:force_style='Fontname=Arial,Fontsize=18,Outline=2,Shadow=1,MarginV=270',scale=720:1280:flags=lanczos,fps=24,format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '3.1', '-b:v', '1100k', '-maxrate', '1400k', '-bufsize', '2800k', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output], { signal, timeout: 600000, cwd: directory });
    const info = await probeFile(output, signal);
    const bytes = (await stat(output)).size;
    if (bytes > 40 * 1024 * 1024 || Number(info.format.duration) < 60 || Number(info.format.duration) > 92) throw new Error(`MP4 fora do limite da extensão: ${bytes} bytes, ${info.format.duration} s.`);
    await db.clip.update({ where: { id }, data: { outputPath: output, status: 'READY' } });
    await log(`Clipe pronto: ${Number(info.format.duration).toFixed(1)} s e ${(bytes / 1048576).toFixed(1)} MB.`);
  } catch (error) {
    await db.clip.update({ where: { id }, data: { status: 'FAILED', lastError: error instanceof Error ? error.message : String(error) } });
    throw new PermanentError(error instanceof Error ? error.message : String(error));
  }
}

export async function publishClip(id: string, jobId: string, owner: string, allowUnverifiedCaption: boolean, skipCaption: boolean, signal: AbortSignal, log: (value: string) => Promise<void>) {
  const clip = await db.clip.findUniqueOrThrow({ where: { id }, include: { account: true } });
  if (clip.status !== 'QUEUED' || !clip.outputPath || clip.submissionStartedAt || clip.postUrl || !clip.account.enabled) throw new PermanentError('Clipe indisponível ou envio anterior existente.');
  const primary = (await getAgentSettings()).accountHandle;
  const bridge = bridgeForAccount(clip.account.handle, primary);
  const directory = path.join(clipDirectory(id), 'publication');
  const authorize = async () => {
    const latest = await db.clip.findUniqueOrThrow({ where: { id }, include: { account: true } });
    if (!latest.account.enabled || latest.account.handle !== clip.account.handle || latest.outputPath !== clip.outputPath || latest.caption !== clip.caption || latest.postUrl || !['QUEUED', 'SENDING'].includes(latest.status) || (latest.status === 'QUEUED' && latest.submissionStartedAt) || (latest.status === 'SENDING' && !latest.submissionStartedAt)) throw new PermanentError('Clipe ou conta alterados durante o envio.');
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== 'RUNNING' || job.leaseOwner !== owner) throw new PermanentError('Tarefa de envio cancelada.');
  };
  const beforeSubmit = async () => {
    await authorize();
    const latest = await db.clip.findUniqueOrThrow({ where: { id } });
    if (latest.status !== 'QUEUED' || latest.submissionStartedAt) throw new PermanentError('Envio já iniciado.');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'intent.json'), JSON.stringify({ clipId: id, account: clip.account.handle, file: clip.outputPath, caption: clip.caption, at: new Date().toISOString() }), 'utf8');
    const changed = await db.clip.updateMany({ where: { id, status: 'QUEUED', submissionStartedAt: null }, data: { status: 'SENDING', submissionStartedAt: new Date() } });
    if (!changed.count) throw new PermanentError('Envio já iniciado.');
  };
  try {
    const result = await publishByExtension({ file: clip.outputPath, caption: clip.caption, account: clip.account.handle, evidenceDirectory: directory, signal, beforeSubmit, authorize, allowUnverifiedCaption, skipCaption }, bridge);
    await db.clip.update({ where: { id }, data: { status: 'PUBLISHED', postUrl: result.postUrl, lastError: result.captionVerified ? null : 'Legenda pública não verificada pelo TikTok.' } });
    await log(`Publicado em ${result.postUrl}`);
  } catch (error) {
    const current = await db.clip.findUniqueOrThrow({ where: { id } });
    await db.clip.update({ where: { id }, data: { status: current.submissionStartedAt ? 'UNKNOWN' : 'BLOCKED', lastError: error instanceof Error ? error.message : String(error) } });
    throw new PermanentError(error instanceof Error ? error.message : String(error));
  }
}

export async function reconcileClipSubmissions() {
  await db.clip.updateMany({ where: { status: 'SENDING' }, data: { status: 'UNKNOWN', lastError: 'Envio interrompido. Confira a conta antes de qualquer nova tentativa.' } });
  const queued = await db.clip.findMany({ where: { status: 'QUEUED', submissionStartedAt: null }, select: { id: true } });
  for (const clip of queued) {
    const active = await db.job.findFirst({ where: { dedupeKey: `clip-publish:${clip.id}`, status: { in: ['QUEUED', 'RETRY_PENDING'] } } });
    if (!active) await db.clip.updateMany({ where: { id: clip.id, status: 'QUEUED', submissionStartedAt: null }, data: { status: 'BLOCKED', lastError: 'Tarefa de envio interrompida antes da publicação.' } });
  }
}
