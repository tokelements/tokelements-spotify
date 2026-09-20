// ==UserScript==
// @name         TokElements for Spotify
// @namespace    tokelements.spotify
// @version      0.7.1
// @description  Drive your logged-in Spotify web player for TokElements (now-playing overlay + song requests + skip). No Spotify app / client-id needed. One-click pairing when TokElements runs in the same browser.
// @author       TokElements
// @homepageURL  https://github.com/tokelements/tokelements-spotify
// @supportURL   https://github.com/tokelements/tokelements-spotify/issues
// @updateURL    https://raw.githubusercontent.com/tokelements/tokelements-spotify/main/tokelements-spotify.user.js
// @downloadURL  https://raw.githubusercontent.com/tokelements/tokelements-spotify/main/tokelements-spotify.user.js
// @match        https://open.spotify.com/*
// @match        http://localhost:3000/*
// @match        http://127.0.0.1:3000/*
// @match        https://*.tokelements.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

/*
  Two roles, chosen by the page it runs on:

  1) On a TokElements page  → "bridge". Lets the Spotify settings page pair with ONE click (same browser):
       page  →  { __te_spotify:'pair', code, teUrl }   → we store it (GM_setValue, shared across tabs)
       we    →  { __te_spotify:'agent-present' | 'paired' | 'unpaired' }  → page updates its UI
     No code typing needed. GM values are shared, so the open.spotify.com tab picks them up live.

  2) On open.spotify.com   → the "agent". Reads now-playing from the player DOM, grabs the player's own
     Bearer token (fetch/XHR/WS hooks), and talks to TokElements over GM_xmlhttpRequest (CSP/CORS-safe):
       POST <TE>/api/spotify/agent/state?code=<pair>    { nowPlaying, premium, connected:true }   (+15s heartbeat)
       GET  <TE>/api/spotify/agent/commands?code=<pair>&since=<n>  → { commands:[…], seq }
       POST <TE>/api/spotify/agent/ack?code=<pair>       { id, ok, error?, added? }

  For a different browser / another computer: open the TokElements Spotify page, copy the pairing code,
  and enter it here via the Tampermonkey menu → "TokElements: set pairing code" (+ "set URL").
*/

(function () {
  'use strict';

  const HOST = location.hostname;
  const IS_TE = HOST === 'localhost' || HOST === '127.0.0.1' || /(^|\.)tokelements\.com$/.test(HOST);
  const IS_SPOTIFY = HOST === 'open.spotify.com';
  if (!IS_TE && !IS_SPOTIFY) return;

  // ============================ ROLE 1: bridge on the TokElements page ============================
  if (IS_TE) {
    const post = (msg) => { try { window.postMessage(Object.assign({ __te_spotify_from: 'agent' }, msg), location.origin); } catch (e) {} };
    const announce = () => post({ __te_spotify: 'agent-present', version: '0.7.1' });
    // keep announcing briefly so the page shows the one-click button even if we loaded first
    announce();
    let n = 0; const iv = setInterval(() => { announce(); if (++n > 12) clearInterval(iv); }, 1200);
    window.addEventListener('message', (e) => {
      // NOTE: no e.source check — in the Tampermonkey sandbox `window` is a proxy that is not identical
      // to the page window, so `e.source !== window` would wrongly drop the page's own messages. Origin +
      // the __te_spotify namespace are the guards.
      if (e.origin !== location.origin) return;
      const d = e.data || {};
      if (!d || d.__te_spotify_from === 'agent') return; // ignore our own
      if (d.__te_spotify === 'page-hello') return announce();
      if (d.__te_spotify === 'pair' && d.code) {
        GM_setValue('teUrl', String(d.teUrl || location.origin).replace(/\/$/, ''));
        GM_setValue('pairCode', String(d.code).trim());
        post({ __te_spotify: 'paired' });
      }
      if (d.__te_spotify === 'unpair') { GM_deleteValue('pairCode'); post({ __te_spotify: 'unpaired' }); }
    });
    return;
  }

  // ============================ ROLE 2: agent on open.spotify.com ============================
  const S = {
    teUrl: (GM_getValue('teUrl', '') || '').replace(/\/$/, ''),
    pairCode: GM_getValue('pairCode', ''),
    token: null, clientToken: null, deviceId: null, spBase: null, np: null, premium: null, seq: 0, loggedOut: false, lastResult: null,
    queue: [],           // up-next tracks captured from the web player's internal state (no rate limit)
    online: null,        // last TokElements POST reachable?
    lastPushOk: 0,
    leader: true, others: 0,
  };
  // live-update when the bridge (TokElements page) pairs/unpairs in another tab
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener('pairCode', (_k, _o, v) => { S.pairCode = v || ''; hud(); });
    GM_addValueChangeListener('teUrl', (_k, _o, v) => { S.teUrl = (v || '').replace(/\/$/, ''); hud(); });
  }

  // ---- token capture: hook the player's own auth'd requests ----
  (function hookToken() {
    const grab = (headers) => {
      try {
        let auth = null, ct = null;
        if (headers && typeof headers.forEach === 'function') headers.forEach((v, k) => { const kk = String(k).toLowerCase(); if (kk === 'authorization') auth = v; if (kk === 'client-token') ct = v; });
        else if (headers) for (const k in headers) { const kk = k.toLowerCase(); if (kk === 'authorization') auth = headers[k]; if (kk === 'client-token') ct = headers[k]; }
        if (auth && /^Bearer /i.test(auth)) S.token = auth.slice(7);
        if (ct) S.clientToken = ct;
      } catch (e) {}
    };
    const of = window.fetch;
    if (of) window.fetch = function (input, init) {
      try { grab((init && init.headers) || (input && input.headers)); } catch (e) {}
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const pr = of.apply(this, arguments);
      // The web player's INTERNAL state endpoint returns the up-next tracks (with cover/artist) and is
      // NOT rate-limited like api.spotify.com. Piggyback on it — clone the response and parse the queue.
      if (/\/track-playback\/v1\/devices\/[^/]+\/state\b/.test(url)) {
        try { const mm = url.match(/^(https?:\/\/[^/]+)\/track-playback\/v1\/devices\/([^/]+)\/state/); if (mm) { S.spBase = mm[1]; S.deviceId = mm[2]; } } catch (e) {}
        try { pr.then((r) => { try { r.clone().json().then(parseState).catch(() => {}); } catch (e) {} }); } catch (e) {}
      }
      return pr;
    };
    const oh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (/^authorization$/i.test(k) && /^Bearer /i.test(v)) S.token = v.slice(7); if (/^client-token$/i.test(k)) S.clientToken = v; return oh.apply(this, arguments); };
    const OW = window.WebSocket;
    if (OW) { window.WebSocket = function (url, p) { try { const m = String(url).match(/access_token=([^&]+)/); if (m) S.token = decodeURIComponent(m[1]); } catch (e) {} return p !== undefined ? new OW(url, p) : new OW(url); }; window.WebSocket.prototype = OW.prototype; }
  })();

  // ---- now-playing from the DOM ----
  const $ = (s) => document.querySelector(s);
  const mmss = (t) => { const m = String(t || '').match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : null; };
  let lastPos = null, lastPosAt = 0;
  function readNP() {
    // Read from the now-playing bar DOM — it holds the track whether PLAYING or PAUSED. The tab title
    // drops the track when paused/browsing, which made paused songs show as "nothing playing". The
    // track/artist LINKS are locale-independent (the widget's aria-label is localized, so we avoid it).
    const w = $('[data-testid="now-playing-widget"]');
    let track = null, artist = null, cover = null;
    if (w) {
      const tl = w.querySelector('[data-testid="context-item-link"]') || w.querySelector('a[href*="/track/"]');
      if (tl) track = (tl.textContent || '').trim() || null;
      const als = w.querySelectorAll('a[href*="/artist/"]');
      if (als.length) artist = Array.prototype.map.call(als, (a) => (a.textContent || '').trim()).filter(Boolean).join(', ') || null;
      const im = w.querySelector('img[src*="i.scdn.co"]');
      if (im) cover = im.getAttribute('src');
    }
    if (!track) { const title = document.title || ''; const i = title.lastIndexOf(' • '); if (i > 0) { track = title.slice(0, i).trim(); if (!artist) artist = title.slice(i + 3).trim(); } }
    if (!cover) { const c2 = $('img[src*="i.scdn.co/image"]'); if (c2) cover = c2.getAttribute('src'); }
    const pos = mmss(($('[data-testid="playback-position"]') || {}).textContent);
    const dur = mmss(($('[data-testid="playback-duration"]') || {}).textContent);
    let playing = track ? null : false;
    if (pos != null) { if (lastPos != null && pos > lastPos) playing = true; else if (lastPos === pos && Date.now() - lastPosAt > 1500) playing = false; lastPos = pos; lastPosAt = Date.now(); }
    return { track, artist, cover, positionMs: pos != null ? pos * 1000 : null, durationMs: dur != null ? dur * 1000 : null, playing };
  }

  // Derive the up-next queue from the web player's internal /track-playback state-machine response.
  // tracks[] is the context window; the current track index comes from the updated_state_ref → states[].
  function parseState(body) {
    try {
      const sm = body && body.state_machine; if (!sm || !sm.tracks || !sm.states) return;
      const ref = body.updated_state_ref || {};
      const cur = (ref.state_index != null && sm.states[ref.state_index]) ? sm.states[ref.state_index].track : null;
      const list = sm.tracks.map((t) => {
        const m = (t && t.metadata) || {}; const im = m.images || [];
        return {
          uri: m.uri || null,
          title: m.name || '',
          artist: (m.authors || []).map((a) => a && a.name).filter(Boolean).join(', '),
          image: (im[2] && im[2].url) || (im[1] && im[1].url) || (im[0] && im[0].url) || null,
          durationMs: m.duration || 0,
        };
      });
      const q = (cur != null) ? list.slice(cur + 1) : list;
      S.queue = q.slice(0, 8);
    } catch (e) {}
  }

  /*
   * Signed in, or just a login page?
   *
   * Only answered when the page is showing one or the other: during the first render neither marker
   * is there, and calling that "signed out" would put a red warning in the streamer's studio every
   * time they open the tab.
   */
  function readLoggedOut() {
    const signedIn = $('[data-testid="user-widget-link"]') || $('[data-testid="user-widget-avatar"]') || $('[data-testid="now-playing-widget"]') || $('[data-testid="control-button-playpause"]');
    if (signedIn) return false;
    const login = $('[data-testid="login-button"]') || document.querySelector('a[href^="/login"], a[href*="accounts.spotify.com/login"]');
    return !!login;
  }

  /*
   * The player bar is rebuilt when Spotify navigates and for a moment between two songs, so a raw
   * read says "nothing playing" every so often while music is in fact playing. On the overlay that
   * is a widget blinking to its empty state and back. Hold the last track for a few seconds before
   * believing that the music stopped.
   */
  let emptyReads = 0, lastGood = null;
  function stableNP() {
    const np = readNP();
    if (np && np.track) { emptyReads = 0; lastGood = np; return np; }
    emptyReads++;
    if (lastGood && emptyReads <= 4) return lastGood;
    lastGood = null;
    return np;
  }

  /*
   * Playback control: click the player's own buttons, and if they are not there, send the command
   * the web app itself sends.
   *
   * The buttons carry test ids that Spotify renames from time to time, and they are missing
   * entirely while the player is still booting — a skip bought with a viewer's points must not be
   * lost to either. The internal command runs against the same device the tab is playing on, which
   * is what the web UI does under its own buttons.
   */
  const CTRL = { play: '[data-testid="control-button-playpause"]', pause: '[data-testid="control-button-playpause"]', playpause: '[data-testid="control-button-playpause"]', next: '[data-testid="control-button-skip-forward"]', prev: '[data-testid="control-button-skip-back"]' };
  const INTERNAL_CTRL = { next: 'skip_next', prev: 'skip_prev', play: 'resume', pause: 'pause', playpause: null };

  function deviceCommand(endpoint) {
    return new Promise((resolve) => {
      if (!S.token || !S.spBase || !S.deviceId || !endpoint) return resolve(false);
      const headers = { authorization: 'Bearer ' + S.token, 'content-type': 'application/json', accept: 'application/json' };
      if (S.clientToken) headers['client-token'] = S.clientToken;
      GM_xmlhttpRequest({
        method: 'POST', url: S.spBase + '/connect-state/v1/player/command/from/' + S.deviceId + '/to/' + S.deviceId,
        headers, data: JSON.stringify({ command: { endpoint } }),
        onload: (r) => resolve(r.status >= 200 && r.status < 300),
        onerror: () => resolve(false),
      });
    });
  }

  async function control(cmd) {
    const el = $(CTRL[cmd]);
    // A disabled button is a player that has nothing loaded; clicking it does nothing at all.
    if (el && !el.disabled) { el.click(); return true; }
    if (cmd === 'playpause') return !!el && (el.click(), true);
    return deviceCommand(INTERNAL_CTRL[cmd]);
  }

  /*
   * Whether song requests are possible is decided by trying, never by reading the page.
   *
   * This used to set "no Premium" the moment it saw an Explore Premium button, and then TokElements
   * refused every request before the script even saw it. Measured on a free account: the internal
   * command the web player uses for its own queue accepts add_to_queue and skip_next perfectly well.
   * It is the PUBLIC Web API that needs Premium, and that is only ever the fallback. So premium
   * stays unknown until a request is actually refused, and only then are requests switched off.
   */

  // ---- Spotify Web API (song requests) ----
  function spApi(path, method) {
    return new Promise((resolve, reject) => {
      if (!S.token) return reject(new Error('no_token'));
      GM_xmlhttpRequest({
        method: method || 'GET', url: 'https://api.spotify.com/v1' + path, headers: { authorization: 'Bearer ' + S.token },
        onload: (r) => { if (r.status === 429) return reject(new Error('rate_limited')); if (r.status === 401 || r.status === 403) return reject(new Error('premium_required')); try { resolve(r.responseText ? JSON.parse(r.responseText) : {}); } catch { resolve({}); } },
        onerror: () => reject(new Error('network')),
      });
    });
  }
  // ---- INTERNAL endpoints (same ones the web UI uses) — NOT rate-limited like api.spotify.com ----
  // searchTracks persisted-query hash from the web player. If Spotify rotates it the internal search
  // 404s and we fall back to the public (rate-limited) search below.
  const PF_HASH = '59ee4a659c32e9ad894a71308207594a65ba67bb6b632b183abe97303a51fa55';
  function pfSearch(query) {
    return new Promise((resolve) => {
      if (!S.token) return resolve(null);
      const headers = { authorization: 'Bearer ' + S.token, 'content-type': 'application/json;charset=UTF-8', accept: 'application/json', 'app-platform': 'WebPlayer' };
      if (S.clientToken) headers['client-token'] = S.clientToken;
      const data = JSON.stringify({ variables: { includePreReleases: false, includeAlbumPreReleases: false, numberOfTopResults: 5, searchTerm: String(query || ''), offset: 0, limit: 5, includeAudiobooks: false, includeAuthors: false, includeEpisodeContentRatingsV2: true }, operationName: 'searchTracks', extensions: { persistedQuery: { version: 1, sha256Hash: PF_HASH } } });
      GM_xmlhttpRequest({
        method: 'POST', url: 'https://api-partner.spotify.com/pathfinder/v2/query', headers, data,
        onload: (r) => {
          try {
            const j = JSON.parse(r.responseText || '{}');
            const items = j && j.data && j.data.searchV2 && j.data.searchV2.tracksV2 && j.data.searchV2.tracksV2.items;
            const it = (items || []).map((x) => x && (x.item && x.item.data || x.data)).filter((x) => x && x.uri)[0];
            if (!it) return resolve(null);
            const cov = it.albumOfTrack && it.albumOfTrack.coverArt && it.albumOfTrack.coverArt.sources;
            resolve({ uri: it.uri, name: it.name, artist: ((it.artists && it.artists.items) || []).map((a) => a && a.profile && a.profile.name).filter(Boolean).join(', '), image: (cov && (cov[0] || cov[1]) || {}).url || null });
          } catch (e) { resolve(null); }
        },
        onerror: () => resolve(null),
      });
    });
  }
  function addToQueueInternal(uri) {
    return new Promise((resolve) => {
      if (!S.token || !S.spBase || !S.deviceId) return resolve(false);
      const headers = { authorization: 'Bearer ' + S.token, 'content-type': 'application/json', accept: 'application/json' };
      if (S.clientToken) headers['client-token'] = S.clientToken;
      GM_xmlhttpRequest({
        method: 'POST', url: S.spBase + '/connect-state/v1/player/command/from/' + S.deviceId + '/to/' + S.deviceId,
        headers, data: JSON.stringify({ command: { endpoint: 'add_to_queue', track: { uri: String(uri), metadata: { is_queued: 'true' } } } }),
        onload: (r) => resolve(r.status >= 200 && r.status < 300),
        onerror: () => resolve(false),
      });
    });
  }
  async function queueByName(query) {
    // Without the player's own token neither search can run. Saying "no match" there would blame
    // the viewer for a request that was never actually made.
    if (!S.token) return { ok: false, error: 'player_unavailable' };
    // 1) find the track via the internal search (no rate limit); fall back to the public search
    let t = await pfSearch(query);
    if (!t || !t.uri) {
      const s = await spApi('/search?type=track&limit=1&q=' + encodeURIComponent(query)).catch(() => null);
      const p = s && s.tracks && s.tracks.items && s.tracks.items[0];
      if (!p || !p.uri) return { ok: false, error: 'no_match' };
      t = { uri: p.uri, name: p.name, artist: p.artists && p.artists[0] && p.artists[0].name, image: p.album && p.album.images && p.album.images[0] && p.album.images[0].url };
    }
    // 2) add it via the internal command (no rate limit); fall back to the public queue-add
    let ok = await addToQueueInternal(t.uri);
    // The reason travels: this used to answer "queue_failed" for everything, so a free account was
    // told Spotify refused the track instead of that requests need Premium.
    if (!ok) { try { await spApi('/me/player/queue?uri=' + encodeURIComponent(t.uri), 'POST'); ok = true; } catch (e) { return { ok: false, error: String((e && e.message) || 'queue_failed') }; } }
    return { ok: true, added: { name: t.name, artist: t.artist, uri: t.uri, image: t.image } };
  }

  /*
   * Free or Premium, asked once.
   *
   * Queueing a track is a Premium feature, on the internal command as much as on the public API. Until
   * now that only surfaced when a viewer had already paid points for a request, as a failure with no
   * explanation. The web player's own token answers it in one request, and the answer travels to
   * TokElements: the studio page and the request widget both already say "needs Premium" when they
   * are told. A non-200 (an expired token, no network) leaves the answer at "unknown" and is asked again.
   */
  let probing = false, probedAt = 0;
  function probeProduct() {
    if (probing || !S.token || Date.now() - probedAt < 30 * 60_000) return;
    probing = true;
    GM_xmlhttpRequest({
      method: 'GET', url: 'https://api.spotify.com/v1/me', headers: { authorization: 'Bearer ' + S.token },
      onload: (r) => {
        probing = false;
        if (r.status !== 200) return;
        probedAt = Date.now();
        try { const j = JSON.parse(r.responseText || '{}'); if (j.product) { S.premium = j.product === 'premium'; hud(); } } catch {}
      },
      onerror: () => { probing = false; },
    });
  }

  // ---- one tab speaks for the player ----
  /*
   * Two or three Spotify tabs each ran this script, each pushed what it saw and each took song
   * requests from the queue: a tab with nothing playing reported "nothing playing" over the song in
   * the other, and a request was handled by whichever tab polled first. The tabs keep a roster in GM
   * storage (shared across tabs) and agree on one leader: the tab that is playing; otherwise one with
   * a track loaded; otherwise the one used most recently. The leader keeps the role until another
   * tab has a better claim, so a pause does not flip it. Only the leader pushes and takes commands.
   */
  const TAB = sessionStorage.getItem('__te_spotify_tab') || Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem('__te_spotify_tab', TAB);
  let focusedAt = document.hasFocus() ? Date.now() : 0;
  window.addEventListener('focus', () => { focusedAt = Date.now(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) focusedAt = Date.now(); });
  function electLeader() {
    const now = Date.now(); let r;
    try { r = JSON.parse(GM_getValue('tabs', '{}') || '{}'); } catch { r = {}; }
    r[TAB] = { at: now, playing: !!(S.np && S.np.track && S.np.playing), track: !!(S.np && S.np.track), focus: focusedAt };
    const alive = {}, ids = [];
    for (const id in r) if (now - (r[id].at || 0) < 8000) { alive[id] = r[id]; ids.push(id); }
    GM_setValue('tabs', JSON.stringify(alive));
    ids.sort((a, b) => { const A = alive[a], B = alive[b]; return (B.playing - A.playing) || (B.track - A.track) || (B.focus - A.focus) || (a < b ? -1 : 1); });
    let best = ids[0]; const lead = GM_getValue('leader', ''), cur = alive[lead];
    if (cur && best !== lead && (cur.playing || !alive[best].playing) && (cur.track || !alive[best].track)) best = lead;
    if (best === TAB && lead !== TAB) GM_setValue('leader', TAB);
    const was = S.leader;
    S.leader = best === TAB;
    S.others = ids.length - 1;
    if (S.leader && !was) lastKey = '';        // taking over: push at once, whatever the last push was
  }

  // ---- TokElements comms over GM_xmlhttpRequest (CSP-safe) ----
  function te(method, path, body) {
    return new Promise((resolve) => {
      if (!S.teUrl || !S.pairCode) return resolve(null);
      GM_xmlhttpRequest({
        method, url: S.teUrl + path + (path.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(S.pairCode),
        headers: { 'content-type': 'application/json' }, data: body ? JSON.stringify(body) : undefined,
        onload: (r) => { S.online = r.status >= 200 && r.status < 500; try { resolve(r.responseText ? JSON.parse(r.responseText) : {}); } catch { resolve({}); } },
        onerror: () => { S.online = false; resolve(null); },
      });
    });
  }

  // push now-playing on change; heartbeat every ~15s so TokElements keeps the link "connected" through
  // pauses and song stops (the state route refreshes a 120s liveness key on every push).
  let lastKey = '', lastSentAt = 0, loggedOutSince = 0;
  async function pushLoop() {
    const np = stableNP(); S.np = np;
    const out = readLoggedOut();
    // A few seconds of grace, so a slow render never shows up as "not signed in" in the studio.
    if (out) { if (!loggedOutSince) loggedOutSince = Date.now(); } else loggedOutSince = 0;
    S.loggedOut = !!loggedOutSince && Date.now() - loggedOutSince > 5000;
    electLeader();
    if (!S.leader) { hud(); return; }
    probeProduct();
    const key = JSON.stringify([np.track, np.artist, np.playing, Math.round((np.positionMs || 0) / 3000), S.premium, S.loggedOut, (S.queue || []).map((q) => q.uri)]);
    const now = Date.now();
    // The server keeps a pushed track for 45 seconds, so ten is frequent enough to survive a couple
    // of failed requests without the overlay falling back to "nothing playing".
    if (key !== lastKey || now - lastSentAt > 10000) {
      lastKey = key; lastSentAt = now;
      const r = await te('POST', '/api/spotify/agent/state', { nowPlaying: np, queue: S.queue, premium: S.premium, loggedOut: S.loggedOut, connected: true });
      if (r) S.lastPushOk = now;
    }
    hud();
  }
  async function pollLoop() {
    if (!S.leader) return;
    const r = await te('GET', '/api/spotify/agent/commands?since=' + S.seq);
    if (r && r.commands) {
      if (typeof r.seq === 'number') S.seq = r.seq;
      for (const c of r.commands) {
        let result;
        if (c.type === 'control') result = { ok: await control(c.cmd) };
        else if (c.type === 'queue') { if (S.premium === false) result = { ok: false, error: 'premium_required' }; else result = await queueByName(c.query).catch((e) => ({ ok: false, error: String(e.message || e) })); }
        if (result && result.error === 'premium_required') S.premium = false;
        S.lastResult = { at: Date.now(), type: c.type, ok: !!(result && result.ok), error: result && result.error, added: result && result.added };
        hud();
        await te('POST', '/api/spotify/agent/ack', { id: c.id, ...result });
      }
    }
  }
  setInterval(pushLoop, 1000);
  setInterval(pollLoop, 2000);

  // ---- pairing menu (for cross-browser / other computer) + reset ----
  GM_registerMenuCommand('TokElements: set URL', () => { const v = prompt('TokElements URL', S.teUrl || 'https://app.tokelements.com'); if (v != null) { S.teUrl = v.trim().replace(/\/$/, ''); GM_setValue('teUrl', S.teUrl); hud(); } });
  GM_registerMenuCommand('TokElements: set pairing code', () => { const v = prompt('Pairing code (from the TokElements Spotify page)', S.pairCode || ''); if (v != null) { S.pairCode = v.trim(); GM_setValue('pairCode', S.pairCode); hud(); } });
  GM_registerMenuCommand('TokElements: check for updates', function () { window.open('https://raw.githubusercontent.com/tokelements/tokelements-spotify/main/tokelements-spotify.user.js', '_blank'); });
  GM_registerMenuCommand('TokElements: reset / unpair', () => { S.pairCode = ''; GM_deleteValue('pairCode'); hud(); });

  // ---- status card, so a streamer can see what is happening without opening a console ----
  // Sits above Spotify's player bar. A click folds it to a dot; the choice is kept across tabs.
  let hudEl = null, hudMin = !!GM_getValue('hudMin', false);
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
  function hud() {
    if (!document.body) return;
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.setAttribute('title', 'TokElements · click to fold');
      hudEl.addEventListener('click', () => { hudMin = !hudMin; GM_setValue('hudMin', hudMin); hud(); });
      document.body.appendChild(hudEl);
    }
    let dot = '#f0c674', tone = '#f0c674', title = '', sub = '';
    if (!S.teUrl || !S.pairCode) { dot = tone = '#8a8b96'; title = 'Not paired'; sub = 'Open TokElements → Connect in this browser'; }
    else if (S.online === false) { dot = tone = '#ff6a6a'; title = 'TokElements unreachable'; sub = 'Check the URL in the Tampermonkey menu'; }
    else if (!S.leader) { dot = tone = '#8a8b96'; title = 'Another Spotify tab is sending'; sub = 'This tab takes over when it plays'; }
    else if (S.loggedOut) { dot = tone = '#ff6a6a'; title = 'Not signed in to Spotify'; sub = 'Log in on this tab to play and queue'; }
    else if (S.premium === false) { dot = tone = '#ffcf5a'; title = 'Spotify Premium required'; sub = 'Song requests need Premium · now playing still works'; }
    else if (!S.np || !S.np.track) { title = 'Waiting for a song'; sub = 'Play a track in this tab'; }
    else {
      dot = tone = S.np.playing ? '#1db954' : '#c9c9d0';
      title = String(S.np.track);
      sub = (S.np.playing ? 'Playing' : 'Paused') + ' · sending to TokElements' + (S.premium === false ? ' · no Premium, requests off' : '') + (S.others ? ' · ' + S.others + ' other tab' + (S.others > 1 ? 's' : '') + ' quiet' : '');
    }
    let line = '';
    if (S.lastResult && Date.now() - S.lastResult.at < 30000) {
      const r = S.lastResult;
      const what = r.type === 'control' ? (r.ok ? 'Skipped' : 'Skip failed') : r.ok ? ('Queued · ' + String((r.added && r.added.name) || 'track')) : ('Request failed · ' + (r.error || 'unknown'));
      line = '<div style="margin-top:7px;padding-top:7px;border-top:1px solid #ffffff14;font-size:11px;font-weight:600;color:' + (r.ok ? '#7ed6a0' : '#ff8c96') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(what) + '</div>';
    }
    const base = 'position:fixed;z-index:99999;right:14px;bottom:100px;color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;cursor:pointer;user-select:none;transition:opacity .2s;';
    if (hudMin) {
      hudEl.style.cssText = base + 'display:flex;align-items:center;gap:7px;height:28px;padding:0 10px 0 9px;border-radius:14px;background:#141418f2;border:1px solid #ffffff1f;box-shadow:0 6px 20px #0008;font-size:11px;font-weight:700;letter-spacing:.04em;';
      hudEl.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:' + dot + ';box-shadow:0 0 6px ' + dot + '"></span><span style="color:#fff;opacity:.85">TE</span>';
      return;
    }
    hudEl.style.cssText = base + 'width:272px;padding:10px 12px 11px 14px;border-radius:12px;background:#141418f2;backdrop-filter:blur(8px);border:1px solid #ffffff1a;box-shadow:0 10px 30px #000a,inset 3px 0 0 ' + tone + ';';
    hudEl.innerHTML =
      '<div style="display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ffffff99">' +
      '<span style="width:7px;height:7px;border-radius:50%;background:' + dot + ';box-shadow:0 0 7px ' + dot + '"></span>TokElements' +
      '<span style="margin-left:auto;font-weight:600;letter-spacing:0;text-transform:none;color:#ffffff55">Spotify</span></div>' +
      '<div style="margin-top:5px;font-size:13px;font-weight:700;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(title) + '</div>' +
      (sub ? '<div style="margin-top:2px;font-size:11px;color:#ffffff80;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(sub) + '</div>' : '') + line;
  }
  hud();
})();
