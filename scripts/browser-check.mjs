import { chromium } from 'playwright';
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const output = path.resolve(process.env.DATA_DIR || 'data', 'qa');
mkdirSync(output, { recursive: true });
const temporaryDirectory = path.join(path.dirname(path.resolve(process.env.DATA_DIR || 'data')), 'tmp');
mkdirSync(temporaryDirectory, { recursive: true });
process.env.TEMP = temporaryDirectory;
process.env.TMP = temporaryDirectory;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:4310', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Visão geral', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'dashboard-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Tendências', exact: true }).click();
  await page.getByRole('heading', { name: 'Tendências', exact: true }).waitFor();
  const count = await page.locator('.trend-row').count();
  if (count) {
    await page.locator('.trend-title').first().click();
    await page.getByRole('dialog', { name: 'Confira o assunto' }).waitFor();
    assert.ok(await page.locator('.source-link').count() > 0);
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.getByRole('textbox', { name: 'Buscar assuntos' }).fill('sem-correspondencia-qa-738192');
    await page.getByRole('heading', { name: 'Nenhum assunto corresponde à busca' }).waitFor();
    await page.getByRole('textbox', { name: 'Buscar assuntos' }).fill('');
  }
  await page.screenshot({ path: path.join(output, 'trends-desktop.png'), fullPage: false });
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByRole('heading', { name: 'Diagnóstico do ambiente' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.check-item').length >= 10);
  await page.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
  for (const name of ['Estúdio', 'Fila de produção', 'Biblioteca', 'Calendário', 'Publicação', 'Agente local']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
  }
  await page.getByRole('heading', { name: 'Rotina diária', exact: true }).waitFor();
  const agent = await (await page.request.get('http://127.0.0.1:4310/api/agent')).json();
  if (agent.settings.loginPaused) {
    if (agent.settings.browserMode === 'persistent') assert.equal(await page.getByRole('button', { name: 'Abrir TikTok para login', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Verificar conta', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Retomar conexão', exact: true }).waitFor();
    assert.equal((await page.request.post('http://127.0.0.1:4310/api/agent/browser/open', { data: {} })).status(), 409);
    assert.equal((await page.request.post('http://127.0.0.1:4310/api/agent/browser/check', { data: {} })).status(), 409);
  }
  if (agent.settings.browserMode === 'extension') {
    await page.getByRole('button', { name: 'Preparar extensão', exact: true }).waitFor();
    await page.getByText('A sessão permanece na aba do seu Chrome habitual.', { exact: true }).waitFor();
  }
  await page.screenshot({ path: path.join(output, 'agent-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Agente sem overflow no mobile');
  await page.screenshot({ path: path.join(output, 'agent-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Visão geral', exact: true }).click();
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(overflow.width <= overflow.viewport, `Layout mobile com overflow: ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: path.join(output, 'dashboard-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const settingsOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(settingsOverflow, false, 'Configurações não devem ultrapassar a tela mobile');
  await page.screenshot({ path: path.join(output, 'settings-mobile.png'), fullPage: true });
  assert.deepEqual(errors, [], 'Erros de JavaScript na interface');
  console.log(JSON.stringify({ status: 'ok', realTrends: count, pages: 9, screenshots: output, javascriptErrors: errors }, null, 2));
} finally { await browser.close(); }
