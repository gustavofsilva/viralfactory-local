import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dataDir, whisperModel, piperModel } from './config.js';
import { db, getSettings } from './db.js';
import { ollamaModels } from './ollama.js';
import type { Check } from '@viralfactory/shared';
const exec = promisify(execFile);
export async function runCommand(file: string, args: string[], timeout = 10000) {
  const result = await exec(file, args, { timeout, windowsHide: true, maxBuffer: 1_000_000 });
  return `${result.stdout}\n${result.stderr}`.trim();
}
let cached: { time: number; checks: Check[] } | undefined;
export async function diagnose(fresh = false): Promise<Check[]> {
  if (!fresh && cached && Date.now() - cached.time < 30000) return cached.checks;
  const checks: Check[] = [
    { id: 'node', name: 'Node.js', status: 'ok', detail: process.version },
    { id: 'memory', name: 'Memória RAM', status: os.freemem() < 2 * 1024 ** 3 ? 'warning' : 'ok', detail: `${(os.totalmem() / 1024 ** 3).toFixed(1)} GB totais · ${(os.freemem() / 1024 ** 3).toFixed(1)} GB disponíveis` },
    { id: 'cpu', name: 'Processador', status: 'ok', detail: os.cpus()[0]?.model || 'Não identificado' }
  ];
  async function command(id: string, name: string, file: string, args: string[]) {
    try { const result = await runCommand(file, args); checks.push({ id, name, status: 'ok', detail: result.split('\n')[0].trim() }); return result; }
    catch { checks.push({ id, name, status: 'missing', detail: 'Não disponível no ambiente do projeto.' }); return null; }
  }
  const [ffmpeg] = await Promise.all([
    command('ffmpeg', 'FFmpeg', process.env.FFMPEG_PATH || 'ffmpeg', ['-version']),
    command('python', 'Python', process.env.PYTHON_PATH || 'python', ['--version']),
    command('piper', 'Piper TTS', process.env.PYTHON_PATH || 'python', ['-c', 'import importlib.metadata; print("piper-tts " + importlib.metadata.version("piper-tts"))']),
    command('whisper', 'Whisper', process.env.PYTHON_PATH || 'python', ['-c', 'import importlib.metadata; print("faster-whisper " + importlib.metadata.version("faster-whisper"))'])
  ]);
  try {
    await db.$queryRawUnsafe('SELECT 1');
    checks.push({ id: 'sqlite', name: 'SQLite', status: 'ok', detail: 'Banco local acessível.' });
  } catch { checks.push({ id: 'sqlite', name: 'SQLite', status: 'missing', detail: 'Execute a preparação do banco.' }); }
  const settings = await getSettings();
  try { await access(path.join(whisperModel, 'model.bin')); checks.push({ id: 'whisper-model', name: 'Modelo Whisper', status: 'ok', detail: 'Modelo small disponível no disco de dados.' }); }
  catch { checks.push({ id: 'whisper-model', name: 'Modelo Whisper', status: 'missing', detail: 'Modelo small ainda não preparado.' }); }
  try {
    const models = await ollamaModels();
    checks.push({ id: 'ollama', name: 'Ollama', status: 'ok', detail: 'Serviço local acessível.' });
    const found = models.some(model => model.name === settings.ollamaModel || model.name === `${settings.ollamaModel}:latest`);
    checks.push({ id: 'model', name: 'Modelo de linguagem', status: found ? 'ok' : 'missing', detail: found ? settings.ollamaModel : `${settings.ollamaModel} ainda não foi baixado.` });
  } catch {
    checks.push({ id: 'ollama', name: 'Ollama', status: 'missing', detail: 'O serviço local não respondeu. Instale ou inicie o Ollama.' }, { id: 'model', name: 'Modelo de linguagem', status: 'missing', detail: `${settings.ollamaModel} não pôde ser verificado.` });
  }
  try {
    const files = await readdir(path.join(dataDir, 'models', 'piper'));
    const voices = files.filter(file => file.startsWith('pt_BR') && file.endsWith('.onnx'));
    for (const voice of voices) await access(path.join(dataDir, 'models', 'piper', `${voice}.json`));
    const license = JSON.parse((await (await import('node:fs/promises')).readFile(path.join(dataDir, 'models/piper/license.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const selected = path.basename(piperModel);
    const ready = voices.includes(selected) && license.datasetLicense === 'CC0';
    checks.push({ id: 'voice', name: 'Voz pt-BR', status: ready ? 'ok' : voices.length ? 'warning' : 'missing', detail: ready ? `${selected} · model card registrado (dataset CC0).` : voices.length ? `${voices.join(', ')} — verifique a licença.` : 'Nenhuma voz local configurada.' });
  } catch { checks.push({ id: 'voice', name: 'Voz pt-BR', status: 'missing', detail: 'Nenhuma voz local configurada.' }); }
  if (process.platform === 'win32') {
    try {
      const text = await runCommand('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name']);
      checks.push({ id: 'gpu', name: 'GPU', status: 'ok', detail: text.replaceAll('\n', ', ') });
    } catch { checks.push({ id: 'gpu', name: 'GPU', status: 'warning', detail: 'Não foi possível identificar a GPU; processamento por CPU disponível.' }); }
  } else checks.push({ id: 'gpu', name: 'GPU', status: 'warning', detail: 'Detecção automática de GPU implementada inicialmente para Windows.' });
  if (ffmpeg) {
    try {
      await runCommand(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
      checks.push({ id: 'nvenc', name: 'Encoder NVENC', status: 'ok', detail: 'Codificação H.264 testada com sucesso.' });
    } catch { checks.push({ id: 'nvenc', name: 'Encoder NVENC', status: 'warning', detail: 'Teste de codificação indisponível; usar libx264.' }); }
  } else checks.push({ id: 'nvenc', name: 'Encoder NVENC', status: 'missing', detail: 'Instale FFmpeg para testar o encoder.' });
  try {
    const { statfs } = await import('node:fs/promises');
    const disk = await statfs(dataDir);
    const free = disk.bavail * disk.bsize / 1024 ** 3;
    checks.push({ id: 'disk', name: 'Espaço em disco', status: free < 10 ? 'warning' : 'ok', detail: `${free.toFixed(1)} GB livres no disco de dados.` });
  } catch { checks.push({ id: 'disk', name: 'Espaço em disco', status: 'warning', detail: 'Verifique o espaço disponível na pasta de dados.' }); }
  cached = { time: Date.now(), checks };
  return checks;
}
