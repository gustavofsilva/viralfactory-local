import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export function isPrivateAddress(address: string) {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  if (isIP(lower) === 4) {
    const [a, b] = lower.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return !lower.includes(':') || lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower);
}
export async function validatePublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('A fonte precisa de uma URL pública HTTP ou HTTPS.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('A fonte precisa usar uma porta HTTP padrão.');
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('Endereços locais e privados não são aceitos como fontes externas.');
  return url;
}
export async function fetchPublicText(value: string, signal?: AbortSignal) {
  let url = await validatePublicUrl(value);
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'ViralFactoryLocal/0.1 (+local RSS reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      url = await validatePublicUrl(new URL(response.headers.get('location')!, url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`A fonte respondeu HTTP ${response.status}.`); }
    if (!response.body) throw new Error('A fonte retornou uma resposta vazia.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) throw new Error('O feed excede o limite de 2 MB.');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  throw new Error('A fonte excedeu o limite de redirecionamentos.');
}
