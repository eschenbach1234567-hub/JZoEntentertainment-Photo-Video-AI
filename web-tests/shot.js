const puppeteer = require(process.env.JZO_NM + '/puppeteer-core'); const SP = process.env.JZO_SP;
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'], protocolTimeout: 600000 });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 1000 });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto('http://localhost:8765/docs/index.html?libs=/libs&gpu=0');
  await (await p.$('#file')).uploadFile(SP + '/webassets/eagle.jpg'); await p.waitForSelector('#viewer:not(.hidden)');
  await p.select('#preset', 'voegel'); await p.select('#scale', '2'); await p.evaluate(() => document.getElementById('ai').click());
  await p.click('#btn-run'); await p.waitForFunction(() => /Fertig|Fehler/.test(document.getElementById('status').textContent), { timeout: 300000 });
  await new Promise((r) => setTimeout(r, 2500));
  await p.screenshot({ path: SP + '/shot1.png', clip: { x: 0, y: 60, width: 1040, height: 880 } });
  await p.evaluate(() => { document.getElementById('stage').style.willChange = 'auto'; });
  await new Promise((r) => setTimeout(r, 1500));
  await p.screenshot({ path: SP + '/shot2.png', clip: { x: 0, y: 60, width: 1040, height: 880 } });
  console.log(await p.evaluate(() => JSON.stringify({ stage: document.getElementById('stage').style.cssText, before: [document.getElementById('c-before').width, document.getElementById('c-before').height], birds: JZO_UI.state.result.birds, srcW: JZO_UI.state.result.srcW })));
  await b.close();
})();
