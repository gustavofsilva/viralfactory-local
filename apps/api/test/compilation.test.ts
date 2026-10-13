import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptSchema } from '@viralfactory/shared';
import { composeReviewedScripts } from '../src/compilation.js';
import { agencyArticleImage } from '../src/media-provider.js';

function part(id: string, title: string, durationSeconds = 20) {
  const url = `https://agenciabrasil.ebc.com.br/politica/noticia/2026-10/${id}`;
  return {
    id, title, reviewedAt: new Date(), durationSeconds,
    script: scriptSchema.parse({
      title, hook: `Entenda o assunto ${id}.`, narration: `O assunto ${id} tem novidades no Brasil. A fonte relata os fatos e apresenta o contexto necessário para o público.`,
      description: `Resumo confirmado para o assunto ${id}.`, coverText: title.toUpperCase(),
      hashtags: ['Brasil'], scenes: [{ text: `O assunto ${id} tem novidades no Brasil.`, visualQuery: `Brasil ${id}` }],
      sourceUrls: [url], claims: [{ text: `Novidade ${id}`, evidence: `A fonte informa detalhes verificáveis sobre o assunto ${id}.`, sourceUrl: url }],
      risk: 'normal', estimatedDurationSeconds: durationSeconds
    })
  };
}

test('montagem preserva a ordem, narrações, fontes e separadores dos assuntos', () => {
  const a = part('primeiro', 'Primeiro assunto');
  const b = part('segundo', 'Segundo assunto');
  const script = composeReviewedScripts([a, b]);
  assert.equal(script.scenes.length, 2);
  assert.equal(script.scenes[0].sectionLabel, 'ASSUNTO 1/2');
  assert.equal(script.scenes[1].sectionLabel, 'ASSUNTO 2/2');
  assert.equal(script.scenes[1].sourceUrl, b.script.sourceUrls[0]);
  assert.ok(script.scenes[0].text.length < a.script.narration.length);
  assert.ok(script.narration.indexOf(a.script.narration) < script.narration.indexOf(b.script.narration));
  assert.ok(script.narration.includes('Em outro assunto, '));
  assert.deepEqual(script.sourceUrls, [a.script.sourceUrls[0], b.script.sourceUrls[0]]);
  assert.equal(script.claims.length, 2);
});

test('montagem recusa roteiros repetidos, sem revisão ou longos', () => {
  const a = part('primeiro', 'Primeiro assunto');
  assert.throws(() => composeReviewedScripts([a, a]), /diferentes/);
  assert.throws(() => composeReviewedScripts([a, { ...part('segundo', 'Segundo assunto'), reviewedAt: null as unknown as Date }]), /revisado/);
  assert.throws(() => composeReviewedScripts([a, part('terceiro', 'Terceiro assunto', 35)]), /30 segundos/);
});

test('três assuntos geram três blocos com fontes próprias', () => {
  const sources = [part('um', 'Primeiro assunto'), part('dois', 'Segundo assunto'), part('tres', 'Terceiro assunto')];
  const script = composeReviewedScripts(sources);
  assert.deepEqual(script.scenes.map(scene => scene.sectionLabel), ['ASSUNTO 1/3', 'ASSUNTO 2/3', 'ASSUNTO 3/3']);
  assert.deepEqual(script.scenes.map(scene => scene.sourceUrls?.[0]), sources.map(source => source.script.sourceUrls[0]));
});

test('foto da Agência Brasil exige crédito próprio e hospedagem EBC', () => {
  const article = 'https://agenciabrasil.ebc.com.br/politica/noticia/2026-10/assunto';
  const html = (credit: string, host = 'imagens.ebc.com.br') => `<meta property="og:image" content="https://${host}/foto.jpg"><figcaption class="credito-foto">© ${credit}</figcaption>`;
  assert.deepEqual(agencyArticleImage(html('Rafa Neddermeyer/ Agência Brasil'), article), { url: 'https://imagens.ebc.com.br/foto.jpg', author: 'Rafa Neddermeyer/ Agência Brasil' });
  assert.equal(agencyArticleImage(html('Foto/ Reuters'), article), null);
  assert.equal(agencyArticleImage(html('Foto/ Agência Brasil', 'terceiros.example'), article), null);
  assert.equal(agencyArticleImage(html('Foto/ Agência Brasil'), 'https://example.com/noticia'), null);
});
