const puppeteer = require(process.env.JZO_NM + '/puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'], protocolTimeout: 120000 });
  const p = await b.newPage();
  p.on('console', (m) => console.log('[page]', m.text().slice(0, 200))); p.on('requestfailed', (r) => console.log('[reqfailed]', r.url().slice(0,120), r.failure() && r.failure().errorText)); p.on('response', (r) => { if (!r.ok() && r.status() !== 404) console.log('[resp]', r.status(), r.url().slice(0,120)); }); p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto('http://localhost:8765/docs/index.html?libs=http://localhost:8766/libs&gpu=0');
  await new Promise((r) => setTimeout(r, 6000));
  console.log('isoliert:', await p.evaluate(() => window.crossOriginIsolated), 'url', p.url());
  const r = await Promise.race([p.evaluate(async () => {
    const out = {};
    await window.JZO_UI.ensureORT(); out.threads = ort.env.wasm.numThreads; console.log('ort geladen, threads', out.threads, 'SAB', typeof SharedArrayBuffer);
    const t = performance.now();
    const s = await ort.InferenceSession.create('/docs/models/esrgan_general_x4v3.onnx', { executionProviders: ['wasm'] });
    out.create = Math.round(performance.now() - t); console.log('session erstellt', out.create);
    const t1 = performance.now();
    await s.run({ input: new ort.Tensor('float32', new Float32Array(3 * 96 * 96).fill(0.5), [1, 3, 96, 96]) });
    out.run1 = Math.round(performance.now() - t1);
    const t2 = performance.now();
    await s.run({ input: new ort.Tensor('float32', new Float32Array(3 * 256 * 256).fill(0.5), [1, 3, 256, 256]) });
    out.run256 = Math.round(performance.now() - t2);
    return out;
  }), new Promise((r) => setTimeout(() => r('TIMEOUT 100s'), 60000))]);
  console.log(JSON.stringify(r));
  await b.close(); process.exit(0);
})();
