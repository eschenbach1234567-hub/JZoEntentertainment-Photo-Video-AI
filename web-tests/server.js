// Kleiner statischer Server für die Browser-Tests (nur für Entwickler).
const http = require('http'), fs = require('fs'), path = require('path');
const roots = JSON.parse(process.env.JZO_ROOTS); // {"/prefix": "/abs/dir"}
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  for (const [p, dir] of Object.entries(roots)) {
    if (url.startsWith(p + '/')) {
      const f = path.join(dir, url.slice(p.length));
      if (f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
        return fs.createReadStream(f).pipe(res);
      }
    }
  }
  res.writeHead(404); res.end('nicht gefunden');
}).listen(process.env.PORT || 8765, () => console.log('server up'));
