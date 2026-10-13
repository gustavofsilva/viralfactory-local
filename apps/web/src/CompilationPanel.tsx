import { useState } from 'react';
import { Film } from 'lucide-react';
import type { Video } from '@viralfactory/shared';

export function CompilationPanel({ videos, busy, create }: { videos: Video[]; busy: boolean; create: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const candidates = videos.filter(video => video.script && video.scriptReviewedAt && video.research?.kind !== 'compilation' && !['FAILED', 'CANCELED'].includes(video.state) && (video.artifacts?.audio?.duration || video.script.estimatedDurationSeconds) <= 30);
  const chosen = selected.filter(id => candidates.some(video => video.id === id));
  return <section className="panel compilation-panel">
    <div className="panel-heading"><div><h2>Juntar roteiros curtos</h2><p>Escolha 2 ou 3 assuntos revisados, com até 30 segundos cada. A ordem da seleção define a ordem do vídeo.</p></div><Film size={20} /></div>
    {candidates.length < 2 ? <p className="compilation-empty">Revise pelo menos dois roteiros curtos para montar um vídeo maior.</p> : <>
      <div className="compilation-list">{candidates.map(video => {
        const checked = chosen.includes(video.id);
        const duration = video.artifacts?.audio?.duration || video.script!.estimatedDurationSeconds;
        return <label key={video.id} className="compilation-choice"><input type="checkbox" checked={checked} disabled={!checked && chosen.length >= 3} onChange={() => setSelected(checked ? chosen.filter(id => id !== video.id) : [...chosen, video.id])} /><span><strong>{video.title}</strong><small>{Math.round(duration)} s · {video.script!.sourceUrls.length} fonte(s)</small></span></label>;
      })}</div>
      <div className="compilation-action"><span>{chosen.length}/3 assuntos selecionados</span><button className="button primary" disabled={busy || chosen.length < 2} onClick={() => create(chosen)}>Montar vídeo<Film size={16} /></button></div>
    </>}
  </section>;
}
