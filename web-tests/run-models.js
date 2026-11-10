const puppeteer = require(process.env.JZO_NM + '/puppeteer-core');
const fs = require('fs');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  p.on('console', (m) => console.log('[page]', m.text()));
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto('http://localhost:8765/tests/unit.html');
  await p.waitForFunction('typeof cv !== "undefined"', { timeout: 60000 });
  await p.evaluate(async () => { if (typeof cv.then === 'function') { window.cv = await cv; } else if (!cv.Mat) { await new Promise((r) => (cv.onRuntimeInitialized = r)); } });
  const res = await p.evaluate(() => window.runModels());
  if (res.png) { fs.writeFileSync(process.env.JZO_OUT || 'out.jpg', Buffer.from(res.png.split(',')[1], 'base64')); delete res.png; }
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})().catch((e) => { console.error('FEHLER', e); process.exit(1); });
