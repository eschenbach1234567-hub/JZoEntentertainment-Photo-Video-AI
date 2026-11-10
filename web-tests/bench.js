// Zeitmessung: KI-Vergrößerung + Vogel-Modus, mit und ohne Mehrkern
const puppeteer = require(process.env.JZO_NM + '/puppeteer-core'); const SP = process.env.JZO_SP;
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'], protocolTimeout: 900000 });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 1000 });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const q = process.env.NOISO ? '&nocoi=1' : '';
  await p.goto('http://localhost:8765/docs/index.html?libs=http://localhost:8766/libs&gpu=0' + q);
  for (let i = 0; i < 40; i++) { try { await p.waitForSelector('#file', { timeout: 3000 }); break; } catch (e) { /* Neustart */ } }
  await new Promise((r) => setTimeout(r, 1500));
  console.log('isoliert:', await p.evaluate(() => window.crossOriginIsolated), 'Kerne:', await p.evaluate(() => navigator.hardwareConcurrency));
  await (await p.$('#file')).uploadFile(SP + '/webassets/eagle.jpg'); await p.waitForSelector('#viewer:not(.hidden)');
  await p.select('#preset', 'voegel'); await p.select('#scale', '2');
  const t0 = Date.now();
  await p.click('#btn-run'); await p.waitForFunction(() => /Fertig|Fehler/.test(document.getElementById('status').textContent), { timeout: 800000 });
  console.log('Zeit:', ((Date.now() - t0) / 1000).toFixed(1), 's |', await p.$eval('#status', (e) => e.textContent));
  await b.close();
})().catch((e) => { console.error('FEHLER', e); process.exit(1); });
