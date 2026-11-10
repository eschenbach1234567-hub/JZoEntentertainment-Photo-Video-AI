/* JZo Entertainment Foto Video AI – Oberfläche (Foto) */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  // ---------------------------------------------------------------- Bibliotheken (aus dem Netz; zum Testen lokal überschreibbar)
  const LIBS = params.get('libs')
    ? { cv: params.get('libs') + '/opencv/opencv.js', ort: params.get('libs') + '/ort/ort.all.min.js', ortBase: params.get('libs') + '/ort/' }
    : {
        cv: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js',
        ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.all.min.js',
        ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/',
      };
  window.JZO_LIBS = LIBS;
  const MODELS = { esrgan: 'models/esrgan_general_x4v3.onnx', yolox: 'models/yolox_s.onnx' };

  const state = {
    img: null, name: 'foto', cvReady: null, ortReady: null,
    sessions: {}, boxes: [], marking: false, result: null, abort: null, busy: false, provider: null,
  };

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
      ort.env.wasm.numThreads = 1;
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

  /** Erstellt eine ONNX-Sitzung; versucht erst WebGPU (Grafikkarte), dann den Prozessor. */
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
        // Probelauf: manche GPU-Treiber scheitern erst beim Rechnen
        const n = probeShape.reduce((a, b) => a * b, 1);
        await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(n).fill(0.5), probeShape) });
        state.provider = state.provider === 'wasm' ? 'wasm' : ep[0];
        state.sessions[name] = s;
        return s;
      } catch (e) { lastErr = e; state.provider = 'wasm'; log(`${label}: ${ep[0]} fehlgeschlagen (${e.message || e})`); }
    }
    throw lastErr;
  }

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
      $('btn-run').disabled = false; $('btn-preview').disabled = false;
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
    $('c-after').classList.add('hidden'); $('cmp').classList.add('hidden'); $('btn-back').classList.add('hidden');
    $('result').classList.add('hidden');
    state.result = null; redrawOverlay(); updateMarkInfo();
  }
  function showResult(res, before) {
    state.result = res;
    drawImgTo($('c-before'), before);
    drawImgTo($('c-after'), res.img);
    const o = $('c-over'); o.width = res.img.w; o.height = res.img.h;
    $('c-after').classList.remove('hidden'); $('cmp').classList.remove('hidden'); $('btn-back').classList.remove('hidden');
    $('result').classList.remove('hidden');
    setCompare($('cmp-range').value);
    const cr = $('crops'); cr.innerHTML = '';
    res.birdCrops.forEach((c, i) => {
      const cv2 = document.createElement('canvas'); drawImgTo(cv2, c);
      const a = document.createElement('a'); a.title = 'Vogel ' + (i + 1) + ' als PNG laden'; a.href = '#';
      const im = document.createElement('img'); im.src = cv2.toDataURL('image/jpeg', 0.7); a.appendChild(im);
      a.onclick = (e) => { e.preventDefault(); cv2.toBlob((b) => saveBlob(b, `${state.name}_vogel${i + 1}.png`), 'image/png'); };
      cr.appendChild(a);
    });
    redrawOverlay();
  }
  function setCompare(v) { $('c-after').style.clipPath = `inset(0 0 0 ${v}%)`; }
  $('cmp-range').addEventListener('input', (e) => setCompare(e.target.value));

  // ---------------------------------------------------------------- Vogel-Markierung
  function redrawOverlay(live) {
    const o = $('c-over'), g = o.getContext('2d'); g.clearRect(0, 0, o.width, o.height);
    const showRes = !!state.result;
    const f = showRes ? o.width / (state.result.srcW || o.width) : 1;
    const draw = (b, col) => { g.lineWidth = Math.max(2, o.width / 400); g.strokeStyle = col; g.strokeRect(b[0] * f, b[1] * f, (b[2] - b[0]) * f, (b[3] - b[1]) * f); };
    if (!showRes) state.boxes.forEach((b) => draw(b, '#ffd24c'));
    else (state.result.birds || []).forEach((b) => draw(b, '#43c07a'));
    if (live) draw(live, '#ffffff');
  }
  function updateMarkInfo() {
    const n = state.boxes.length;
    $('markcount').textContent = n ? `${n} Vogel/Vögel von Hand markiert – automatische Suche wird übersprungen.` : '';
    $('markhint').classList.toggle('hidden', !state.marking);
    $('btn-mark').textContent = state.marking ? 'Markieren beenden' : 'Vögel von Hand markieren';
    $('stage').classList.toggle('marking', state.marking);
  }
  (function setupMarking() {
    const o = $('c-over'); let start = null;
    const pos = (e) => { const r = o.getBoundingClientRect(); return [(e.clientX - r.left) * o.width / r.width, (e.clientY - r.top) * o.height / r.height]; };
    o.addEventListener('pointerdown', (e) => { if (!state.marking || state.result) return; start = pos(e); o.setPointerCapture(e.pointerId); });
    o.addEventListener('pointermove', (e) => { if (!start) return; const p = pos(e); redrawOverlay([Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])]); });
    o.addEventListener('pointerup', (e) => {
      if (!start) return; const p = pos(e);
      const b = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])].map(Math.round);
      start = null;
      if (b[2] - b[0] >= 12 && b[3] - b[1] >= 12) { state.boxes.push(b); $('birds').checked = true; $('birdbox').open = true; }
      redrawOverlay(); updateMarkInfo();
    });
  })();
  $('btn-mark').onclick = () => { if (state.result) showOriginal(); state.marking = !state.marking; updateMarkInfo(); };
  $('btn-clear').onclick = () => { state.boxes = []; redrawOverlay(); updateMarkInfo(); };
  $('btn-back').onclick = () => { showOriginal(); };
  $('btn-zoom').onclick = () => { const z = $('scroller').classList.toggle('zoom'); $('btn-zoom').textContent = z ? 'Einpassen' : 'Lupe 100 %'; };

  // ---------------------------------------------------------------- Einstellungen
  const sliders = ['denoise', 'sharpen', 'birdDetail', 'birdBg'];
  function readSettings() {
    return {
      denoise: +$('denoise').value, sharpen: +$('sharpen').value, scale: +$('scale').value, ai: $('ai').checked,
      birds: $('birds').checked, birdMode: $('birdMode').value, birdDetail: +$('birdDetail').value, birdBg: +$('birdBg').value,
      birdTarget: +$('birdTarget').value, birdBoxes: state.boxes.slice(),
    };
  }
  function writeSettings(s) {
    for (const k of Object.keys(s)) {
      const el = $(k); if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    }
    sliders.forEach(syncOut);
    $('birdbox').open = $('birds').checked;
  }
  function syncOut(id) { $('o-' + id).textContent = Math.round(+$(id).value * 100) + ' %'; }
  sliders.forEach((id) => $(id).addEventListener('input', () => syncOut(id)));
  $('preset').addEventListener('change', () => {
    const p = JZO.PRESETS[$('preset').value];
    writeSettings(Object.assign({}, JZO.defaultSettings(), { birds: false }, p));
  });
  $('birds').addEventListener('change', () => { $('birdbox').open = $('birds').checked; });

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
      const ctx = { signal: state.abort.signal, onProgress, log, tile: 512, upTile: 192 };
      if (S.ai && S.scale > 1) ctx.session = await getSession('esrgan', 'KI-Vergrößerung', [1, 3, 16, 16]);
      if (S.birds && !S.birdBoxes.length) ctx.detector = await getSession('yolox', 'Vogelerkennung', [1, 3, 640, 640]);
      setStatus(preview ? 'Rechne Vorschau …' : 'Rechne …');

      let src = state.img, offX = 0, offY = 0;
      if (preview) {
        // Ausschnitt: um den ersten markierten Vogel, sonst Bildmitte
        const W = state.img.w, H = state.img.h, cw = Math.min(W, 640), ch = Math.min(H, 640);
        let cx = W / 2, cy = H / 2;
        if (S.birdBoxes.length) { const b = S.birdBoxes[0]; cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2; }
        offX = Math.max(0, Math.min(W - cw, Math.round(cx - cw / 2))); offY = Math.max(0, Math.min(H - ch, Math.round(cy - ch / 2)));
        src = JZO.cropImg(state.img, offX, offY, cw, ch);
        S.birdBoxes = S.birdBoxes.map((b) => [b[0] - offX, b[1] - offY, b[2] - offX, b[3] - offY])
          .map((b) => [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(cw, b[2]), Math.min(ch, b[3])])
          .filter((b) => b[2] - b[0] > 8 && b[3] - b[1] > 8);
      }
      const res = await JZO.processPhoto(src, S, ctx);
      res.srcW = src.w;
      const before = res.img.w === src.w ? src : JZO.resizeImg(src, res.img.w, res.img.h, cv.INTER_CUBIC);
      res.preview = preview;
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

  // ---------------------------------------------------------------- Download
  function saveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  }
  function download(type) {
    if (!state.result) return;
    $('c-after').toBlob((b) => {
      if (!b) { setStatus('Das Bild ist zu groß für den Download im Browser. Bitte 2× statt 4× wählen.', 'err'); return; }
      saveBlob(b, `${state.name}_jzo.${type === 'image/png' ? 'png' : 'jpg'}`);
    }, type, 0.95);
  }
  $('dl-png').onclick = () => download('image/png');
  $('dl-jpg').onclick = () => download('image/jpeg');

  // ---------------------------------------------------------------- Drag & Drop, Tabs
  function wireDrop(zone, input, input2, handler, test) {
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handler(f); });
    input.addEventListener('change', () => handler(input.files[0]));
    if (input2) input2.addEventListener('change', () => handler(input2.files[0]));
  }
  wireDrop($('drop'), $('file'), $('file2'), loadFile);
  // Ablegen auch direkt auf dem Bild
  const viewer = $('viewer');
  viewer.addEventListener('dragover', (e) => e.preventDefault());
  viewer.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  window.JZO_UI = { wireDrop, $, params, ensureCV, ensureORT, state };

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
  }));

  writeSettings(Object.assign({}, JZO.defaultSettings(), { birds: false }));
  $('birdTarget').value = '1200';
  // Bibliothek schon mal im Hintergrund laden, damit der erste Klick schnell geht
  ensureCV().then(() => setStatus('')).catch((e) => setStatus('Bibliothek konnte nicht geladen werden (Internet?): ' + e.message, 'err'));
})();
