import { spawn } from 'node:child_process';
export async function runProcess(executable: string, args: string[], options: { signal?: AbortSignal; timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  options.signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env || process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false, settled = false;
    const kill = () => {
      stopped = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timeout = setTimeout(kill, options.timeout || 180000);
    const abort = () => kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-100000); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-100000); });
    child.on('error', error => { if (settled) return; settled = true; cleanup(); reject(new Error(`Não foi possível executar ${executable}: ${error.message}`)); });
    child.on('close', code => {
      if (settled) return;
      settled = true; cleanup();
      if (options.signal?.aborted) return reject(options.signal.reason || new Error('Tarefa cancelada.'));
      if (stopped) return reject(new Error('A operação excedeu o tempo máximo permitido.'));
      if (code !== 0) return reject(new Error(`${executable.split(/[\\/]/).pop()} encerrou com erro ${code}: ${stderr.slice(-2500) || stdout.slice(-2500)}`));
      resolve(stdout);
    });
  });
}
