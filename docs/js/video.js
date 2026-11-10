/* JZo Entertainment Foto Video AI – Video im Browser (FFmpeg.wasm). Lange Videos werden in Stücken gerechnet. */
(function () {
  'use strict';
  const { $, params, wireDrop, saveFile } = window.JZO_UI;
  const VF = window.JZOVF;
  const FF_CORE = params.get('libs') ? params.get('libs') + '/ffcore/' : 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/';   // 31 MB, aus dem Netz
  const MAX_BYTES = 1.4e9;
  const maxSeconds = () => Math.max(60, (+$('v-maxMin').value || 20) * 60);
  try { const m = localStorage.getItem('jzo.maxMin'); if (m) $('v-maxMin').value = m; } catch (e) { /* ohne Speicher */ }

  let file = null, ffmpeg = null, loading = null, srcUrl = null, vmeta = null, running = false, cancelled = false, result = null, logSink = null;

  const setStatus = (t, c) => { const s = $('vstatus'); s.textContent = t || ''; s.className = 'status' + (c ? ' ' + c : ''); };

  // ---------------------------------------------------------------- Regler
  const NUM = ['denoise', 'sharpen', 'detail', 'grain', 'bright', 'contrast', 'sat', 'warm', 'shSize', 'stab', 'fps', 'speed', 'crf', 'segLen', 'start', 'len'];
  const SLIDERS = { denoise: 'pct', sharpen: 'pct', detail: 'pct', grain: 'pct', bright: 'sgn', contrast: 'sgn', sat: 'sgn', warm: 'sgn', crf: 'crf' };
  const fmt = {
    pct: (v) => Math.round(v * 100) + ' %', sgn: (v) => (v > 0 ? '+' : '') + Math.round(v * 100),
    crf: (v) => v + (v <= 15 ? ' (sehr hoch)' : v <= 20 ? ' (hoch)' : v <= 25 ? ' (mittel)' : ' (klein)'),
  };
  function readSettings() {
    const o = VF.defaults();
    for (const k of Object.keys(o)) {
      const el = $('v-' + k); if (!el) continue;
      o[k] = el.type === 'checkbox' ? el.checked : NUM.includes(k) ? +el.value : el.value;
    }
    return o;
  }
  function writeSettings(o) {
    for (const k of Object.keys(o)) {
      const el = $('v-' + k); if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!o[k]; else el.value = o[k];
      if (SLIDERS[k]) $('o-v-' + k).textContent = fmt[SLIDERS[k]](+o[k]);
    }
    syncCodec();
  }
  function syncCodec() { if ($('v-codec').value === 'prores') $('v-format').value = 'mov'; $('v-format').disabled = $('v-codec').value === 'prores'; }
  const PRESETS = {
    standard: { res: '1080', denoise: 0.3, sharpen: 0.3 },
    clean: { res: 'orig', denoise: 0.5, dnMode: 'both', sharpen: 0.4, detail: 0.2 },
    neutral: { res: 'orig', denoise: 0, sharpen: 0 },
    slow: { res: 'orig', speed: 0.5, fps: 60, interp: 'mci', denoise: 0.2, sharpen: 0.2 },
    shaky: { res: 'orig', stab: 32, denoise: 0.2, sharpen: 0.3 },
  };
  Object.keys(SLIDERS).forEach((k) => $('v-' + k).addEventListener('input', () => { $('o-v-' + k).textContent = fmt[SLIDERS[k]](+$('v-' + k).value); updateEstimate(); }));
  document.querySelectorAll('#tab-video select, #tab-video input[type=number], #tab-video input[type=checkbox]').forEach((el) => el.addEventListener('change', () => { if (el.id === 'v-codec') syncCodec(); if (el.id === 'v-maxMin') { try { localStorage.setItem('jzo.maxMin', el.value); } catch (e) { /* egal */ } } updateEstimate(); }));
  $('vpreset').addEventListener('change', () => writeSettings(Object.assign({}, VF.defaults(), PRESETS[$('vpreset').value])));

  // ---------------------------------------------------------------- Größenabschätzung
  function outDims(o, w, h) {
    let k = 1;
    if (o.res !== 'orig') { if (/^x/.test(o.res)) k = +o.res.slice(1); else k = +o.res / Math.min(w, h); }
    let W = w * k, H = h * k;
    if (o.rot === 'cw' || o.rot === 'ccw') [W, H] = [H, W];
    if (o.crop !== 'orig') { const [a, b] = o.crop.split(':').map(Number); const A = a / b; if (W / H > A) W = H * A; else H = W / A; }
    return [Math.round(W), Math.round(H)];
  }
  function spanFor(o, dur) { const s = Math.min(o.start, Math.max(0, dur - 0.1)); return o.len > 0 ? Math.min(o.len, dur - s) : dur - s; }
  function updateEstimate() {
    if (!vmeta || !vmeta.w) { $('vestimate').textContent = ''; return; }
    const o = readSettings(), span = spanFor(o, vmeta.dur), [W, H] = outDims(o, vmeta.w, vmeta.h);
    const fps = o.fps || vmeta.fps || 30, outSecs = span / o.speed;
    const bytes = VF.estimateBytes(o, W, H, fps, outSecs);
    const mb = bytes / 1e6;
    let t = `Ausgabe ca. ${W} × ${H}, ${Math.round(outSecs)} s, Dateigröße etwa ${mb >= 1000 ? (mb / 1000).toFixed(1) + ' GB' : Math.round(mb) + ' MB'}.`;
    let bad = false;
    if (span > maxSeconds()) { t += ` Länger als dein Clip-Limit (${Math.round(maxSeconds() / 60)} Min.) – bitte „Länge“ begrenzen oder das Limit anheben.`; bad = true; }
    if (bytes > MAX_BYTES) { t += ' Zu groß für den Browser-Speicher – Auflösung oder Qualität senken.'; bad = true; }
    $('vestimate').textContent = t; $('vestimate').style.color = bad ? 'var(--err)' : '';
  }

  // ---------------------------------------------------------------- FFmpeg
  async function getFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (!loading) loading = (async () => {
      setStatus('Lade Video-Baustein (ca. 30 MB, nur beim ersten Mal) …');
      const { FFmpeg } = await import(new URL('lib/ffmpeg/index.js', location.href).href);
      const toBlobURL = async (u, type) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type }));
      const f = new FFmpeg();
      f.on('log', ({ message }) => { if (logSink) logSink(message); if (params.get('debug')) console.log(message); });
      await f.load({ coreURL: await toBlobURL(FF_CORE + 'ffmpeg-core.js', 'text/javascript'), wasmURL: await toBlobURL(FF_CORE + 'ffmpeg-core.wasm', 'application/wasm') });
      ffmpeg = f; return f;
    })().finally(() => { loading = null; });
    return loading;
  }
  function resetFFmpeg() { try { if (ffmpeg) ffmpeg.terminate(); } catch (e) { /* egal */ } ffmpeg = null; }

  async function mountInput(ff) {
    const ext = ((file.name.match(/\.[^.]+$/) || ['.mp4'])[0] || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '');
    const name = 'input' + ext;
    try { await ff.createDir('/in'); } catch (e) { /* gibt es schon */ }
    try { await ff.unmount('/in'); } catch (e) { /* war nicht eingehängt */ }
    await ff.mount('WORKERFS', { files: [new File([file], name)] }, '/in');   // liest direkt von der Festplatte, kein Kopieren in den Speicher
    return '/in/' + name;
  }
  async function probe(ff, path) {
    const lines = []; logSink = (m) => lines.push(m);
    try { await ff.exec(['-hide_banner', '-i', path]); } finally { logSink = null; }
    const t = lines.join('\n'), info = { fps: 0, w: 0, h: 0, dur: 0, audio: /Stream #\d+:\d+.*Audio:/.test(t), video: /Stream #\d+:\d+.*Video:/.test(t) };
    let m = t.match(/Duration:\s*(\d+):(\d+):([\d.]+)/); if (m) info.dur = +m[1] * 3600 + +m[2] * 60 + +m[3];
    m = t.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/); if (m) { info.w = +m[1]; info.h = +m[2]; }
    m = t.match(/(\d+(?:\.\d+)?)\s*fps/); if (m) info.fps = +m[1];
    return info;
  }

  // ---------------------------------------------------------------- Video laden
  function loadVideo(f) {
    if (!f) return;
    file = f; vmeta = null; result = null;
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    srcUrl = URL.createObjectURL(f);
    const p = $('vplayer'); p.src = srcUrl;
    $('vdrop').classList.add('hidden'); $('vviewer').classList.remove('hidden'); $('vresultbox').classList.add('hidden');
    $('vrun').disabled = false; $('vpreview').disabled = false;
    $('vinfo').textContent = `${f.name} · ${(f.size / 1e6).toFixed(0)} MB`;
    setStatus('');
    p.onloadedmetadata = () => {
      vmeta = { w: p.videoWidth, h: p.videoHeight, dur: p.duration, fps: 0 };
      $('vinfo').textContent = `${f.name} · ${p.videoWidth} × ${p.videoHeight} · ${fmtTime(p.duration)} · ${(f.size / 1e6).toFixed(0)} MB`;
      updateEstimate();
    };
    p.onerror = () => { $('vinfo').textContent = `${f.name} · ${(f.size / 1e6).toFixed(0)} MB (Vorschau im Browser nicht möglich, Verarbeitung geht trotzdem)`; };
  }
  const fmtTime = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  wireDrop($('vdrop'), $('vfile'), $('vfile2'), loadVideo);
  $('vviewer').addEventListener('dragover', (e) => e.preventDefault());
  $('vviewer').addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadVideo(e.dataTransfer.files[0]); });

  // ---------------------------------------------------------------- Verarbeiten
  async function run(preview) {
    if (!file || running) return;
    running = true; cancelled = false; result = null;
    $('vrun').disabled = true; $('vpreview').disabled = true; $('vprogress').classList.remove('hidden'); $('vbar').style.width = '0%'; $('vresultbox').classList.add('hidden');
    const o = readSettings(), t0 = performance.now();
    const prog = (frac, text) => {
      $('vbar').style.width = Math.round(frac * 100) + '%';
      const el = (performance.now() - t0) / 1000, eta = frac > 0.02 ? el / frac - el : 0;
      $('vtext').textContent = `${text} ${Math.round(frac * 100)} %` + (eta ? ` · noch ca. ${fmtTime(eta)}` : '');
    };
    try {
      const ff = await getFFmpeg();
      setStatus('Lese Video …'); prog(0, 'Lese Video …');
      const path = await mountInput(ff);
      const info = await probe(ff, path);
      if (!info.video) throw new Error('In der Datei wurde kein Videobild gefunden.');
      const dur = info.dur || (vmeta && vmeta.dur) || 0;
      let start = Math.min(o.start, Math.max(0, dur - 0.1)), span = (o.len > 0 ? Math.min(o.len, dur - start) : dur - start);
      if (preview) span = Math.min(5, span);
      if (span <= 0) throw new Error('Der gewählte Ausschnitt ist leer (Start liegt hinter dem Ende).');
      if (span > maxSeconds()) throw new Error(`Länger als dein Clip-Limit (${Math.round(maxSeconds() / 60)} Min.). Bitte „Länge“ begrenzen oder das Limit anheben.`);
      const [W, H] = outDims(o, info.w, info.h), outFps = o.fps || info.fps || 30;
      if (!preview && VF.estimateBytes(o, W, H, outFps, span / o.speed) > MAX_BYTES) throw new Error('Die Ausgabedatei wäre zu groß für den Browser-Speicher. Bitte Auflösung oder Qualität senken oder einen kürzeren Ausschnitt wählen.');
      const vf = VF.video(o, info), af = VF.audio(o), container = VF.container(o), withAudio = o.audio === 'keep' && info.audio;
      const codec = VF.codecArgs(o), segLen = o.segLen, nSeg = preview ? 1 : Math.max(1, Math.ceil(span / segLen - 1e-6));
      setStatus(`Verarbeite${nSeg > 1 ? ` in ${nSeg} Stücken` : ''} … (Browserfenster bitte offen lassen)`);

      const run1 = async (args, expectOut, label, base, share) => {
        logSink = (m) => { const mm = m.match(/time=(\d+):(\d+):([\d.]+)/); if (mm && expectOut > 0) prog(base + share * Math.min(0.999, (+mm[1] * 3600 + +mm[2] * 60 + +mm[3]) / expectOut), label); };
        let code; try { code = await ff.exec(args); } finally { logSink = null; }
        if (cancelled) throw new Error('terminate');
        if (code !== 0) throw new Error('FFmpeg meldet einen Fehler (Code ' + code + '). Evtl. ist das Videoformat oder eine Einstellung nicht unterstützt.');
      };
      const times = (s, l) => ['-ss', String(s), '-t', String(l), '-i', path];
      const muxFlags = container === 'mp4' || container === 'mov' ? ['-movflags', '+faststart'] : [];
      const audioArgs = withAudio ? ['-map', '0:a:0', ...(af ? ['-af', af] : []), '-c:a', 'aac', '-b:a', '160k'] : ['-an'];
      let outBlob;

      if (nSeg === 1) {
        await run1([...times(start, span), '-map', '0:v:0', ...audioArgs, '-vf', vf, ...codec, ...muxFlags, 'out.' + container], span / o.speed, preview ? 'Vorschau' : 'Rechne', 0, 1);
        outBlob = new Blob([(await ff.readFile('out.' + container)).buffer], { type: 'video/' + (container === 'mkv' ? 'x-matroska' : container === 'mov' ? 'quicktime' : 'mp4') });
        try { await ff.deleteFile('out.' + container); } catch (e) { /* egal */ }
      } else {
        // 1) Ton in einem Stück (klein), 2) Bild in Stücken, 3) zusammensetzen
        if (withAudio) { await run1([...times(start, span), '-vn', ...audioArgs, 'audio.m4a'], span, 'Ton', 0, 0.02); }
        const parts = [];
        for (let i = 0; i < nSeg; i++) {
          const s0 = start + i * segLen, l = Math.min(segLen, span - i * segLen), name = `seg_${String(i).padStart(4, '0')}.mkv`;
          await run1([...times(s0, l), '-map', '0:v:0', '-an', '-vf', vf, ...codec, name], l / o.speed, `Stück ${i + 1}/${nSeg}`, 0.02 + 0.93 * (i / nSeg), 0.93 / nSeg);
          const data = await ff.readFile(name); parts.push(new Blob([data.buffer])); try { await ff.deleteFile(name); } catch (e) { /* egal */ }
        }
        prog(0.95, 'Setze zusammen');
        let list = '';
        for (let i = 0; i < nSeg; i++) { const name = `seg_${String(i).padStart(4, '0')}.mkv`; await ff.writeFile(name, new Uint8Array(await parts[i].arrayBuffer())); list += `file '${name}'\n`; }
        await ff.writeFile('list.txt', list);
        await run1(['-f', 'concat', '-safe', '0', '-i', 'list.txt', ...(withAudio ? ['-i', 'audio.m4a'] : []), '-map', '0:v', ...(withAudio ? ['-map', '1:a'] : []), '-c', 'copy', ...(o.codec === 'h265' && container !== 'mkv' ? ['-tag:v', 'hvc1'] : []), ...(withAudio ? ['-shortest'] : []), ...muxFlags, 'out.' + container], 0, 'Setze zusammen', 0.95, 0.05);
        outBlob = new Blob([(await ff.readFile('out.' + container)).buffer], { type: 'video/' + (container === 'mkv' ? 'x-matroska' : container === 'mov' ? 'quicktime' : 'mp4') });
        for (let i = 0; i < nSeg; i++) { try { await ff.deleteFile(`seg_${String(i).padStart(4, '0')}.mkv`); } catch (e) { /* egal */ } }
        for (const n of ['out.' + container, 'list.txt', 'audio.m4a']) { try { await ff.deleteFile(n); } catch (e) { /* egal */ } }
      }
      try { await ff.unmount('/in'); } catch (e) { /* egal */ }

      const base = file.name.replace(/\.[^.]+$/, '');
      result = { blob: outBlob, name: `${base}_jzo${preview ? '_vorschau' : ''}.${container}`, mime: outBlob.type };
      const u = URL.createObjectURL(outBlob); $('vout').src = u;
      $('vresultbox').classList.remove('hidden'); $('vbar').style.width = '100%';
      $('vsaveinfo').textContent = `${(outBlob.size / 1e6).toFixed(1)} MB · ${W} × ${H}${container === 'mkv' || o.codec === 'prores' ? ' (wird evtl. nicht im Browser abgespielt)' : ''}`;
      setStatus(`Fertig in ${fmtTime((performance.now() - t0) / 1000)}.${preview ? ' (Vorschau: die ersten 5 Sekunden)' : ''}`, 'ok');
      window.__videoDone = { size: outBlob.size, secs: span, segs: nSeg, w: W, h: H };
    } catch (e) {
      if (cancelled || String((e && e.message) || e).includes('terminate')) setStatus('Abgebrochen.');
      else { console.error(e); setStatus('Fehler: ' + (e.message || e), 'err'); }
      resetFFmpeg();
    } finally { running = false; $('vrun').disabled = false; $('vpreview').disabled = false; $('vprogress').classList.add('hidden'); }
  }
  $('vrun').onclick = () => run(false);
  $('vpreview').onclick = () => run(true);
  $('vcancel').onclick = () => { cancelled = true; resetFFmpeg(); };

  // ---------------------------------------------------------------- Export
  $('vsave').onclick = async () => { if (!result) return; const r = await saveFile(result.blob, result.name, result.mime); $('vsaveinfo').textContent = r === 'cancel' ? 'Abgebrochen.' : r === 'saved' ? 'Gespeichert: ' + result.name : 'Heruntergeladen: ' + result.name + ' (Download-Ordner)'; };
  $('vframe').onclick = () => {
    const v = result && !$('vresultbox').classList.contains('hidden') ? $('vout') : $('vplayer');
    if (!v.videoWidth) { $('vsaveinfo').textContent = 'Kein Bild verfügbar.'; return; }
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((b) => saveFile(b, `${(file ? file.name.replace(/\.[^.]+$/, '') : 'video')}_standbild_${Math.round(v.currentTime)}s.png`, 'image/png'), 'image/png');
  };

  writeSettings(Object.assign({}, VF.defaults(), PRESETS.standard));
  window.JZO_VIDEO = { loadVideo, run, readSettings, writeSettings };
})();
