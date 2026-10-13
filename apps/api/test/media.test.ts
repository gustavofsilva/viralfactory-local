import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema, scriptSchema } from '@viralfactory/shared';
import { allowedLicense, relevantImageTitle } from '../src/media-provider.js';
import { productionRevision, sceneDurations } from '../src/production.js';
import { runProcess } from '../src/subprocess.js';
import { aiScriptSchema, materializeScript, discardFalseUnsupported, longestCopiedPhrase, repairMetadata } from '../src/ollama.js';

test('materiais sem licença comercial aceita são recusados', () => {
  for (const license of ['CC0', 'Public domain', 'CC BY 4.0']) assert.equal(allowedLicense(license), true);
  for (const license of ['', 'All rights reserved', 'CC BY-NC 4.0', 'CC BY-ND 4.0', 'CC BY-SA 4.0']) assert.equal(allowedLicense(license), false);
});
test('busca de mídia recusa uma medalha encontrada para estudante lendo prova', () => {
  assert.equal(relevantImageTitle("File:Alfred Boxall's Military Cross.jpg", 'student reading exam'), false);
  assert.equal(relevantImageTitle('File:Students reading books.jpg', 'student reading exam'), true);
  assert.equal(relevantImageTitle('File:Study-abroad students.jpg', 'student study notes'), true);
  assert.equal(relevantImageTitle('File:Book.jpg', 'open book desk'), false);
});
test('cortes das cenas usam palavras com timestamps, incluindo pausas reais', () => {
  const scenes = [{ text: 'Primeiro assunto aqui', visualQuery: 'a' }, { text: 'Agora outro assunto', visualQuery: 'b' }];
  const words = [{ text: 'Primeiro', start: 0.3, end: 0.7 }, { text: 'assunto', start: 1, end: 1.5 }, { text: 'aqui', start: 2, end: 2.4 }, { text: 'Agora', start: 7.2, end: 7.7 }, { text: 'outro', start: 8, end: 8.5 }, { text: 'assunto', start: 9, end: 9.5 }];
  const durations = sceneDurations(scenes, words, 10);
  assert.deepEqual(durations, [7.2, 2.8]);
  assert.equal(durations.reduce((a,b) => a+b), 10);
});
test('alterar narração ou estilo de legenda invalida os arquivos da revisão', () => {
  const script = scriptSchema.parse({ title: 'Roteiro de teste', hook: 'Um gancho', narration: 'Esta é uma narração suficiente para testar a revisão do conteúdo.', description: 'Descrição do vídeo de teste.', hashtags: ['teste'], coverText: 'Roteiro', scenes: [{ text: 'Cena de teste', visualQuery: 'graphics' }], sourceUrls: ['https://example.com'], claims: [{ text: 'Uma afirmação', sourceUrl: 'https://example.com', evidence: 'Um trecho verificável na fonte' }], risk: 'normal', estimatedDurationSeconds: 40 });
  const settings = settingsSchema.parse({});
  const original = productionRevision(script, settings);
  assert.notEqual(original, productionRevision({ ...script, narration: script.narration + ' Outro trecho.' }, settings));
  assert.notEqual(original, productionRevision(script, { ...settings, subtitleSize: 72 }));
  assert.equal(original, productionRevision(script, settings));
});
test('subprocesso captura erro e encerra tarefa cancelada', async () => {
  await assert.rejects(() => runProcess(process.execPath, ['-e', 'process.stderr.write("erro controlado"); process.exit(3)']), /erro controlado/);
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Cancelamento de teste')), 200);
  await assert.rejects(() => running, /Cancelamento de teste/);
});
test('evidências são copiadas da fonte pelo índice e referências inexistentes falham', () => {
  const draft = aiScriptSchema.parse({ title: 'Roteiro com evidência', hook: 'Uma evidência verificável.', narration: 'Um texto com informações que constam nas fontes fornecidas.', description: 'Descrição do assunto.', hashtags: [], coverText: 'Evidência', scenes: [{ text: 'Um texto com informações.', visualQuery: 'graphics' }], sourceIds: [0], claims: [{ text: 'Um fato', sourceId: 0, evidenceIndex: 0 }], risk: 'normal', estimatedDurationSeconds: 40 });
  const sources = [{ url: 'https://example.com', text: 'Este é o trecho exato coletado na fonte original. Outra evidência presente no texto original.' }];
  const script = materializeScript(draft, sources);
  assert.equal(script.claims[0].evidence, 'Este é o trecho exato coletado na fonte original.');
  assert.equal(script.claims[0].sourceUrl, sources[0].url);
  assert.throws(() => materializeScript({ ...draft, claims: [{ text: 'Um fato', sourceId: 0, evidenceIndex: 20 }] }, sources), /não existe/);
});
test('auditoria preserva alegação sem suporte e reconhece uma frase literal da fonte', () => {
  const sources = [{ text: 'A celebração foi reconhecida como patrimônio cultural.' }];
  const critique = discardFalseUnsupported({ supported: false, unsupportedClaims: [{ claim: sources[0].text, reason: 'Falso negativo da auditoria' }, { claim: 'O percurso simboliza toda a história.', reason: 'A fonte não associa essas informações.' }] }, sources);
  assert.equal(critique.supported, false);
  assert.equal(critique.unsupportedClaims.length, 1);
  assert.equal(critique.unsupportedClaims[0].claim, 'O percurso simboliza toda a história.');
  const denied = discardFalseUnsupported({ supported: false, unsupportedClaims: [{ claim: 'A pessoa cometeu um crime', reason: 'A fonte nega a acusação.' }] }, [{ text: 'A fonte negou a acusação de que A pessoa cometeu um crime.' }]);
  assert.equal(denied.supported, false);
  assert.equal(longestCopiedPhrase(sources[0].text, sources), 7);
  assert.ok(longestCopiedPhrase('Uma celebração importante recebeu esse reconhecimento.', sources) < 7);
});
test('correção de metadados não aceita uma afirmação sem suporte na narração', () => {
  const script = scriptSchema.parse({ title: 'Texto de teste', hook: 'A interpretação é mais importante.', narration: 'Interpretar é tão importante quanto conhecer o conteúdo.', description: 'Uma descrição de teste.', hashtags: [], coverText: 'Interpretação', scenes: [{ text: 'Interpretar é tão importante.', visualQuery: 'books' }], sourceUrls: ['https://example.com'], claims: [{ text: 'Interpretar é importante.', sourceUrl: 'https://example.com', evidence: 'Uma evidência de teste.' }], risk: 'normal', estimatedDurationSeconds: 40 });
  const repaired = repairMetadata(script, [{ claim: script.hook }], 'Assunto da fonte');
  assert.equal(repaired?.narration, script.narration);
  assert.equal(repaired?.hook, 'Você quer entender melhor esse assunto?');
  assert.equal(repairMetadata(script, [{ claim: script.narration }], 'Assunto'), null);
});
