import { scriptSchema, type Script } from '@viralfactory/shared';
import { scriptRisk } from './content-risk.js';

export type ReviewedPart = { id: string; title: string; script: Script; reviewedAt: Date; durationSeconds: number };

export function composeReviewedScripts(parts: ReviewedPart[]): Script {
  if (parts.length < 2 || parts.length > 3 || new Set(parts.map(part => part.id)).size !== parts.length) throw new Error('Escolha dois ou três roteiros diferentes.');
  for (const part of parts) {
    if (!part.reviewedAt || part.durationSeconds > 30 || part.durationSeconds < 1) throw new Error('Cada roteiro precisa estar revisado e ter até 30 segundos.');
    if (!part.script.sourceUrls.length || !part.script.claims.length) throw new Error('Cada roteiro precisa manter fontes e evidências.');
  }
  const count = parts.length;
  const prefix = (index: number) => index ? 'Em outro assunto, ' : '';
  const narration = parts.map((part, index) => `${prefix(index)}${part.script.narration.trim()}`).join(' ');
  const cardExcerpt = (value: string) => {
    const firstSentence = value.trim().split(/(?<=[.!?])\s+/)[0];
    if (firstSentence.length <= 240) return firstSentence;
    return `${firstSentence.slice(0, 237).replace(/\s+\S*$/, '')}…`;
  };
  const scenes = parts.map((part, index) => ({
    text: `${prefix(index)}${cardExcerpt(part.script.narration)}`,
    visualQuery: part.script.scenes[0].visualQuery,
    title: part.script.coverText,
    sourceUrl: part.script.sourceUrls[0],
    sourceUrls: part.script.sourceUrls,
    sectionLabel: `ASSUNTO ${index + 1}/${count}`
  }));
  const sourceUrls = [...new Set(parts.flatMap(part => part.script.sourceUrls))];
  const claims = parts.flatMap(part => part.script.claims.slice(0, 2)).slice(0, 8);
  const title = `Brasil Gerais: ${count} assuntos em destaque`;
  const script = scriptSchema.parse({
    origin: 'edited', title, hook: `${count === 2 ? 'Dois' : 'Três'} assuntos em destaque.`, narration,
    description: parts.map((part, index) => `${index + 1}. ${part.title}: ${part.script.description}`).join('\n\n'),
    hashtags: [...new Set(parts.flatMap(part => part.script.hashtags))].slice(0, 12),
    coverText: `${count} ASSUNTOS EM DESTAQUE`, scenes, sourceUrls, claims,
    risk: parts.some(part => scriptRisk(part.script) === 'sensitive') ? 'sensitive' : 'normal',
    estimatedDurationSeconds: Math.min(90, parts.reduce((sum, part) => sum + part.durationSeconds, 0) + count - 1)
  });
  if (scenes.some(scene => scene.text.length > 1000) || script.estimatedDurationSeconds >= 90) throw new Error('A montagem excede o limite de 90 segundos. Escolha roteiros menores.');
  return script;
}
