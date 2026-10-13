import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
mkdirSync(path.resolve(process.env.DATA_DIR || './data'), { recursive: true });
for (const args of [['generate'], ['migrate', 'deploy']]) {
  const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
