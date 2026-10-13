const monthNumbers: Record<string, number> = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const dayMs = 86400000;
const saoPauloDay = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const number = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return Date.UTC(number('year'), number('month')-1, number('day'));
};

export function eventSignals(title: string, summary: string, publishedAt: Date | null, now = new Date()) {
  const text = normalize(`${title}. ${summary.slice(0, 1400)}`);
  const matches: Date[] = [];
  for (const match of text.matchAll(/\b(\d{1,2})\s+de\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(20\d{2}))?\b/g)) {
    const day = Number(match[1]), month = monthNumbers[match[2]], year = Number(match[3] || publishedAt?.getUTCFullYear() || now.getUTCFullYear());
    const date = new Date(Date.UTC(year, month-1, day));
    if (date.getUTCDate() === day && date.getUTCMonth() === month-1) matches.push(date);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)) {
    const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
    const date = new Date(Date.UTC(year, month-1, day));
    if (date.getUTCDate() === day && date.getUTCMonth() === month-1) matches.push(date);
  }
  const countdown = /\b(?:faltam|daqui a)\s+(\d{1,2})\s+dias?\b/.exec(text);
  if (countdown && publishedAt) matches.push(new Date(saoPauloDay(publishedAt) + Number(countdown[1])*dayMs));
  const today = saoPauloDay(now);
  const candidate = matches.filter(date => (date.getTime()-today)/dayMs >= -2 && (date.getTime()-today)/dayMs <= 30)
    .sort((a,b) => Math.abs(a.getTime()-today)-Math.abs(b.getTime()-today))[0];
  const fresh = !!publishedAt && now.getTime()-publishedAt.getTime() >= 0 && now.getTime()-publishedAt.getTime() <= 36*3600000;
  const liveContext = /\b(jogo|partida|debate|sessao|coletiva|votacao|apuracao|transmissao|show|festival|cerimonia|competicao|evento)\b/.test(text);
  const live = fresh && (/\b(em andamento|neste momento|acontece hoje|comeca hoje|inicia hoje|nesta (segunda|terca|quarta|quinta|sexta|sabado|domingo)|neste (sabado|domingo))\b/.test(text) || (liveContext && /\bao vivo\b/.test(text)));
  const days = candidate ? (candidate.getTime()-today)/dayMs : null;
  const event = live ? 15 : days !== null && days >= -1 && days <= 3 ? 15 : days !== null && days > 3 && days <= 10 ? 12 : days !== null && days > 10 && days <= 30 ? 6 : 0;
  return { eventDate: candidate?.toISOString().slice(0, 10) || null, event };
}
