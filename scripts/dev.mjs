import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
const storage = path.dirname(path.resolve(process.env.DATA_DIR || path.join(root, 'data')));
const temporaryDirectory = path.join(storage, 'tmp');
mkdirSync(temporaryDirectory, { recursive: true });
process.env.TEMP = temporaryDirectory;
process.env.TMP = temporaryDirectory;
process.env.CUDA_CACHE_PATH = path.join(storage, 'cache/cuda');
if (!existsSync(path.join(root, 'apps/api/src/generated/prisma/client.ts'))) {
  console.error('Banco não preparado. Execute npm run db:setup antes de iniciar.'); process.exit(1);
}
if (production && !existsSync(path.join(root, 'apps/web/dist/index.html'))) {
  console.error('Dashboard não compilado. Execute npm run build.'); process.exit(1);
}
const children = [];
function run(args, cwd = root, executable = process.execPath, env = process.env) {
  const child = spawn(executable, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('exit', code => { if (!closing) { console.error(`Um serviço encerrou (${code}).`); shutdown(code || 0); } });
}
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
const localOllama = path.join(process.env.TOOLS_DIR || path.join(root, 'data/tools'), 'ollama', 'ollama.exe');
if (existsSync(localOllama)) {
  try {
    await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(1000) });
  } catch {
    const models = process.env.OLLAMA_MODELS || path.join(process.env.DATA_DIR || path.join(root, 'data'), 'models/ollama');
    const childEnv = { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_MODELS: models, OLLAMA_NO_CLOUD: 'true', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: '4096', OLLAMA_KEEP_ALIVE: '30s', USERPROFILE: path.join(process.env.DATA_DIR || path.join(root, 'data'), 'ollama-profile') };
    run(['serve'], path.dirname(localOllama), localOllama, childEnv);
    for (let attempt = 0; attempt < 20; attempt++) {
      try { const response = await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
run(['--import', 'tsx', 'apps/api/src/server.ts']);
if (!production) run([path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], path.join(root, 'apps/web'));
console.log(`ViralFactory Local: http://127.0.0.1:${production ? process.env.API_PORT || 4310 : process.env.WEB_PORT || 5173}`);
