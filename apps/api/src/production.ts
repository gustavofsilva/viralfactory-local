import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Artifacts, Script, MediaAsset, Settings, pipelineStates, TimedWord } from '@viralfactory/shared';
import { db, getSettings, type Db } from './db.js';
import { dataDir, rootDir, pythonPath, piperModel, whisperModel, ffmpegPath, ffprobePath } from './config.js';
import { PermanentError } from './queue.js';
import { runProcess } from './subprocess.js';
import { commonsAsset, sourceImageAsset } from './media-provider.js';
import { scriptRisk } from './content-risk.js';
import { getAgentSettings } from './agent.js';
type State = typeof pipelineStates[number];
export function productionRevision(script: Script, settings: Settings) {
  return createHash('sha256').update(JSON.stringify({ script, template: settings.template, duration: settings.durationSeconds, speed: settings.ttsSpeed, size: settings.subtitleSize, color: settings.subtitleColor, margin: settings.subtitleMargin, provider: settings.mediaProvider, voice: piperModel, branding: 'brasilgerais-intro-1s', version: 8 })).digest('hex').slice(0, 20);
}
export function narrationPadding(duration: number) {
  return duration >= 13.5 && duration < 15 ? 15.2 - duration : 0;
}
const exists = async (filename: string | undefined) => { if (!filename) return false; try { await access(filename); return true; } catch { return false; } };
export function sceneDurations(scenes: Script['scenes'], words: TimedWord[], duration: number) {
  const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const normalizedWords = words.map(word => normalize(word.text));
  const starts = [0];
  for (let index = 1; index < scenes.length; index++) {
    const prefix = scenes[index].text.split(/\s+/).map(normalize).filter(Boolean).slice(0, 3);
    let found = -1;
    if (prefix.length) for (let offset = 0; offset <= words.length-prefix.length; offset++) {
      if (words[offset].start > starts[index-1] + 1 && prefix.every((word, inner) => word === normalizedWords[offset+inner])) { found = offset; break; }
    }
    const fallback = Math.min(words.length-1, Math.floor(words.length * index / scenes.length));
    const preferred = words[found >= 0 ? found : fallback]?.start ?? duration * index / scenes.length;
    starts.push(Math.min(duration-(scenes.length-index)*0.5, Math.max(starts[index-1]+0.5, preferred)));
  }
  return starts.map((start, index) => (starts[index+1] ?? duration) - start);
}
export async function mediaTask<T>(task: 'tts' | 'subtitles' | 'card' | 'prepare' | 'clip_intro', request: object, directory: string, signal: AbortSignal) {
  await mkdir(directory, { recursive: true });
  const token = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 12);
  const input = path.join(directory, `${task}-${token}.request.json`), output = path.join(directory, `${task}-${token}.response.json`);
  await writeFile(input, JSON.stringify(request), 'utf8');
  const duration = 'duration' in request && typeof request.duration === 'number' ? request.duration : 0;
  const timeout = task === 'prepare' ? 1800000 : task === 'subtitles' ? Math.max(600000, Math.ceil(duration * 1200)) : 240000;
  await runProcess(pythonPath, ['-X', 'utf8', path.join(rootDir, 'workers/media/worker.py'), task, '--request', input, '--response', output], { signal, timeout, env: { ...process.env, TEMP: path.join(path.dirname(dataDir), 'tmp'), TMP: path.join(path.dirname(dataDir), 'tmp'), PYTHONUTF8: '1', HF_HUB_DISABLE_XET: '1', HF_HOME: process.env.HF_HOME || path.join(dataDir, 'cache/huggingface') } });
  return JSON.parse(await readFile(output, 'utf8')) as T;
}
export async function probeFile(filename: string, signal?: AbortSignal) {
  const text = await runProcess(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', filename], { signal, timeout: 20000 });
  return JSON.parse(text) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[] };
}
async function chooseEncoder(settings: Settings, signal: AbortSignal, log: (message: string) => Promise<void>) {
  if (settings.renderEncoder === 'cpu') return 'libx264';
  try {
    await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { signal, timeout: 15000 });
    await log('NVENC confirmado por codificação real.');
    return 'h264_nvenc';
  } catch { signal.throwIfAborted(); await log('NVENC indisponível; renderização por libx264.'); return 'libx264'; }
}
export async function produceVideo(videoId: string, jobId: string, owner: string, signal: AbortSignal, log: (message: string) => Promise<void>, client: Db = db) {
  const video = await client.video.findUniqueOrThrow({ where: { id: videoId } });
  if (!video.scriptJson) throw new PermanentError('Gere ou salve um roteiro antes de produzir o vídeo.');
  const script = JSON.parse(video.scriptJson) as Script;
  if (scriptRisk(script) === 'sensitive' && !video.scriptReviewedAt && !(await getAgentSettings(client)).autoPublishSensitive) throw new PermanentError('Este assunto é sensível. A revisão humana do roteiro é necessária antes da produção.');
  const settings = await getSettings(client);
  const revision = productionRevision(script, settings);
  const previous = video.artifactJson ? JSON.parse(video.artifactJson) as Artifacts : null;
  let artifacts: Artifacts = previous?.revision === revision ? previous : { revision };
  const directory = path.join(dataDir, 'videos', videoId, revision);
  await mkdir(directory, { recursive: true });
  const save = async (state: State) => {
    signal.throwIfAborted();
    await client.$transaction(async tx => {
      const active = await tx.job.findFirst({ where: { id: jobId, status: 'RUNNING', leaseOwner: owner } });
      if (!active) throw new Error('A produção foi cancelada ou retomada por outro worker.');
      await tx.video.update({ where: { id: videoId }, data: { state, artifactJson: JSON.stringify(artifacts), lastError: null, outputPath: artifacts.render?.path || null, reviewRequired: true } });
    });
  };
  if (await exists(artifacts.render?.path)) {
    await probeFile(artifacts.render!.path, signal);
    await save('REVIEW_PENDING'); await log('MP4 já salvo; arquivo preservado para revisão.'); return;
  }
  if (!(await exists(piperModel))) throw new PermanentError('Voz Piper não encontrada. Prepare as ferramentas locais no disco D.');
  if (!(await exists(path.join(whisperModel, 'model.bin')))) throw new PermanentError('Modelo Whisper local não preparado.');
  await runProcess(ffmpegPath, ['-version'], { signal, timeout: 10000 });
  if (!(await exists(artifacts.audio?.path))) {
    await log('Gerando narração pt-BR com Piper local.');
    const audio = await mediaTask<{ output: string; duration: number; voice: string }>('tts', { text: script.narration, model: piperModel, output: path.join(directory, 'narration.wav'), speed: settings.ttsSpeed }, directory, signal);
    const targetDuration = Math.max(15.05, settings.durationSeconds / settings.ttsSpeed);
    const tempo = audio.duration / targetDuration;
    if (Math.abs(audio.duration - targetDuration) > 2 && tempo >= 0.7 && tempo <= 1.4) {
      const fitted = path.join(directory, 'narration-fitted.wav');
      await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audio.output, '-af', `atempo=${tempo.toFixed(6)}`, '-c:a', 'pcm_s16le', fitted], { signal, timeout: 60000 });
      audio.output = fitted;
      audio.duration = Number((await probeFile(fitted, signal)).format.duration);
      await log(`Ritmo ajustado à duração desejada: ${audio.duration.toFixed(1)} segundos.`);
    }
    const padding = narrationPadding(audio.duration);
    if (padding) {
      const padded = path.join(directory, 'narration-padded.wav');
      await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audio.output, '-af', `apad=pad_dur=${padding.toFixed(3)}`, '-t', '15.2', '-c:a', 'pcm_s16le', padded], { signal, timeout: 60000 });
      audio.output = padded;
      audio.duration = Number((await probeFile(padded, signal)).format.duration);
      await log(`Final do clipe ajustado para ${audio.duration.toFixed(1)} segundos, mantendo a velocidade da fala.`);
    }
    artifacts.audio = { path: audio.output, duration: audio.duration, voice: audio.voice };
    if (audio.duration < 15 || audio.duration > 90) throw new PermanentError(`A narração tem ${audio.duration.toFixed(1)} segundos. Edite o roteiro ou a velocidade para ficar entre 15 e 90 segundos.`);
    await save('AUDIO_READY'); await log(`Narração salva: ${audio.duration.toFixed(1)} segundos.`);
  } else { await save('AUDIO_READY'); await log('Narração anterior reutilizada.'); }
  if (!artifacts.media || !(await Promise.all(artifacts.media.cards.map(exists))).every(Boolean)) {
    await log('Preparando cenas e procurando materiais licenciados.');
    const cards: string[] = [], assets: MediaAsset[] = [];
    const scenes = script.scenes.slice(0, 8);
    let misses = 0;
    for (let index = 0; index < scenes.length; index++) {
      signal.throwIfAborted();
      const scene = scenes[index];
      let asset: MediaAsset | null = null;
      if (settings.mediaProvider === 'commons') {
        const articleUrls = (scene.sourceUrls || (scene.sourceUrl ? [scene.sourceUrl] : script.sourceUrls)).filter(url => script.sourceUrls.includes(url));
        for (const articleUrl of articleUrls) {
          try { asset = await sourceImageAsset(articleUrl, signal); } catch (error) { signal.throwIfAborted(); await log(`Imagem da fonte: ${error instanceof Error ? error.message : error}. Buscando alternativa.`); }
          if (asset) break;
        }
        if (!asset && misses < 2) {
          try { asset = await commonsAsset(scene.visualQuery, signal); } catch (error) { signal.throwIfAborted(); await log(`Busca de mídia: ${error instanceof Error ? error.message : error}. Usando grafismo próprio.`); }
          if (!asset) misses++;
        }
      }
      const output = path.join(directory, `scene-${index}.png`);
      try {
        await mediaTask('card', { title: scene.title || script.coverText, sectionLabel: scene.sectionLabel, sceneText: scene.text, image: asset?.path, imageLabel: asset?.kind === 'source' ? 'FOTO DA FONTE' : 'IMAGEM ILUSTRATIVA', imageCredit: asset ? `${asset.author}${asset.kind === 'commons' ? ' / Wikimedia Commons' : ''}` : undefined, output, index, total: scenes.length, template: settings.template }, directory, signal);
      } catch (error) {
        if (!asset) throw error;
        signal.throwIfAborted();
        await log('A imagem não pôde ser composta. Gerando cena original.');
        asset = null;
        await mediaTask('card', { title: scene.title || script.coverText, sectionLabel: scene.sectionLabel, sceneText: scene.text, output, index, total: scenes.length, template: settings.template }, directory, signal);
      }
      cards.push(output);
      assets.push(asset || { originUrl: 'local:generated', author: 'ViralFactory Local', license: 'Original', attribution: 'Grafismo original criado programaticamente para esta produção.', restrictions: 'Não representa uma fotografia do acontecimento.', acquiredAt: new Date().toISOString(), path: output, kind: 'graphic' });
      await log(`Cena ${index+1}/${scenes.length}: ${asset ? asset.license : 'grafismo original'}.`);
    }
    artifacts.media = { cards, assets, template: settings.template };
    await save('MEDIA_READY');
  } else { await save('MEDIA_READY'); await log('Cenas anteriores reutilizadas.'); }
  if (!(await exists(artifacts.subtitles?.path))) {
    await log('Obtendo timestamps de palavras com Whisper em CPU.');
    const subtitles = await mediaTask<{ output: string; words: TimedWord[]; similarity: number }>('subtitles', { model: whisperModel, audio: artifacts.audio!.path, text: script.narration, output: path.join(directory, 'captions.ass'), duration: artifacts.audio!.duration, offset: 1, style: { size: settings.subtitleSize, color: settings.subtitleColor, margin: settings.subtitleMargin } }, directory, signal);
    artifacts.subtitles = { path: subtitles.output, wordCount: subtitles.words.length, similarity: subtitles.similarity, words: subtitles.words };
    await save('SUBTITLES_READY'); await log(`Legendas salvas: ${subtitles.words.length} palavras, correspondência ${(subtitles.similarity * 100).toFixed(0)}%.`);
  } else { await save('SUBTITLES_READY'); await log('Legendas anteriores reutilizadas.'); }
  const audio = artifacts.audio!, media = artifacts.media!;
  const temporary = path.join(directory, 'final.part.mp4'), final = path.join(directory, 'final.mp4');
  const subtitleTarget = path.join(directory, 'captions.ass');
  if (artifacts.subtitles!.path !== subtitleTarget) await copyFile(artifacts.subtitles!.path, subtitleTarget);
  const intro = path.join(directory, 'intro.png');
  if (!(await exists(intro))) await mediaTask('card', { intro: true, template: settings.template, output: intro }, directory, signal);
  let encoder = await chooseEncoder(settings, signal, log);
  const durations = sceneDurations(script.scenes.slice(0, media.cards.length), artifacts.subtitles!.words, audio.duration);
  const render = async (selectedEncoder: string) => {
    const args = ['-hide_banner', '-loglevel', 'warning', '-y'];
    const filters: string[] = [];
    args.push('-loop', '1', '-framerate', '30', '-i', intro);
    filters.push('[0:v]scale=1080:1920,setsar=1,trim=duration=1,setpts=PTS-STARTPTS[intro]');
    for (let index = 0; index < media.cards.length; index++) {
      const duration = durations[index];
      args.push('-loop', '1', '-framerate', '30', '-i', media.cards[index]);
      filters.push(`[${index+1}:v]scale=1080:1920,setsar=1,zoompan=z='min(pzoom+0.00008,1.025)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,trim=duration=${duration.toFixed(5)},setpts=PTS-STARTPTS[v${index}]`);
    }
    args.push('-i', audio.path);
    filters.push(`[intro]${media.cards.map((_, index) => `[v${index}]`).join('')}concat=n=${media.cards.length+1}:v=1:a=0[base]`, "[base]ass=filename='captions.ass'[v]", `[${media.cards.length+1}:a]adelay=1000:all=1,loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
    args.push('-filter_complex_threads', '2', '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', selectedEncoder, '-pix_fmt', 'yuv420p', '-r', '30');
    if (selectedEncoder === 'h264_nvenc') args.push('-preset', 'p4', '-b:v', '5M');
    else args.push('-preset', 'veryfast', '-crf', '23', '-threads', '4');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', (audio.duration+1).toFixed(5), '-movflags', '+faststart', temporary);
    await runProcess(ffmpegPath, args, { signal, timeout: 900000, cwd: directory });
  };
  await log(`Renderizando 1080×1920, 30 FPS, H.264/AAC (${encoder}).`);
  try { await render(encoder); }
  catch (error) { signal.throwIfAborted(); if (encoder !== 'h264_nvenc') throw error; encoder = 'libx264'; await log('A renderização NVENC falhou; repetindo com libx264.'); await render(encoder); }
  signal.throwIfAborted();
  const verified = await probeFile(temporary, signal);
  const videoStream = verified.streams.find(stream => stream.codec_type === 'video');
  if (videoStream?.width !== 1080 || videoStream.height !== 1920 || videoStream.codec_name !== 'h264' || !verified.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac') || Math.abs(Number(verified.format.duration) - (audio.duration+1)) > 1) throw new Error('O MP4 não passou na verificação de resolução, codecs e duração.');
  await rename(temporary, final);
  const coverPath = path.join(directory, 'cover.png');
  await copyFile(media.cards[0], coverPath);
  artifacts.render = { path: final, coverPath, duration: Number(verified.format.duration), encoder, width: 1080, height: 1920 };
  await save('RENDERED');
  const metadata = { title: script.title, scriptOrigin: script.origin || 'unknown', description: script.description, hashtags: script.hashtags, sources: script.sourceUrls, media: media.assets, voice: { model: audio.voice, modelCard: 'https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/faber/medium/MODEL_CARD', datasetLicense: 'CC0' }, duration: artifacts.render.duration, reviewRequired: true };
  await writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  await save('REVIEW_PENDING');
  await log(`MP4 verificado e salvo (${artifacts.render.duration.toFixed(1)}s). Aguardando revisão humana.`);
}
