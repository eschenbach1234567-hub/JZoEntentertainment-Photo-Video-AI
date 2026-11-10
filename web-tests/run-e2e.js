// Ende-zu-Ende-Test der ganzen Seite in headless Chrome (Foto + Video). Aufruf: siehe README im Ordner.
const puppeteer = require(process.env.JZO_NM + '/puppeteer-core');
const fs = require('fs'), path = require('path');
const SP = process.env.JZO_SP, DL = SP + '/downloads';
const ok = (c, msg) => { console.log((c ? 'OK     ' : 'FEHLER ') + msg); if (!c) process.exitCode = 1; };
(async () => {
  fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'], protocolTimeout: 900000 });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 1000 });
  const cdp = await p.createCDPSession(); await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await p.evaluateOnNewDocument(() => { delete window.showSaveFilePicker; delete window.showDirectoryPicker; });
  const errs = [];
  p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
  p.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) console.log('[console.error]', m.text()); });
  await p.goto('http://localhost:8765/docs/index.html?libs=/libs&gpu=0', { waitUntil: 'load' });
  const waitText = (sel, re, t = 300000) => p.waitForFunction((s, r) => new RegExp(r).test(document.querySelector(s).textContent), { timeout: t }, sel, re.source);
  const val = (sel) => p.$eval(sel, (e) => e.value);
  const setRange = (id, v) => p.evaluate((i, x) => { const e = document.getElementById(i); e.value = x; e.dispatchEvent(new Event('input', { bubbles: true })); }, id, v);

  if (!process.env.SKIP_PHOTO) {
  // ================= FOTO
  await (await p.$('#file')).uploadFile(SP + '/webassets/eagle.jpg');
  await p.waitForSelector('#viewer:not(.hidden)', { timeout: 60000 });
  ok((await p.$$('#controls input[type=range]')).length >= 18, 'Regler wurden gebaut');
  await p.select('#preset', 'voegel'); await p.select('#scale', '2'); await p.evaluate(() => { document.getElementById('ai').click(); });
  ok((await p.$eval('#ai', (e) => e.checked)) === false, 'KI-Haken aus (Test mit klassischer Vergrößerung)');
  // Autopilot
  await p.click('#btn-auto'); await new Promise((r) => setTimeout(r, 500));
  console.log('Autopilot:', await p.$eval('#autoinfo', (e) => e.textContent));
  // Zoom/Verschieben
  const t0 = await p.$eval('#stage', (e) => e.style.transform);
  const box = await (await p.$('#viewport')).boundingBox();
  await p.mouse.move(box.x + 300, box.y + 200); await p.mouse.wheel({ deltaY: -400, deltaX: 0 });
  await new Promise((r) => setTimeout(r, 200));
  const t1 = await p.$eval('#stage', (e) => e.style.transform); ok(t0 !== t1, 'Mausrad zoomt: ' + t1);
  await p.mouse.down(); await p.mouse.move(box.x + 380, box.y + 240, { steps: 4 }); await p.mouse.up();
  const t2 = await p.$eval('#stage', (e) => e.style.transform); ok(t1 !== t2, 'Ziehen verschiebt: ' + t2);
  await p.click('#z-fit');
  // Verarbeiten (ganze Foto, Vogel-Modus, klassisch)
  await p.click('#btn-run'); await waitText('#status', /Fertig|Fehler/);
  const st = await p.$eval('#status', (e) => e.textContent); console.log('Foto-Status:', st); ok(/Fertig/.test(st) && /1 Vogel/.test(st), 'Foto verarbeitet mit Vogel');
  await p.screenshot({ path: SP + '/ui_photo.png' });
  // Live-Licht
  const before = await p.evaluate(() => { const c = document.getElementById('c-after'); return c.getContext('2d').getImageData(100, 100, 1, 1).data.join(','); });
  await setRange('exposure', 1); await p.waitForFunction((b) => document.getElementById('c-after').getContext('2d').getImageData(100, 100, 1, 1).data.join(',') !== b, { timeout: 60000 }, before);
  ok(true, 'Belichtungsregler wirkt sofort auf das Ergebnis');
  // Export: einzeln und mehrere Größen als ZIP
  await p.select('#exFormat', 'image/jpeg');
  await p.evaluate(() => { document.querySelector('#exSizes [data-id=s1080]').click(); document.querySelector('#exSizes [data-id=orig]').click(); });
  await p.click('#btn-export'); await waitText('#exinfo', /Gespeichert|Fehler/); await new Promise((r) => setTimeout(r, 800));
  let files = fs.readdirSync(DL); console.log('Download:', files.join(', ')); ok(files.some((f) => /_jzo_\d+x1080\.jpg$|_jzo_1620x1080/.test(f) || /\.jpg$/.test(f)), 'Einzel-Export JPG');
  await p.evaluate(() => { document.querySelector('#exSizes [data-id=orig]').click(); document.querySelector('#exSizes [data-id=s2048]').click(); });
  await p.select('#exFormat', 'image/png');
  await p.click('#btn-export'); await waitText('#exinfo', /ZIP gespeichert|Fehler/); await new Promise((r) => setTimeout(r, 1000));
  files = fs.readdirSync(DL); console.log('Download:', files.join(', ')); ok(files.some((f) => /\.zip$/.test(f)), 'Mehrfach-Export als ZIP');
  const zip = files.find((f) => /\.zip$/.test(f)); if (zip) { const { execSync } = require('child_process'); console.log(execSync(`unzip -l "${DL}/${zip}" 2>&1 | tail -6`).toString()); }

  }
  // ================= VIDEO
  await p.click('.tab[data-tab=video]');
  await (await p.$('#vfile')).uploadFile(SP + '/clip.mp4');
  await p.waitForSelector('#vviewer:not(.hidden)');
  await p.evaluate(() => { const s = document.getElementById('v-segLen'); s.insertAdjacentHTML('beforeend', '<option value="1">1</option>'); });
  await p.select('#vpreset', 'standard'); await p.select('#v-res', 'x2'); await p.select('#v-stab', '32');
  // Einzel-Durchgang
  await p.evaluate(() => { const l = document.getElementById('v-len'); l.value = 1; l.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.click('#vrun'); await waitText('#vstatus', /Fertig|Fehler|Abgebrochen/);
  let vs = await p.$eval('#vstatus', (e) => e.textContent); let vd = await p.evaluate(() => window.__videoDone);
  console.log('Video 1:', vs, JSON.stringify(vd)); ok(/Fertig/.test(vs) && vd.w === 640, 'Video einzeln verarbeitet (2×)');
  // Stückweise (3 Stücke à 1 s) mit Ton + Zeitlupe-Preset-Teile
  await p.evaluate(() => { const l = document.getElementById('v-len'); l.value = 0; l.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('v-segLen').value = '1'; });
  await p.select('#v-res', 'orig'); await p.select('#v-stab', '0'); await p.select('#v-codec', process.env.VCODEC || 'h264'); await p.select('#v-format', 'mp4');
  await p.click('#vrun'); await waitText('#vstatus', /Fertig|Fehler|Abgebrochen/, 300000);
  vs = await p.$eval('#vstatus', (e) => e.textContent); vd = await p.evaluate(() => window.__videoDone);
  console.log('Video 2:', vs, JSON.stringify(vd)); ok(/Fertig/.test(vs) && vd.segs === 2, 'Video in Stücken (H.264) zusammengesetzt');
  await p.click('#vsave'); await new Promise((r) => setTimeout(r, 1500));
  files = fs.readdirSync(DL); ok(files.some((f) => /_jzo\.mp4$/.test(f)), 'Video-Export (Download): ' + files.filter((f) => /mp4/.test(f)).join(','));
  await p.screenshot({ path: SP + '/ui_video.png' });
  ok(errs.length === 0, 'keine Seitenfehler (' + errs.length + ')');
  await b.close();
})().catch((e) => { console.error('FEHLER', e); process.exit(1); });
