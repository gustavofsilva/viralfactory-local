import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db, getSettings } from '../apps/api/src/db.js';
import { writeDraft } from '../apps/api/src/script-compose.js';
import { critiqueScript, discardFalseUnsupported, repairMetadata } from '../apps/api/src/ollama.js';
import { dataDir } from '../apps/api/src/config.js';
try {
  const video = await db.video.findUniqueOrThrow({ where: { id: process.argv[2] } });
  const research = JSON.parse(video.researchJson!);
  const settings = await getSettings();
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let candidate = await writeDraft({ title: research.title, sources: research.sources, duration: settings.durationSeconds, style: settings.scriptStyle, model: settings.ollamaModel, signal: new AbortController().signal, feedback, log: async message => { console.log(message); } });
      let audit = discardFalseUnsupported(await critiqueScript(candidate, research.sources, settings.ollamaModel, new AbortController().signal), research.sources);
      if (!audit.supported) {
        const repaired = repairMetadata(candidate, audit.unsupportedClaims, research.title);
        if (repaired) { candidate = repaired; audit = discardFalseUnsupported(await critiqueScript(candidate, research.sources, settings.ollamaModel, new AbortController().signal), research.sources); }
      }
      const directory = path.join(dataDir, 'qa');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `agent-draft-attempt-${attempt+1}.json`), JSON.stringify({ candidate, audit, sources: research.sources }, null, 2));
      if (audit.supported && !audit.unsupportedClaims.length) { console.log(JSON.stringify({ status: 'ok', origin: candidate.origin, words: candidate.narration.split(/\s+/).length, scenes: candidate.scenes.length, risk: audit.risk, attempt: attempt+1 })); break; }
      feedback = JSON.stringify(audit.unsupportedClaims); console.log(`Auditoria recusou: ${feedback}`);
      if (attempt === 2) process.exitCode = 1;
    } catch (error) { feedback = error instanceof Error ? error.message : String(error); console.log(feedback); if (attempt === 2) process.exitCode = 1; }
  }
} finally { await db.$disconnect(); }
