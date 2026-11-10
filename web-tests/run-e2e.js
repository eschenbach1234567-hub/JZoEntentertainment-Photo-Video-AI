const puppeteer = require(process.env.JZO_NM + '/puppeteer-core');
const SP = process.env.JZO_SP;
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 1000 });
  const errs = [];
  p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
  p.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  await p.goto('http://localhost:8765/docs/index.html?libs=/libs&gpu=0', { waitUntil: 'load' });
  const waitStatus = (sel, re, t = 300000) => p.waitForFunction((s, r) => new RegExp(r).test(document.querySelector(s).textContent), { timeout: t }, sel, re.source);
  // ---- Foto
  if (!process.env.SKIP_PHOTO) {
  const inp = await p.$('#file'); await inp.uploadFile(SP + '/webassets/eagle.jpg');
  await p.waitForSelector('#viewer:not(.hidden)', { timeout: 60000 });
  await p.select('#preset', 'voegel'); await p.select('#scale', '2');
  console.log('preset applied:', await p.evaluate(() => ({ birds: birds.checked, dn: denoise.value })));
  await p.click(process.env.PREVIEW ? '#btn-preview' : '#btn-run');
  await waitStatus('#status', /Fertig|Fehler/);
  console.log('Foto-Status:', await p.$eval('#status', (e) => e.textContent));
  await p.screenshot({ path: SP + '/ui_photo.png' }); await p.evaluate(() => document.getElementById('cmp-range').value = 40);
  const dl = await p.evaluate(() => new Promise((r) => document.getElementById('c-after').toBlob((x) => r(x && x.size), 'image/png')));
  console.log('PNG-Bytes:', dl);
  }
  // ---- Video
  await p.click('.tab[data-tab=video]');
  const vin = await p.$('#vfile'); await vin.uploadFile(SP + '/clip.mp4');
  await p.waitForSelector('#vviewer:not(.hidden)');
  await p.evaluate(() => { document.getElementById('vlen').value = 1; });
  await p.select('#vscale', '2');
  await p.evaluate(() => document.getElementById('vstab').click());
  await p.click('#vrun');
  await waitStatus('#vstatus', /Fertig|Fehler|Abgebrochen/, 300000);
  console.log('Video-Status:', await p.$eval('#vstatus', (e) => e.textContent), JSON.stringify(await p.evaluate(() => window.__videoDone)));
  await p.screenshot({ path: SP + '/ui_video.png' });
  console.log('Fehler gesamt:', errs.length);
  await b.close();
})().catch((e) => { console.error('FEHLER', e); process.exit(1); });
