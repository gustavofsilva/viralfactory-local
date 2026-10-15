import React, { useEffect, useState } from 'react';
import { CalendarDays, Cpu, ExternalLink, Play, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { agentSettingsSchema, type AgentSettings, type AgentStatus } from '@viralfactory/shared';
import './agent.css';

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/agent${route}`, { method, ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'A operação não foi concluída.');
  return result;
}
const labels: Record<string, string> = { PLANNED: 'Agendado', WAITING_SOURCE: 'Aguardando fonte', GENERATING: 'Criando vídeo', READY: 'Vídeo pronto', WAITING_REVIEW: 'Revisão necessária', WAITING_LOGIN: 'Verificar navegador', BLOCKED: 'Produção bloqueada', QUEUED: 'Envio na fila', SENDING: 'Enviando', PUBLISHED: 'Publicado', UNKNOWN: 'Conferir resultado', SKIPPED: 'Horário encerrado' };
export function AgentPanel() {
  const [status, setStatus] = useState<AgentStatus>();
  const [settings, setSettings] = useState<AgentSettings>(agentSettingsSchema.parse({}));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [extensionDirectory, setExtensionDirectory] = useState('');
  async function load() { const value = await api<AgentStatus>(''); setStatus(value); if (!dirty) setSettings(value.settings); }
  useEffect(() => {
    void load().catch(reason => { setError(true); setMessage(reason.message); });
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [dirty]);
  async function action(route: string, body: unknown, success: string, method = 'POST') {
    setBusy(true); setMessage('');
    try {
      const result = await api<AgentSettings & { directory?: string }>(route, method, body);
      if (route === '/settings') { setSettings(result); setDirty(false); }
      if (route === '/extension/setup' && result.directory) setExtensionDirectory(result.directory);
      setError(false); setMessage(success); await load();
    } catch (reason) { setError(true); setMessage(reason instanceof Error ? reason.message : 'Erro ao executar a ação.'); }
    finally { setBusy(false); }
  }
  function edit(value: Partial<AgentSettings>) { setDirty(true); setSettings(current => ({ ...current, ...value })); }
  const slots = status?.slots || [];
  const loginPaused = status?.settings.loginPaused || false;
  const preparedDirectory = extensionDirectory || (status?.extension?.prepared ? status.extension.directory : '');
  return <div className="agent-page">
    <div className="agent-banner panel"><div><span className="eyebrow">SEU AGENTE NO COMPUTADOR</span><h2>Pesquisa → roteiro → vídeo → publicação</h2><p>{status?.settings.continuousHourly ? 'Publicação por hora após o teste de três vídeos.' : 'Dois horários por dia.'} Fila persistente e retomada após reiniciar.</p></div><Cpu size={34} /></div>
    {message && <div role="status" className={`notice ${error ? 'warning' : 'subtle'}`}>{message}</div>}
    {status?.settings.continuousHourly && <div className="notice subtle"><CalendarDays size={18} /><span>{status.settings.burstTarget > status.settings.burstSuccesses ? `Teste de publicação: ${status.settings.burstSuccesses}/${status.settings.burstTarget} posts confirmados. Os próximos vídeos saem assim que ficarem prontos.` : `Teste concluído. Agenda contínua: um vídeo por hora${status.settings.hourlyResumeAt ? `, a partir de ${new Date(status.settings.hourlyResumeAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : ''}.`}</span></div>}
    {status?.settings.hourlyStartAt && status.settings.hourlyEndAt && <div className="notice subtle"><CalendarDays size={18} /><span>Agenda temporária: um vídeo por hora, de {new Date(status.settings.hourlyStartAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} até {new Date(status.settings.hourlyEndAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (fim exclusivo). Depois, voltam os dois horários diários. Notícias gerais não sensíveis podem ser publicadas automaticamente somente durante esta agenda.</span><button className="text-button" disabled={busy} onClick={() => void action('/settings', { ...settings, hourlyStartAt: undefined, hourlyEndAt: undefined, hourlyAutoPublishNormal: false }, 'Agenda por hora encerrada.', 'PUT')}>Encerrar agenda por hora</button></div>}
    <div className="agent-columns"><section className="panel"><div className="panel-heading"><div><h2>Rotina diária</h2><p>O computador precisa estar ligado e o aplicativo em execução.</p></div><CalendarDays size={22} /></div>
      <form className="form-grid" onSubmit={event => { event.preventDefault(); void action('/settings', settings, 'Configuração do agente salva.', 'PUT'); }}>
        <label>Primeiro vídeo<input type="time" required value={settings.times[0]} onChange={event => edit({ times: [event.target.value, settings.times[1]] })} /></label>
        <label>Segundo vídeo<input type="time" required value={settings.times[1]} onChange={event => edit({ times: [settings.times[0], event.target.value] })} /></label>
        <label>Preparar com antecedência<input type="number" min={1} max={24} value={settings.prepareHours} onChange={event => edit({ prepareHours: Number(event.target.value) })} /></label>
        <label>Conta TikTok<input placeholder="@sua_conta" value={settings.accountHandle} maxLength={25} onChange={event => edit({ accountHandle: event.target.value.replace(/^@/, '') })} /></label>
        <label className="full">Conexão com o TikTok<select value={settings.browserMode} onChange={event => edit({ browserMode: event.target.value as AgentSettings['browserMode'], publicationEnabled: false })}><option value="extension">Extensão no meu Chrome habitual</option><option value="persistent">Navegador separado do agente</option></select></label>
        <label className="full">Foco das pautas<select value={settings.topicFocus} onChange={event => edit({ topicFocus: event.target.value as AgentSettings['topicFocus'] })}><option value="general">Assuntos gerais</option><option value="elections">Eleições</option></select></label>
        <label className="full">Legenda no TikTok<select value={settings.captionMode} onChange={event => edit({ captionMode: event.target.value as AgentSettings['captionMode'] })}><option value="full">Texto completo</option><option value="source">Somente fonte</option></select></label>
        <label className="agent-toggle full"><input type="checkbox" checked={settings.allowUnverifiedCaption} onChange={event => edit({ allowUnverifiedCaption: event.target.checked })} /><span>Permitir postagem mesmo sem confirmação da legenda pelo TikTok</span></label>
        <label className="agent-toggle full"><input type="checkbox" checked={settings.enabled} onChange={event => edit({ enabled: event.target.checked, ...(!event.target.checked ? { publicationEnabled: false } : {}) })} /><span>Pesquisar e produzir automaticamente</span></label>
        <label className="agent-toggle full"><input type="checkbox" checked={settings.autoPublishNormal} onChange={event => edit({ autoPublishNormal: event.target.checked })} /><span>Permitir publicação de roteiros do Ollama não sensíveis sem revisão manual</span></label>
        <label className="agent-toggle full"><input type="checkbox" checked={settings.autoPublishSensitive} onChange={event => edit({ autoPublishSensitive: event.target.checked })} /><span>Publicar também pautas eleitorais auditadas sem revisão manual</span></label>
        <label className="agent-toggle full"><input type="checkbox" checked={settings.continuousHourly} onChange={event => edit({ continuousHourly: event.target.checked })} /><span>Manter uma publicação por hora após o teste</span></label>
        <label className="agent-toggle full"><input type="checkbox" checked={settings.publicationEnabled} disabled={!settings.accountHandle || !settings.enabled || loginPaused} onChange={event => edit({ publicationEnabled: event.target.checked })} /><span>Publicar nos horários escolhidos</span></label>
        <p className="muted full">Fuso: São Paulo. O agente audita fontes e afirmações antes de produzir. Roteiros editados precisam de aprovação; pautas sensíveis geradas pelo agente seguem a permissão acima. Se faltar fonte suficiente, o horário pode ficar sem vídeo.</p>
        <button className="button primary full" disabled={busy}><Save size={17} />Salvar rotina</button>
        <button type="button" className="button secondary full" disabled={busy || !settings.enabled || !settings.accountHandle || !!status && status.settings.burstTarget > status.settings.burstSuccesses} onClick={() => void action('/settings', { ...settings, enabled: true, publicationEnabled: true, autoPublishNormal: true, autoPublishSensitive: true, continuousHourly: true, hourlyResumeAt: undefined, hourlyStartAt: undefined, hourlyEndAt: undefined, hourlyAutoPublishNormal: false, burstRunId: crypto.randomUUID(), burstTarget: 3, burstSuccesses: 0 }, 'Teste de três vídeos iniciado. Depois, a agenda passa a uma publicação por hora.', 'PUT')}>Testar 3 vídeos e depois publicar de hora em hora</button>
      </form>
    </section><section className="panel"><div className="panel-heading"><div><h2>Navegador do TikTok</h2><p>{settings.browserMode === 'extension' ? 'A sessão permanece na aba do seu Chrome habitual.' : 'Seu login fica em um perfil exclusivo no disco D.'}</p></div><ShieldCheck size={22} /></div>
      <div className="notice subtle">{status?.browser.detail || 'Consultando o agente local…'}</div>
      <p className="agent-browser-state">{loginPaused ? 'Conexão pausada' : status?.browser.state === 'CONNECTED' ? `Conta identificada: @${status.browser.account}` : 'Conta ainda não verificada'}</p>
      {settings.browserMode === 'extension' && <div className="notice subtle extension-instructions"><p>1. No Chrome habitual, abra chrome://extensions, ative Modo do desenvolvedor e use Carregar sem compactação.</p><p>2. Selecione a pasta preparada. Abra a <a href="https://www.tiktok.com/tiktokstudio/upload" target="_blank" rel="noreferrer">tela de envio do TikTok</a> no Chrome já autenticado.</p><p>3. Clique na extensão ViralFactory e em Conectar esta aba. Deixe seu @ visível no cabeçalho ou menu de perfil e mantenha a aba aberta.</p>{preparedDirectory ? <p>Pasta: <code>{preparedDirectory}</code></p> : <p>Use Preparar extensão abaixo para criar a pasta no disco de ferramentas.</p>}<p>A conexão por extensão ainda precisa de validação com sua conta; nenhuma senha ou sessão é transferida ao aplicativo.</p></div>}
      <div className="agent-buttons">{settings.browserMode === 'extension' ? <><button className="button secondary" disabled={busy} onClick={() => void action('/extension/setup', {}, 'Extensão preparada no disco de ferramentas. Carregue a pasta no Chrome habitual.')}><ExternalLink size={17} />Preparar extensão</button><button className="button secondary" disabled={busy} onClick={() => void action('/extension/disconnect', {}, 'Extensão desconectada. Publicação desativada.')}>Desconectar extensão</button></> : <button className="button secondary" disabled={busy || loginPaused} onClick={() => void action('/browser/open', {}, 'Navegador aberto. Faça login pessoalmente e depois verifique a conta.')}><ExternalLink size={17} />Abrir TikTok para login</button>}
        <button className="button secondary" disabled={busy || loginPaused || !status?.settings.accountHandle} onClick={() => void action('/browser/check', {}, 'Estado do navegador atualizado.')}><RefreshCw size={17} />Verificar conta</button>
        <button className="button secondary" disabled={busy || !status} onClick={() => void action('/settings', { ...settings, loginPaused: !loginPaused, publicationEnabled: false }, loginPaused ? 'Conexão liberada para uma tentativa manual. A publicação continua desativada.' : 'Conexão e publicação pausadas. A pesquisa e produção continuam.', 'PUT')}>{loginPaused ? 'Retomar conexão' : 'Pausar conexão'}</button>
        <button className="button primary" disabled={busy || !status?.settings.enabled} onClick={() => void action('/prepare', {}, 'Preparação dos próximos horários solicitada. Acompanhe a fila.')}><Play size={17} />Preparar próximos vídeos</button>
      </div>
      <p className="muted">O envio pelo navegador é experimental e ainda precisa de uma postagem real para validação. O agente não contorna verificações nem repete envios de resultado incerto.</p>
      <p className="muted">Para iniciar com o Windows, execute o script install-agent-autostart.ps1 na pasta do projeto. A rotina usa o aplicativo local e funciona sem esta conversa aberta.</p>
    </section></div>
    <section className="panel"><div className="panel-heading"><div><h2>Agenda e resultados</h2><p>Uma produção por horário; URLs só aparecem após confirmação.</p></div></div>
      {!slots.length ? <div className="notice subtle">Ative a pesquisa e produção para criar os próximos horários da agenda.</div> : <div className="agent-slot-list">{[...slots].sort((a,b) => a.scheduledFor.localeCompare(b.scheduledFor)).map(slot => <article className="agent-slot" key={slot.id}>
        <div><time>{new Date(slot.scheduledFor).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span className={`agent-state state-${slot.status.toLowerCase()}`}>{labels[slot.status] || slot.status}</span></div>
        <h3>{slot.video?.title || 'Assunto será escolhido na pesquisa'}</h3>{slot.lastError && <p className="muted">{slot.lastError}</p>}
        <div className="agent-buttons">{slot.video?.outputPath && <a className="text-button" href={`/api/videos/${slot.video.id}/file/video?download=true`}>Baixar vídeo</a>}{slot.video?.outputPath && !slot.submissionStartedAt && ['READY', 'WAITING_LOGIN'].includes(slot.status) && <button className="text-button" disabled={busy || !status?.settings.publicationEnabled || status?.browser.state !== 'CONNECTED'} onClick={() => void action(`/slots/${slot.id}/publish-now`, {}, 'Teste real de envio solicitado. Acompanhe o resultado.')}>Testar envio agora</button>}{slot.postUrl && <a className="text-button" href={slot.postUrl} target="_blank" rel="noreferrer">Ver publicação<ExternalLink size={14} /></a>}
          {['BLOCKED', 'WAITING_LOGIN'].includes(slot.status) && !slot.submissionStartedAt && <button className="text-button" disabled={busy} onClick={() => void action(`/slots/${slot.id}/retry`, {}, 'Nova tentativa solicitada.')}>Repetir etapa</button>}
        </div>{slot.status === 'UNKNOWN' && <form className="agent-confirm" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void action(`/slots/${slot.id}/confirm`, { postUrl: data.get('postUrl'), confirmed: true }, 'URL conferida por você e salva.'); }}><label>URL do vídeo que você conferiu no TikTok<input name="postUrl" type="url" required placeholder="https://www.tiktok.com/@…/video/…" /></label><button className="button secondary" disabled={busy}>Confirmar publicação conferida</button></form>}
      </article>)}</div>}
    </section>
  </div>;
}
