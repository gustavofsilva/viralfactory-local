// Integration validation with an explicitly edited draft, not a simulated LLM result.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:4310/api';
const videoId = process.argv[2];
assert.ok(videoId, 'Informe uma produção existente com o dossiê da matéria sobre interpretação no Enem.');
const videos = await (await fetch(`${base}/videos`)).json();
const video = videos.find(item => item.id === videoId);
const source = video?.research?.sources?.find(item => item.url.includes('interpretacao-e-base-da-prova-de-linguagens-do-enem'));
assert.ok(source, 'A matéria real precisa estar coletada antes do teste.');
const chunks = [
  'Você começa a questão pelo texto ou pelo comando? Na prova de Linguagens do Enem, interpretar bem conta tanto quanto conhecer o conteúdo.',
  'Uma dica apresentada por professores à Agência Brasil é ler primeiro o comando da questão. Assim, você sabe o que procurar no texto e evita releituras desnecessárias.',
  'Para treinar, resolva provas de anos anteriores, prestando atenção nos comandos e no contexto.',
  'Revise também funções da linguagem, variação linguística e conectores como contudo, portanto e embora.',
  'Em literatura, procure relacionar as obras às ideias e ao contexto histórico de cada época. Como você vai organizar sua próxima revisão?'
];
const queries = ['student reading exam', 'open book desk', 'student study notes', 'text notebook pen', 'literature books library'];
const sentences = source.text.split(/(?<=[.!?])\s+/).map(text => text.trim());
const evidenceFor = (phrase) => {
  const sentence = sentences.find(text => text.includes(phrase));
  assert.ok(sentence && sentence.length <= 450, `Trecho original ausente: ${phrase}`);
  return sentence;
};
const facts = [
  ['Interpretar conta tanto quanto conhecer o conteúdo.', 'Saber interpretar textos é tão importante'],
  ['A orientação é ler primeiro o comando da questão.', 'a melhor estratégia para a prova é ler primeiro'],
  ['Conhecer o comando ajuda a evitar releituras desnecessárias.', 'você economiza tempo e evita releituras'],
  ['Resolver questões de anos anteriores é uma forma de preparação.', 'Uma das formas de se preparar é resolver questões'],
  ['Revisar funções da linguagem, variação linguística e conectores é recomendado.', 'Na reta final, o professor recomenda'],
  ['Literatura envolve relações entre obras e contexto histórico.', 'O mais importante é compreender as relações']
];
const script = {
  origin: 'edited', title: 'Enem: comece pelo comando da questão', hook: chunks[0].split('?')[0]+'?',
  narration: chunks.join(' '), description: 'Dicas de preparação e leitura para a prova de Linguagens, a partir da reportagem da Agência Brasil. Rascunho editado durante a validação técnica; requer revisão antes da publicação.',
  hashtags: ['#Enem', '#Linguagens', '#DicasDeEstudo'], coverText: 'Leia o comando primeiro',
  scenes: chunks.map((text, index) => ({ text, visualQuery: queries[index] })), sourceUrls: [source.url],
  claims: facts.map(([text, phrase]) => ({ text, sourceUrl: source.url, evidence: evidenceFor(phrase) })), risk: 'normal', estimatedDurationSeconds: 40
};
const directory = path.join(process.env.DATA_DIR, 'qa');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'edited-render-script.json'), JSON.stringify(script, null, 2));
async function send(route, method, body) {
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
const saved = await send(`/videos/${videoId}/script`, 'PUT', script);
assert.equal(saved.script.origin, 'edited');
assert.equal(saved.scriptReviewedAt, null);
const job = await send(`/videos/${videoId}/produce`, 'POST', {});
console.log(JSON.stringify({ videoId, jobId: job.id, scriptOrigin: saved.script.origin, words: script.narration.split(/\s+/).length, reviewRequired: saved.reviewRequired }, null, 2));
