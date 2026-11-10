/* JZo Entertainment Foto Video AI – Video im Browser (FFmpeg.wasm, klassische Filter) */
(function () {
  'use strict';
  const { $, params, wireDrop } = window.JZO_UI;
  const FF = params.get('libs')
    ? { core: params.get('libs') + '/ffcore/' }
    : { core: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/' };   // FFmpeg-Kern (31 MB) aus dem Netz; die kleine Steuerung liegt in lib/ffmpeg
  let file = null, ffmpeg = null, loading = null, url = null;

  const setStatus = (t, c) => { const s = $('vstatus'); s.textContent = t || ''; s.className = 'status' + (c ? ' ' + c : ''); };
  const syncOut = (id) => { $('o-' + id).textContent = Math.round(+$(id).value * 100) + ' %'; };
  ['vdenoise', 'vsharpen'].forEach((id) => { syncOut(id); $(id).addEventListener('input', () => syncOut(id)); });

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Konnte nicht laden: ' + src)); document.head.appendChild(s);
    });
  }

  async function getFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (!loading) loading = (async () => {
      setStatus('Lade Video-Baustein (ca. 30 MB, nur beim ersten Mal) …');
            const { FFmpeg } = await import(new URL('lib/ffmpeg/index.js', location.href).href);
      const toBlobURL = async (u, type) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type }));
      const f = new FFmpeg();
      await f.load({
        coreURL: await toBlobURL(FF.core + 'ffmpeg-core.js', 'text/javascript'),
        wasmURL: await toBlobURL(FF.core + 'ffmpeg-core.wasm', 'application/wasm'),
      });
      ffmpeg = f; return f;
    })().finally(() => { loading = null; });
    return loading;
  }

  function loadVideo(f) {
    if (!f) return;
    file = f;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(f);
    const p = $('vplayer'); p.src = url;
    p.onloadedmetadata = () => {
      $('vinfo').textContent = `${f.name} · ${p.videoWidth} × ${p.videoHeight} · ${p.duration.toFixed(1)} s · ${(f.size / 1e6).toFixed(0)} MB`;
      if (p.videoWidth * p.videoHeight > 1920 * 1080) setStatus('Sehr hohe Auflösung – das kann im Browser zu viel Speicher brauchen. Bitte 1× wählen oder ein kürzeres Stück.', 'err');
      else if (f.size > 400e6) setStatus('Große Datei – besser nur ein kurzes Stück verarbeiten.', 'err');
      else setStatus('');
    };
    $('vdrop').classList.add('hidden'); $('vviewer').classList.remove('hidden'); $('vresultbox').classList.add('hidden');
    $('vrun').disabled = false;
  }
  wireDrop($('vdrop'), $('vfile'), $('vfile2'), loadVideo);

  function buildFilters(o) {
    const f = [];
    if (o.stab) f.push('deshake=rx=32:ry=32:edge=mirror');
    if (o.denoise > 0.01) { const d = o.denoise; f.push(`hqdn3d=${(1 + 7 * d).toFixed(1)}:${(1 + 5 * d).toFixed(1)}:${(2 + 8 * d).toFixed(1)}:${(2 + 6 * d).toFixed(1)}`); }
    if (o.scale !== 1) f.push(`scale=trunc(iw*${o.scale}/2)*2:trunc(ih*${o.scale}/2)*2:flags=lanczos`);
    else f.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    if (o.sharpen > 0.01) f.push(`unsharp=5:5:${(0.2 + 1.3 * o.sharpen).toFixed(2)}:5:5:0`);
    if (o.fps > 0) f.push(o.interp === 'mci' ? `minterpolate=fps=${o.fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1` : `framerate=fps=${o.fps}`);
    return f.join(',');
  }

  let running = false;
  async function run() {
    if (!file || running) return;
    running = true; $('vrun').disabled = true; $('vprogress').classList.remove('hidden'); $('vbar').style.width = '0%'; $('vresultbox').classList.add('hidden');
    const o = { scale: +$('vscale').value, denoise: +$('vdenoise').value, sharpen: +$('vsharpen').value, stab: $('vstab').checked, fps: +$('vfps').value, interp: $('vinterp').value, start: +$('vstart').value || 0, len: +$('vlen').value || 0 };
    const t0 = performance.now();
    try {
      const ff = await getFFmpeg();
      const fetchFile = async (f) => new Uint8Array(await f.arrayBuffer());
      const dur = $('vplayer').duration || 0;
      const span = o.len > 0 ? Math.min(o.len, Math.max(0, dur - o.start)) : Math.max(0, dur - o.start);
      ff.on('progress', ({ progress }) => { if (progress >= 0 && progress <= 1) { $('vbar').style.width = Math.round(progress * 100) + '%'; $('vtext').textContent = 'Rechne … ' + Math.round(progress * 100) + ' %'; } });
      ff.on('log', ({ message }) => { if (params.get('debug')) console.log(message); });
      setStatus('Lese Video …'); $('vtext').textContent = 'Lese Video …';
      const ext = (file.name.match(/\.[^.]+$/) || ['.mp4'])[0].toLowerCase();
      await ff.writeFile('in' + ext, await fetchFile(file));
      const args = [];
      if (o.start > 0) args.push('-ss', String(o.start));
      args.push('-i', 'in' + ext);
      if (o.len > 0) args.push('-t', String(o.len));
      args.push('-vf', buildFilters(o), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-map', '0:v:0', '-map', '0:a?', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4');
      setStatus('Verarbeite … (das Browserfenster bitte offen lassen)');
      const code = await ff.exec(args);
      if (code !== 0) throw new Error('FFmpeg meldet einen Fehler (Code ' + code + '). Evtl. ist das Videoformat nicht unterstützt.');
      const data = await ff.readFile('out.mp4');
      try { await ff.deleteFile('in' + ext); await ff.deleteFile('out.mp4'); } catch (e) { /* egal */ }
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      const u = URL.createObjectURL(blob);
      $('vout').src = u; $('vdl').href = u; $('vdl').download = file.name.replace(/\.[^.]+$/, '') + '_jzo.mp4';
      $('vresultbox').classList.remove('hidden'); $('vbar').style.width = '100%';
      setStatus(`Fertig in ${((performance.now() - t0) / 1000).toFixed(0)} s (${(blob.size / 1e6).toFixed(1)} MB).`, 'ok');
      window.__videoDone = { size: blob.size, secs: span };
    } catch (e) {
      if (String(e && e.message).includes('terminate') || e === 'cancel') setStatus('Abgebrochen.');
      else { console.error(e); setStatus('Fehler: ' + (e.message || e), 'err'); try { if (ffmpeg) ffmpeg.terminate(); } catch (x) { /* egal */ } ffmpeg = null; }
    } finally { running = false; $('vrun').disabled = false; $('vprogress').classList.add('hidden'); }
  }
  $('vrun').onclick = run;
  $('vcancel').onclick = () => { if (ffmpeg) { ffmpeg.terminate(); ffmpeg = null; } setStatus('Abgebrochen.'); };
  window.JZO_VIDEO = { loadVideo, run, buildFilters };
})();
