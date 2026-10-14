import { useEffect, useState } from 'react';
import './clip.css';

type Account = { id: string; handle: string; label: string; enabled: boolean; primary: boolean; extensionDirectory: string; connection: { state: string; account: string | null; detail: string } };
type Segment = { start: number; end: number; text: string };
type Clip = { id: string; accountId: string; account: Account; title: string; caption: string; sourceName: string; sourceBytes: number; uploadOffset: number; durationSeconds: number | null; segments: Segment[] | null; status: string; lastError: string | null; outputPath: string | null; postUrl: string | null; createdAt: string };
type EpisodeBatch = { id: string; account: Account; sourceRoot: string; intervalMinutes: number; enabled: boolean; nextPublishAt: string; lastError: string | null; counts: { status: string; _count: { _all: number } }[] };
async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, { method, ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Operação não concluída.');
  return result;
}
export function ClipPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [batches, setBatches] = useState<EpisodeBatch[]>([]);
  const [batchAccountId, setBatchAccountId] = useState('');
  const [batchRights, setBatchRights] = useState(false);
  const [batchInterval, setBatchInterval] = useState(60);
  const [selectedId, setSelectedId] = useState<string>();
  const [newHandle, setNewHandle] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [accountId, setAccountId] = useState('');
  const [file, setFile] = useState<File>();
  const [draftTitle, setDraftTitle] = useState('');
  const [draftCaption, setDraftCaption] = useState('');
  const [sourceAuthorized, setSourceAuthorized] = useState(false);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [acceptCaptionRisk, setAcceptCaptionRisk] = useState(false);
  const [confirmUrl, setConfirmUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const selected = clips.find(clip => clip.id === selectedId);
  async function refresh() {
    const [nextAccounts, nextClips, nextBatches] = await Promise.all([api<Account[]>('/accounts'), api<Clip[]>('/clips'), api<EpisodeBatch[]>('/episode-batches')]);
    setAccounts(nextAccounts); setClips(nextClips); setBatches(nextBatches);
    setAccountId(current => current || nextAccounts[0]?.id || '');
    setBatchAccountId(current => current || nextAccounts.find(account => account.handle === 'autoanimescortes')?.id || nextAccounts[0]?.id || '');
  }
  useEffect(() => { void refresh().catch(value => setError(String(value))); const timer = setInterval(() => { if (!document.hidden) void refresh().catch(() => {}); }, 6000); return () => clearInterval(timer); }, []);
  function choose(clip: Clip) {
    setSelectedId(clip.id); setTitle(clip.title); setCaption(clip.caption); setSegments(clip.segments || []); setAcceptCaptionRisk(false); setConfirmUrl(''); setError(''); setNotice('');
    if (clip.status === 'UPLOADING') { setAccountId(clip.accountId); setDraftTitle(clip.title); setDraftCaption(clip.caption); }
  }
  async function run(label: string, task: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('');
    try { await task(); await refresh(); } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(''); }
  }
  async function upload() {
    if (!file || !accountId || !draftTitle.trim()) throw new Error('Escolha conta, arquivo e título.');
    if (!sourceAuthorized) throw new Error('Confirme que você pode editar e publicar este vídeo.');
    const resumable = selected?.status === 'UPLOADING' && selected.accountId === accountId && selected.sourceName === file.name && selected.sourceBytes === file.size ? selected : undefined;
    const created = resumable || await api<Clip>('/clips', 'POST', { accountId, title: draftTitle.trim(), caption: draftCaption.trim() || draftTitle.trim(), sourceName: file.name, sourceBytes: file.size });
    choose(created);
    for (let offset = created.uploadOffset; offset < file.size;) {
      const part = file.slice(offset, Math.min(file.size, offset + 4_194_304));
      const response = await fetch(`/api/clips/${created.id}/chunk`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': String(offset) }, body: part });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Falha ao copiar o arquivo.');
      offset = result.offset; setProgress(Math.round(offset / file.size * 100));
    }
    await api(`/clips/${created.id}/complete`, 'POST');
    setFile(undefined); setProgress(0); setDraftTitle(''); setDraftCaption(''); setSourceAuthorized(false); setNotice('Arquivo importado; a transcrição e a sugestão vão aparecer aqui.');
  }
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
  return <div className="clip-page">
    <section className="panel"><div className="panel-heading"><div><h2>Contas TikTok</h2><p>Um perfil do Chrome por conta. A extensão confere o @ antes de enviar.</p></div></div>
      <div className="clip-accounts">{accounts.map(account => <div className="clip-account" key={account.id}><strong>{account.label} <small>@{account.handle}</small></strong><span>{account.connection.state === 'CONNECTED' ? 'Conectada' : 'Desconectada ou aguardando identificação'}</span><div className="clip-actions"><button className="button secondary" disabled={!!busy} onClick={() => void run('extension', async () => { const result = await api<{ directory: string }>(`/accounts/${account.id}/extension/setup`, 'POST'); setNotice(`No perfil Chrome de @${account.handle}, carregue a extensão sem compactação em: ${result.directory}`); })}>Preparar extensão</button><button className="button secondary" disabled={!!busy} onClick={() => void run('check', async () => { const result = await api<{ state: string }>(`/accounts/${account.id}/browser/check`, 'POST'); setNotice(`@${account.handle}: ${result.state}`); })}>Verificar conta</button></div></div>)}</div>
      <form className="clip-inline" onSubmit={event => { event.preventDefault(); void run('account', async () => { await api('/accounts', 'POST', { handle: newHandle, label: newLabel || undefined }); setNewHandle(''); setNewLabel(''); setNotice('Conta cadastrada. Prepare a extensão no perfil Chrome correspondente.'); }); }}><label>Novo @<input value={newHandle} onChange={event => setNewHandle(event.target.value)} placeholder="@minha_conta" required /></label><label>Nome no painel<input value={newLabel} onChange={event => setNewLabel(event.target.value)} placeholder="Canal de clipes" /></label><button className="button secondary" disabled={!!busy}>Adicionar conta</button></form>
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Temporadas em lote</h2><p>Biblioteca local D:\ViralFactoryLocal\videos. Um clipe de 60 a 90 segundos por episódio, em ordem, com intervalo entre publicações.</p></div></div>
      <div className="clip-inline"><label>Conta de destino<select value={batchAccountId} onChange={event => setBatchAccountId(event.target.value)}>{accounts.map(account => <option key={account.id} value={account.id}>@{account.handle}</option>)}</select></label><label>Intervalo (minutos)<input type="number" min="60" max="1440" value={batchInterval} onChange={event => setBatchInterval(Number(event.target.value))} /></label><label className="clip-check"><input type="checkbox" checked={batchRights} onChange={event => setBatchRights(event.target.checked)} /> Tenho autorização para recortar e publicar todos os episódios desta biblioteca</label><button className="button secondary" disabled={!!busy || !batchRights || !batchAccountId} onClick={() => void run('batch', async () => { const result = await api<{ count: number }>('/episode-batches', 'POST', { accountId: batchAccountId, intervalMinutes: batchInterval, rightsConfirmed: true }); setBatchRights(false); setNotice(`${result.count} episódios encontrados. Ative o lote para começar.`); })}>Criar lote</button></div>
      <div className="clip-accounts">{batches.map(batch => <div className="clip-account" key={batch.id}><strong>@{batch.account.handle} · {batch.counts.reduce((sum, row) => sum + row._count._all, 0)} episódios</strong><span>{batch.enabled ? 'Ativo' : 'Pausado'} · 1 clipe a cada {batch.intervalMinutes} min · próximo envio: {new Date(batch.nextPublishAt).toLocaleString('pt-BR')}</span><span>{batch.counts.map(row => `${row.status}: ${row._count._all}`).join(' · ')}</span>{batch.lastError && <p className="notice error">{batch.lastError}</p>}<button className="button secondary" disabled={!!busy} onClick={() => void run('batch-toggle', async () => { await api(`/episode-batches/${batch.id}`, 'PATCH', { enabled: !batch.enabled }); setNotice(batch.enabled ? 'Lote pausado.' : 'Lote ativado.'); })}>{batch.enabled ? 'Pausar lote' : 'Ativar lote'}</button>{batch.counts.some(row => row.status === 'FAILED') && <button className="button secondary" disabled={!!busy} onClick={() => void run('batch-retry', async () => { await api(`/episode-batches/${batch.id}/retry-failed`, 'POST'); setNotice('Episódio retomado.'); })}>Retomar episódio com falha</button>}{batch.counts.some(row => row.status === 'BLOCKED') && <button className="button secondary" disabled={!!busy} onClick={() => void run('batch-retry-upload', async () => { await api(`/episode-batches/${batch.id}/retry-blocked`, 'POST'); setNotice('Envio retomado.'); })}>Tentar envio novamente</button>}</div>)}</div>
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Importar vídeo longo</h2><p>MP4/MOV com áudio, de 1 a 30 minutos e até 1 GB. O arquivo fica no disco D.</p></div></div>
      <div className="clip-inline"><label>Conta de destino<select value={accountId} onChange={event => setAccountId(event.target.value)}>{accounts.map(account => <option key={account.id} value={account.id}>@{account.handle}</option>)}</select></label><label>Vídeo<input type="file" accept=".mp4,.mov,video/mp4,video/quicktime" onChange={event => setFile(event.target.files?.[0])} /></label><label>Título<input value={draftTitle} onChange={event => setDraftTitle(event.target.value)} placeholder="Título do clipe" /></label><label>Legenda inicial<input value={draftCaption} onChange={event => setDraftCaption(event.target.value)} placeholder="Texto da publicação" /></label><label className="clip-check"><input type="checkbox" checked={sourceAuthorized} onChange={event => setSourceAuthorized(event.target.checked)} /> Tenho autorização para editar e publicar este vídeo</label><button className="button primary" disabled={!!busy || !file || !sourceAuthorized} onClick={() => void run('upload', upload)}>{selected?.status === 'UPLOADING' && selected.sourceName === file?.name ? 'Retomar upload' : 'Importar e analisar'}</button></div>{busy === 'upload' && <p>Copiando: {progress}%</p>}
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Clipes</h2><p>Revise os cortes e a legenda antes de gerar ou publicar.</p></div></div><div className="clip-list">{clips.map(clip => <button className={selectedId === clip.id ? 'clip-item active' : 'clip-item'} key={clip.id} onClick={() => choose(clip)}><strong>{clip.title}</strong><span>@{clip.account.handle} · {clip.status} · {new Date(clip.createdAt).toLocaleString('pt-BR')}</span></button>)}</div>
      {selected && <div className="clip-editor"><h3>{selected.title}</h3>{selected.lastError && <p className="notice">{selected.lastError}</p>}<video controls preload="metadata" src={`/api/clips/${selected.id}/file/${selected.outputPath ? 'video' : 'source'}`} />
        {selected.segments && <><p>Trechos sugeridos: {total.toFixed(1)} s. Ajuste início e fim; o total deve ficar entre 60 e 90 s.</p>{segments.map((segment, index) => <div className="clip-segment" key={index}><label>Início (s)<input type="number" min="0" step="0.1" value={segment.start} onChange={event => setSegments(current => current.map((item, i) => i === index ? { ...item, start: Number(event.target.value) } : item))} /></label><label>Fim (s)<input type="number" min="0" step="0.1" value={segment.end} onChange={event => setSegments(current => current.map((item, i) => i === index ? { ...item, end: Number(event.target.value) } : item))} /></label><p>{segment.text}</p><button className="text-button" onClick={() => setSegments(current => current.filter((_, i) => i !== index))}>Remover</button></div>)}<button className="text-button" onClick={() => setSegments(current => [...current, { start: 0, end: 10, text: '' }])}>Adicionar trecho</button><label>Título<input value={title} onChange={event => setTitle(event.target.value)} /></label><label>Legenda<input value={caption} onChange={event => setCaption(event.target.value)} /></label><div className="clip-actions"><button className="button secondary" disabled={!!busy || !['SUGGESTED', 'FAILED'].includes(selected.status)} onClick={() => void run('save', async () => { await api(`/clips/${selected.id}/segments`, 'PUT', { segments, title, caption }); setNotice('Cortes salvos.'); })}>Salvar cortes</button><button className="button primary" disabled={!!busy || selected.status !== 'SUGGESTED' || total < 60 || total > 90} onClick={() => void run('render', async () => { await api(`/clips/${selected.id}/segments`, 'PUT', { segments, title, caption }); await api(`/clips/${selected.id}/render`, 'POST'); setNotice('Renderização iniciada.'); })}>Gerar clipe</button></div></>}
        {selected.outputPath && <div className="clip-actions"><a className="button secondary" href={`/api/clips/${selected.id}/file/video`} download={`${selected.id}.mp4`}>Baixar MP4</a><label className="clip-check"><input type="checkbox" checked={acceptCaptionRisk} onChange={event => setAcceptCaptionRisk(event.target.checked)} /> Aceito publicar mesmo que o TikTok não confirme a legenda pública</label><button className="button primary" disabled={!!busy || selected.status !== 'READY' || !acceptCaptionRisk} onClick={() => void run('publish', async () => { await api(`/clips/${selected.id}/publish`, 'POST', { allowUnverifiedCaption: true }); setNotice('Envio solicitado. Acompanhe o resultado antes de tentar novamente.'); })}>Publicar em @{selected.account.handle}</button></div>}
        {selected.status === 'UNKNOWN' && <div className="clip-inline"><p>Confira se o clipe apareceu em @{selected.account.handle}. Se apareceu, registre a URL pública para encerrar o envio incerto.</p><label>URL do post<input type="url" value={confirmUrl} onChange={event => setConfirmUrl(event.target.value)} placeholder={`https://www.tiktok.com/@${selected.account.handle}/video/...`} /></label><button className="button secondary" disabled={!!busy || !confirmUrl} onClick={() => void run('confirm', async () => { await api(`/clips/${selected.id}/confirm`, 'POST', { postUrl: confirmUrl, confirmed: true }); setNotice('Publicação registrada.'); })}>Confirmar post existente</button></div>}
        {selected.postUrl && <a href={selected.postUrl} target="_blank" rel="noreferrer">Abrir publicação</a>}
      </div>}
    </section>{notice && <p className="notice">{notice}</p>}{error && <p className="notice error">{error}</p>}
  </div>;
}
