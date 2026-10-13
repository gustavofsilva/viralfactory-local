import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import path from 'node:path';

const base = 'D:/ViralFactoryLocal';
const directory = await mkdtemp(path.join(base, 'test-clips-'));
process.env.DATA_DIR = directory;
const root = path.resolve(import.meta.dirname, '..');
const native = new DatabaseSync(path.join(directory, 'viralfactory.db'));
for (const migration of (await readdir(path.join(root, 'apps/api/prisma/migrations'))).filter(name => !name.endsWith('.toml')).sort())
  native.exec(await readFile(path.join(root, 'apps/api/prisma/migrations', migration, 'migration.sql'), 'utf8'));
native.close();
const { db } = await import('../apps/api/src/db.js');
const { renderClip, clipDirectory } = await import('../apps/api/src/clips.js');
const { ffmpegPath } = await import('../apps/api/src/config.js');
function command(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Processo encerrou com ${code}`)));
  });
}
try {
  const account = await db.tikTokAccount.create({ data: { handle: 'testeclips', label: 'Teste de clipes' } });
  const clip = await db.clip.create({ data: { accountId: account.id, title: 'Teste local de clipe', caption: 'Teste local', sourceName: 'sample.mp4', sourceBytes: 1, durationSeconds: 64, status: 'APPROVED', transcriptJson: JSON.stringify([{ text: 'Exemplo de legenda', start: 2, end: 3 }]), segmentsJson: JSON.stringify([{ start: 0, end: 64, text: 'Teste local' }]) } });
  const folder = clipDirectory(clip.id);
  await mkdir(folder, { recursive: true });
  const source = path.join(folder, 'source.mp4');
  await command(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '64', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
  await db.clip.update({ where: { id: clip.id }, data: { sourcePath: source, sourceBytes: (await stat(source)).size } });
  await renderClip(clip.id, AbortSignal.timeout(900000), value => { process.stdout.write(`${value}\n`); return Promise.resolve(); });
  const result = await db.clip.findUniqueOrThrow({ where: { id: clip.id } });
  if (result.status !== 'READY' || !result.outputPath) throw new Error(`Renderização falhou: ${result.lastError}`);
  process.stdout.write(`OK ${result.outputPath}\n`);
  const { buildApp } = await import('../apps/api/src/app.js');
  const app = await buildApp();
  try {
    const accountResponse = await app.inject({ method: 'POST', url: '/api/accounts', payload: { handle: '@OUTRACONTA', label: 'Outra conta' } });
    if (accountResponse.statusCode !== 200 || accountResponse.json().handle !== 'outraconta') throw new Error(`Cadastro de conta: ${accountResponse.body}`);
    const second = accountResponse.json();
    const bytes = await readFile(source);
    const created = await app.inject({ method: 'POST', url: '/api/clips', payload: { accountId: second.id, title: 'Fonte de teste', caption: 'Legenda de teste', sourceName: 'sample.mp4', sourceBytes: bytes.length } });
    if (created.statusCode !== 200) throw new Error(`Criar clipe: ${created.body}`);
    const importedId = created.json().id;
    const chunk = await app.inject({ method: 'PUT', url: `/api/clips/${importedId}/chunk`, headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': '0' }, payload: bytes });
    if (chunk.statusCode !== 200 || chunk.json().offset !== bytes.length) throw new Error(`Upload: ${chunk.body}`);
    const complete = await app.inject({ method: 'POST', url: `/api/clips/${importedId}/complete`, payload: {} });
    if (complete.statusCode !== 200 || (await db.clip.findUniqueOrThrow({ where: { id: importedId } })).status !== 'IMPORTED') throw new Error(`Concluir upload: ${complete.body}`);
    process.stdout.write('OK contas separadas e importação local pela API\n');
  } finally { await app.close(); }
} finally {
  await db.$disconnect();
  if (!path.resolve(directory).startsWith(path.resolve(base) + path.sep)) throw new Error('Pasta de teste fora de D:/ViralFactoryLocal');
  await rm(directory, { recursive: true, force: true });
}
