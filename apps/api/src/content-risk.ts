import type { Script } from '@viralfactory/shared';
export function sensitiveText(text: string) {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(acidentes?|mortes?|crimes?|acus[a-z]*|saude|doenc[a-z]*|tratamentos?|cirurgi[a-z]*|suspeit[a-z]*|homicidio|assassin[a-z]*|violencia|justica|juridic[a-z]*|tribunal|judicial|juiz[a-z]*|corregedor[a-z]*|eleitor[a-z]*|eleic[a-z]*|votac[a-z]*|candidat[a-z]*|segundo turno|cautelar|prefeit[a-z]*|vereador[a-z]*|senador[a-z]*|deputad[a-z]*|bolsonaro|lula|investimento[a-z]*|tempestad[a-z]*|alerta meteorologic[a-z]*|enchent[a-z]*|deslizament[a-z]*|furac[a-z]*)\b/.test(normalized);
}
export function scriptRisk(script: Script, sourceTitle = '') {
  return script.risk === 'sensitive' || sensitiveText([sourceTitle, script.title, script.hook, script.narration, script.description].join(' ')) ? 'sensitive' as const : 'normal' as const;
}
