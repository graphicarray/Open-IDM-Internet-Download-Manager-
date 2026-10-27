import { validUrl, request } from './http.mjs';
import { createHash } from 'node:crypto';

export function scopedHeaders(headers, source, target) {
  const next = { ...headers };
  if (new URL(source).origin !== new URL(target).origin) { delete next.cookie; delete next.authorization; delete next.origin; }
  return next;
}
function attrs(line) {
  const fields = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) fields[match[1]] = match[2].replace(/^"|"$/g, '');
  return fields;
}
function byteRange(text, previousEnd, previousUrl, url) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(text).trim());
  if (!m) throw new Error('Invalid HLS byte range.');
  const length = Number(m[1]);
  let start;
  if (m[2] !== undefined) start = Number(m[2]);
  else if (previousEnd !== null && previousUrl === url) start = previousEnd + 1;
  else throw new Error('HLS byte range has no starting offset.');
  if (!(length > 0) || !Number.isSafeInteger(start + length)) throw new Error('Invalid HLS byte range.');
  return { start, end: start + length - 1 };
}
export function parseHls(text, base) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('The server did not return an HLS playlist.');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const variants = [], segments = [];
  let variant = null, duration = 0, map = null, mapRange = null, encrypted = false;
  const ranges = []; let pendingRange = null, lastEnd = null, lastUrl = null, anyRange = false;
  const audio = new Map();
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) { const a = attrs(line); if (a.TYPE === 'AUDIO' && a.URI && a['GROUP-ID'] && (!audio.has(a['GROUP-ID']) || a.DEFAULT === 'YES')) audio.set(a['GROUP-ID'], validUrl(new URL(a.URI, base).href)); }
    else if (line.startsWith('#EXT-X-STREAM-INF:')) variant = attrs(line);
    else if (line.startsWith('#EXT-X-KEY:')) { if (attrs(line).METHOD !== 'NONE') encrypted = true; }
    else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice('#EXT-X-BYTERANGE:'.length);
    else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line);
      const next = validUrl(new URL(a.URI, base).href);
      const nextRange = a.BYTERANGE ? byteRange(a.BYTERANGE, null, null, next) : null;
      if (nextRange) anyRange = true;
      if (map && (map !== next || JSON.stringify(mapRange) !== JSON.stringify(nextRange))) throw new Error('HLS streams with changing initialization maps are not supported yet.');
      map = next; mapRange = nextRange;
    } else if (line.startsWith('#EXTINF:')) duration += Number.parseFloat(line.slice(8)) || 0;
    else if (!line.startsWith('#')) {
      const url = validUrl(new URL(line, base).href);
      if (variant) { variants.push({ url, bandwidth: Number(variant.BANDWIDTH) || 0, resolution: variant.RESOLUTION || null, audioGroup: variant.AUDIO }); variant = null; }
      else {
        segments.push(url);
        if (pendingRange !== null) {
          const range = byteRange(pendingRange, lastEnd, lastUrl, url);
          ranges.push(range); lastEnd = range.end; lastUrl = url; pendingRange = null; anyRange = true;
        } else ranges.push(null);
      }
    }
  }
  if (encrypted) throw new Error('Encrypted HLS is not supported by this build.');
  if (variants.length) return { variants: variants.map(v => ({...v, audioUrl:audio.get(v.audioGroup)})).sort((a, b) => b.bandwidth - a.bandwidth) };
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('Live HLS streams are not supported yet. Choose an on-demand video.');
  if (!segments.length || segments.length > 20000) throw new Error('HLS playlist has no segments or exceeds the 20,000 segment limit.');
  const plan = { urls: map ? [map, ...segments] : segments, duration, extension: map ? '.mp4' : '.ts' };
  if (anyRange) plan.ranges = map ? [mapRange, ...ranges] : ranges;
  return plan;
}
export async function fetchPlaylist(url, headers, signal) {
  const response = await request(url, { headers, signal });
  try {
    if (response.statusCode !== 200) throw new Error(`Playlist returned HTTP ${response.statusCode}.`);
    const buffers = []; let length = 0;
    for await (const chunk of response) { length += chunk.length; if (length > 2 * 1024 * 1024) throw new Error('HLS playlist exceeds 2 MiB.'); buffers.push(chunk); }
    return { text: Buffer.concat(buffers).toString('utf8'), url: response.finalUrl };
  } finally { response.destroy(); }
}
export async function resolveHls(url, headers, signal, depth = 0, source = url) {
  if (depth > 3) throw new Error('Too many nested HLS playlists.');
  const playlist = await fetchPlaylist(url, scopedHeaders(headers, source, url), signal);
  const plan = parseHls(playlist.text, playlist.url);
  if (plan.variants) {
    const chosen = plan.variants[0];
    const video = await resolveHls(chosen.url, headers, signal, depth + 1, source);
    if (chosen.audioUrl) video.audio = await resolveHls(chosen.audioUrl, headers, signal, depth + 1, source);
    return video;
  }
  return { ...plan, source, identity: createHash('sha256').update(JSON.stringify(plan.ranges ? [plan.urls, plan.ranges] : plan.urls)).digest('hex') };
}
