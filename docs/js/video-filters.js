/* JZo Entertainment Foto Video AI – Aufbau der FFmpeg-Filterketten (rein rechnerisch, ohne Oberfläche; auch in Node testbar). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JZOVF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VF = {};
  const f1 = (v, d) => (+v).toFixed(d === undefined ? 2 : d);

  VF.defaults = () => ({
    res: 'orig',            // orig | 720 | 1080 | 1440 | 2160 | x2 | x3 | x4   (Zahl = Kurzkante in Pixeln)
    scaler: 'lanczos',      // lanczos | bicubic | spline
    denoise: 0.3, dnMode: 'fast',   // fast | temporal | both
    sharpen: 0.3, shSize: 5, detail: 0,
    deint: false, grain: 0,
    stab: 0,                // 0 aus, 16 leicht, 32 mittel, 48 stark
    fps: 0, interp: 'blend', speed: 1,
    bright: 0, contrast: 0, sat: 0, warm: 0,
    rot: 'none',            // none | cw | ccw | 180 | flip
    crop: 'orig',           // orig | 16:9 | 9:16 | 1:1 | 4:5 | 4:3 | 21:9
    start: 0, len: 0,
    format: 'mp4', codec: 'h264', crf: 18, preset: 'veryfast', audio: 'keep', segLen: 60,
  });

  /** Filterkette für das Video. info: {fps} (Quellbildrate, falls bekannt). */
  VF.video = function (o, info) {
    const f = [], srcFps = (info && info.fps) || 30;
    if (o.deint) f.push('bwdif=mode=send_frame');
    if (o.rot === 'cw') f.push('transpose=1'); else if (o.rot === 'ccw') f.push('transpose=2');
    else if (o.rot === '180') f.push('hflip,vflip'); else if (o.rot === 'flip') f.push('hflip');
    if (o.crop && o.crop !== 'orig') {
      const [a, b] = o.crop.split(':').map(Number);
      f.push(`crop='trunc(min(iw\\,ih*${a}/${b})/2)*2':'trunc(min(ih\\,iw*${b}/${a})/2)*2'`);
    }
    if (o.stab) f.push(`deshake=rx=${o.stab}:ry=${o.stab}:edge=mirror`);
    if (o.denoise > 0.01) {
      const d = o.denoise;
      if (o.dnMode === 'temporal' || o.dnMode === 'both') f.push(`atadenoise=0a=${f1(0.01 + 0.04 * d, 3)}:0b=${f1(0.02 + 0.08 * d, 3)}:1a=${f1(0.02 + 0.06 * d, 3)}:1b=${f1(0.04 + 0.1 * d, 3)}:2a=${f1(0.02 + 0.06 * d, 3)}:2b=${f1(0.04 + 0.1 * d, 3)}:s=${d > 0.6 ? 11 : 7}`);
      if (o.dnMode !== 'temporal') f.push(`hqdn3d=${f1(1 + 7 * d, 1)}:${f1(1 + 5 * d, 1)}:${f1(2 + 8 * d, 1)}:${f1(2 + 6 * d, 1)}`);
    }
    const fl = o.scaler === 'bicubic' ? 'bicubic' : o.scaler === 'spline' ? 'spline' : 'lanczos';
    if (o.res && o.res !== 'orig') {
      if (/^x\d/.test(o.res)) { const k = +o.res.slice(1); f.push(`scale='trunc(iw*${k}/2)*2':'trunc(ih*${k}/2)*2':flags=${fl}`); }
      else { const H = +o.res; f.push(`scale='if(gt(iw,ih),-2,${H})':'if(gt(iw,ih),${H},-2)':flags=${fl}`); }
    } else f.push("scale='trunc(iw/2)*2':'trunc(ih/2)*2'");
    if (o.sharpen > 0.01) { const s = o.shSize || 5; f.push(`unsharp=${s}:${s}:${f1(0.2 + 1.3 * o.sharpen)}:${s}:${s}:0`); }
    if (o.detail > 0.01) f.push(`cas=strength=${f1(o.detail)}`);
    if (o.bright || o.contrast || o.sat) f.push(`eq=brightness=${f1(0.3 * o.bright)}:contrast=${f1(1 + 0.5 * o.contrast)}:saturation=${f1(1 + o.sat)}`);
    if (o.warm) f.push(`colorbalance=rs=${f1(0.25 * o.warm)}:rm=${f1(0.12 * o.warm)}:bs=${f1(-0.25 * o.warm)}:bm=${f1(-0.12 * o.warm)}`);
    if (o.grain > 0.01) f.push(`noise=alls=${Math.round(25 * o.grain)}:allf=t+u`);
    const speed = o.speed || 1;
    if (speed !== 1) f.push(`setpts=PTS/${speed}`);
    const effSrc = srcFps * speed;
    const target = o.fps > 0 ? o.fps : (speed < 1 ? srcFps : 0);
    if (target > 0) {
      if (target > effSrc * 1.05) f.push(o.interp === 'mci' ? `minterpolate=fps=${target}:mi_mode=mci:mc_mode=aobmc:vsbmc=1` : `framerate=fps=${target}:scene=100`);
      else f.push(`fps=${target}`);
    }
    return f.join(',');
  };

  /** Tempo-Änderung für den Ton (atempo nimmt 0,5 bis 100). */
  VF.audio = function (o) {
    const s = o.speed || 1; if (s === 1) return '';
    const parts = []; let r = s;
    while (r < 0.5) { parts.push('atempo=0.5'); r /= 0.5; }
    while (r > 4) { parts.push('atempo=4'); r /= 4; }
    parts.push('atempo=' + f1(r, 4));
    return parts.join(',');
  };

  VF.codecArgs = function (o) {
    const a = [];
    if (o.codec === 'prores') a.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le');
    else if (o.codec === 'h265') a.push('-c:v', 'libx265', '-preset', o.preset, '-crf', String(o.crf + 4), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'log-level=error:pools=none:frame-threads=1:lookahead-slices=0:wpp=0');
    else a.push('-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p');
    return a;
  };
  VF.container = (o) => (o.codec === 'prores' ? 'mov' : o.format);

  /** Geschätzte Ausgabegröße in Bytes (grob), damit der Browser-Speicher nicht überrascht wird. */
  VF.estimateBytes = function (o, outW, outH, outFps, outSecs) {
    if (o.codec === 'prores') return outW * outH * outFps * outSecs * 1.3 / 8 * 1.0;
    const crf = o.codec === 'h265' ? o.crf + 4 : o.crf, bpp = 0.07 * Math.pow(2, (18 - crf) / 6) * (o.codec === 'h265' ? 0.65 : 1);
    return (outW * outH * outFps * outSecs * bpp) / 8;
  };
  return VF;
});
