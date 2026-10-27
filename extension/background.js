/* Downloads require extension UI messages; page player metadata is bounded and sanitized. */
if(typeof importScripts==='function') importScripts('hls.js','youtube-media.js');
const api = globalThis.browser || chrome;
const HOST = 'com.graphicarray.openidm';
const CACHE_KEY = 'mediaByTab';
let serial = Promise.resolve();
// Credentials stay in worker memory and are used only for the selected observed URL.
const requestContext = new Map();
const youtubePlayers=new Map(), youtubeObserved=new Map(), youtubeSabrObserved=new Map(), youtubeSabrSeed=new Map();
function clearSabrCapture(tabId){
  youtubeSabrObserved.delete(tabId);
  for(const [id,seed] of youtubeSabrSeed)if(seed.tabId===tabId)youtubeSabrSeed.delete(id);
}
function bytesBase64(bytes){let binary='';const view=new Uint8Array(bytes);for(let i=0;i<view.length;i+=8192)binary+=String.fromCharCode(...view.subarray(i,i+8192));return btoa(binary);}
api.webRequest.onBeforeRequest?.addListener(details=>{
  const url=globalThis.youtubeMedia?.sabrUrl(details.url), raw=details.requestBody?.raw;
  if(!url||details.tabId<0||!Array.isArray(raw)||!raw.length)return;
  let size=0;for(const part of raw){if(!part.bytes)return;size+=part.bytes.byteLength;}if(!size||size>262144)return;
  const bytes=new Uint8Array(size);let offset=0;for(const part of raw){bytes.set(new Uint8Array(part.bytes),offset);offset+=part.bytes.byteLength;}
  youtubeSabrSeed.set(details.requestId,{tabId:details.tabId,url,requestBody:bytesBase64(bytes)});
  if(youtubeSabrSeed.size>100)youtubeSabrSeed.delete(youtubeSabrSeed.keys().next().value);
},{urls:['https://*.googlevideo.com/videoplayback*','https://googlevideo.com/videoplayback*']},['requestBody']);
function rememberRequest(details) {
  if(details.tabId<0 || !httpUrl(details.url))return;
  let tab=requestContext.get(details.tabId);
  if(!tab){tab=new Map();requestContext.set(details.tabId,tab);if(requestContext.size>50)requestContext.delete(requestContext.keys().next().value);}
  const headers={};
  for(const h of details.requestHeaders||[]) {
    const name=h.name.toLowerCase();
    if(['cookie','authorization','user-agent','referer','origin'].includes(name)&&typeof h.value==='string'&&h.value.length<=16384&&!/[\r\n]/.test(h.value))headers[name]=h.value;
  }
  tab.set(details.url,headers);if(tab.size>100)tab.delete(tab.keys().next().value);
}
api.webRequest.onBeforeSendHeaders?.addListener(rememberRequest,{urls:['http://*/*','https://*/*']},['requestHeaders',...(globalThis.browser?[]:['extraHeaders'])]);
function httpUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function unsupported(url, mime = '') { return /\.mpd(?:[?#]|$)/i.test(url) || /dash\+xml/i.test(mime); }
function isFragment(url) { return /\.(m4s|ts|aac)(?:[?#]|$)/i.test(url) || /\/init[^/]*\.mp4(?:[?#]|$)/i.test(url); }
const hlsSeen=new Map(); let hlsActive=0;
async function discoverHls(tabId,url) {
  if(tabId<0 || hlsActive>=8)return;
  let seen=hlsSeen.get(tabId);if(!seen){seen=new Set();hlsSeen.set(tabId,seen);if(hlsSeen.size>50)hlsSeen.delete(hlsSeen.keys().next().value);}
  if(seen.has(url)||seen.size>=20)return;seen.add(url);hlsActive++;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch(url,{signal:controller.signal,credentials:'omit'});
    if(!response.ok)throw new Error('Manifest fetch failed.');
    const reader=response.body.getReader();let size=0;const chunks=[];
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw new Error('Manifest too large.');}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const variants=globalThis.parseHlsMaster(new TextDecoder().decode(bytes),response.url||url);
    let title='';try{title=(await api.tabs.get(tabId)).title||'';}catch{}
    if(hlsSeen.get(tabId)===seen)await remember(tabId,variants.map(item=>({...item,title})));
  } catch {
    // Playlist could not be read here (cookies, referer, CORS). Still offer it, labelled, so it is not lost.
    if(hlsSeen.get(tabId)===seen){let title='';try{title=(await api.tabs.get(tabId)).title||'';}catch{}await remember(tabId,[{url,format:'HLS',quality:globalThis.hlsQualityFromUrl?.(url)||'',title}]).catch(()=>{});}
  } finally {clearTimeout(timer);hlsActive--;}
}
function nativeSend(payload) {
  return new Promise((resolve, reject) => {
    // Chrome callbacks retain useful runtime.lastError diagnostics.
    if (!globalThis.browser) chrome.runtime.sendNativeMessage(HOST, payload, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!result?.ok) reject(new Error(result?.error || 'The desktop app did not accept this download.'));
      else resolve(result);
    });
    else browser.runtime.sendNativeMessage(HOST, payload).then(result => result?.ok ? resolve(result) : reject(new Error(result?.error || 'Desktop rejected download.')), reject);
  });
}
async function enqueue(item, tabId) {
  let sabr;
  if(item.sabrSelection){
    const player=youtubePlayers.get(tabId), selection=item.sabrSelection;
    const videoItag=selection.videoItag===undefined?undefined:Number(selection.videoItag), audioItag=Number(selection.audioItag);
    if(!player||!Number.isSafeInteger(audioItag)||audioItag<=0||videoItag!==undefined&&(!Number.isSafeInteger(videoItag)||videoItag<=0))throw new Error('The captured YouTube session expired. Reopen the menu.');
    const audio=player.formats.find(f=>f.itag===audioItag&&/^audio\/mp4/i.test(f.mimeType));
    const video=videoItag===undefined?undefined:player.formats.find(f=>f.itag===videoItag&&/^video\/mp4/i.test(f.mimeType));
    const captured=youtubeSabrObserved.get(tabId);
    if(!captured)throw new Error('Play this YouTube video briefly so its streaming session can be captured, then try again.');
    const serverAbrStreamingUrl=captured.url;
    if(!audio||videoItag!==undefined&&!video||!globalThis.youtubeMedia.sabrUrl(serverAbrStreamingUrl)||!player.ustreamerConfig)throw new Error('The captured YouTube SABR session is incomplete. Play the video briefly and reopen the menu.');
    sabr={videoId:player.videoId,serverAbrStreamingUrl,videoPlaybackUstreamerConfig:player.ustreamerConfig,clientInfo:{clientName:player.clientName,clientVersion:player.clientVersion},formats:player.formats,videoItag,audioItag,requestBody:captured.requestBody};
  }
  const url = httpUrl(sabr?.serverAbrStreamingUrl||item.url);
  if (!url) throw new Error('Only direct HTTP and HTTPS links are supported.');
  if (unsupported(url, item.mime) || item.unsupported) throw new Error(item.reason || 'DASH streams are unsupported.');
  let requestHeaders=requestContext.get(tabId)?.get(url);
  if(!requestHeaders&&requestContext.get(tabId))for(const [seenUrl,seenHeaders] of requestContext.get(tabId))if(cleanMediaUrl(seenUrl)===url){requestHeaders=seenHeaders;break;}
  return nativeSend({action: 'download', url, youtubeFormat:item.youtubeFormat, sabr, startNow:item.startNow===true, audioUrl:httpUrl(item.audioUrl)||undefined, outputFormat:item.outputFormat, filename: item.filename, referer: httpUrl(requestHeaders?.referer || item.referer) || undefined,requestHeaders});
}

// Facebook/Instagram CDN links often carry a byte window (bytestart/byteend). The full track URL is the same link without it.
function cleanMediaUrl(value) {
  try {
    const u = new URL(value);
    if (/(^|\.)(fbcdn\.net|cdninstagram\.com)$/.test(u.hostname) && (u.searchParams.has('bytestart') || u.searchParams.has('byteend'))) {
      u.searchParams.delete('bytestart'); u.searchParams.delete('byteend'); return u.href;
    }
  } catch {}
  return value;
}
// Minimal MP4 reader: finds video size and whether the file has video and/or audio tracks.
function parseMp4Info(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const four = at => String.fromCharCode(buf[at], buf[at+1], buf[at+2], buf[at+3]);
  const out = {video:false, audio:false, width:0, height:0, found:false};
  const boxes = (start, end, visit) => {
    let at = start;
    while (at + 8 <= end) {
      let size = dv.getUint32(at), header = 8;
      if (size === 1) { if (at + 16 > end) return; size = Number(dv.getBigUint64(at + 8)); header = 16; }
      else if (size === 0) size = end - at;
      if (size < header) return;
      visit(four(at + 4), at, Math.min(at + size, end), header);
      at += size;
    }
  };
  boxes(0, buf.length, (type, at, end, header) => {
    if (type !== 'moov') return;
    out.found = true;
    boxes(at + header, end, (t1, a1, e1, h1) => {
      if (t1 !== 'trak') return;
      let handler = '', width = 0, height = 0;
      boxes(a1 + h1, e1, (t2, a2, e2, h2) => {
        if (t2 === 'tkhd' && e2 - a2 >= 16) { width = dv.getUint32(e2 - 8) >>> 16; height = dv.getUint32(e2 - 4) >>> 16; }
        if (t2 === 'mdia') boxes(a2 + h2, e2, (t3, a3, e3) => { if (t3 === 'hdlr' && e3 - a3 >= 20) handler = four(a3 + 16); });
      });
      if (handler === 'vide') { out.video = true; if (height > out.height) { out.height = height; out.width = width; } }
      if (handler === 'soun') out.audio = true;
    });
  });
  return out;
}
async function readLimited(response, limit) {
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  while (size < limit) { const {done, value} = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(size, limit)); let offset = 0;
  for (const chunk of chunks) { const part = chunk.subarray(0, Math.max(0, bytes.length - offset)); bytes.set(part, offset); offset += part.length; if (offset >= bytes.length) break; }
  return bytes;
}
async function probeMp4(url) {
  const attempt = async range => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {headers: range ? {Range: range} : {}, credentials: 'omit', signal: controller.signal});
      if (!response.ok) return null;
      return parseMp4Info(await readLimited(response, 786432));
    } catch { return null; } finally { clearTimeout(timer); }
  };
  let info = await attempt('bytes=0-786431');
  if (!info?.found) info = await attempt('bytes=-786432') || info;
  return info?.found ? {video: info.video, audio: info.audio, width: info.width, height: info.height} : null;
}
function updateCache(change) {
  const next = serial.then(async () => {
    const data = await api.storage.session.get(CACHE_KEY);
    const map = data[CACHE_KEY] || {};
    await change(map);
    // Bound total tracked tabs as well as each tab's results.
    const keys = Object.keys(map);
    keys.slice(0, Math.max(0, keys.length - 50)).forEach(key => delete map[key]);
    await api.storage.session.set({[CACHE_KEY]: map});
  });
  serial = next.catch(() => {});
  return next;
}
async function remember(tabId, items) {
  if (tabId < 0) return;
  await updateCache(map => {
    const prior = map[tabId] || [];
    for (const item of items.slice(0, 100)) {
      const url = httpUrl(cleanMediaUrl(item.url));
      if (!url || isFragment(url)) continue;
      const value={url, mime: String(item.mime || '').slice(0, 100), title: String(item.title || '').slice(0, 180), quality:String(item.quality||'').slice(0,40),bitrate:Number(item.bitrate)||0,format:String(item.format||'').slice(0,20),separateAudio:!!item.separateAudio,reason:String(item.reason||'').slice(0,180),unsupported: unsupported(url, item.mime)||!!item.unsupported};
      value.audioUrl=httpUrl(item.audioUrl)||undefined;
      value.codecs=String(item.codecs||'').slice(0,200);
      value.masterUrl=httpUrl(item.masterUrl)||undefined;
      const existing=prior.findIndex(v=>v.url===url);
      if(existing>=0){const previous=prior[existing];if(previous.format==='HLS'&&!item.format){if(value.title)previous.title=value.title;continue;}prior[existing]={...previous,...value,audioUrl:value.audioUrl||previous.audioUrl,codecs:value.codecs||previous.codecs,masterUrl:value.masterUrl||previous.masterUrl,title:value.title||previous.title,quality:value.quality||previous.quality,bitrate:value.bitrate||previous.bitrate,format:value.format||previous.format,separateAudio:value.separateAudio||previous.separateAudio,unsupported:value.unsupported||previous.unsupported,reason:value.reason||previous.reason};continue;}
      prior.push(value);
    }
    map[tabId] = prior.slice(-100);
  });
}
api.webRequest.onHeadersReceived.addListener(details => {
  const mime = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  const captured=globalThis.youtubeMedia?.mediaUrl(details.url);
  const capturedSabr=globalThis.youtubeMedia?.sabrUrl(details.url);
  if(capturedSabr && details.tabId>=0 && [200,206].includes(details.statusCode)){
    const seed=youtubeSabrSeed.get(details.requestId);
    if(seed?.tabId===details.tabId&&seed.url===capturedSabr)youtubeSabrObserved.set(details.tabId,seed);
    youtubeSabrSeed.delete(details.requestId);
    if(youtubeSabrObserved.size>50)youtubeSabrObserved.delete(youtubeSabrObserved.keys().next().value);
  }
  if(captured && details.tabId>=0 && [200,206].includes(details.statusCode) && /^(video|audio)\//i.test(mime)) {
    const urls=youtubeObserved.get(details.tabId)||[];
    if(!urls.includes(captured))urls.unshift(captured);
    youtubeObserved.set(details.tabId,urls.slice(0,100));
    if(youtubeObserved.size>50)youtubeObserved.delete(youtubeObserved.keys().next().value);
  }
  if (details.type === 'media' || /^(video|audio)\//i.test(mime) || unsupported(details.url, mime)) {
    remember(details.tabId, [{url: details.url, mime}]).catch(() => {});
  }
  if(/\.m3u8(?:[?#]|$)/i.test(details.url)||/mpegurl/i.test(mime))discoverHls(details.tabId,details.url);
}, {urls: ['http://*/*', 'https://*/*']}, ['responseHeaders']);
api.tabs.onRemoved.addListener(tabId => {youtubePlayers.delete(tabId);youtubeObserved.delete(tabId);clearSabrCapture(tabId);requestContext.delete(tabId);hlsSeen.delete(tabId);updateCache(map => { delete map[tabId]; }).catch(() => {});});
api.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') {youtubePlayers.delete(tabId);youtubeObserved.delete(tabId);clearSabrCapture(tabId);requestContext.delete(tabId);hlsSeen.delete(tabId);updateCache(map => { delete map[tabId]; }).catch(() => {});} });
api.runtime.onInstalled.addListener(async () => {
  try {
    await api.contextMenus.removeAll();
    api.contextMenus.create({id: 'openidm-link', title: 'Download with Open IDM', contexts: ['link', 'video', 'audio']});
    api.contextMenus.create({id: 'openidm-page', title: 'Find downloadable links on this page', contexts: ['page']});
  } catch (error) { await api.storage.local.set({lastError: error.message}); }
});
api.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'openidm-page') { await api.tabs.sendMessage(tab.id, {action: 'collectLinks'}); await api.action.setBadgeText({tabId: tab.id, text: 'LINK'}); return; }
    await enqueue({url: info.linkUrl || info.srcUrl, referer: tab?.url},tab?.id);
    await api.action.setBadgeText({tabId: tab.id, text: 'OK'});
  } catch (e) {
    await api.storage.local.set({lastError: e.message});
    if (tab?.id) await api.action.setBadgeText({tabId: tab.id, text: '!'});
  }
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) return false;
  const task = async () => {
    if(message.action==='playerResponse' && sender.tab) {
      const page=new URL(sender.url || sender.tab.url || 'https://invalid.local');
      if(!['www.youtube.com','youtube.com','m.youtube.com'].includes(page.hostname))throw new Error('Invalid player source.');
      const data=message.data;
      if(!data || !Array.isArray(data.formats) || data.formats.length>150)throw new Error('Invalid player data.');
      const clean=globalThis.youtubeMedia.sanitizePlayer(data);
      if(clean){
        const previous=youtubePlayers.get(sender.tab.id);
        if(previous&&previous.videoId!==clean.videoId){clearSabrCapture(sender.tab.id);youtubeObserved.delete(sender.tab.id);}
        youtubePlayers.set(sender.tab.id,clean);if(youtubePlayers.size>50)youtubePlayers.delete(youtubePlayers.keys().next().value);
      }
      return {ok:true};
    }
    if (message.action === 'remember' && sender.tab) { await remember(sender.tab.id, message.items || []); return {ok: true}; }
    if (message.action === 'download') {
      const tabId=sender.tab?.id ?? message.tabId;
      return enqueue({...message.item, referer: sender.tab?.url || message.item?.referer},tabId);
    }
    if (message.action === 'list' && !sender.tab) {
      await serial;
      const data = await api.storage.session.get(CACHE_KEY);
      return {ok: true, items: data[CACHE_KEY]?.[message.tabId] || []};
    }
    if (message.action === 'probeMedia' && sender.tab) {
      const urls = (Array.isArray(message.urls) ? message.urls : []).map(httpUrl).filter(Boolean).slice(0, 12);
      const info = {};
      await Promise.all(urls.map(async url => { const result = await probeMp4(url); if (result) info[url] = result; }));
      return {ok: true, info};
    }
    if (message.action === 'listForFrame' && sender.tab) {
      const page=new URL(sender.tab.url||'https://invalid.local');
      if(['www.youtube.com','youtube.com','m.youtube.com'].includes(page.hostname)) {
        const id=page.searchParams.get('v')||/^\/shorts\/([\w-]{11})/.exec(page.pathname)?.[1];
        if(!/^[\w-]{11}$/.test(id||''))return {ok:true,items:[]};
        await api.tabs.sendMessage(sender.tab.id,{action:'refreshPlayer'}).catch(()=>{});
        const player=youtubePlayers.get(sender.tab.id);
        const active=player?.videoId===id?{...player,sabrUrl:youtubeSabrObserved.get(sender.tab.id)?.url||player.sabrUrl}:null;
        let items=active?globalThis.youtubeMedia.choices(active,youtubeObserved.get(sender.tab.id)||[]):[];
        // SABR formats cannot be downloaded until the player's streaming session was captured.
        // Without captured formats, or without that session, ask the desktop app (bundled yt-dlp) instead.
        let desktopError='';
        if(!items.length||(items.some(i=>i.sabrSelection)&&!youtubeSabrObserved.has(sender.tab.id))) {
          try {
            const listed=await nativeSend({action:'formats',url:'https://www.youtube.com/watch?v='+id});
            const fromDesktop=(listed.items||[]).filter(i=>i&&i.provider==='youtube'&&httpUrl(i.url));
            if(fromDesktop.length)return {ok:true,items:fromDesktop};
          } catch(error) { desktopError=error.message; }
        }
        const notice=!items.length?(desktopError||(player?.videoId===id&&player.sabr?'This video uses YouTube SABR streaming, which this version cannot download yet. No download has been started.':undefined)):undefined;
        return {ok:true,items,notice};
      }
      await serial;
      const data = await api.storage.session.get(CACHE_KEY);
      return {ok:true, items:(data[CACHE_KEY]?.[sender.tab.id] || []).filter(item => item.unsupported || item.format==='HLS' || /^(video|audio)\//i.test(item.mime) || /\.(m3u8|mp4|webm|mov|m4v|mp3|m4a|ogg|wav)(?:[?#]|$)/i.test(item.url))};
    }
    throw new Error('Unsupported extension request.');
  };
  task().then(respond, error => respond({ok: false, error: error.message}));
  return true;
});
api.downloads.onCreated.addListener(async item => {
  let paused=false;
  try {
    const {interceptDownloads = false} = await api.storage.local.get('interceptDownloads');
    if (!interceptDownloads || !httpUrl(item.finalUrl || item.url)) return;
    // IDM's observed ownership model: pause during handoff, resume on failure.
    await api.downloads.pause(item.id); paused=true;
    await enqueue({url: item.finalUrl || item.url, filename: item.filename?.split(/[\\/]/).pop(), referer: item.referrer},item.tabId);
    await api.downloads.cancel(item.id);
  } catch (e) { if(paused)await api.downloads.resume(item.id).catch(()=>{}); await api.storage.local.set({lastError: `Browser download was kept: ${e.message}`}); }
});
