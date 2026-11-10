/* JZo Entertainment Foto Video AI – Oberfläche (Foto) */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------------------------------------------------------------- Bibliotheken (aus dem Netz; zum Testen lokal überschreibbar)
  const LIBS = params.get('libs')
    ? { cv: params.get('libs') + '/opencv/opencv.js', ort: params.get('libs') + '/ort/ort.all.min.js', ortBase: params.get('libs') + '/ort/' }
    : {
        cv: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js',
        ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.all.min.js',
        ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/',
      };
  const MODELS = { esrgan: 'models/esrgan_general_x4v3.onnx', yolox: 'models/yolox_s.onnx' };

  const state = { img: null, name: 'foto', cvReady: null, ortReady: null, sessions: {}, boxes: [], marking: false, result: null, abort: null, busy: false, provider: null, defaults: null };

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Konnte nicht laden: ' + src));
      document.head.appendChild(s);
    });
  }
  function setStatus(text, cls) { const s = $('status'); s.textContent = text || ''; s.className = 'status' + (cls ? ' ' + cls : ''); }
  function log(t) { const l = $('log'); l.classList.remove('hidden'); l.textContent += t + '\n'; l.scrollTop = l.scrollHeight; }

  async function ensureCV() {
    if (!state.cvReady) state.cvReady = (async () => {
      setStatus('Lade Bildbibliothek (OpenCV) …');
      await loadScript(LIBS.cv);
      if (typeof cv.then === 'function') window.cv = await cv;
      else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
      JZO.setLibs({ cv: window.cv, ort: window.ort || null });
    })();
    return state.cvReady;
  }
  async function ensureORT() {
    if (!state.ortReady) state.ortReady = (async () => {
      setStatus('Lade KI-Laufzeit …');
      await loadScript(LIBS.ort);
      ort.env.wasm.wasmPaths = LIBS.ortBase;
      ort.env.wasm.numThreads = window.crossOriginIsolated ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8)) : 1;   // Mehrkern nur mit Cross-Origin-Isolation
      if (window.cv) JZO.setLibs({ cv: window.cv, ort });
    })();
    return state.ortReady;
  }
  async function fetchModel(url, label) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Modell nicht gefunden: ' + url);
    const total = +r.headers.get('content-length') || 0;
    if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      setStatus(`Lade ${label} … ${Math.round((100 * got) / total)} %`);
    }
    const out = new Uint8Array(got); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  /** ONNX-Sitzung: erst WebGPU (Grafikkarte), sonst Prozessor. */
  async function getSession(name, label, probeShape) {
    if (state.sessions[name]) return state.sessions[name];
    await ensureORT();
    const bytes = await fetchModel(MODELS[name], label);
    const tryEPs = [];
    if (navigator.gpu && params.get('gpu') !== '0') tryEPs.push(['webgpu']);
    tryEPs.push(['wasm']);
    let lastErr;
    for (const ep of tryEPs) {
      try {
        setStatus(`Starte ${label} (${ep[0] === 'webgpu' ? 'Grafikkarte' : 'Prozessor'}) …`);
        const s = await ort.InferenceSession.create(bytes, { executionProviders: ep });
        const n = probeShape.reduce((a, b) => a * b, 1);
        await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(n).fill(0.5), probeShape) });
        state.provider = state.provider === 'wasm' ? 'wasm' : ep[0];
        state.sessions[name] = s;
        return s;
      } catch (e) { lastErr = e; state.provider = 'wasm'; log(`${label}: ${ep[0]} fehlgeschlagen (${e.message || e})`); }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------- Einstellungs-Regler (werden aus dieser Liste gebaut)
  const pct = (v) => Math.round(v * 100) + ' %', sgn = (v) => (v > 0 ? '+' : '') + Math.round(v * 100);
  const GROUPS = [
    { title: 'Entrauschen', open: true, items: [
      { id: 'denoise', label: 'Stärke', min: 0, max: 1, step: 0.05, fmt: pct },
      { id: 'dnDetail', label: 'Details erhalten', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Mischt etwas vom Original zurück (mehr Struktur, mehr Restrauschen).' },
      { id: 'dnColor', label: 'Farbrauschen entfernen', min: 0, max: 1, step: 0.05, fmt: pct },
    ] },
    { title: 'Schärfen', open: true, items: [
      { id: 'sharpen', label: 'Stärke', min: 0, max: 1, step: 0.05, fmt: pct },
      { id: 'shRadius', label: 'Radius', min: 0.3, max: 2.5, step: 0.1, fmt: (v) => v.toFixed(1) + ' px', tip: 'Klein = feine Details, groß = Kanten kräftiger.' },
      { id: 'shGate', label: 'Rauschschutz', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Schärft Rauschen weniger mit.' },
      { id: 'shHalo', label: 'Haloschutz', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Begrenzt helle/dunkle Säume an Kanten.' },
    ] },
    { title: 'Vergrößern', open: true, custom: 'scale' },
    { title: 'Licht', items: [
      { id: 'exposure', label: 'Belichtung', min: -2, max: 2, step: 0.05, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' EV' },
      { id: 'contrast', label: 'Kontrast', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'highlights', label: 'Lichter', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'shadows', label: 'Tiefen', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'whites', label: 'Weiß', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'blacks', label: 'Schwarz', min: -1, max: 1, step: 0.05, fmt: sgn },
    ] },
    { title: 'Farbe', items: [
      { id: 'saturation', label: 'Sättigung', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'vibrance', label: 'Dynamik (Vibrance)', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'temperature', label: 'Temperatur', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'tint', label: 'Tönung', min: -1, max: 1, step: 0.05, fmt: sgn },
    ] },
    { title: 'Details', items: [
      { id: 'clarity', label: 'Klarheit', min: -1, max: 1, step: 0.05, fmt: sgn },
      { id: 'grain', label: 'Körnung', min: 0, max: 1, step: 0.05, fmt: pct },
    ] },
  ];
  const ADJ_IDS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'vibrance', 'temperature', 'tint', 'clarity', 'grain'];
  const SLIDER = {};   // id -> {el, out, fmt, def}
  function buildControls() {
    const host = $('controls');
    for (const g of GROUPS) {
      const det = document.createElement('details'); det.className = 'grp'; det.open = !!g.open;
      const sm = document.createElement('summary'); sm.textContent = g.title; det.appendChild(sm);
      if (g.custom === 'scale') {
        det.insertAdjacentHTML('beforeend', `<div class="field"><label for="scale">Faktor</label><select id="scale"><option value="1">Original (1×)</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></div>
          <div class="field check"><label><input id="ai" type="checkbox" checked> KI-Vergrößerung (Real-ESRGAN)</label><small>Aus = schneller, klassische Vergrößerung.</small></div>`);
      } else for (const it of g.items) {
        const f = document.createElement('div'); f.className = 'field';
        f.innerHTML = `<label class="lbl" title="${it.tip ? it.tip + ' ' : ''}Doppelklick = zurücksetzen"><span>${it.label}</span><output></output></label><input type="range" id="${it.id}" min="${it.min}" max="${it.max}" step="${it.step}">`;
        const el = f.querySelector('input'), out = f.querySelector('output');
        SLIDER[it.id] = { el, out, fmt: it.fmt };
        el.addEventListener('input', () => { out.textContent = it.fmt(+el.value); if (ADJ_IDS.includes(it.id)) scheduleLiveAdjust(); });
        f.querySelector('label').addEventListener('dblclick', () => { el.value = state.defaults[it.id]; el.dispatchEvent(new Event('input')); });
        det.appendChild(f);
      }
      host.appendChild(det);
    }
  }
  function readSettings() {
    const S = {};
    for (const id of Object.keys(SLIDER)) S[id] = +SLIDER[id].el.value;
    Object.assign(S, {
      scale: +$('scale').value, ai: $('ai').checked, birds: $('birds').checked, birdMode: $('birdMode').value,
      birdDetail: +$('birdDetail').value, birdBg: +$('birdBg').value, birdTarget: +$('birdTarget').value, birdBoxes: state.boxes.slice(),
    });
    return S;
  }
  function writeSettings(s) {
    for (const k of Object.keys(s)) {
      if (SLIDER[k]) { SLIDER[k].el.value = s[k]; SLIDER[k].out.textContent = SLIDER[k].fmt(+s[k]); continue; }
      const el = $(k); if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    }
    ['birdDetail', 'birdBg'].forEach((id) => { $('o-' + id).textContent = pct(+$(id).value); });
    $('birdbox').open = $('birds').checked;
  }
  ['birdDetail', 'birdBg'].forEach((id) => $(id).addEventListener('input', () => { $('o-' + id).textContent = pct(+$(id).value); }));
  $('preset').addEventListener('change', () => {
    const keep = { scale: $('scale').value, ai: $('ai').checked };
    writeSettings(Object.assign({}, state.defaults, { birds: false }, JZO.PRESETS[$('preset').value], keep));
  });
  $('btn-reset').onclick = () => { const keep = { scale: $('scale').value, ai: $('ai').checked }; writeSettings(Object.assign({}, state.defaults, keep)); $('preset').value = 'standard'; scheduleLiveAdjust(); };
  $('birds').addEventListener('change', () => { $('birdbox').open = $('birds').checked; });

  // ---------------------------------------------------------------- Viewer: Verschieben und Zoomen
  const V = { k: 1, tx: 0, ty: 0, fit: 1, iw: 0, ih: 0, fitted: true, raf: 0 };
  const vp = () => $('viewport');
  function applyView() {
    V.raf = 0;
    $('stage').style.transform = `translate(${V.tx}px,${V.ty}px) scale(${V.k})`;
    $('stage').classList.toggle('pix', V.k >= 2);
    $('z-label').textContent = Math.round(V.k * 100) + ' %';
  }
  function queueView() { if (!V.raf) V.raf = requestAnimationFrame(applyView); }
  function fitView() {
    const r = vp().getBoundingClientRect();
    V.fit = Math.min(r.width / V.iw, r.height / V.ih) * 0.98;
    V.k = V.fit; V.tx = (r.width - V.iw * V.k) / 2; V.ty = (r.height - V.ih * V.k) / 2; V.fitted = true; applyView(); redrawOverlay();
  }
  function zoomTo(nk, cx, cy) {
    const r = vp().getBoundingClientRect();
    if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
    nk = clamp(nk, Math.min(V.fit, 0.05), 16);
    V.tx = cx - (cx - V.tx) * (nk / V.k); V.ty = cy - (cy - V.ty) * (nk / V.k); V.k = nk; V.fitted = false; queueView();
    if (state.boxes.length || state.result) redrawOverlay();
  }
  function setImageSize(w, h, keepView) {
    const changed = w !== V.iw || h !== V.ih; V.iw = w; V.ih = h;
    const st = $('stage'); st.style.width = w + 'px'; st.style.height = h + 'px';
    if (changed && !keepView) fitView();
  }
  (function setupViewport() {
    const el = vp(); let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || state.marking) return;
      drag = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty }; el.setPointerCapture(e.pointerId); el.classList.add('dragging'); $('vp-hint').classList.add('fade');
    });
    el.addEventListener('pointermove', (e) => { if (!drag) return; V.tx = drag.tx + e.clientX - drag.x; V.ty = drag.ty + e.clientY - drag.y; V.fitted = false; queueView(); });
    const end = () => { drag = null; el.classList.remove('dragging'); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      const trackpadScroll = !e.ctrlKey && !e.metaKey && !e.altKey && e.deltaMode === 0 && (Math.abs(e.deltaY) < 40 || e.deltaX !== 0);
      if (trackpadScroll) { V.tx -= e.deltaX; V.ty -= e.deltaY; V.fitted = false; queueView(); }
      else zoomTo(V.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), cx, cy);
    }, { passive: false });
    el.addEventListener('dblclick', (e) => {
      if (state.marking) return;
      const r = el.getBoundingClientRect();
      if (Math.abs(V.k - 1) < 0.02) fitView(); else zoomTo(1, e.clientX - r.left, e.clientY - r.top);
    });
    window.addEventListener('resize', () => { if (V.iw && V.fitted) fitView(); });
  })();
  $('z-fit').onclick = fitView; $('z-100').onclick = () => zoomTo(1); $('z-in').onclick = () => zoomTo(V.k * 1.5); $('z-out').onclick = () => zoomTo(V.k / 1.5);

  // ---------------------------------------------------------------- Bild laden / anzeigen
  async function loadFile(file) {
    if (!file) return;
    setStatus('Lade Foto …');
    try {
      await ensureCV();
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) { throw new Error('Diese Datei kann der Browser nicht öffnen. RAW-Dateien bitte als JPG/TIFF exportieren.'); }
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
      state.img = JZO.fromImageData(g.getImageData(0, 0, c.width, c.height));
      state.name = file.name.replace(/\.[^.]+$/, '') || 'foto';
      state.boxes = []; state.result = null; state.marking = false;
      const mp = (bmp.width * bmp.height) / 1e6;
      $('fileinfo').textContent = `${file.name} · ${bmp.width} × ${bmp.height} (${mp.toFixed(1)} MP)`;
      $('drop').classList.add('hidden'); $('viewer').classList.remove('hidden');
      showOriginal();
      $('btn-run').disabled = false; $('btn-preview').disabled = false; $('btn-auto').disabled = false;
      setStatus(mp > 40 ? 'Achtung: sehr großes Foto – Vergrößern kann den Speicher sprengen.' : '', mp > 40 ? 'err' : '');
    } catch (e) { setStatus(e.message, 'err'); }
  }
  function drawImgTo(canvas, img) {
    canvas.width = img.w; canvas.height = img.h;
    canvas.getContext('2d').putImageData(new ImageData(JZO.toRGBA(img), img.w, img.h), 0, 0);
  }
  function showOriginal() {
    drawImgTo($('c-before'), state.img);
    const o = $('c-over'); o.width = state.img.w; o.height = state.img.h;
    $('c-after').classList.add('hidden'); $('cmp').classList.add('hidden'); $('btn-back').classList.add('hidden'); $('result').classList.add('hidden');
    state.result = null; setImageSize(state.img.w, state.img.h); redrawOverlay(); updateMarkInfo();
  }
  function showResult(res, before) {
    state.result = res;
    drawImgTo($('c-before'), before); drawImgTo($('c-after'), res.img);
    const o = $('c-over'); o.width = res.img.w; o.height = res.img.h;
    $('c-after').classList.remove('hidden'); $('cmp').classList.remove('hidden'); $('btn-back').classList.remove('hidden'); $('result').classList.remove('hidden');
    setCompare($('cmp-range').value);
    setImageSize(res.img.w, res.img.h);
    const cr = $('crops'); cr.innerHTML = '';
    res.birdCrops.forEach((c, i) => {
      const cv2 = document.createElement('canvas'); drawImgTo(cv2, c);
      const a = document.createElement('a'); a.title = 'Vogel ' + (i + 1) + ' als PNG speichern'; a.href = '#';
      const im = document.createElement('img'); im.src = cv2.toDataURL('image/jpeg', 0.7); a.appendChild(im);
      a.onclick = (e) => { e.preventDefault(); cv2.toBlob((b) => saveFile(b, `${state.name}_vogel${i + 1}.png`, 'image/png')); };
      cr.appendChild(a);
    });
    updateExportInfo(); redrawOverlay();
  }
  function setCompare(v) { $('c-after').style.clipPath = `inset(0 0 0 ${v}%)`; }
  $('cmp-range').addEventListener('input', (e) => setCompare(e.target.value));

  // ---------------------------------------------------------------- Autopilot
  $('btn-auto').onclick = async () => {
    if (!state.img) return;
    await ensureCV();
    const a = JZO.analyze(state.img);
    writeSettings({ denoise: a.denoise, sharpen: a.sharpen, scale: a.scale });
    $('autoinfo').textContent = `Rauschpegel ca. ${a.sigma.toFixed(1)} → Entrauschen ${Math.round(a.denoise * 100)} %, Schärfen ${Math.round(a.sharpen * 100)} %, Vergrößern ${a.scale}×. Du kannst alles noch ändern.`;
  };

  // ---------------------------------------------------------------- Vogel-Markierung
  function redrawOverlay(live) {
    const o = $('c-over'), g = o.getContext('2d'); g.clearRect(0, 0, o.width, o.height);
    const showRes = !!state.result, f = showRes ? o.width / (state.result.srcW || o.width) : 1;
    g.lineWidth = 2 / Math.max(V.k, 0.01);
    const draw = (b, col) => { g.strokeStyle = col; g.strokeRect(b[0] * f, b[1] * f, (b[2] - b[0]) * f, (b[3] - b[1]) * f); };
    if (!showRes) state.boxes.forEach((b) => draw(b, '#ffd24c')); else (state.result.birds || []).forEach((b) => draw(b, '#43c07a'));
    if (live) draw(live, '#ffffff');
  }
  function updateMarkInfo() {
    const n = state.boxes.length;
    $('markcount').textContent = n ? `${n} Vogel/Vögel von Hand markiert – automatische Suche wird übersprungen.` : '';
    $('markhint').classList.toggle('hidden', !state.marking);
    $('btn-mark').textContent = state.marking ? 'Markieren beenden' : 'Vögel von Hand markieren';
    vp().classList.toggle('marking', state.marking);
  }
  (function setupMarking() {
    const el = vp(); let start = null;
    const pos = (e) => { const r = $('stage').getBoundingClientRect(); return [(e.clientX - r.left) / V.k, (e.clientY - r.top) / V.k]; };
    el.addEventListener('pointerdown', (e) => { if (!state.marking || state.result || e.button !== 0) return; start = pos(e); el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => { if (!start) return; const p = pos(e); redrawOverlay([Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])]); });
    el.addEventListener('pointerup', (e) => {
      if (!start) return; const p = pos(e);
      const b = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])].map(Math.round);
      start = null;
      if (b[2] - b[0] >= 12 && b[3] - b[1] >= 12) { state.boxes.push(b); $('birds').checked = true; $('birdbox').open = true; }
      redrawOverlay(); updateMarkInfo();
    });
  })();
  $('btn-mark').onclick = () => { if (state.result) showOriginal(); state.marking = !state.marking; updateMarkInfo(); };
  $('btn-clear').onclick = () => { state.boxes = []; redrawOverlay(); updateMarkInfo(); };
  $('btn-back').onclick = () => showOriginal();

  // ---------------------------------------------------------------- Verarbeiten
  function setBusy(b) {
    state.busy = b;
    $('btn-run').disabled = b || !state.img; $('btn-preview').disabled = b || !state.img;
    $('progress').classList.toggle('hidden', !b);
  }
  function onProgress(frac, text) { $('bar-fill').style.width = Math.round(frac * 100) + '%'; $('ptext').textContent = `${text || ''} ${Math.round(frac * 100)} %`; }

  async function run(preview) {
    if (!state.img || state.busy) return;
    const S = readSettings();
    state.abort = new AbortController(); setBusy(true); onProgress(0, 'Starte'); $('log').textContent = '';
    const t0 = performance.now();
    try {
      await ensureCV(); await ensureORT();
      const ctx = { signal: state.abort.signal, onProgress, log, tile: 512, upTile: 256 };
      if (S.ai && S.scale > 1) ctx.session = await getSession('esrgan', 'KI-Vergrößerung', [1, 3, 16, 16]);
      if (S.birds && !S.birdBoxes.length) ctx.detector = await getSession('yolox', 'Vogelerkennung', [1, 3, 640, 640]);
      setStatus(preview ? 'Rechne Vorschau …' : 'Rechne …');
      let src = state.img;
      if (preview) {
        const W = state.img.w, H = state.img.h, cw = Math.min(W, 640), ch = Math.min(H, 640);
        let cx = W / 2, cy = H / 2;
        if (S.birdBoxes.length) { const b = S.birdBoxes[0]; cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2; }
        const offX = clamp(Math.round(cx - cw / 2), 0, W - cw), offY = clamp(Math.round(cy - ch / 2), 0, H - ch);
        src = JZO.cropImg(state.img, offX, offY, cw, ch);
        S.birdBoxes = S.birdBoxes.map((b) => [Math.max(0, b[0] - offX), Math.max(0, b[1] - offY), Math.min(cw, b[2] - offX), Math.min(ch, b[3] - offY)]).filter((b) => b[2] - b[0] > 8 && b[3] - b[1] > 8);
      }
      const res = await JZO.processPhoto(src, S, ctx);
      res.srcW = src.w; res.settings = S; res.ctx = { session: ctx.session };
      const before = res.img.w === src.w ? src : JZO.resizeImg(src, res.img.w, res.img.h, cv.INTER_CUBIC);
      showResult(res, before);
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      const prov = state.provider === 'webgpu' ? ' · Grafikkarte' : state.provider === 'wasm' ? ' · Prozessor (mit Chrome und Grafikkarte wäre es schneller)' : '';
      setStatus(`Fertig in ${sec} s${prov}. ${res.birds.length ? res.birds.length + ' Vogel/Vögel bearbeitet.' : (S.birds ? 'Kein Vogel gefunden – ziehe von Hand einen Rahmen um den Vogel.' : '')}`, 'ok');
    } catch (e) {
      if (e && e.name === 'Cancelled') setStatus('Abgebrochen.');
      else { console.error(e); setStatus('Fehler: ' + (e.message || e), 'err'); log(String(e.stack || e)); }
    } finally { setBusy(false); }
  }
  $('btn-run').onclick = () => run(false);
  $('btn-preview').onclick = () => run(true);
  $('btn-cancel').onclick = () => { if (state.abort) state.abort.abort(); };

  // Licht/Farbe-Regler wirken sofort auf das fertige Ergebnis (ohne alles neu zu rechnen)
  let liveTimer = 0, liveBusy = false, livePending = false;
  function scheduleLiveAdjust() {
    if (!state.result || !state.result.base) return;
    clearTimeout(liveTimer); liveTimer = setTimeout(liveAdjust, 350);
  }
  async function liveAdjust() {
    if (liveBusy) { livePending = true; return; }
    const r = state.result; if (!r) return;
    liveBusy = true;
    try {
      const S = Object.assign({}, r.settings, readSettings());   // nur Licht/Farbe aus den aktuellen Reglern
      const adj = {}; ADJ_IDS.forEach((k) => (adj[k] = S[k]));
      const img = await JZO.applyAdjust(r.base, Object.assign({}, r.settings, adj), {});
      r.img = img; drawImgTo($('c-after'), img); updateExportInfo();
    } catch (e) { console.error(e); }
    liveBusy = false;
    if (livePending) { livePending = false; liveAdjust(); }
  }

  // ---------------------------------------------------------------- Export
  const EX_SIZES = [{ id: 'orig', label: 'Original (Ergebnisgröße)', edge: 0 }, { id: 's4096', label: '4096 px', edge: 4096 }, { id: 's2048', label: '2048 px', edge: 2048 }, { id: 's1080', label: '1080 px', edge: 1080 }];
  (function buildExport() {
    $('exSizes').innerHTML = EX_SIZES.map((s, i) => `<label class="check"><input type="checkbox" data-id="${s.id}" ${i === 0 ? 'checked' : ''}> <span>${s.label}</span> <small class="dim" data-dim="${s.id}"></small></label>`).join('');
    $('exFormat').addEventListener('change', () => { $('exQualRow').classList.toggle('hidden', $('exFormat').value === 'image/png'); });
    $('exQuality').addEventListener('input', () => { $('o-exQuality').textContent = $('exQuality').value; });
    $('exSizes').addEventListener('change', updateExportInfo); $('exCustomOn').addEventListener('change', updateExportInfo); $('exCustom').addEventListener('input', updateExportInfo);
  })();
  function dimsFor(edge) {
    const r = state.result.img; if (!edge) return [r.w, r.h];
    const k = edge / Math.max(r.w, r.h); return [Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k))];
  }
  function selectedSizes() {
    const out = [];
    for (const s of EX_SIZES) if ($('exSizes').querySelector(`[data-id=${s.id}]`).checked) out.push(s.edge);
    if ($('exCustomOn').checked) { const e = +$('exCustom').value; if (e >= 64) out.push(e); }
    return out;
  }
  function updateExportInfo() {
    if (!state.result) return;
    for (const s of EX_SIZES) { const [w, h] = dimsFor(s.edge); $('exSizes').querySelector(`[data-dim=${s.id}]`).textContent = `${w} × ${h}`; }
    const n = selectedSizes().length;
    $('exinfo').textContent = n > 1 ? `${n} Größen → ${window.showDirectoryPicker ? 'in einen Ordner deiner Wahl' : 'als eine ZIP-Datei'}.` : (window.showSaveFilePicker ? 'Du wählst den Speicherort selbst (z. B. Schreibtisch).' : 'Die Datei landet im Download-Ordner deines Browsers (Safari/Firefox können keinen Speicherort vorab wählen).');
  }
  function extFor(type) { return type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'; }
  async function encodeSize(edge, type, quality) {
    const r = state.result.img; const [w, h] = dimsFor(edge);
    const c = document.createElement('canvas');
    if (w === r.w && h === r.h) drawImgTo(c, r); else drawImgTo(c, JZO.resizeImg(r, w, h));
    const blob = await new Promise((res) => c.toBlob(res, type, quality));
    if (!blob) throw new Error('Das Bild ist zu groß für den Export im Browser. Bitte eine kleinere Größe wählen.');
    return { blob, w, h };
  }
  async function saveFile(blob, name, type) {
    if (window.showSaveFilePicker) {
      try {
        const ext = '.' + name.split('.').pop();
        const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'Datei', accept: { [type || blob.type || 'application/octet-stream']: [ext] } }] });
        const w = await h.createWritable(); await w.write(blob); await w.close(); return 'saved';
      } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); return 'download';
  }
  $('btn-export').onclick = async () => {
    if (!state.result) return;
    const sizes = selectedSizes();
    if (!sizes.length) { $('exinfo').textContent = 'Bitte mindestens eine Größe auswählen.'; return; }
    const type = $('exFormat').value, q = +$('exQuality').value / 100;
    $('btn-export').disabled = true; $('exinfo').textContent = 'Exportiere …';
    try {
      const files = [];
      for (const edge of sizes) {
        const { blob, w, h } = await encodeSize(edge, type, q);
        files.push({ name: `${state.name}_jzo_${w}x${h}.${extFor(type)}`, blob });
      }
      if (files.length === 1) { const r = await saveFile(files[0].blob, files[0].name, type); $('exinfo').textContent = r === 'cancel' ? 'Abgebrochen.' : 'Gespeichert: ' + files[0].name; }
      else if (window.showDirectoryPicker) {
        try {
          const dir = await showDirectoryPicker({ mode: 'readwrite' });
          for (const f of files) { const h = await dir.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.blob); await w.close(); }
          $('exinfo').textContent = `${files.length} Dateien gespeichert.`;
        } catch (e) { if (e && e.name === 'AbortError') $('exinfo').textContent = 'Abgebrochen.'; else throw e; }
      } else {
        const zip = await JZO_ZIP(files); await saveFile(zip, `${state.name}_jzo.zip`, 'application/zip'); $('exinfo').textContent = `${files.length} Dateien als ZIP gespeichert.`;
      }
    } catch (e) { console.error(e); $('exinfo').textContent = 'Fehler: ' + (e.message || e); }
    $('btn-export').disabled = false;
  };

  // Minimaler ZIP-Schreiber (ohne Kompression) – für mehrere Dateien in einem Download
  async function JZO_ZIP(files) {
    const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    const crc = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = table[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), c = crc(data);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint32(14, c, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      parts.push(lh, name, data);
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, c, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(ch, name); off += 30 + name.length + data.length;
    }
    const csize = central.reduce((a, p) => a + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
    const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
  window.JZO_ZIP = JZO_ZIP;

  // ---------------------------------------------------------------- Drag & Drop, Tabs
  function wireDrop(zone, input, input2, handler) {
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handler(f); });
    input.addEventListener('change', () => handler(input.files[0]));
    if (input2) input2.addEventListener('change', () => handler(input2.files[0]));
  }
  wireDrop($('drop'), $('file'), $('file2'), loadFile);
  $('viewer').addEventListener('dragover', (e) => e.preventDefault());
  $('viewer').addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  window.JZO_UI = { wireDrop, $, params, ensureCV, ensureORT, state, saveFile };

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    if (t.dataset.tab === 'photo' && V.iw && V.fitted) fitView();
  }));

  state.defaults = Object.assign({}, JZO.defaultSettings(), { birds: false });
  buildControls();
  writeSettings(state.defaults);
  $('birdTarget').value = '1200';
  // Notbremse: Falls im Mehrkern-Modus ein Baustein nicht lädt, Mehrkern dauerhaft abschalten und einmal neu starten
  function disableIsolation() {
    try { localStorage.setItem('jzo.nocoi', '1'); } catch (e) { /* egal */ }
    const done = () => { sessionStorage.setItem('jzo.coi', '1'); location.reload(); };
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then(done, done); else done();
  }
  window.JZO_disableIsolation = disableIsolation;
  ensureCV().then(() => setStatus('')).catch((e) => {
    if (window.crossOriginIsolated && !sessionStorage.getItem('jzo.fallback')) { sessionStorage.setItem('jzo.fallback', '1'); disableIsolation(); return; }
    setStatus('Bibliothek konnte nicht geladen werden (Internet?): ' + e.message, 'err');
  });
})();
