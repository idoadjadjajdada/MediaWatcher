import { makeRng, valueNoise2, fbm } from '../core/rng.js';
import { clamp, TAU } from '../core/const.js';
import { blackbodyColor } from './texture.js';

/**
 * The background.
 *
 * Stars sit on a fixed celestial sphere — they are infinitely far away, so they
 * do not parallax when the camera pans, only when it rotates. Nebulae are drawn
 * on a slightly nearer layer so there is *some* depth cue when you move.
 */
export class Starfield {
  constructor(count = 900, seed = 0x5eed) {
    const rng = makeRng(seed);
    this.stars = new Float32Array(count * 4);   // angle, elevation, brightness, temp index
    this.colors = [];
    for (let i = 0; i < count; i++) {
      this.stars[i * 4] = rng();                       // u in [0,1)
      this.stars[i * 4 + 1] = rng();                   // v in [0,1)
      // Brightness follows a power law — a few bright ones, many faint — but
      // not so steep that most of the field falls below one colour step.
      this.stars[i * 4 + 2] = 0.16 + Math.pow(rng(), 2.1) * 0.84;
      // Most stars are red dwarfs; a handful are hot and blue.
      const t = rng();
      const temp = t < 0.76 ? 2600 + rng() * 1600
        : t < 0.94 ? 4800 + rng() * 1800
          : 8000 + rng() * 16000;
      this.stars[i * 4 + 3] = temp;
      const c = blackbodyColor(temp);
      this.colors.push(c);
    }
    this.count = count;
    this.nebulaSeed = seed ^ 0x1234;
    this.nebulaCanvas = null;
  }

  /**
   * Draw into the low-resolution buffer. `parallax` is how much the field
   * shifts with camera position — kept tiny, since at solar-system scales any
   * real parallax would be invisible anyway.
   */
  draw(ctx, camera, opts = {}) {
    const w = camera.width, h = camera.height;
    const density = opts.density != null ? opts.density : 1;
    if (density <= 0) return;

    const rot = camera.rotation;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    // A very slow drift with camera position, so panning across empty space
    // does not feel completely static.
    const px = (camera.x * camera.scale * 1e-4) % w;
    const py = (camera.y * camera.scale * 1e-4) % h;

    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const n = Math.round(this.count * density);

    // The field tiles over a region twice the buffer so rotation never reveals
    // an edge.
    const spanX = w * 2, spanY = h * 2;
    for (let i = 0; i < n; i++) {
      const u = this.stars[i * 4] * spanX - spanX / 2;
      const v = this.stars[i * 4 + 1] * spanY - spanY / 2;
      let x = u * cos - v * sin + w / 2 - px;
      let y = u * sin + v * cos + h / 2 - py;
      x = ((x % spanX) + spanX) % spanX - (spanX - w) / 2;
      y = ((y % spanY) + spanY) % spanY - (spanY - h) / 2;
      const xi = x | 0, yi = y | 0;
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;

      const b = this.stars[i * 4 + 2];
      const c = this.colors[i];
      const a = clamp(b * b * 0.85, 0.04, 0.9);
      const p = (yi * w + xi) * 4;
      data[p] = clamp(data[p] + c[0] * a, 0, 255);
      data[p + 1] = clamp(data[p + 1] + c[1] * a, 0, 255);
      data[p + 2] = clamp(data[p + 2] + c[2] * a, 0, 255);

      // Only the genuinely bright ones get a one-pixel cross — the classic way
      // to say "this one is bright" without any blur. Give it to too many and
      // the sky turns into graph paper.
      if (b > 0.955) {
        const dim = a * 0.5;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = xi + dx, ny = yi + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = (ny * w + nx) * 4;
          data[q] = clamp(data[q] + c[0] * dim, 0, 255);
          data[q + 1] = clamp(data[q + 1] + c[1] * dim, 0, 255);
          data[q + 2] = clamp(data[q + 2] + c[2] * dim, 0, 255);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /**
   * A slow nebula wash, rendered once at low resolution and stretched. It is
   * regenerated only when the buffer changes size.
   */
  drawNebula(ctx, camera, intensity = 0.5) {
    if (intensity <= 0) return;
    const w = camera.width, h = camera.height;
    const lw = 48, lh = Math.max(8, Math.round((48 * h) / w));
    if (!this.nebulaCanvas || this.nebulaCanvas.width !== lw || this.nebulaCanvas.height !== lh) {
      const c = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(lw, lh)
        : Object.assign(document.createElement('canvas'), { width: lw, height: lh });
      const cx = c.getContext('2d');
      const img = cx.createImageData(lw, lh);
      const d = img.data;
      let p = 0;
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++, p += 4) {
          const u = x / lw * 3, v = y / lh * 3;
          const a = fbm(u, v, this.nebulaSeed, 5, 2.1, 0.55);
          const b = fbm(u + 5.2, v - 3.1, this.nebulaSeed ^ 0x77, 4);
          const mask = Math.pow(clamp(a * 1.5 - 0.35, 0, 1), 2.1);
          d[p] = 96 + b * 70;
          d[p + 1] = 42 + a * 50;
          d[p + 2] = 150 + b * 80;
          d[p + 3] = Math.round(mask * 255);
        }
      }
      cx.putImageData(img, 0, 0);
      this.nebulaCanvas = c;
    }
    ctx.save();
    ctx.globalAlpha = intensity * 0.5;
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.nebulaCanvas, 0, 0, w, h);
    ctx.restore();
  }
}
