
  import {
    boot, importFiles, allTracks, getTrack, getState, isPublicTrack,
    artworkUrl, hasArtwork, onArtworkFound, onLyricsFound, lookupArtwork, lookupLyrics,
    cachedArtistImage, lookupArtistImage,
    parseLRC, shareTrack, loadPublicTracks, saveTrack,
    identifyAvailable, identifyClip, trackFromMatch, needsRecognition, recognizeTrack,
    onTrackUpdated,
    playback, onPlayback, setQueue, playAt, playNext, playPrev,
    getQueue, getQueueIndex, setShuffle, setRepeat,
  } from './wavefy-core.js';
  // Liquid glass is progressive enhancement: it only activates on Chromium,
  // where an SVG filter can actually be used as a backdrop-filter. Everywhere
  // else the plain blur() saturate() glass stays exactly as-is.
  import { refreshLiquidGlass } from './liquid-glass.js';

  // ---------- Navigation ----------
  const main = document.getElementById('main');
  const views = [...document.querySelectorAll('.view')];
  const sideBtns = [...document.querySelectorAll('.side-btn[data-view]')];
  const pillBtns = [...document.querySelectorAll('.pill-btn[data-view]')];
  const pillNav = document.getElementById('pillNav');
  const navPill = document.getElementById('navPill');
  const navGlider = document.getElementById('navGlider');

  function showView(id) {
    views.forEach(v => v.classList.toggle('active', v.id === id));
    sideBtns.forEach(b => b.classList.toggle('active', b.dataset.view === id));
    pillBtns.forEach(b => b.classList.toggle('active', b.dataset.view === id));
    syncSlider();
    main.scrollTo({ top: 0 });
    // Re-theme the page background to the covers visible on this view.
    const st = getState();
    let pool = [];
    if (id === 'view-library') pool = [...st.tracks, ...st.publicTracks];
    else if (id === 'view-search') pool = st.publicTracks;
    else pool = [...st.publicTracks, ...st.tracks];
    updatePageBackground(pool.slice(0, 6));
  }

  // Park the glass indicator under whichever tab is active. Width is set too so
  // it stays honest if the labels ever measure differently.
  function syncSlider() {
    const active = navPill?.querySelector('.pill-btn.active');
    if (!active || !navGlider) return;
    navGlider.style.width = active.offsetWidth + 'px';
    navGlider.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  sideBtns.forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  pillBtns.forEach(b => b.addEventListener('click', () => {
    // a drag just switched tabs — swallow the synthetic click that trails it
    if (performance.now() < suppressNavClick) return;
    showView(b.dataset.view);
  }));
  window.addEventListener('resize', syncSlider);
  window.addEventListener('load', syncSlider);

  // ---------- Draggable pill nav ----------
  // Drag across the pill and the indicator follows your finger, previewing the
  // tab underneath; release snaps to the nearest one. A plain tap still clicks.
  let suppressNavClick = 0;
  let navDrag = null;

  const nearestTab = x => pillBtns.reduce((best, btn, i) => {
    const r = btn.getBoundingClientRect();
    const d = Math.abs(x - (r.left + r.width / 2));
    return d < best.d ? { i, d } : best;
  }, { i: 0, d: Infinity }).i;

  if (navPill) navPill.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const from = pillBtns.findIndex(b => b.classList.contains('active'));
    navDrag = { x: e.clientX, index: from < 0 ? 0 : from, moved: false };
  });

  window.addEventListener('pointermove', e => {
    if (!navDrag) return;
    if (!navDrag.moved) {
      if (Math.abs(e.clientX - navDrag.x) < 7) return;
      navDrag.moved = true;
      navPill.classList.add('dragging');
    }
    const r = navPill.getBoundingClientRect();
    const half = (navGlider?.offsetWidth || 0) / 2;
    const x = Math.min(Math.max(e.clientX, r.left + half), r.right - half);
    navGlider.style.transform = `translateX(${x - r.left - half}px)`;
    const i = nearestTab(e.clientX);
    if (i !== navDrag.index) {
      navDrag.index = i;
      pillBtns.forEach((b, n) => b.classList.toggle('active', n === i));
    }
  });

  const endNavDrag = () => {
    if (!navDrag) return;
    const { moved, index } = navDrag;
    navDrag = null;
    navPill.classList.remove('dragging');
    if (moved) {
      suppressNavClick = performance.now() + 400;
      const btn = pillBtns[index];
      if (btn) showView(btn.dataset.view);
    }
    syncSlider();
  };
  window.addEventListener('pointerup', endNavDrag);
  window.addEventListener('pointercancel', endNavDrag);
  // Keep the indicator glued to the tab across fonts loading / rotation.
  if (document.fonts?.ready) document.fonts.ready.then(syncSlider);
  requestAnimationFrame(syncSlider);

  // ---------- Player overlay ----------
  const overlay = document.getElementById('playerOverlay');
  const openPlayer = () => overlay.classList.add('open');
  const closePlayer = () => overlay.classList.remove('open');
  document.getElementById('sidePlayer').addEventListener('click', openPlayer);
  document.getElementById('dragHandle').addEventListener('click', closePlayer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePlayer(); });

  const playerBar = document.getElementById('playerBar');
  playerBar.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    openPlayer();
  });

  // ---------- Player DOM handles ----------
  const fills = [document.getElementById('fill'), ...document.querySelectorAll('[data-fill]')];
  const timeLabels = [document.getElementById('timeNow'), ...document.querySelectorAll('[data-timenow]')];
  const totalLabels = [...document.querySelectorAll('.t-total')];
  const playIcons = [document.getElementById('playIcon'), ...document.querySelectorAll('[data-playicon]')];
  const npTitle = document.querySelector('.np-title');
  const npArtist = document.querySelector('.np-artist');
  const npArt = document.querySelector('.np-art .art');
  const pbTitle = document.querySelector('.pb-title');
  const pbArtist = document.querySelector('.pb-artist');
  const pbArt = document.querySelector('.pb-art');
  const lyricsEl = document.querySelector('.lyrics');
  const heartBtn = document.getElementById('heartBtn');
  const pbHeart = document.getElementById('pbHeart');

  const fmt = s => {
    if (!Number.isFinite(s)) return '0:00';
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  };

  function renderTime(e) {
    const elapsed = e ? e.elapsed : playback.elapsed;
    const total = e ? (e.duration || 0) : (playback.duration || 0);
    const pct = total ? (elapsed / total * 100) + '%' : '0%';
    fills.forEach(f => f.style.width = pct);
    timeLabels.forEach(t => t.textContent = fmt(elapsed));
    totalLabels.forEach(t => t.textContent = fmt(total));
  }

  function renderPlayState() {
    const playing = playback.playing;
    playIcons.forEach(ic => ic.innerHTML = '<use href="#i-' + (playing ? 'pause' : 'play') + '"/>');
  }

  const overlayEl = document.getElementById('playerOverlay');

  /* ---- Dominant color extraction from the cover art ----
     Draws the image to a tiny canvas and picks bright, saturated colors to
     paint the backdrop — the same visual trick the reference app uses: only
     the rounded square is the cover, everything else extends its colors. */
  function applyCoverColors(track) {
    const url = artworkUrl(track);
    const rootStyle = document.documentElement.style;
    const fallback = () => {
      ['--cover-1', '--cover-2', '--cover-3', '--cover-4'].forEach(v => rootStyle.removeProperty(v));
    };
    if (!url) { fallback(); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24; c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        // Bucket pixels by coarse hue, weighted toward saturated color so
        // near-black/near-white areas (text, borders) don't dominate.
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const l = (max + min) / 510;             // 0..1
          const d = max - min;
          const sat = max === 0 ? 0 : d / max;
          // Skip achromatic pixels entirely — they turn gradients to mud.
          if (sat < 0.15 || l < 0.08 || l > 0.92) continue;
          const weight = Math.pow(sat, 1.5) * (1 - Math.abs(l - 0.5));
          const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
          const key = Math.round(hue * 2) % 12;
          const cur = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
          cur.w += weight; cur.r += r * weight; cur.g += g * weight; cur.b += b * weight;
          buckets.set(key, cur);
        }
        const sorted = [...buckets.entries()].sort((a, b) => b[1].w - a[1].w);
        const main = sorted[0]?.[1];
        const second = sorted[1]?.[1] || main;
        if (!main || main.w <= 0) { fallback(); return; }
        // Normalize through HSL with lightness clamps so ANY cover yields a
        // clean, rich gradient (never muddy, never pitch black).
        const paint = (rgb, lMul, lMin, lMax, sMul = 1) => {
          let [h, s, l] = rgbToHsl(rgb.r / rgb.w, rgb.g / rgb.w, rgb.b / rgb.w);
          l = Math.min(lMax, Math.max(lMin, l * lMul));
          s = Math.min(0.85, Math.max(0.38, s * sMul));
          const [r2, g2, b2] = hslToRgb(h, s, l);
          return `rgb(${Math.round(r2)},${Math.round(g2)},${Math.round(b2)})`;
        };
        rootStyle.setProperty('--cover-1', paint(main, 1.25, 0.42, 0.58, 1.1));
        rootStyle.setProperty('--cover-2', paint(second, 0.9, 0.3, 0.44, 1.05));
        rootStyle.setProperty('--cover-3', paint(main, 0.6, 0.18, 0.3));
        rootStyle.setProperty('--cover-4', paint(main, 0.35, 0.09, 0.18));
      } catch { fallback(); }
    };
    img.onerror = fallback;
    img.src = url;
  }

  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb(h, s, l) {
    if (s === 0) { const v = l * 255; return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = t => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  /* ---- Scrolling synced lyrics ---- */
  let lyricLines = [];
  let lyricActive = -1;

  function renderLyrics(track) {
    lyricLines = []; lyricActive = -1;
    if (track?.syncedLyrics?.length) {
      lyricsEl.innerHTML = track.syncedLyrics.map((l, i) =>
        `<div class="line" data-i="${i}" data-t="${l.time}">${l.text}</div>`).join('');
      lyricLines = [...lyricsEl.querySelectorAll('.line')];
      lyricsEl.scrollTop = 0;
    } else if (track?.lyrics) {
      const lines = track.lyrics.split('\n').filter(Boolean);
      lyricsEl.innerHTML = lines.length
        ? lines.map(l => `<div class="line static">${l}</div>`).join('')
        : '<div class="dim">No lyrics yet</div>';
    } else {
      lyricsEl.innerHTML = '<div class="dim">Looking for lyrics…</div>';
    }
  }

  function syncLyrics(elapsed) {
    if (!lyricLines.length) return;
    // Small negative offset so the highlight lands ON the vocal, not ahead
    // of it (LRCLIB timestamps tend to lead by a few hundred ms).
    const t = elapsed - 0.35;
    let active = -1;
    for (let i = 0; i < lyricLines.length; i++) {
      if (Number(lyricLines[i].dataset.t) <= t) active = i;
      else break;
    }
    if (active === lyricActive) return;
    lyricActive = active;
    lyricLines.forEach((el, i) => el.classList.toggle('active', i === active));
    if (active >= 0) {
      const el = lyricLines[active];
      // Center the active line in the lyrics box. offsetTop is relative to
      // .lyrics itself (it is position:relative) — but scroll position is
      // included in rect math, so compute purely from layout offsets:
      const center = el.offsetTop - (lyricsEl.clientHeight - el.offsetHeight) / 2;
      const max = lyricsEl.scrollHeight - lyricsEl.clientHeight;
      lyricsEl.scrollTo({ top: Math.max(0, Math.min(center, max)), behavior: 'smooth' });
    } else {
      lyricsEl.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // Tap a lyric line to seek there.
  lyricsEl.addEventListener('click', e => {
    const line = e.target.closest('.line[data-t]');
    if (line) playback.seek(Number(line.dataset.t));
  });

  function coverHtml(track, fallbackSymbol) {
    const url = artworkUrl(track);
    if (url) return `<img class="art-img" src="${url}" alt="" />`;
    return `<svg><use href="#${fallbackSymbol || 'i-note'}"/></svg>`;
  }

  const bgArt = document.getElementById('bgArt');

  function renderNowPlaying() {
    const track = playback.current;
    if (!track) return;
    npTitle.textContent = track.title;
    npArtist.textContent = track.artist;
    npArt.innerHTML = coverHtml(track, 'i-cover-np');
    pbTitle.textContent = track.title;
    pbArtist.textContent = track.artist;
    pbArt.innerHTML = coverHtml(track, 'i-note');
    const cover = artworkUrl(track);
    if (cover) { bgArt.src = cover; bgArt.style.display = 'block'; }
    else bgArt.style.display = 'none';
    applyCoverColors(track);
    const liked = Boolean(track.loved);
    heartBtn.classList.toggle('liked', liked);
    pbHeart.classList.toggle('liked', liked);
    renderLyrics(track);
  }

  onPlayback('time', e => { renderTime(e); syncLyrics(e.elapsed); });
  onPlayback('state', renderPlayState);
  onPlayback('state', renderHeroPlay);
  onPlayback('state', e => { if (e.error) document.getElementById('importStatus').textContent = e.error; });
  onPlayback('track', renderNowPlaying);
  onPlayback('track', renderHeroPlay);

  // Hero chip toggles playback. stopPropagation keeps it from bubbling into the
  // card's own handler, which opens the full player instead.
  document.getElementById('heroPlay').addEventListener('click', async e => {
    e.stopPropagation();
    if (!heroTrackId) return;
    if (playback.current?.id === heroTrackId) { playback.toggle(); return; }
    const list = allTracks();
    const idx = list.findIndex(t => t.id === heroTrackId);
    if (idx < 0) return;
    setQueue(list, idx);
    await playAt(idx);
  });
  onArtworkFound(track => { if (track.id === playback.current?.id) renderNowPlaying(); renderLibrary(); });
  onLyricsFound(track => { if (track.id === playback.current?.id) renderLyrics(track); });
  // Recognition rewrites a track's title and artist behind the UI's back, so
  // every surface showing that track has to be repainted.
  onTrackUpdated(track => {
    if (track.id === playback.current?.id) renderNowPlaying();
    renderMiniPlayer();
    renderLibrary();
  });

  document.getElementById('playBtn').addEventListener('click', () => playback.toggle());
  document.querySelector('.player-bar .play-toggle').addEventListener('click', () => playback.toggle());

  // Shuffle / repeat now drive the real playback engine and stay in sync
  // between the full player and the desktop bar.
  const shuffleBtns = [...document.querySelectorAll('.ctrl[aria-label="Shuffle"]')];
  const repeatBtns = [...document.querySelectorAll('.ctrl[aria-label="Repeat"]')];
  let shuffleState = false, repeatState = false;
  shuffleBtns.forEach(b => b.addEventListener('click', () => {
    shuffleState = !shuffleState;
    setShuffle(shuffleState);
    shuffleBtns.forEach(x => x.classList.toggle('on', shuffleState));
  }));
  repeatBtns.forEach(b => b.addEventListener('click', () => {
    repeatState = !repeatState;
    setRepeat(repeatState);
    repeatBtns.forEach(x => x.classList.toggle('on', repeatState));
  }));

  document.querySelectorAll('.pb-controls .ctrl[aria-label="Previous"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); playPrev(); }));
  document.querySelectorAll('.pb-controls .ctrl[aria-label="Next"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); playNext(); }));
  document.querySelectorAll('.np-controls .ctrl[aria-label="Previous"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); playPrev(); }));
  document.querySelectorAll('.np-controls .ctrl[aria-label="Next"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); playNext(); }));

  // ---------- Search shortcut + kebab action sheet ----------
  const gotoSearch = (focus) => {
    showView('view-search');
    if (focus) setTimeout(() => searchInput?.focus(), 120);
  };
  document.getElementById('pillSearch').addEventListener('click', () => gotoSearch(false));

  const sheet = document.getElementById('sheet');
  const topMenu = document.getElementById('topMenu');
  const closeSheet = () => { sheet.hidden = true; topMenu.classList.remove('active'); };
  topMenu.addEventListener('click', e => {
    e.stopPropagation();
    sheet.hidden = !sheet.hidden;
    topMenu.classList.toggle('active', !sheet.hidden);
  });
  document.addEventListener('click', e => {
    if (!sheet.hidden && !e.target.closest('#sheet') && !e.target.closest('#topMenu')) closeSheet();
  });
  sheet.addEventListener('click', async e => {
    const btn = e.target.closest('.sheet-item');
    if (!btn) return;
    const action = btn.dataset.action;
    closeSheet();
    if (action === 'import') importInput.click();
    else if (action === 'identify') openMic();
    else if (action === 'cloud') uploadAllLocal();
    else if (action === 'refresh') {
      importStatus.textContent = 'Refreshing the shared library…';
      await loadPublicTracks();
      renderLibrary();
      importStatus.textContent = 'Shared library up to date';
    } else if (action === 'shuffle') {
      const list = allTracks();
      if (!list.length) { importStatus.textContent = 'Nothing to play yet'; return; }
      shuffleState = true; setShuffle(true);
      shuffleBtns.forEach(x => x.classList.add('on'));
      setQueue(list, Math.floor(Math.random() * list.length));
      playAt(Math.floor(Math.random() * list.length));
      openPlayer();
    } else if (action === 'library') showView('view-library');
  });

  function seek(trackEl, e) {
    const r = trackEl.getBoundingClientRect();
    const total = playback.duration || 0;
    if (!total) return;
    playback.seek(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * total);
  }
  document.getElementById('track').addEventListener('click', e => seek(e.currentTarget, e));
  document.querySelector('.pb-progress').addEventListener('click', e => seek(e.currentTarget, e));

  function toggleLike() {
    const track = playback.current;
    if (!track) return;
    track.loved = !track.loved;
    heartBtn.classList.toggle('liked', track.loved);
    pbHeart.classList.toggle('liked', track.loved);
    import('./wavefy-core.js').then(m => m.saveTrack(track));
  }
  heartBtn.addEventListener('click', toggleLike);
  pbHeart.addEventListener('click', toggleLike);

  // ---------- Import music ----------
  const importBtn = document.getElementById('importBtn');
  const importInput = document.getElementById('importInput');
  const importStatus = document.getElementById('importStatus');
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    if (!importInput.files.length) return;
    importStatus.textContent = 'Reading tags…';
    const imported = await importFiles(importInput.files, {
      onProgress: (i, n, name) => { importStatus.textContent = `Importing ${i + 1}/${n} — ${name}`; },
      onStatus: m => { importStatus.textContent = m; },
    });
    importInput.value = '';
    renderLibrary();
    if (imported.length) {
      importStatus.textContent = `Imported ${imported.length} track${imported.length > 1 ? 's' : ''} — untagged files are being identified, then covers and lyrics`;
      // Start playing the first fresh import right away.
      setQueue(allTracks(), Math.max(0, allTracks().findIndex(t => t.id === imported[0].id)));
      renderTime();
    } else {
      importStatus.textContent = 'No audio files found in the selection';
    }
  });

  // ---------- Library rendering ----------
  const localRows = document.getElementById('localRows');
  const sharedRows = document.getElementById('sharedRows');
  const sharedHeading = document.getElementById('libSharedHeading');
  const heroCard = document.getElementById('heroCard');
  const heroLabel = document.getElementById('heroLabel');
  const heroArtist = document.getElementById('heroArtist');
  const heroKicker = document.getElementById('heroKicker');
  const heroPlayIcon = document.getElementById('heroPlayIcon');
  const heroPlayText = document.getElementById('heroPlayText');
  const recentHeading = document.getElementById('recentHeading');
  const recentRow = document.getElementById('recentRow');
  const recentCount = document.getElementById('recentCount');
  const releasesHeading = document.getElementById('releasesHeading');
  const releasesGrid = document.getElementById('releasesGrid');
  const localCount = document.getElementById('localCount');
  const homeSharedHeading = document.getElementById('homeSharedHeading');
  const homeSharedRows = document.getElementById('homeSharedRows');
  const sharedCount = document.getElementById('sharedCount');
  const homeEmpty = document.getElementById('homeEmpty');
  const artistsHeading = document.getElementById('artistsHeading');
  const artistsRow = document.getElementById('artistsRow');

  function rowHtml(track, fallbackSymbol, extra) {
    const playing = playback.current?.id === track.id ? ' playing' : '';
    // A local song with audio can be published to the cloud from its own row.
    const canUpload = !isPublicTrack(track) && track.blob;
    const cloudBtn = canUpload
      ? `<button class="row-cloud" data-cloud="${track.id}" title="Upload to the cloud" aria-label="Upload to the cloud"><svg width="18" height="18"><use href="#i-cloud-up"/></svg></button>`
      : '';
    // Songs whose identity came from a filename get a one-tap "listen to this"
    // button, so a bad guess can always be corrected by hand.
    const fixBtn = needsRecognition(track)
      ? `<button class="row-cloud" data-fix="${track.id}" title="Identify with AI" aria-label="Identify with AI"><svg width="18" height="18"><use href="#i-spark"/></svg></button>`
      : '';
    return `<div class="row${playing}" data-id="${track.id}"${extra || ''}>
      <div class="thumb">${coverHtml(track, fallbackSymbol)}</div>
      <div class="info"><div class="t">${track.title}</div><div class="a">${track.artist}</div></div>
      ${fixBtn}${cloudBtn}
      <div class="more"><svg width="20" height="20"><use href="#i-play"/></svg></div>
    </div>`;
  }

  /* Shared card template for the grid and the horizontal Recently played row. */
  const albumCardHtml = t => `
      <div class="album" data-id="${t.id}">
        <div class="cover">${coverHtml(t, 'i-note')}</div>
        <div class="title">${t.title}</div>
        <div class="sub">${t.album || t.artist}</div>
      </div>`;

  /* The hero mirrors real playback: its chip reads Play / Resume / Pause. */
  let heroTrackId = null;
  function renderHeroPlay() {
    if (!heroTrackId) return;
    const isCurrent = playback.current?.id === heroTrackId;
    const playing = isCurrent && playback.playing;
    heroPlayIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
    heroPlayText.textContent = playing ? 'Pause' : (isCurrent ? 'Resume' : 'Play');
  }

  const EMPTY_HINT_HTML = `<div class="row empty-hint" id="emptyHint">
      <div class="thumb" style="background:linear-gradient(140deg,rgba(255,255,255,.18),rgba(255,255,255,.06))"><svg><use href="#i-plus"/></svg></div>
      <div class="info"><div class="t">Import your music</div><div class="a">Tags, covers and lyrics are matched automatically</div></div>
    </div>`;

  /* ---- Artist portraits ----
     The artist row shows a photo of the actual singer or band, looked up by
     name through the core (which proxies Deezer via the local server, since
     Deezer sends no CORS headers). A photo already known from a previous
     render — or a previous session — is inlined on the first frame; the rest
     stream in and swap the placeholder out in place, so nothing re-renders
     underneath a tap. */
  let artistRowNames = [];
  const artistPhotoHtml = url => `<img class="art-img" src="${url}" alt="" />`;

  function hydrateArtistPhotos() {
    artistsRow.querySelectorAll('.artist[data-artist]').forEach(tile => {
      const name = artistRowNames[Number(tile.dataset.artist)];
      if (!name || cachedArtistImage(name)) return;
      lookupArtistImage(name).then(url => {
        if (!url) return;
        const face = tile.querySelector('.face');
        if (!face) return;
        face.classList.add('photo');
        face.innerHTML = artistPhotoHtml(url);
      }).catch(() => { /* the SVG placeholder stays */ });
    });
  }

  function renderLibrary() {
    const st = getState();
    const local = st.tracks;
    const shared = st.publicTracks;
    const everything = [...shared, ...local];

    localRows.innerHTML = local.length ? local.map(t => rowHtml(t, 'i-note')).join('') : EMPTY_HINT_HTML;
    sharedHeading.hidden = !shared.length;
    sharedRows.innerHTML = shared.slice(0, 30).map(t => rowHtml(t, 'i-wave')).join('');

    // ---- Home ----
    // Continue listening = the most recently played track, else the newest
    // addition. Not "whatever sorts first", so the hero always means something.
    const byRecency = [...everything].sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    const hero = byRecency[0] || null;
    heroTrackId = hero ? hero.id : null;

    heroCard.hidden = !hero;
    homeEmpty.hidden = Boolean(everything.length);

    if (hero) {
      const artEl = heroCard.querySelector('.hero-art');
      const url = artworkUrl(hero);
      artEl.innerHTML = url ? `<img class="hero-img" src="${url}" alt="" />` : '';
      heroKicker.textContent = hero.lastPlayedAt ? 'Continue listening' : 'Start here';
      heroLabel.textContent = hero.title || 'Unknown track';
      heroArtist.textContent = hero.artist || '';
      heroCard.dataset.id = hero.id;
      renderHeroPlay();
    }

    // Each section below draws from ONE source, so nothing is listed twice:
    // history, then imported songs, then the shared library.
    const recent = byRecency.filter(t => t.lastPlayedAt).slice(0, 10);
    recentHeading.hidden = recent.length < 2;
    recentCount.textContent = recent.length ? ` · ${recent.length}` : '';
    recentRow.innerHTML = recent.map(albumCardHtml).join('');

    releasesHeading.hidden = local.length === 0;
    localCount.textContent = local.length ? ` · ${local.length}` : '';
    releasesGrid.innerHTML = local.slice(0, 12).map(albumCardHtml).join('');

    homeSharedHeading.hidden = shared.length === 0;
    sharedCount.textContent = shared.length ? ` · ${shared.length}` : '';
    homeSharedRows.innerHTML = shared.slice(0, 10).map(t => rowHtml(t, 'i-wave')).join('');

    // ---- Artists (unique artists from the real library) ----
    const seen = new Map();
    everything.forEach(t => { const a = t.artist; if (a && a !== 'Unknown artist' && !seen.has(a)) seen.set(a, t); });
    // Indexed rather than embedded, so an artist name with a quote in it cannot
    // break out of the attribute.
    const knownArtists = [...seen.entries()].slice(0, 8);
    artistRowNames = knownArtists.map(([name]) => name);
    artistsHeading.hidden = seen.size === 0;
    artistsRow.innerHTML = knownArtists.map(([name, t], index) => {
      const photo = cachedArtistImage(name);
      return `
      <div class="artist" data-id="${t.id}" data-artist="${index}">
        <div class="face${photo ? ' photo' : ''}">${photo ? artistPhotoHtml(photo) : coverHtml(t, 'i-person')}</div>
        <div class="name">${name}</div>
      </div>`;
    }).join('');
    hydrateArtistPhotos();

    renderSearch(searchQuery);
    renderPlaylists();
    if (!document.querySelector('.view.active')?.id) showView('view-home');
  }

  // ---- Sidebar playlists: built from the real library, each one playable ----
  const sidePlaylistsEl = document.getElementById('sidePlaylists');
  function renderPlaylists() {
    const st = getState();
    const everything = [...st.publicTracks, ...st.tracks];
    const byAlbum = new Map();
    everything.forEach(t => {
      const key = t.album || t.artist || 'Unknown';
      if (!byAlbum.has(key)) byAlbum.set(key, []);
      byAlbum.get(key).push(t);
    });
    const groups = [...byAlbum.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 4);
    if (!groups.length) {
      sidePlaylistsEl.innerHTML = `<div class="side-empty">Import music to build playlists</div>`;
      return;
    }
    sidePlaylistsEl.innerHTML = groups.map(([name, tracks]) => `
      <div class="side-playlist" data-playlist="${encodeURIComponent(name)}">
        <div class="pl-thumb">${coverHtml(tracks[0], 'i-vinyl')}</div>
        <span class="pl-name">${name}</span>
        <span class="pl-count">${tracks.length}</span>
      </div>`).join('');
  }

  // Clicking a playlist queues exactly that album/artist group.
  sidePlaylistsEl.addEventListener('click', e => {
    const item = e.target.closest('.side-playlist');
    if (!item) return;
    const name = decodeURIComponent(item.dataset.playlist);
    const st = getState();
    const everything = [...st.publicTracks, ...st.tracks];
    const group = everything.filter(t => (t.album || t.artist || 'Unknown') === name);
    if (!group.length) return;
    setQueue(group, 0);
    renderLibrary();
    openPlayer();
  });

  function renderSearch(q) {
    searchQuery = q;
    const st = getState();
    const everything = [...st.publicTracks, ...st.tracks];
    const needle = (q || '').trim().toLowerCase();
    const results = needle
      ? everything.filter(t =>
          t.title.toLowerCase().includes(needle) ||
          t.artist.toLowerCase().includes(needle) ||
          (t.album || '').toLowerCase().includes(needle))
      : everything.slice(0, 20);
    searchRows.innerHTML = results.length
      ? results.map(t => rowHtml(t, 'i-note')).join('')
      : `<div class="row empty-hint"><div class="info"><div class="t">${needle ? 'No matches' : 'Nothing to search yet'}</div><div class="a">${needle ? 'Try a different title or artist' : 'Import music or open the shared library first'}</div></div></div>`;
  }

  const searchInput = document.getElementById('searchInput');
  const searchRows = document.getElementById('searchRows');
  let searchQuery = '';
  searchInput.addEventListener('input', () => renderSearch(searchInput.value));

  function playFromRow(row) {
    const id = row.dataset.id;
    const track = getTrack(id);
    if (!track) return;
    setQueue(allTracks(), allTracks().findIndex(t => t.id === id));
    renderLibrary();
    openPlayer();
  }

  [localRows, sharedRows, homeSharedRows, searchRows, releasesGrid, recentRow, artistsRow, heroCard].forEach(root =>
    root.addEventListener('click', e => {
      const hit = e.target.closest('[data-id]');
      if (!hit) return;
      const id = hit.dataset.id;
      if (!getTrack(id)) return;
      setQueue(allTracks(), allTracks().findIndex(t => t.id === id));
      renderLibrary();
      openPlayer();
    }));

  /* ---- Cloud upload ----
     Explicit buttons rather than a hidden gesture: one on each local row, one
     in the Library actions, one in the kebab sheet. All three land here. */
  async function uploadTrack(track, btn) {
    if (!track) return;
    if (btn) btn.classList.add('busy');
    importStatus.textContent = `Uploading ${track.title}…`;
    try {
      await shareTrack(track, { onStatus: m => { importStatus.textContent = m; } });
      if (btn) { btn.classList.remove('busy'); btn.classList.add('done'); }
      importStatus.textContent = `${track.title} is now in the shared library`;
      renderLibrary();
    } catch (err) {
      if (btn) btn.classList.remove('busy');
      importStatus.textContent = err.message || 'Upload failed';
    }
  }

  async function uploadAllLocal() {
    const locals = getState().tracks.filter(t => t.blob && !isPublicTrack(t));
    if (!locals.length) { importStatus.textContent = 'Nothing to upload — import music first'; return; }
    let done = 0;
    for (const track of locals) {
      try {
        await shareTrack(track, { onStatus: m => { importStatus.textContent = `${m} (${done + 1}/${locals.length})`; } });
        done++;
      } catch (err) {
        importStatus.textContent = err.message || 'Upload failed';
        renderLibrary();
        return;
      }
    }
    importStatus.textContent = `Uploaded ${done} song${done === 1 ? '' : 's'} to the shared library`;
    renderLibrary();
  }

  [localRows, sharedRows, homeSharedRows, searchRows].forEach(root => root.addEventListener('click', e => {
    const btn = e.target.closest('[data-cloud]');
    if (!btn) return;
    e.stopPropagation();
    uploadTrack(getTrack(btn.dataset.cloud), btn);
  }));

  // Let the AI listen to a specific local song and correct its tags.
  [localRows, sharedRows, homeSharedRows, searchRows].forEach(root => root.addEventListener('click', async e => {
    const btn = e.target.closest('[data-fix]');
    if (!btn) return;
    e.stopPropagation();
    const track = getTrack(btn.dataset.fix);
    if (!track) return;
    btn.classList.add('busy');
    try {
      const matched = await recognizeTrack(track, { onStatus: m => { importStatus.textContent = m; } });
      btn.classList.remove('busy');
      importStatus.textContent = matched
        ? `Matched ${track.title} — ${track.artist}`
        : 'No match found for that track';
      if (matched) {
        // The old lookups searched the filename, so redo them against the match.
        lookupArtwork(track, true).then(() => lookupLyrics(track, true)).catch(() => {});
      }
      renderLibrary();
    } catch (err) {
      btn.classList.remove('busy');
      importStatus.textContent = err.message || 'Recognition failed';
    }
  }));

  document.getElementById('cloudAllBtn').addEventListener('click', uploadAllLocal);

  // Long-press (or right-click) a row to share it to the shared library.
  [localRows, sharedRows, homeSharedRows, searchRows].forEach(root => root.addEventListener('contextmenu', async e => {
    const row = e.target.closest('.row[data-id]');
    if (!row) return;
    e.preventDefault();
    const track = getTrack(row.dataset.id);
    if (!track || isPublicTrack(track)) return;
    importStatus.textContent = 'Sharing…';
    try {
      await shareTrack(track, { onStatus: m => importStatus.textContent = m });
      importStatus.textContent = `${track.title} is now in the shared library`;
      renderLibrary();
    } catch (err) {
      importStatus.textContent = err.message || 'Sharing failed';
    }
  }));

  // ---------- Mini player ----------
  const miniPlayer = document.getElementById('miniPlayer');
  const mpArt = document.getElementById('mpArt');
  const mpTitle = document.getElementById('mpTitle');
  const mpArtist = document.getElementById('mpArtist');
  const mpNextTitle = document.getElementById('mpNextTitle');
  const mpNextArtist = document.getElementById('mpNextArtist');
  const mpPlayIcon = document.getElementById('mpPlayIcon');
  document.getElementById('mpPlay').addEventListener('click', e => { e.stopPropagation(); playback.toggle(); });
  document.getElementById('mpNextBtn').addEventListener('click', e => { e.stopPropagation(); playNext(); });
  miniPlayer.addEventListener('click', openPlayer);

  function nextUp() {
    const q = getQueue();
    if (!q.length) return null;
    const i = getQueueIndex();
    return q[i + 1] || null;
  }

  function renderMiniPlayer() {
    const track = playback.current;
    if (!track) { miniPlayer.classList.remove('show'); return; }
    const show = !overlay.classList.contains('open');
    miniPlayer.classList.toggle('show', show);
    miniPlayer.classList.toggle('playing', playback.playing);
    mpArt.innerHTML = coverHtml(track, 'i-note');
    mpTitle.textContent = track.title || 'Unknown';
    mpArtist.textContent = track.artist || '';
    const up = nextUp();
    mpNextTitle.textContent = up ? up.title : '';
    mpNextArtist.textContent = up ? (up.artist || '') : '';
    mpPlayIcon.innerHTML = '<use href="#i-' + (playback.playing ? 'pause' : 'play') + '"/>';
  }
  onPlayback('time', renderMiniPlayer);
  onPlayback('state', renderMiniPlayer);
  onPlayback('track', renderMiniPlayer);
  overlay.addEventListener('transitionend', renderMiniPlayer);

  // ---------- AI song recognition (AudD) ----------
  // Records a short clip, has the server ask AudD what it is, then offers the
  // match as a playable preview. Recognition itself never runs in the browser:
  // /api/identify attaches the operator's token server-side.
  const micPanel = document.getElementById('micPanel');
  const micTitleEl = document.getElementById('micTitle');
  const micSubEl = document.getElementById('micSub');
  const micResult = document.getElementById('micResult');
  const micArt = document.getElementById('micArt');
  const micSong = document.getElementById('micSong');
  const micArtist = document.getElementById('micArtist');
  const micAction = document.getElementById('micAction');
  const micSaveBtn = document.getElementById('micSave');
  const identifyBtn = document.getElementById('identifyBtn');

  let micSupported = false;
  let micRecorder = null;
  let micStream = null;
  let micChunks = [];
  let micStopTimer = 0;
  let micTicker = 0;
  let micMatch = null;

  // Recognition needs no configuration — the AudD key ships with the app — so
  // the only thing that can hold it back is a browser without a microphone.
  identifyAvailable().then(ok => {
    micSupported = ok && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
    identifyBtn.classList.toggle('unavailable', !micSupported);
    identifyBtn.title = micSupported
      ? 'Identify a song from a short clip'
      : 'This browser cannot record audio';
  });

  function micIdle() {
    micTitleEl.textContent = 'Song recognition';
    micSubEl.textContent = micSupported
      ? 'Tap start, then hold your phone near the music'
      : 'This browser cannot record audio';
    micAction.textContent = micSupported ? 'Start listening' : 'Unavailable';
    micAction.disabled = !micSupported;
  }

  function stopMic() {
    clearTimeout(micStopTimer);
    clearInterval(micTicker);
    if (micRecorder && micRecorder.state !== 'inactive') { try { micRecorder.stop(); } catch { /* already stopping */ } }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    micPanel.classList.remove('listening');
  }

  function openMic() {
    micMatch = null;
    micResult.hidden = true;
    micSaveBtn.hidden = true;
    micPanel.hidden = false;
    micPanel.classList.remove('listening');
    document.body.classList.add('mic-open');
    micIdle();
  }

  function closeMic() {
    stopMic();
    micPanel.hidden = true;
    document.body.classList.remove('mic-open');
  }

  document.getElementById('micClose').addEventListener('click', closeMic);
  identifyBtn.addEventListener('click', openMic);

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    } catch {
      micTitleEl.textContent = 'Microphone blocked';
      micSubEl.textContent = 'Allow microphone access, then try again';
      micAction.textContent = 'Try again';
      return;
    }
    micChunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(m => MediaRecorder.isTypeSupported?.(m)) || '';
    micRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
    micRecorder.ondataavailable = e => { if (e.data && e.data.size) micChunks.push(e.data); };
    micRecorder.onstop = () => submitClip();
    micRecorder.start();

    micPanel.classList.add('listening');
    micTitleEl.textContent = 'Listening…';
    micAction.textContent = 'Stop & identify';
    const startedAt = Date.now();
    micTicker = setInterval(() => {
      micSubEl.textContent = `Recording ${((Date.now() - startedAt) / 1000).toFixed(1)}s — keep it steady`;
    }, 100);
    // Clips this long are plenty for AudD and keep the upload small.
    micStopTimer = setTimeout(() => { if (micRecorder?.state === 'recording') micRecorder.stop(); }, 9000);
  }

  async function submitClip() {
    clearInterval(micTicker);
    const blob = new Blob(micChunks, { type: micChunks[0]?.type || 'audio/webm' });
    micChunks = [];
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    micPanel.classList.remove('listening');
    if (!blob.size) {
      micTitleEl.textContent = 'Nothing captured';
      micSubEl.textContent = 'Try again with the music playing';
      micAction.textContent = 'Start listening';
      return;
    }
    micTitleEl.textContent = 'Identifying…';
    micSubEl.textContent = 'Matching the clip against AudD';
    micAction.disabled = true;
    try {
      const match = await identifyClip(blob);
      if (!match) throw new Error('No match — try a clearer or longer clip');
      micMatch = trackFromMatch(match);
      micSong.textContent = micMatch.title;
      micArtist.textContent = [micMatch.artist, micMatch.album].filter(Boolean).join(' · ');
      micArt.innerHTML = coverHtml(micMatch, 'i-note');
      micResult.hidden = false;
      micTitleEl.textContent = 'Found it';
      micSubEl.textContent = micMatch.previewUrl ? 'Preview ready — press play' : 'No playable preview for this one';
      micAction.textContent = micMatch.previewUrl ? 'Play preview' : 'Start listening';
      micSaveBtn.hidden = false;
      // Swap in the real sleeve once iTunes answers, and line up lyrics for it.
      lookupArtwork(micMatch, true).then(ok => { if (ok && micMatch) micArt.innerHTML = coverHtml(micMatch, 'i-note'); });
      lookupLyrics(micMatch).catch(() => {});
    } catch (err) {
      micTitleEl.textContent = 'No match';
      micSubEl.textContent = err.message || 'Try again';
      micAction.textContent = 'Try again';
    } finally {
      micAction.disabled = false;
    }
  }

  micAction.addEventListener('click', () => {
    if (micPanel.classList.contains('listening')) {
      if (micRecorder?.state === 'recording') micRecorder.stop();
      return;
    }
    if (micMatch) {
      setQueue([micMatch], 0);
      renderLibrary();
      openPlayer();
      closeMic();
      return;
    }
    if (!micSupported) { micIdle(); return; }
    startMic();
  });

  micSaveBtn.addEventListener('click', async () => {
    if (!micMatch) return;
    const st = getState();
    st.tracks = [micMatch, ...st.tracks.filter(t => t.id !== micMatch.id)];
    await saveTrack(micMatch);
    micSaveBtn.hidden = true;
    micTitleEl.textContent = 'Saved to your library';
    micSubEl.textContent = 'You can find it in Library';
    renderLibrary();
  });

  // ---------- Dynamic page background from cover colors ----------
  const bgA = document.getElementById('bgA');
  const bgB = document.getElementById('bgB');
  let bgFront = bgA;
  let bgPaintedKey = '';
  const paletteCache = new Map(); // track id -> [r,g,b]

  function extractPalette(track) {
    return new Promise(resolve => {
      const url = artworkUrl(track);
      if (!url) return resolve(null);
      const cached = paletteCache.get(track.id);
      if (cached) return resolve(cached);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 16; c.height = 16;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 16, 16);
          const d = ctx.getImageData(0, 0, 16, 16).data;
          let r = 0, g = 0, b = 0, w = 0;
          for (let i = 0; i < d.length; i += 4) {
            const pr = d[i], pg = d[i + 1], pb = d[i + 2];
            const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
            const l = (max + min) / 510, sat = max === 0 ? 0 : (max - min) / max;
            if (sat < 0.12 || l < 0.08 || l > 0.92) continue;
            const px = Math.pow(sat, 1.4) * (1 - Math.abs(l - 0.5));
            r += pr * px; g += pg * px; b += pb * px; w += px;
          }
          if (!w) return resolve(null);
          // Normalize via HSL so every color is usable in a gradient.
          const [h, s0, l0] = rgbToHsl(r / w, g / w, b / w);
          const s = Math.min(0.8, Math.max(0.35, s0 * 1.1));
          const l = Math.min(0.55, Math.max(0.3, l0));
          resolve({ id: track.id, hsl: [h, s, l] });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // Circular mean, so blending hues never jumps across the colour wheel.
  function meanHue(items) {
    let x = 0, y = 0;
    for (const it of items) {
      const a = it.h * Math.PI * 2;
      x += Math.cos(a) * it.w;
      y += Math.sin(a) * it.w;
    }
    if (!x && !y) return items[0] ? items[0].h : 0;
    const h = Math.atan2(y, x) / (Math.PI * 2);
    return h < 0 ? h + 1 : h;
  }

  /* The page background is ONE colour pulled from the covers on screen —
     a single tone washed over a near-black base. The film grain layer supplies
     the texture; there is deliberately no multi-colour mesh here. */
  async function updatePageBackground(tracks) {
    const key = tracks.map(t => t.id).join('|') + '#' + (document.querySelector('.view.active')?.id || '');
    if (key === bgPaintedKey) return;
    bgPaintedKey = key;
    const results = (await Promise.all(tracks.slice(0, 8).map(extractPalette))).filter(Boolean);
    if (!results.length) return;

    // Weight each cover by how vivid it is, so a saturated sleeve leads the
    // tone and a washed-out one only nudges it.
    const weighted = results.map(r => {
      const [h, s, l] = r.hsl;
      return { h, s, l, w: Math.max(0.06, s * (1 - Math.abs(l - 0.5))) };
    });
    const totalW = weighted.reduce((a, b) => a + b.w, 0) || 1;
    const hue = meanHue(weighted);
    const avgS = weighted.reduce((a, b) => a + b.s * b.w, 0) / totalW;
    const avgL = weighted.reduce((a, b) => a + b.l * b.w, 0) / totalW;

    // Refined wash: lower saturation and a higher floor on lightness. Pushing
    // a muted cover to high saturation gave slabs of flat colour; this keeps
    // the page airy and lets the grain do the texturing.
    const s = Math.min(0.46, Math.max(0.24, avgS * 0.72));
    const l = Math.min(0.90, Math.max(0.82, 0.86 + (avgL - 0.45) * 0.16));
    const [tr, tg, tb] = hslToRgb(hue, s, l).map(Math.round);
    const tone = `${tr}, ${tg}, ${tb}`;
    const [dr, dg, db] = hslToRgb(hue, Math.min(0.52, s * 1.1), Math.max(0.70, l - 0.11)).map(Math.round);

    const gradient = [
      'radial-gradient(120% 78% at 50% -10%, rgba(255,255,255,.88) 0%, rgba(255,255,255,0) 62%)',
      `linear-gradient(180deg, rgb(${tone}) 0%, rgb(${tone}) 34%, rgb(${dr}, ${dg}, ${db}) 100%)`,
    ].join(',');

    // Paint the hidden layer, then crossfade.
    const back = bgFront === bgA ? bgB : bgA;
    // backgroundImage (not the `background` shorthand), so the CSS keeps
    // background-size mapping the gradient to the visible screen.
    back.style.backgroundImage = gradient;
    back.classList.remove('hidden');
    bgFront.classList.add('hidden');
    bgFront = back;

    // The same single tone drives the ambient corner blobs — nothing is red.
    const root = document.documentElement.style;
    root.setProperty('--tone', tone);
    root.setProperty('--tone-deep', `${dr}, ${dg}, ${db}`);
    // The canvas only ever shows *outside* the shell — a browser toolbar strip,
    // or the area a phone exposes while it animates its bottom bar away. So it
    // carries the SAME gradient and grain as the app's own background rather
    // than a flat fill: even a flat fill matched to the gradient's last stop
    // read as a stray bar every time the viewport stretched past the shell.
    root.setProperty('--app-canvas', gradient);
    root.setProperty('--app-canvas-flat', `rgb(${dr}, ${dg}, ${db})`);
    // OS chrome (status bar, Android nav bar) is painted from theme-color; keep
    // it on the app's own top tone so no system bar can mismatch either.
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', `rgb(${tr}, ${tg}, ${tb})`);
    root.setProperty('--cover-glow', 'rgba(255, 255, 255, .62)');
    root.setProperty('--cover-glow-2', `rgba(${dr}, ${dg}, ${db}, .5)`);
  }

  // ---------- Shell geometry: measured, not assumed ----------
  // The bottom of a phone screen is where every version of this bug lived. The
  // shell is a plain 100dvh flex column now and the nav is one of its rows, so
  // the only thing left to get right down here is the inset: whether the home
  // indicator actually needs clearing, or whether a browser's own bottom bar is
  // already covering it. That is measured below, in one place, and nowhere else.
  const docEl = document.documentElement;
  const viewport = window.visualViewport;

  // Standalone / home-screen app: no browser chrome at all, which is what makes
  // the physical screen a valid floor (declared here because the first measure
  // below already reads it).
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.documentElement.classList.toggle('standalone', standalone);

  function physicalScreenEdge() {
    const w = (window.screen && window.screen.width) || 0;
    const h = (window.screen && window.screen.height) || 0;
    if (!w || !h) return 0;
    const portrait = (window.innerHeight || 0) >= (window.innerWidth || 0);
    // In portrait the on-screen height is the long edge, in landscape the short one.
    return Math.round(portrait ? Math.max(w, h) : Math.min(w, h));
  }

  // Probe the insets instead of trusting the values CSS resolved at first paint.
  // A home indicator is at most ~34px, so anything larger is a toolbar height
  // being reported as an inset, and gets clamped.
  const safeProbe = document.createElement('div');
  safeProbe.setAttribute('aria-hidden', 'true');
  safeProbe.style.cssText = 'position:fixed;left:-9999px;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden';
  document.body.appendChild(safeProbe);
  const topProbe = document.createElement('div');
  topProbe.setAttribute('aria-hidden', 'true');
  topProbe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:env(safe-area-inset-top,0px);pointer-events:none;visibility:hidden';
  document.body.appendChild(topProbe);

  function syncSafeArea() {
    const raw = Math.min(Math.round(safeProbe.getBoundingClientRect().height) || 0, 34);
    const edge = physicalScreenEdge();
    const visible = Math.round((viewport ? viewport.height : window.innerHeight) || 0);
    const chromeTop = Math.round(topProbe.getBoundingClientRect().height) || 0;
    // If the display is taller than the visible viewport by more than the status
    // bar, the leftover strip at the bottom is a browser's own bar — and the home
    // indicator is behind that bar, so reserving its inset as well would lift the
    // nav off the bottom edge for no reason, which is exactly what read as a
    // stray bar. Both numbers here are measured, never assumed.
    const browserBarBelow = edge > 0 && visible > 0 && edge - visible - chromeTop > 24;
    setShellVar('--safe-bottom', `${browserBarBelow ? 0 : raw}px`);
  }

  // Only touch the DOM when a value actually moved: this runs on scroll too, and
  // an unconditional write would invalidate style on every scroll frame.
  function setShellVar(name, value) {
    if (docEl.style.getPropertyValue(name) === value) return;
    docEl.style.setProperty(name, value);
  }

  // Last-mile guard, in one direction only. If the shell's last row still ends
  // up below what the phone reports as visible — a dynamic viewport unit that
  // resolved before the browser settled its toolbars — lift the bottom chrome by
  // exactly the shortfall. It can only ever raise the nav into view, so the worst
  // case stays a small gap above the bottom instead of a hidden control, and the
  // geometry is measured rather than assumed.
  const chromeEl = document.getElementById('bottomChrome');
  function clampChrome() {
    if (!chromeEl) return;
    if (chromeEl.style.transform) chromeEl.style.transform = '';
    const visible = Math.round((viewport ? viewport.height : window.innerHeight) || 0);
    if (!visible) return;
    const short = chromeEl.getBoundingClientRect().bottom - visible;
    if (short < 1.5) return;
    chromeEl.style.transform = `translateY(${-Math.min(Math.round(short), 96)}px)`;
  }

  function syncShell() { syncSafeArea(); clampChrome(); }

  syncShell();
  requestAnimationFrame(syncShell);
  // The browser keeps revising the viewport for a moment after load, so measure
  // a few more times rather than trusting the first reading.
  [90, 320, 900, 1800, 3500].forEach(ms => setTimeout(syncShell, ms));
  window.addEventListener('load', syncShell, { once: true });
  window.addEventListener('resize', syncShell, { passive: true });
  window.addEventListener('orientationchange', () => { syncShell(); setTimeout(syncShell, 320); });
  viewport?.addEventListener('resize', syncShell, { passive: true });
  // iOS sometimes corrects its layout viewport with no event at all — which is
  // exactly why flipping the phone used to "fix" the nav. Scrolling is when it
  // happens most, so re-measure then (one rAF-throttled call, no-op writes only).
  // Safari in a tab keeps its bottom bar over the app until the *document*
  // scrolls, and this shell never scrolls by itself — which is why the bar stayed
  // put and had to be shaken loose by rotating the phone. Two pixels of scrollable
  // height (see the html rule) plus one nudge on load and on the first touch is
  // enough for Safari to retract its bars; nothing moves on screen because every
  // visible layer is fixed to the viewport.
  function nudgeBrowserBars() {
    if (standalone) return;
    if (docEl.scrollHeight <= docEl.clientHeight) return;
    if ((window.scrollY || docEl.scrollTop || 0) < 2) window.scrollTo(0, 2);
  }
  window.addEventListener('load', nudgeBrowserBars);
  setTimeout(nudgeBrowserBars, 300);
  document.addEventListener('touchstart', nudgeBrowserBars, { passive: true, once: true });

  let shellTick = false;
  main.addEventListener('scroll', () => {
    if (shellTick) return;
    shellTick = true;
    requestAnimationFrame(() => { shellTick = false; syncShell(); });
  }, { passive: true });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // Kill pinch-zoom and double-tap zoom so the layout stays fixed like a native app.
  document.addEventListener('gesturestart', e => e.preventDefault());
  let lastTap = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 300 && !e.target.closest('input, textarea')) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  // ---------- iOS Safari: say the one thing that actually removes the bar ----
  // In a Safari tab, Safari's own bottom bar sits over the app and no page code
  // can paint it away or shrink it. An installed Wavefy has no browser chrome at
  // all, so the tip is offered once, only where it applies, and dismisses for good.
  (() => {
    const ua = navigator.userAgent || '';
    const safariTab = !standalone && /iPhone|iPad|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    if (!safariTab) return;
    try { if (localStorage.getItem('wavefy.safari-hint')) return; } catch { /* private mode */ }
    const hint = document.createElement('div');
    hint.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top));z-index:120;display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:20px;background:rgba(255,255,255,.78);border:1px solid rgba(255,255,255,.85);backdrop-filter:blur(22px) saturate(180%);-webkit-backdrop-filter:blur(22px) saturate(180%);box-shadow:0 16px 38px rgba(74,48,100,.22);color:var(--ink);font-size:.8125rem;line-height:1.35';
    const text = document.createElement('span');
    text.style.cssText = 'flex:1 1 auto';
    text.innerHTML = 'Safari keeps its own bar over the bottom of the app. For the full-screen version: Share <b>&rarr; Add to Home Screen</b>.';
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'flex:0 0 auto;background:none;border:none;color:var(--ink-dim);padding:4px;cursor:pointer';
    close.innerHTML = '<svg width="13" height="13"><use href="#i-close"/></svg>';
    close.addEventListener('click', () => {
      hint.remove();
      try { localStorage.setItem('wavefy.safari-hint', 'seen'); } catch { /* ignore */ }
    });
    hint.append(text, close);
    document.body.appendChild(hint);
  })();

  // ---------- Optional on-screen diagnostics (?diag) ----------
  // A phone is the only place these numbers can be read, and between them they
  // explain any gap at the bottom: the visual viewport vs the layout viewport vs
  // the physical screen. Add ?diag to the URL, screenshot it, remove it to hide.
  if (/[?&]diag/.test(location.search)) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:6px;top:6px;z-index:9999;padding:6px 8px;border-radius:10px;background:rgba(20,10,20,.74);color:#fff;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;pointer-events:none';
    document.body.appendChild(box);
    const paintDiag = () => {
      const cs = getComputedStyle(docEl);
      const shell = document.body.getBoundingClientRect();
      const navRect = document.getElementById('pillNav').getBoundingClientRect();
      const chromeRect = document.getElementById('bottomChrome').getBoundingClientRect();
      const visible = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      box.textContent = [
        `vv ${Math.round(visible)} inner ${Math.round(window.innerHeight || 0)} client ${Math.round(docEl.clientHeight || 0)}`,
        `screen ${Math.round(screen.width || 0)}x${Math.round(screen.height || 0)} dpr ${window.devicePixelRatio || 1} standalone ${standalone}`,
        `safe-bottom ${cs.getPropertyValue('--safe-bottom').trim()} shell-h ${cs.height}`,
        `shell ${Math.round(shell.height)} foot ${Math.round(chromeRect.bottom)}`,
        `nav bottom ${Math.round(navRect.bottom)} gap-under-nav ${Math.round(visible - navRect.bottom)}`,
        `short ${Math.round(chromeRect.bottom - visible)}`,
      ].join('\n');
    };
    paintDiag();
    [500, 1500, 3000].forEach(ms => setTimeout(paintDiag, ms));
    window.addEventListener('resize', paintDiag, { passive: true });
    document.addEventListener('scroll', paintDiag, { passive: true, capture: true });
  }

  // ---------- Boot ----------
  (async () => {
    await boot();
    renderLibrary();
    // Glass maps are size-specific, so build them once layout has settled.
    refreshLiquidGlass();
    renderTime();
    renderPlayState();
    applyCoverColors(getState().publicTracks[0] || getState().tracks[0] || null);
    updatePageBackground([...getState().publicTracks, ...getState().tracks]);
    // Refresh the shared library silently every time the tab regains focus.
    document.addEventListener('visibilitychange', async () => {
      if (!document.hidden) { await loadPublicTracks(); renderLibrary(); }
    });
  })();
