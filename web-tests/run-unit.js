const puppeteer = require(process.env.JZO_NM + '/puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu'] });
  const p = await b.newPage();
  p.on('console', (m) => console.log('[page]', m.text()));
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto('http://localhost:8765/tests/unit.html');
  await p.waitForFunction('typeof cv !== "undefined" && (cv.Mat || cv.onRuntimeInitialized !== undefined)', { timeout: 60000 }).catch(() => {});
  await p.evaluate(async () => { if (typeof cv.then === 'function') { window.cv = await cv; } else if (!cv.Mat) { await new Promise((r) => (cv.onRuntimeInitialized = r)); } });
  const res = await p.evaluate(() => window.runTests());
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})().catch((e) => { console.error('FEHLER', e); process.exit(1); });
