import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../apps/api/src/db.js';
import { dataDir } from '../apps/api/src/config.js';
try {
  const videos = await db.video.findMany({ where: { state: 'SCRIPTED', scriptReviewedAt: null, artifactJson: null } });
  for (const video of videos) {
    const research = video.researchJson ? JSON.parse(video.researchJson) : null;
    if (research?.sources?.length && research.sources.every((source: { url: string }) => source.url.includes('news.google.com/rss/articles/'))) {
      const directory = path.join(dataDir, 'logs/rejected-drafts');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${video.id}.json`), JSON.stringify({ script: JSON.parse(video.scriptJson!), research, reason: 'Fontes de descoberta contêm apenas manchetes; não sustentam detalhes adicionais do roteiro.' }, null, 2));
      await db.$transaction(async tx => {
        await tx.video.update({ where: { id: video.id }, data: { state: 'FAILED', scriptJson: null, lastError: 'As fontes contêm apenas manchetes. Reúna um texto verificável com data antes de gerar um roteiro.' } });
        const jobs = await tx.job.findMany({ where: { videoId: video.id, kind: 'SCRIPT', status: 'COMPLETED' } });
        for (const job of jobs) {
          await tx.job.update({ where: { id: job.id }, data: { status: 'FAILED', lastError: 'Rascunho rejeitado por informações insuficientes nas fontes.' } });
          await tx.jobLog.create({ data: { jobId: job.id, level: 'warning', message: 'Rascunho inicial rejeitado. Manchetes não sustentam extrapolações; use texto de fonte original.' } });
        }
      });
      console.log(`Rascunho ${video.id} rejeitado e preservado no histórico.`);
    }
  }
} finally { await db.$disconnect(); }
