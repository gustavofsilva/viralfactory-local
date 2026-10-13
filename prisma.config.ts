import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import path from 'node:path';
const dbPath = path.resolve(process.env.DATA_DIR || './data', 'viralfactory.db').replaceAll('\\', '/');
export default defineConfig({
  schema: 'apps/api/prisma/schema.prisma',
  migrations: { path: 'apps/api/prisma/migrations' },
  datasource: { url: `file:${dbPath}` }
});
