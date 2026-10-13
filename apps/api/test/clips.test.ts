import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateSegments, clipSubtitles, fitHighlights, narrativeCandidates, validateClipSegments } from '../src/clips.js';

test('sugestão usa trechos reais do vídeo e soma de 60 a 90 segundos', () => {
  const words = Array.from({ length: 480 }, (_, index) => ({ text: index % 45 === 44 ? 'assunto.' : 'palavra', start: index * 0.4, end: index * 0.4 + 0.25 }));
  const candidates = candidateSegments(words, 195);
  assert.ok(candidates.every((segment, index) => index === 0 || segment.start >= candidates[index - 1].end));
  const highlights = fitHighlights(candidates, [1, 3, 5, 7], 195);
  const total = highlights.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  assert.ok(total >= 60 && total <= 90);
  assert.ok(highlights.every(segment => segment.end <= 195));
  assert.ok(highlights.every((segment, index) => index === 0 || segment.start >= highlights[index - 1].end));
});

test('editor recusa cortes sobrepostos, curtos e fora da duração', () => {
  assert.throws(() => validateClipSegments([{ start: 0, end: 40, text: '' }, { start: 30, end: 70, text: '' }], 100), /sobrepor/);
  assert.throws(() => validateClipSegments([{ start: 0, end: 70, text: '' }, { start: 70, end: 72, text: '' }], 100), /menor que 3/);
  assert.throws(() => validateClipSegments([{ start: 50, end: 120, text: '' }], 100), /fora da duração/);
});

test('legenda desloca palavras dos cortes para a linha do tempo final', () => {
  const words = [{ text: 'Primeiro', start: 10, end: 10.5 }, { text: 'Segundo', start: 41, end: 41.6 }];
  const subtitles = clipSubtitles(words, [{ start: 10, end: 30, text: '' }, { start: 40, end: 80, text: '' }]);
  assert.match(subtitles, /00:00:01,000 --> 00:00:22,600/);
  assert.match(subtitles, /Primeiro Segundo/);
});

test('episódios evitam abertura e créditos ao escolher candidatos narrativos', () => {
  const chunks = Array.from({ length: 60 }, (_, index) => ({ start: index * 20, end: index * 20 + 18, text: index === 30 ? 'Você descobriu a verdade! Precisamos agir agora.' : 'Uma fala do episódio continua.' }));
  const candidates = narrativeCandidates(chunks, 1200);
  assert.ok(candidates.length <= 40);
  assert.ok(candidates.every(chunk => chunk.start >= 90 && chunk.end <= 1125));
  assert.ok(candidates.some(chunk => chunk.start === 600));
  const selected = fitHighlights(candidates, [candidates.findIndex(chunk => chunk.start === 600)], 1200, true);
  assert.ok(selected.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0) >= 60);
});
