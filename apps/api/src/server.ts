import { buildApp } from './app.js';
import { apiPort } from './config.js';
import { db, getSettings, seed } from './db.js';
import { Worker, enqueueDiscovery, PermanentError } from './queue.js';
import { discover } from './trends.js';
import { generateScript } from './ollama.js';
import { produceVideo } from './production.js';
import cron from 'node-cron';
import { tickAgent } from './agent.js';
import { publishSlot, tiktokBrowser } from './tiktok-browser.js';
import { disconnectAllBridges } from './extension-bridge.js';
import { analyzeClip, renderClip, publishClip, reconcileClipSubmissions } from './clips.js';
import { tickEpisodeBatches } from './episode-batches.js';

await seed();
await reconcileClipSubmissions();
const app = await buildApp();
const worker = new Worker(async (job, signal, log) => {
  if (job.kind === 'DISCOVER') return discover(signal, log);
  if (job.kind === 'SCRIPT' && job.videoId && job.leaseOwner) return generateScript(job.videoId, job.leaseOwner, job.id, signal, log);
  if (job.kind === 'PRODUCE' && job.videoId && job.leaseOwner) return produceVideo(job.videoId, job.id, job.leaseOwner, signal, log);
  if (job.kind === 'TIKTOK_PUBLISH' && job.leaseOwner) return publishSlot(JSON.parse(job.payload).slotId, job.id, job.leaseOwner, signal, log);
  if (job.kind === 'CLIP_ANALYZE') return analyzeClip(JSON.parse(job.payload).clipId, signal, log);
  if (job.kind === 'CLIP_RENDER') return renderClip(JSON.parse(job.payload).clipId, signal, log);
  if (job.kind === 'CLIP_PUBLISH' && job.leaseOwner) {
    const payload = JSON.parse(job.payload);
    return publishClip(payload.clipId, job.id, job.leaseOwner, payload.allowUnverifiedCaption === true, signal, log);
  }
  throw new PermanentError(`Etapa ${job.kind} ainda não implementada.`);
});
let scheduling = false;
const scheduler = cron.schedule('* * * * *', async () => {
  if (scheduling) return;
  scheduling = true;
  try {
    const settings = await getSettings();
    if (settings.discoveryEnabled) {
      const slot = Math.floor(Date.now() / (settings.discoveryIntervalMinutes * 60000));
      await enqueueDiscovery(`discover:scheduled:${settings.discoveryIntervalMinutes}:${slot}`);
    }
    await tickAgent();
    await tickEpisodeBatches();
  } catch (error) { app.log.error(error); }
  finally { scheduling = false; }
}, { timezone: 'America/Sao_Paulo' });
await app.listen({ port: apiPort, host: '127.0.0.1' });
worker.start();
await tickAgent();
await tickEpisodeBatches();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  scheduler.stop();
  await worker.stop();
  await tiktokBrowser.close();
  disconnectAllBridges();
  await app.close();
  await db.$disconnect();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
