/* JZo Entertainment Foto Video AI - Kernbibliothek (läuft im Browser und in Node).
 *
 * Bilder sind überall {w, h, d: Uint8ClampedArray} mit RGB (3 Byte pro Pixel).
 * Gerechnet wird kachelweise in Fließkomma (0..1), damit auch große Fotos in den Speicher passen.
 * Benötigt die Bibliotheken OpenCV.js (cv) und onnxruntime-web (ort); sie werden mit JZO.setLibs() übergeben.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JZO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const JZO = {};
  let cv = null, ort = null;
  JZO.setLibs = (libs) => { cv = libs.cv; ort = libs.ort; };

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  class Cancelled extends Error { constructor() { super('Abgebrochen'); this.name = 'Cancelled'; } }
  JZO.Cancelled = Cancelled;
  function checkCancel(ctx) { if (ctx && ctx.signal && ctx.signal.aborted) throw new Cancelled(); }

  // ------------------------------------------------------------------ Bild-Grundfunktionen
  JZO.newImg = (w, h) => ({ w, h, d: new Uint8ClampedArray(w * h * 3) });

  JZO.fromImageData = (id) => {
    const img = JZO.newImg(id.width, id.height);
    const s = id.data, d = img.d;
    for (let i = 0, j = 0; i < s.length; i += 4, j += 3) { d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2]; }
    return img;
  };

  JZO.toRGBA = (img) => {
    const out = new Uint8ClampedArray(img.w * img.h * 4), s = img.d;
    for (let i = 0, j = 0; j < s.length; i += 4, j += 3) { out[i] = s[j]; out[i + 1] = s[j + 1]; out[i + 2] = s[j + 2]; out[i + 3] = 255; }
    return out;
  };

  function cropF(img, x0, y0, w, h) {
    const out = new Float32Array(w * h * 3), s = img.d;
    let o = 0;
    for (let y = 0; y < h; y++) {
      let i = ((y0 + y) * img.w + x0) * 3;
      for (let x = 0; x < w * 3; x++) out[o++] = s[i++] / 255;
    }
    return out;
  }
  JZO.cropImg = (img, x0, y0, w, h) => {
    const out = JZO.newImg(w, h);
    for (let y = 0; y < h; y++) out.d.set(img.d.subarray(((y0 + y) * img.w + x0) * 3, ((y0 + y) * img.w + x0 + w) * 3), y * w * 3);
    return out;
  };

  // ------------------------------------------------------------------ OpenCV-Hilfen
  function matF32(d, w, h, ch) {
    const m = new cv.Mat(h, w, ch === 3 ? cv.CV_32FC3 : cv.CV_32FC1);
    m.data32F.set(d);
    return m;
  }
  function mats() {
    const list = [];
    const mk = (m) => { list.push(m); return m; };
    mk.free = () => { for (const m of list) { try { m.delete(); } catch (e) { /* schon freigegeben */ } } list.length = 0; };
    return mk;
  }
  JZO.resizeImg = (img, w, h, interp) => {
    const mk = mats();
    try {
      const src = mk(new cv.Mat(img.h, img.w, cv.CV_8UC3)); src.data.set(img.d);
      const dst = mk(new cv.Mat());
      const up = w * h > img.w * img.h;
      cv.resize(src, dst, new cv.Size(w, h), 0, 0, interp !== undefined ? interp : (up ? cv.INTER_LANCZOS4 : cv.INTER_AREA));
      const out = JZO.newImg(w, h); out.d.set(dst.data);
      return out;
    } finally { mk.free(); }
  };
  function resizeF(d, w, h, nw, nh, ch) {
    if (w === nw && h === nh) return d;
    const mk = mats();
    try {
      const src = mk(matF32(d, w, h, ch));
      const dst = mk(new cv.Mat());
      cv.resize(src, dst, new cv.Size(nw, nh), 0, 0, nw * nh > w * h ? cv.INTER_LANCZOS4 : cv.INTER_AREA);
      return Float32Array.from(dst.data32F);
    } finally { mk.free(); }
  }
  function blurF(plane, w, h, sigma) {
    const mk = mats();
    try {
      const m = mk(matF32(plane, w, h, 1)), b = mk(new cv.Mat());
      cv.GaussianBlur(m, b, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
      return Float32Array.from(b.data32F);
    } finally { mk.free(); }
  }
  function lumaF(d, n) {
    const Y = new Float32Array(n);
    for (let i = 0; i < n; i++) Y[i] = 0.299 * d[3 * i] + 0.587 * d[3 * i + 1] + 0.114 * d[3 * i + 2];
    return Y;
  }

  // ------------------------------------------------------------------ Kachelverarbeitung
  /**
   * Zerlegt das Bild in Blöcke, ruft fn(region) mit Rand (margin) auf und setzt nur den Innenteil
   * wieder ein. fn bekommt {w,h,d(Float32 RGB),x0,y0} und liefert {w,h,d} mit Faktor `scale`.
   */
  JZO.mapTiles = async function (img, opt) {
    const { tile, margin, fn, onProgress, ctx } = opt;
    const scale = opt.scale || 1;
    const out = JZO.newImg(img.w * scale, img.h * scale);
    const step = Math.max(16, tile - 2 * margin);
    const total = Math.ceil(img.w / step) * Math.ceil(img.h / step);
    let n = 0;
    for (let by = 0; by < img.h; by += step) {
      for (let bx = 0; bx < img.w; bx += step) {
        checkCancel(ctx);
        const bw = Math.min(step, img.w - bx), bh = Math.min(step, img.h - by);
        const rx0 = Math.max(0, bx - margin), ry0 = Math.max(0, by - margin);
        const rx1 = Math.min(img.w, bx + bw + margin), ry1 = Math.min(img.h, by + bh + margin);
        const rw = rx1 - rx0, rh = ry1 - ry0;
        const res = await fn({ w: rw, h: rh, d: cropF(img, rx0, ry0, rw, rh), x0: rx0, y0: ry0 });
        const ix = (bx - rx0) * scale, iy = (by - ry0) * scale, iw = bw * scale, ih = bh * scale;
        for (let y = 0; y < ih; y++) {
          let si = ((iy + y) * res.w + ix) * 3;
          let di = ((by * scale + y) * out.w + bx * scale) * 3;
          for (let x = 0; x < iw * 3; x++) out.d[di++] = res.d[si++] * 255;
        }
        n++;
        if (onProgress) onProgress(n / total);
        await tick();
      }
    }
    return out;
  };

  // ------------------------------------------------------------------ Entrauschen
  const PYR_LEVELS = 4;
  const TUNE = { bw: [1.0, 0.35, 0.12, 0.04], k0: 0.5, k1: 1.0, chroma0: 0.4, chroma1: 0.6 };
  JZO._tune = TUNE;

  function median(arr) {
    const a = Float32Array.from(arr).sort();
    return a.length ? a[a.length >> 1] : 0;
  }

  /** Laplace-Pyramide mit Soft-Threshold ("Wavelet-Schrumpfung") auf der Helligkeit. */
  function shrinkLuma(Y, w, h, s) {
    const mk = mats();
    try {
      const G = [mk(matF32(Y, w, h, 1))];
      for (let i = 0; i < PYR_LEVELS; i++) { const d = mk(new cv.Mat()); cv.pyrDown(G[i], d); G.push(d); }
      const bands = [];
      const ups = [];
      for (let i = 0; i < PYR_LEVELS; i++) {
        const up = mk(new cv.Mat()); cv.pyrUp(G[i + 1], up, new cv.Size(G[i].cols, G[i].rows)); ups.push(up);
        const b = mk(new cv.Mat()); cv.subtract(G[i], up, b); bands.push(b);
      }
      // Rauschpegel aus dem feinsten Band schätzen (robust über den Median)
      const b0 = bands[0].data32F;
      const sample = new Float32Array(Math.ceil(b0.length / 7));
      for (let i = 0, j = 0; i < b0.length; i += 7, j++) sample[j] = Math.abs(b0[i]);
      const sigma = median(sample) / 0.6745;
      const k = TUNE.k0 + TUNE.k1 * s;
      let rec = G[PYR_LEVELS];
      for (let i = PYR_LEVELS - 1; i >= 0; i--) {
        const T = sigma * k * TUNE.bw[i];
        const bd = bands[i].data32F;
        for (let j = 0; j < bd.length; j++) {
          const v = bd[j], a = Math.abs(v) - T;
          bd[j] = a > 0 ? (v > 0 ? a : -a) : 0;
        }
        const up = mk(new cv.Mat()); cv.pyrUp(rec, up, new cv.Size(G[i].cols, G[i].rows));
        const sum = mk(new cv.Mat()); cv.add(up, bands[i], sum);
        rec = sum;
      }
      return { y: Float32Array.from(rec.data32F), sigma };
    } finally { mk.free(); }
  }

  /** Entrauscht eine Kachel: Helligkeit per Pyramiden-Schrumpfung, Farbe per Glättung bei halber Auflösung. */
  JZO.denoiseRegion = function (reg, s, o) {
    if (s <= 0.001) return reg;
    o = o || {};
    const cm = o.color === undefined ? 1 : o.color, keep = o.keep || 0;
    const mk = mats();
    try {
      const M = 16;
      const pw = Math.ceil(reg.w / M) * M, ph = Math.ceil(reg.h / M) * M;
      let src = mk(matF32(reg.d, reg.w, reg.h, 3));
      if (pw !== reg.w || ph !== reg.h) {
        const padded = mk(new cv.Mat());
        cv.copyMakeBorder(src, padded, 0, ph - reg.h, 0, pw - reg.w, cv.BORDER_REPLICATE, new cv.Scalar());
        src = padded;
      }
      const ycc = mk(new cv.Mat()); cv.cvtColor(src, ycc, cv.COLOR_RGB2YCrCb);
      const planes = mk(new cv.MatVector()); cv.split(ycc, planes);
      const Y = planes.get(0), Cr = planes.get(1), Cb = planes.get(2);
      mk(Y); mk(Cr); mk(Cb);

      // Farbe: zweimal halbieren, weichzeichnen, wieder vergrößern (Farbrauschen ist grob und unauffällig)
      const sig = Math.max(0.05, (TUNE.chroma0 + TUNE.chroma1 * s) * cm);
      if (cm > 0.01) for (const C of [Cr, Cb]) {
        const a = mk(new cv.Mat()), b = mk(new cv.Mat());
        cv.pyrDown(C, a); cv.GaussianBlur(a, a, new cv.Size(0, 0), sig, sig, cv.BORDER_REPLICATE);
        cv.pyrDown(a, b); cv.GaussianBlur(b, b, new cv.Size(0, 0), sig, sig, cv.BORDER_REPLICATE);
        const a2 = mk(new cv.Mat()); cv.pyrUp(b, a2, new cv.Size(a.cols, a.rows));
        cv.pyrUp(a2, C, new cv.Size(C.cols, C.rows));
      }
      const { y } = shrinkLuma(Y.data32F, pw, ph, s);
      Y.data32F.set(y);
      const merged = mk(new cv.Mat()); planes.set(0, Y); planes.set(1, Cr); planes.set(2, Cb);
      cv.merge(planes, merged);
      const rgb = mk(new cv.Mat()); cv.cvtColor(merged, rgb, cv.COLOR_YCrCb2RGB);
      const out = new Float32Array(reg.w * reg.h * 3);
      const rd = rgb.data32F;
      for (let yy = 0; yy < reg.h; yy++) {
        const si = yy * pw * 3, di = yy * reg.w * 3;
        for (let x = 0; x < reg.w * 3; x++) { let v = rd[si + x]; v = v < 0 ? 0 : v > 1 ? 1 : v; out[di + x] = keep > 0 ? v * (1 - keep) + reg.d[di + x] * keep : v; }
      }
      return { w: reg.w, h: reg.h, d: out, x0: reg.x0, y0: reg.y0 };
    } finally { mk.free(); }
  };

  // ------------------------------------------------------------------ Schärfen
  /** Schärft nur die Helligkeit; sehr feine Differenzen (Rauschen) werden nicht verstärkt. Verändert reg in place. */
  JZO.sharpenRegion = function (reg, amount, sigma, weightFn, o) {
    if (amount <= 0.001) return reg;
    o = o || {};
    const gateV = o.gate === undefined ? 0.25 : o.gate, halo = o.halo === undefined ? 0.5 : o.halo;
    const lim = 0.02 + 0.3 * (1 - halo) * (1 - halo);
    const n = reg.w * reg.h, d = reg.d;
    const Y = lumaF(d, n), B = blurF(Y, reg.w, reg.h, sigma);
    const nf = 0.001 + 0.012 * gateV;
    for (let i = 0; i < n; i++) {
      const det = Y[i] - B[i];
      let gate = (Math.abs(det) - nf) / (nf * 2); gate = gate < 0 ? 0 : gate > 1 ? 1 : gate;
      let delta = amount * 1.5 * det * gate;
      delta = delta > lim ? lim : delta < -lim ? -lim : delta;
      if (weightFn) delta *= weightFn(i);
      d[3 * i] += delta; d[3 * i + 1] += delta; d[3 * i + 2] += delta;
    }
    return reg;
  };


  // ------------------------------------------------------------------ Licht, Farbe, Klarheit, Körnung
  const ADJ_KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'vibrance', 'temperature', 'tint', 'clarity', 'grain'];
  JZO.hasAdjust = (S) => ADJ_KEYS.some((k) => Math.abs(S[k] || 0) > 0.001);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /** Ton- und Farbkorrektur für eine Kachel (Fließkomma 0..1), verändert reg in place. */
  JZO.adjustRegion = function (reg, A) {
    const n = reg.w * reg.h, d = reg.d, W = reg.w;
    const ev = Math.pow(2, A.exposure || 0);
    const t = A.temperature || 0, ti = A.tint || 0;
    const wr = ev * (1 + 0.22 * t) * (1 + 0.05 * ti), wg = ev * (1 - 0.12 * ti), wb = ev * (1 - 0.22 * t) * (1 + 0.05 * ti);
    const con = 1 + 0.8 * (A.contrast || 0), hl = A.highlights || 0, sh = A.shadows || 0, wh = A.whites || 0, bl = A.blacks || 0;
    const sat = 1 + (A.saturation || 0), vib = A.vibrance || 0, grain = A.grain || 0, clarity = A.clarity || 0;
    let blur = null;
    if (Math.abs(clarity) > 0.001) blur = blurF(lumaF(d, n), reg.w, reg.h, A.clarSigma || 10);
    const x0 = reg.x0 || 0, y0 = reg.y0 || 0;
    for (let i = 0; i < n; i++) {
      let r = d[3 * i] * wr, g = d[3 * i + 1] * wg, b = d[3 * i + 2] * wb;
      let Y = 0.299 * r + 0.587 * g + 0.114 * b;
      Y = Y < 0 ? 0 : Y > 1 ? 1 : Y;
      // Lichter/Tiefen/Weiß/Schwarz als additive Helligkeitsänderung (erhält die Farbtöne)
      let dY = 0;
      if (sh) dY += 0.35 * sh * (1 - Y) * (1 - Y) * smooth(0, 0.25, Y);
      if (hl) dY += 0.3 * hl * Y * Y * smooth(0.35, 0.9, Y);
      if (wh) dY += 0.15 * wh * Y * Y * Y;
      if (bl) dY += 0.1 * bl * (1 - Y) * (1 - Y) * (1 - Y);
      if (blur) { const m = 1 - (2 * Y - 1) * (2 * Y - 1); dY += clarity * 1.2 * (Y - blur[i]) * m; }
      r += dY; g += dY; b += dY;
      if (con !== 1) { r = 0.5 + (r - 0.5) * con; g = 0.5 + (g - 0.5) * con; b = 0.5 + (b - 0.5) * con; }
      if (sat !== 1 || vib) {
        const y2 = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sc = mx > 0.001 ? (mx - mn) / mx : 0;
        const f = Math.max(0, sat * (1 + vib * (1 - sc)));
        r = y2 + (r - y2) * f; g = y2 + (g - y2) * f; b = y2 + (b - y2) * f;
      }
      if (grain) {
        const xx = x0 + (i % W), yy = y0 + ((i / W) | 0);
        let h1 = Math.imul(xx, 374761393) + Math.imul(yy, 668265263); h1 = Math.imul(h1 ^ (h1 >>> 13), 1274126177); h1 ^= h1 >>> 16;
        let h2 = Math.imul(xx + 977, 668265263) + Math.imul(yy + 131, 374761393); h2 = Math.imul(h2 ^ (h2 >>> 13), 1274126177); h2 ^= h2 >>> 16;
        const nz = ((h1 >>> 0) / 4294967296 + (h2 >>> 0) / 4294967296 - 1) * 0.16 * grain * (1 - 0.6 * Math.abs(2 * Y - 1));
        r += nz; g += nz; b += nz;
      }
      d[3 * i] = r < 0 ? 0 : r > 1 ? 1 : r; d[3 * i + 1] = g < 0 ? 0 : g > 1 ? 1 : g; d[3 * i + 2] = b < 0 ? 0 : b > 1 ? 1 : b;
    }
    return reg;
  };

  /** Wendet nur Licht/Farbe/Klarheit/Körnung an (ohne die langsamen Schritte). Liefert img selbst zurück, wenn nichts zu tun ist. */
  JZO.applyAdjust = async function (img, S, ctx) {
    if (!JZO.hasAdjust(S)) return img;
    const A = Object.assign({}, S, { clarSigma: clamp(Math.max(img.w, img.h) / 200, 6, 14) });
    return JZO.mapTiles(img, { tile: 512, margin: 48, ctx, onProgress: ctx && ctx.onProgress ? (f) => ctx.onProgress(f, 'Licht und Farbe') : null, fn: (reg) => JZO.adjustRegion(reg, A) });
  };

  /** Autopilot: schätzt das Rauschen (Median der Laplace-Antwort) und schlägt Einstellungen vor. */
  JZO.analyze = function (img) {
    const w = img.w, h = img.h, d = img.d, vals = [];
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
    const Y = (x, y) => { const i = (y * w + x) * 3; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
      const v = Y(x - 1, y - 1) - 2 * Y(x, y - 1) + Y(x + 1, y - 1) - 2 * Y(x - 1, y) + 4 * Y(x, y) - 2 * Y(x + 1, y) + Y(x - 1, y + 1) - 2 * Y(x, y + 1) + Y(x + 1, y + 1);
      vals.push(Math.abs(v));
    }
    vals.sort((a, b) => a - b);
    const med = vals.length ? vals[vals.length >> 1] : 0;
    const sigma = med / 0.6745 / 6;
    const edge = Math.max(w, h);
    return {
      sigma,
      denoise: clamp(+(0.08 + sigma / 22).toFixed(2), 0, 0.95),
      sharpen: sigma > 8 ? 0.2 : 0.3,
      scale: edge < 800 ? 4 : edge < 1800 ? 2 : 1,
    };
  };

  // ------------------------------------------------------------------ KI-Upscaling (Real-ESRGAN compact als ONNX)
  async function esrganRegion(session, reg, scale) {
    const { w, h, d } = reg, n = w * h;
    const plane = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { plane[i] = d[3 * i]; plane[n + i] = d[3 * i + 1]; plane[2 * n + i] = d[3 * i + 2]; }
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', plane, [1, 3, h, w]) });
    const o = res[session.outputNames[0]];
    const H = o.dims[2], W = o.dims[3], od = o.data, m = W * H;
    let out = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) { out[3 * i] = od[i]; out[3 * i + 1] = od[m + i]; out[3 * i + 2] = od[2 * m + i]; }
    if (scale !== 4) out = resizeF(out, W, H, w * scale, h * scale, 3);
    return { w: w * scale, h: h * scale, d: out };
  }

  /** Vergrößert ein Bild um den ganzzahligen Faktor 1..4: mit KI (session) oder Lanczos. */
  JZO.upscale = async function (img, scale, ctx, onProgress) {
    if (scale === 1) return img;
    if (!ctx || !ctx.session) return JZO.resizeImg(img, img.w * scale, img.h * scale, cv.INTER_LANCZOS4);
    return JZO.mapTiles(img, {
      tile: ctx.tile || 192, margin: 16, scale, ctx, onProgress,
      fn: (reg) => esrganRegion(ctx.session, reg, scale),
    });
  };

  // ------------------------------------------------------------------ Vogelerkennung (YOLOX, COCO-Klasse "bird")
  const BIRD_CLASS = 14;

  function iou(a, b) {
    const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return ua > 0 ? inter / ua : 0;
  }
  function nms(dets, thr) {
    dets.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const d of dets) if (keep.every((k) => iou(k.box, d.box) < thr)) keep.push(d);
    return keep;
  }

  /** Eine Detektion auf einem Ausschnitt des Bildes (Letterbox auf 640x640). Liefert Boxen im Bildkoordinatensystem. */
  async function yoloxRegion(session, img, x0, y0, w, h, conf, size) {
    const mk = mats();
    try {
      const r = Math.min(size / w, size / h);
      const nw = Math.max(1, Math.round(w * r)), nh = Math.max(1, Math.round(h * r));
      const reg = JZO.cropImg(img, x0, y0, w, h);
      const src = mk(new cv.Mat(h, w, cv.CV_8UC3)); src.data.set(reg.d);
      const rs = mk(new cv.Mat()); cv.resize(src, rs, new cv.Size(nw, nh), 0, 0, cv.INTER_LINEAR);
      const inp = new Float32Array(3 * size * size).fill(114);
      const rd = rs.data, plane = size * size;
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const i = (y * nw + x) * 3, o = y * size + x;
        inp[o] = rd[i + 2]; inp[plane + o] = rd[i + 1]; inp[2 * plane + o] = rd[i];   // BGR, 0..255
      }
      const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, size, size]) });
      const out = res[session.outputNames[0]].data;
      const dets = [];
      let idx = 0;
      for (const stride of [8, 16, 32]) {
        const g = size / stride;
        for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++, idx++) {
          const p = idx * 85;
          const score = out[p + 4] * out[p + 5 + BIRD_CLASS];
          if (score < conf) continue;
          // nur wenn "Vogel" auch wirklich die wahrscheinlichste Klasse ist (sonst z. B. Flugzeug, Drachen)
          let best = -1, bi = -1;
          for (let c = 0; c < 80; c++) if (out[p + 5 + c] > best) { best = out[p + 5 + c]; bi = c; }
          if (bi !== BIRD_CLASS && best > 1.5 * out[p + 5 + BIRD_CLASS]) continue;
          const cx = (out[p] + gx) * stride, cy = (out[p + 1] + gy) * stride;
          const bw = Math.exp(out[p + 2]) * stride, bh = Math.exp(out[p + 3]) * stride;
          dets.push({
            score,
            box: [x0 + (cx - bw / 2) / r, y0 + (cy - bh / 2) / r, x0 + (cx + bw / 2) / r, y0 + (cy + bh / 2) / r],
          });
        }
      }
      return nms(dets, 0.45);
    } finally { mk.free(); }
  }

  /** mode 'fast': Gesamtbild + 2x2 Kacheln; 'thorough': Kacheln in Originalauflösung (findet kleinere Vögel, dauert länger). */
  JZO.detectBirds = async function (session, img, opt, ctx) {
    const conf = (opt && opt.conf) || 0.3, mode = (opt && opt.mode) || 'fast', size = 640;
    const jobs = [[0, 0, img.w, img.h]];
    if (mode === 'thorough') {
      const t = 640, st = 480;
      for (let y = 0; y === 0 || y < img.h - (t - st); y += st) for (let x = 0; x === 0 || x < img.w - (t - st); x += st) {
        jobs.push([x, y, Math.min(t, img.w - x), Math.min(t, img.h - y)]);
      }
    } else {
      const tw = Math.ceil(img.w * 0.55), th = Math.ceil(img.h * 0.55);
      for (const y of [0, img.h - th]) for (const x of [0, img.w - tw]) jobs.push([Math.max(0, x), Math.max(0, y), tw, th]);
    }
    let all = [];
    for (let i = 0; i < jobs.length; i++) {
      checkCancel(ctx);
      const [x, y, w, h] = jobs[i];
      if (w < 16 || h < 16) continue;
      all = all.concat(await yoloxRegion(session, img, x, y, w, h, conf, size));
      if (opt && opt.onProgress) opt.onProgress((i + 1) / jobs.length);
      await tick();
    }
    // Teilboxen entfernen: ein von einer Kachel abgeschnittener Vogel liegt fast ganz in der Box des ganzen Vogels
    const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const merged = nms(all, 0.4);
    const kept = merged.filter((a) => !merged.some((b) => {
      if (b === a || area(b.box) <= area(a.box)) return false;
      const ix = Math.max(0, Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]));
      const iy = Math.max(0, Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]));
      return ix * iy > 0.8 * area(a.box);
    }));
    return kept.filter((d) => (d.box[2] - d.box[0]) >= 8 && (d.box[3] - d.box[1]) >= 8);
  };

  // ------------------------------------------------------------------ Vogel-Freisteller (GrabCut) und Detailarbeit
  /** Maske für einen Vogel in der Box [x0,y0,x1,y1]. Liefert {box, mask(Float32 box-groß, 0..1)}. */
  JZO.birdFromBox = function (img, box) {
    const mk = mats();
    try {
      let [x0, y0, x1, y1] = box.map(Math.round);
      x0 = clamp(x0, 0, img.w - 1); y0 = clamp(y0, 0, img.h - 1); x1 = clamp(x1, x0 + 1, img.w); y1 = clamp(y1, y0 + 1, img.h);
      const bw = x1 - x0, bh = y1 - y0;
      if (bw < 4 || bh < 4) throw new Error('Markierter Bereich ist zu klein.');
      const pad = Math.floor(0.25 * Math.max(bw, bh)) + 4;
      const rx0 = Math.max(0, x0 - pad), ry0 = Math.max(0, y0 - pad), rx1 = Math.min(img.w, x1 + pad), ry1 = Math.min(img.h, y1 + pad);
      const rw = rx1 - rx0, rh = ry1 - ry0;
      const reg = JZO.cropImg(img, rx0, ry0, rw, rh);
      const full = mk(new cv.Mat(rh, rw, cv.CV_8UC3)); full.data.set(reg.d);
      const s = Math.min(1, 800 / Math.max(rw, rh));
      const sw = Math.max(8, Math.round(rw * s)), sh = Math.max(8, Math.round(rh * s));
      const small = mk(new cv.Mat()); cv.resize(full, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
      const rect = new cv.Rect(Math.round((x0 - rx0) * s), Math.round((y0 - ry0) * s), Math.max(2, Math.round(bw * s)), Math.max(2, Math.round(bh * s)));
      const mask = mk(new cv.Mat(sh, sw, cv.CV_8UC1, new cv.Scalar(0)));
      const bgd = mk(new cv.Mat()), fgd = mk(new cv.Mat());
      let fg = new Float32Array(sw * sh), cnt = 0;
      try {
        cv.grabCut(small, mask, rect, bgd, fgd, 4, cv.GC_INIT_WITH_RECT);
        const md = mask.data;
        for (let i = 0; i < md.length; i++) if (md[i] === 1 || md[i] === 3) { fg[i] = 1; cnt++; }
      } catch (e) { cnt = 0; }
      if (cnt < 0.05 * rect.width * rect.height) {   // Notlösung: Ellipse
        fg = new Float32Array(sw * sh);
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2, a = rect.width / 2, b = rect.height / 2;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1) fg[y * sw + x] = 1;
      }
      const up = resizeF(fg, sw, sh, rw, rh, 1);
      const mask2 = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) mask2[y * bw + x] = clamp(up[(y + y0 - ry0) * rw + (x + x0 - rx0)], 0, 1);
      return { box: [x0, y0, x1, y1], mask: mask2, score: 1 };
    } finally { mk.free(); }
  };

  function featherMask(mask, w, h, size) {
    const mk = mats();
    try {
      let m = mk(matF32(mask, w, h, 1));
      const k = Math.max(1, Math.floor(size * 0.004));
      if (k > 1) { const e = mk(new cv.Mat()); const ker = mk(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * k + 1, 2 * k + 1))); cv.erode(m, e, ker); m = e; }
      const b = mk(new cv.Mat()); const sig = Math.max(1, size * 0.006);
      cv.GaussianBlur(m, b, new cv.Size(0, 0), sig, sig, cv.BORDER_REPLICATE);
      return Float32Array.from(b.data32F).map((v) => clamp(v, 0, 1));
    } finally { mk.free(); }
  }

  /** Federn herausarbeiten: Mehrskalen-Schärfung + Mikrokontrast (CLAHE), nur innerhalb der Maske. */
  JZO.enhanceBirdDetail = function (reg, mask, strength, size) {
    if (strength <= 0) return reg;
    const { w, h, d } = reg, n = w * h;
    const Y = lumaF(d, n);
    const fine = Math.max(0.7, size / 900), mid = Math.max(1.5, size / 250);
    const Bf = blurF(Y, w, h, fine), Bm = blurF(Y, w, h, mid);
    const gate = (v, nf) => { const g = (Math.abs(v) - nf) / (nf * 2); return g < 0 ? 0 : g > 1 ? 1 : g; };
    const Y1 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Y[i] - Bf[i], b = Y[i] - Bm[i];
      Y1[i] = Y[i] + 0.9 * strength * a * gate(a, 0.003) + 0.45 * strength * b * gate(b, 0.004);
    }
    // CLAHE auf 16 Bit
    const mk = mats();
    let Y2 = Y1;
    try {
      const m32 = mk(matF32(Y1, w, h, 1)); const m16 = mk(new cv.Mat());
      m32.convertTo(m16, cv.CV_16U, 65535);
      const grid = clamp(Math.floor(size / 120), 4, 12);
      const cl = new cv.CLAHE(1.0 + 2.0 * strength, new cv.Size(grid, grid));
      const o16 = mk(new cv.Mat()); cl.apply(m16, o16); cl.delete();
      const o32 = mk(new cv.Mat()); o16.convertTo(o32, cv.CV_32F, 1 / 65535);
      Y2 = Float32Array.from(o32.data32F);
    } catch (e) { Y2 = Y1; } finally { mk.free(); }
    const out = new Float32Array(d.length);
    for (let i = 0; i < n; i++) {
      const delta = (Y2[i] - Y[i]) * mask[i];
      out[3 * i] = clamp(d[3 * i] + delta, 0, 1); out[3 * i + 1] = clamp(d[3 * i + 1] + delta, 0, 1); out[3 * i + 2] = clamp(d[3 * i + 2] + delta, 0, 1);
    }
    return { w, h, d: out };
  };

  // ------------------------------------------------------------------ Gesamtablauf
  JZO.defaultSettings = () => ({
    denoise: 0.4, dnDetail: 0, dnColor: 0.5,
    sharpen: 0.3, shRadius: 0.8, shGate: 0.25, shHalo: 0.5,
    scale: 1, ai: true,
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    saturation: 0, vibrance: 0, temperature: 0, tint: 0, clarity: 0, grain: 0,
    birds: false, birdMode: 'fast', birdBoxes: [], birdDetail: 0.7, birdBg: 0.4, birdTarget: 1200,
  });
  JZO.PRESETS = {
    neutral: { denoise: 0, sharpen: 0 },
    standard: { denoise: 0.4, sharpen: 0.3 },
    'hohe-iso': { denoise: 0.8, dnColor: 0.7, dnDetail: 0.1, sharpen: 0.35, shGate: 0.4 },
    'natur-kraeftig': { denoise: 0.4, sharpen: 0.35, vibrance: 0.3, saturation: 0.1, clarity: 0.25, contrast: 0.1 },
    voegel: { denoise: 0.5, sharpen: 0.3, birds: true, birdDetail: 0.7, birdBg: 0.4, birdTarget: 1200 },
    'voegel-klein': { denoise: 0.6, sharpen: 0.3, birds: true, birdMode: 'thorough', birdDetail: 0.8, birdBg: 0.5, birdTarget: 1400 },
  };

  /**
   * ctx: { session (ESRGAN, optional), detector (YOLOX, optional), tile, signal, onProgress(frac,text), log(text) }
   * Liefert { img, birds, birdCrops }.
   */
  JZO.processPhoto = async function (img, S, ctx) {
    ctx = ctx || {};
    const prog = (lo, hi, text) => (f) => { if (ctx.onProgress) ctx.onProgress(lo + (hi - lo) * f, text); };
    const log = ctx.log || (() => {});
    const tile = ctx.tile || 512;
    const scale = S.scale || 1;
    const useAI = S.ai && ctx.session;
    if (S.ai && !ctx.session) log('KI-Upscaling nicht verfügbar - es wird klassisch vergrößert.');

    // 1) Vögel finden
    let birds = [];
    if (S.birds) {
      if (S.birdBoxes && S.birdBoxes.length) {
        birds = S.birdBoxes.map((b) => JZO.birdFromBox(img, b));
      } else if (ctx.detector) {
        const dets = await JZO.detectBirds(ctx.detector, img, { mode: S.birdMode, onProgress: prog(0.02, 0.2, 'Vögel suchen') }, ctx);
        log(dets.length + ' Vogel/Vögel erkannt.');
        for (const dt of dets) { checkCancel(ctx); birds.push(JZO.birdFromBox(img, dt.box)); await tick(); }
      } else {
        log('Vogelerkennung nicht verfügbar - bitte Vögel von Hand markieren.');
      }
    }
    let union = null;
    if (birds.length) {
      union = new Uint8Array(img.w * img.h);
      for (const b of birds) {
        const [x0, y0, x1, y1] = b.box, bw = x1 - x0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const v = b.mask[(y - y0) * bw + (x - x0)] * 255;
          if (v > union[y * img.w + x]) union[y * img.w + x] = v;
        }
      }
      // Rand der Gesamtmaske weich machen
      const mk = mats();
      try {
        const m = mk(new cv.Mat(img.h, img.w, cv.CV_8UC1)); m.data.set(union);
        const k = Math.max(3, Math.floor(0.004 * Math.max(img.w, img.h)) | 1);
        const b = mk(new cv.Mat()); cv.GaussianBlur(m, b, new cv.Size(0, 0), k, k, cv.BORDER_REPLICATE);
        union.set(b.data);
      } finally { mk.free(); }
    }

    // 2) Entrauschen (Hintergrund stärker, Vogel schonender)
    let cur = img;
    const base = S.denoise, dOpt = { color: (S.dnColor === undefined ? 0.5 : S.dnColor) * 2, keep: S.dnDetail || 0 };
    const bgS = union ? Math.min(1, base + S.birdBg) : base, birdS = base * 0.6;
    if (Math.max(base, bgS) > 0.01) {
      cur = await JZO.mapTiles(cur, {
        tile, margin: 32, ctx, onProgress: prog(0.2, 0.5, 'Entrauschen'),
        fn: (reg) => {
          if (!union) return JZO.denoiseRegion(reg, base, dOpt);
          const a = JZO.denoiseRegion(reg, bgS, dOpt), b = birdS > 0.01 ? JZO.denoiseRegion(reg, birdS, dOpt) : reg;
          const out = new Float32Array(reg.d.length);
          for (let y = 0; y < reg.h; y++) for (let x = 0; x < reg.w; x++) {
            const i = y * reg.w + x, m = union[(reg.y0 + y) * img.w + (reg.x0 + x)] / 255;
            for (let c = 0; c < 3; c++) out[3 * i + c] = a.d[3 * i + c] * (1 - m) + b.d[3 * i + c] * m;
          }
          return { w: reg.w, h: reg.h, d: out };
        },
      });
    }
    const denoised = cur;

    // 3) Upscaling
    let up = await JZO.upscale(cur, scale, useAI ? { session: ctx.session, tile: ctx.upTile || 256, signal: ctx.signal } : null, prog(0.5, 0.8, 'Vergrößern'));

    const upPre = up;   // vor dem Schärfen: Grundlage für den Vogel-Pass (spart eine zweite KI-Vergrößerung)

    // 4) Schärfen (Hintergrund etwas weniger)
    if (S.sharpen > 0.01) {
      let unionUp = null;
      if (union) {
        const mk = mats();
        try {
          const m = mk(new cv.Mat(img.h, img.w, cv.CV_8UC1)); m.data.set(union);
          const r = mk(new cv.Mat()); cv.resize(m, r, new cv.Size(up.w, up.h), 0, 0, cv.INTER_LINEAR);
          unionUp = new Uint8Array(r.data);
        } finally { mk.free(); }
      }
      up = await JZO.mapTiles(up, {
        tile, margin: 8, ctx, onProgress: prog(0.8, 0.88, 'Schärfen'),
        fn: (reg) => JZO.sharpenRegion(reg, S.sharpen, (S.shRadius || 0.8) * Math.sqrt(scale),
          unionUp ? (i) => { const y = Math.floor(i / reg.w), x = i - y * reg.w; return 0.5 + 0.5 * unionUp[(reg.y0 + y) * up.w + (reg.x0 + x)] / 255; } : null, { gate: S.shGate, halo: S.shHalo }),
      });
    }

    // 5) Vogel-Detailpass
    const crops = [];
    for (let bi = 0; bi < birds.length; bi++) {
      checkCancel(ctx);
      const b = birds[bi];
      const [x0, y0, x1, y1] = b.box, bw = x1 - x0, bh = y1 - y0, size = Math.max(bw, bh);
      const m = Math.floor(0.12 * size) + 4;
      const rx0 = Math.max(0, x0 - m), ry0 = Math.max(0, y0 - m), rx1 = Math.min(img.w, x1 + m), ry1 = Math.min(img.h, y1 + m);
      const rw = rx1 - rx0, rh = ry1 - ry0;
      const crop = JZO.cropImg(denoised, rx0, ry0, rw, rh);
      const maskReg = new Float32Array(rw * rh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) maskReg[(y + y0 - ry0) * rw + (x + x0 - rx0)] = b.mask[y * bw + x];
      const need = Math.ceil((S.birdTarget || 1200) / Math.max(size, 1));
      const f = Math.min(4, Math.max(scale, need));
      let cropUp;
      if (scale > 1 || f === 1) {
        // Das Foto wurde schon vergrößert: Vogel-Ausschnitt dort herausnehmen, nur ggf. noch klassisch weiter vergrößern
        const base = JZO.cropImg(upPre, rx0 * scale, ry0 * scale, rw * scale, rh * scale);
        cropUp = f === scale ? base : JZO.resizeImg(base, Math.round(rw * f), Math.round(rh * f));
      } else cropUp = await JZO.upscale(crop, f, useAI ? { session: ctx.session, tile: ctx.upTile || 256, signal: ctx.signal } : null, prog(0.88 + 0.09 * bi / birds.length, 0.88 + 0.09 * (bi + 1) / birds.length, 'Vogel ' + (bi + 1) + '/' + birds.length));
      const mUp = resizeF(maskReg, rw, rh, cropUp.w, cropUp.h, 1);
      const soft = featherMask(mUp, cropUp.w, cropUp.h, size * f);
      const regUp = { w: cropUp.w, h: cropUp.h, d: cropF(cropUp, 0, 0, cropUp.w, cropUp.h) };
      const enh = JZO.enhanceBirdDetail(regUp, soft, S.birdDetail, size * f);
      const enhImg = JZO.newImg(enh.w, enh.h);
      for (let i = 0; i < enh.d.length; i++) enhImg.d[i] = enh.d[i] * 255;
      crops.push(enhImg);
      // zurück auf Ausgabegröße und mit weicher Maske einsetzen
      const tw = rw * scale, th = rh * scale;
      const enhT = (enh.w === tw && enh.h === th) ? enhImg : JZO.resizeImg(enhImg, tw, th);
      const softT = resizeF(soft, enh.w, enh.h, tw, th, 1);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const a = clamp(softT[y * tw + x], 0, 1);
        if (a <= 0) continue;
        const oi = ((ry0 * scale + y) * up.w + rx0 * scale + x) * 3, ei = (y * tw + x) * 3;
        for (let c = 0; c < 3; c++) up.d[oi + c] = up.d[oi + c] * (1 - a) + enhT.d[ei + c] * a;
      }
      await tick();
    }
    // 6) Licht, Farbe, Klarheit, Körnung (ganz am Ende, damit auch der Vogel mitzieht)
    const preAdjust = up;   // Zustand vor Licht/Farbe, damit Licht-Regler später schnell nachgerechnet werden können
    up = await JZO.applyAdjust(up, S, Object.assign({}, ctx, { onProgress: ctx.onProgress ? (f, t) => ctx.onProgress(0.97 + 0.03 * f, t) : null }));
    if (ctx.onProgress) ctx.onProgress(1, 'Fertig');
    return { img: up, base: preAdjust, birds: birds.map((b) => b.box), birdCrops: crops };
  };

  return JZO;
});
