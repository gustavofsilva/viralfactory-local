import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/prisma/client.js';
import { dbUrl } from './config.js';
import { agentSettingsSchema, defaultSettings, settingsSchema } from '@viralfactory/shared';
export function createDb(url = dbUrl) {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url, timeout: 5000 }) });
}
export type Db = ReturnType<typeof createDb>;
export const db = createDb();
export async function getSettings(client: Db = db) {
  const row = await client.setting.findUnique({ where: { key: 'preferences' } });
  return row ? settingsSchema.parse(JSON.parse(row.value)) : defaultSettings;
}
export async function seed(client: Db = db) {
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await client.setting.upsert({ where: { key: 'preferences' }, create: { key: 'preferences', value: JSON.stringify(defaultSettings) }, update: {} });
  const legacyAgent = await client.setting.findUnique({ where: { key: 'agent' } });
  if (legacyAgent) {
    const handle = agentSettingsSchema.parse(JSON.parse(legacyAgent.value)).accountHandle.toLowerCase();
    if (handle) await client.tikTokAccount.upsert({ where: { handle }, create: { handle, label: `@${handle}` }, update: {} });
  }
  const sources = [
    { name: 'Google News · Brasil', url: 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419', category: 'Todas' },
    { name: 'Google News · Em andamento', url: 'https://news.google.com/rss/search?q=%22ao+vivo%22+OR+%22hoje%22+when%3A1d&hl=pt-BR&gl=BR&ceid=BR:pt-419', category: 'Agora' },
    { name: 'Google News · Tecnologia', url: 'https://news.google.com/rss/search?q=tecnologia+when:2d&hl=pt-BR&gl=BR&ceid=BR:pt-419', category: 'Tecnologia' },
    { name: 'Google News · Games', url: 'https://news.google.com/rss/search?q=games+when:2d&hl=pt-BR&gl=BR&ceid=BR:pt-419', category: 'Games' },
    { name: 'Agência Brasil', url: 'https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml', category: 'Notícias' },
    { name: 'Agência Brasil · Educação', url: 'https://agenciabrasil.ebc.com.br/rss/educacao/feed.xml', category: 'Educação' },
    { name: 'Agência Brasil · Esportes', url: 'https://agenciabrasil.ebc.com.br/rss/esportes/feed.xml', category: 'Esportes' },
    { name: 'Agência Brasil · Geral', url: 'https://agenciabrasil.ebc.com.br/rss/geral/feed.xml', category: 'Geral' },
    { name: 'Agência Brasil · Política', url: 'https://agenciabrasil.ebc.com.br/rss/politica/feed.xml', category: 'Política' },
    { name: 'Agência Brasil · Internacional', url: 'https://agenciabrasil.ebc.com.br/rss/internacional/feed.xml', category: 'Internacional' },
    { name: 'TSE · Notícias via Google News', url: 'https://news.google.com/rss/search?q=site%3Atse.jus.br+when%3A2d&hl=pt-BR&gl=BR&ceid=BR:pt-419', category: 'Eleições' }
  ];
  for (const source of sources) await client.source.upsert({ where: { url: source.url }, create: source, update: {} });
}
