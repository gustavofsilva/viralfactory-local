import React from 'react';
import { ArrowDownToLine, Check, CheckCircle2, Clapperboard, Copy, FileText, Film, LoaderCircle, Play, ShieldCheck } from 'lucide-react';
import type { Video } from '@viralfactory/shared';

export function VideoTools({ video, running, busy, produce, reviewScript, approve, copyMetadata }: { video: Video; running: boolean; busy: boolean; produce: () => void; reviewScript: () => void; approve: () => void; copyMetadata: () => void }) {
  const done = [!!video.script, !!video.artifacts?.audio, !!video.artifacts?.media, !!video.artifacts?.subtitles, !!video.outputPath, video.state === 'APPROVED'];
  return <>
    <section className="panel preview-panel"><div className="panel-heading"><div><h2>Prévia do vídeo</h2><p>Vertical · 1080×1920 · pt-BR</p></div><Film size={18} /></div>
      {video.outputPath ? <video className="video-preview" controls preload="metadata" poster={`/api/videos/${video.id}/file/cover`} src={`/api/videos/${video.id}/file/video`} aria-label="Prévia do vídeo final" /> : <div className="preview-placeholder"><Clapperboard size={35} /><strong>Sua história ganha vida aqui</strong><p>Gere o vídeo para assistir à prévia.</p></div>}
      <div className="preview-actions">{video.script && <button className="button primary" disabled={busy || running || (video.script.risk === 'sensitive' && !video.scriptReviewedAt)} onClick={produce}>{running ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}{running ? 'Produzindo…' : video.outputPath ? 'Atualizar vídeo' : 'Gerar vídeo'}</button>}
        {video.script && !video.scriptReviewedAt && <button className="button secondary" disabled={busy || running} onClick={reviewScript}><ShieldCheck size={16} />Confirmar revisão do roteiro</button>}
        {video.artifacts?.audio && <div className="audio-preview"><span>Narração · {video.artifacts.audio.duration.toFixed(1)}s</span><audio controls preload="metadata" src={`/api/videos/${video.id}/file/audio`} /></div>}
        {video.outputPath && <><a className="button secondary" href={`/api/videos/${video.id}/file/video?download=true`}><ArrowDownToLine size={16} />Baixar MP4</a><button className="button secondary" onClick={copyMetadata}><Copy size={16} />Copiar metadados</button><a className="text-button" href={`/api/videos/${video.id}/file/metadata?download=true`}><FileText size={15} />Fontes e licenças</a>{video.state !== 'APPROVED' && <button className="button primary" disabled={busy || running} onClick={approve}><CheckCircle2 size={17} />Aprovar vídeo revisado</button>}</>}
      </div>
    </section>
    <section className="panel pipeline-card"><h2>Etapas da produção</h2>{['Roteiro', 'Narração', 'Mídia', 'Legendas', 'Renderização', 'Revisão'].map((label, index) => <div className="pipeline-step" key={label}><span className={done[index] ? 'done' : ''}>{done[index] ? <Check size={15} /> : index+1}</span><div><strong>{label}</strong><small>{done[index] ? index === 5 ? 'Aprovado por você' : 'Resultado salvo' : index === 5 && video.outputPath ? 'Aguardando sua aprovação' : 'Aguardando etapa anterior'}</small></div></div>)}</section>
    {video.artifacts?.media && <section className="panel media-attributions"><h2>Materiais visuais</h2>{video.artifacts.media.assets.map((asset, index) => <div key={index}><strong>Cena {index+1} · {asset.license}</strong><p>{asset.author}</p>{asset.kind === 'commons' ? <a href={asset.originUrl} target="_blank" rel="noreferrer">Ver origem e licença</a> : <span>Grafismo original</span>}</div>)}</section>}
  </>;
}

export function PublicationTools({ videos, copyMetadata }: { videos: Video[]; copyMetadata: (video: Video) => void }) {
  const ready = videos.filter(video => !!video.outputPath);
  return <section className="panel manual-publication"><div className="panel-heading"><div><h2>Publicação manual</h2><p>Baixe o vídeo e copie os metadados para publicar na plataforma.</p></div></div>{!ready.length ? <div className="notice subtle">Os vídeos renderizados aparecerão aqui.</div> : ready.map(video => <div className="manual-publish-row" key={video.id}><div><strong>{video.title}</strong><p>{video.reviewRequired ? 'Revise o vídeo antes de publicar.' : 'Vídeo revisado e aprovado.'}</p></div><a className="button secondary" href={`/api/videos/${video.id}/file/video?download=true`}><ArrowDownToLine size={16} />MP4</a><button className="button primary" onClick={() => copyMetadata(video)}>Copiar metadados</button></div>)}</section>;
}
