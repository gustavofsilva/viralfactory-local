import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db, getSettings } from '../apps/api/src/db.js';
import { dataDir } from '../apps/api/src/config.js';
import { auditEvidence } from '../apps/api/src/evidence-audit.js';
import { chooseEvidence } from '../apps/api/src/script-compose.js';
import { scriptSchema } from '@viralfactory/shared';
try {
  const video = await db.video.findUniqueOrThrow({ where: { id: process.argv[2] } });
  const { sources } = JSON.parse(video.researchJson!);
  const settings = await getSettings();
  const model = process.argv[3] || settings.ollamaModel;
  const examples = [
    { text: 'Luisa Stefani venceu o WTA 1000 de Pequim com Gabriela Dabrowski.', expected: true },
    { text: 'A parceria Brasil-Canadá venceu a final por dois sets a zero.', expected: true },
    { text: 'Luisa Stefani e Gabriela Dabrowski disputarão o torneio de Wuhan.', expected: true },
    { text: 'Luisa Stefani encerrou sua temporada e não disputará outros torneios.', expected: false },
    { text: 'A parceria venceu a final por três sets a zero.', expected: false },
    { text: 'Luisa Stefani conquistou um título em Wimbledon nesta reportagem.', expected: false }
  ];
  const results = [];
  for (const example of examples) {
    const script = scriptSchema.parse({ origin: 'ollama', title: 'Teste de consistência de evidências', hook: 'Uma afirmação para verificar.', narration: example.text, description: 'Teste técnico, não destinado à publicação.', hashtags: [], coverText: 'Teste', scenes: [{ text: example.text, visualQuery: 'graphics' }], sourceUrls: sources.map((source: { url: string }) => source.url), claims: [{ text: example.text, ...chooseEvidence(example.text, sources) }], risk: 'normal', estimatedDurationSeconds: 40 });
    const result = await auditEvidence(script, sources, model, new AbortController().signal);
    const item = { ...example, actual: result.supported, correct: example.expected === result.supported, reason: result.reason };
    results.push(item); console.log(JSON.stringify(item));
  }
  await writeFile(path.join(dataDir, 'qa', `evidence-evaluation-${model.replace(/[^a-z0-9]/gi, '-')}.json`), JSON.stringify({ model, correct: results.filter(item => item.correct).length, total: results.length, results }, null, 2));
  if (results.some(item => !item.correct)) process.exitCode = 1;
} finally { await db.$disconnect(); }
