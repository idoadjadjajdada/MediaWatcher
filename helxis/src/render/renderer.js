import { clamp, TAU, formatDistance, schwarzschild } from '../core/const.js';
import { incandescence, surfaceColor } from '../core/materials.js';
import {
  bodyTexture, shadeMask, glowSprite, dotSprite, pickSize, blackbodyColor,
} from './texture.js';
import { Starfield } from './starfield.js';
import { displayRadiusPx } from './scale.js';
import {
  drawTrails, drawOrbits, drawVectors, drawRadii, drawBarycenter, drawGrid,
  drawSelection, drawPlacement, drawToolRing, collectLabels, niceDistance,
} from './overlays.js';

const P = [0, 0];

/**
 * The renderer.
 *
 * Everything is drawn into a small buffer — typically a third or a quarter of
 * the window — and then blown up with nearest-neighbour sampling. That single
 * decision is what makes this pixel art instead of a smooth canvas scene: every
 * sprite, every orbit line, every spark lands on the same coarse grid.
 *
 * Text is the one exception. It is drawn after the upscale, at full device
 * resolution, because a label rendered at 1/4 scale and stretched is unreadable
 * and nobody wants that kind of authenticity.
 */
export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.camera = camera;
    this.pixelScale = 3;
    this.buffer = document.createElement('canvas');
    this.bctx = this.buffer.getContext('2d', { alpha: false, willReadFrequently: true });
    this.starfield = new Starfield(1100);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.labels = [];
    this.stats = { bodiesDrawn: 0, spritesDrawn: 0 };
    this.resize();
  }

  setPixelScale(s) {
    this.pixelScale = clamp(Math.round(s), 1, 8);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.cssWidth = cssW;
    this.cssHeight = cssH;

    const bw = Math.max(64, Math.round(cssW / this.pixelScale));
    const bh = Math.max(48, Math.round(cssH / this.pixelScale));
    if (this.buffer.width !== bw || this.buffer.height !== bh) {
      this.buffer.width = bw;
      this.buffer.height = bh;
    }
    this.camera.resize(bw, bh);
    this.ctx.imageSmoothingEnabled = false;
    this.bctx.imageSmoothingEnabled = false;
  }

  /** Screen (CSS) pixels to buffer pixels. */
  toBuffer(cssX, cssY) {
    return {
      x: (cssX / this.cssWidth) * this.buffer.width,
      y: (cssY / this.cssHeight) * this.buffer.height,
    };
  }

  toScreen(bufX, bufY) {
    return {
      x: (bufX / this.buffer.width) * this.cssWidth,
      y: (bufY / this.buffer.height) * this.cssHeight,
    };
  }

  render(world, effects, settings, state) {
    const cam = this.camera;
    const ctx = this.bctx;
    const w = this.buffer.width, h = this.buffer.height;
    this.stats.bodiesDrawn = 0;
    this.stats.spritesDrawn = 0;

    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#07050e';
    ctx.fillRect(0, 0, w, h);

    if (settings.nebula) this.starfield.drawNebula(ctx, cam, settings.nebulaIntensity);
    if (settings.starfield) this.starfield.draw(ctx, cam, { density: settings.starDensity });

    const gridInfo = drawGrid(ctx, cam, settings);
    this.gridInfo = gridInfo;

    drawTrails(ctx, world, cam, settings);
    drawOrbits(ctx, world, cam, settings, state.selected);
    drawRadii(ctx, world, cam, settings, state.selected);

    // Light sources, gathered once: every body's shading and every glow needs
    // them, and there are rarely more than a handful.
    const stars = [];
    for (const b of world.bodies) if (b.luminosity > 0) stars.push(b);

    if (settings.glow) this.drawGlows(ctx, world, cam, stars, settings);
    this.drawBodies(ctx, world, cam, stars, settings, state);
    if (settings.lensing) this.drawLensing(ctx, world, cam, settings);

    this.drawEffects(ctx, effects, cam, settings);

    drawVectors(ctx, world, cam, settings, state.selected);
    drawBarycenter(ctx, world, cam, settings);
    if (state.selected) {
      drawSelection(ctx, state.selected, cam, state.pulse || 0, displayRadiusPx(state.selected, cam, settings));
    }
    if (state.toolRing) {
      drawToolRing(ctx, state.toolRing.x, state.toolRing.y, state.toolRing.r, state.toolRing.color, state.toolRing.dashed);
    }
    if (state.placement) drawPlacement(ctx, state.placement, cam);
    if (state.dragLine) {
      const d = state.dragLine;
      ctx.strokeStyle = 'rgba(255,210,122,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(d.x0) + 0.5, Math.round(d.y0) + 0.5);
      ctx.lineTo(Math.round(d.x1) + 0.5, Math.round(d.y1) + 0.5);
      ctx.stroke();
    }

    this.labels = collectLabels(world, cam, settings, state.selected);

    // --- upscale ------------------------------------------------------------
    const out = this.ctx;
    out.imageSmoothingEnabled = false;
    out.globalCompositeOperation = 'source-over';
    out.globalAlpha = 1;
    out.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);

    if (settings.scanlines) this.drawScanlines(out);
    if (settings.labels) this.drawLabels(out);
    if (settings.scaleBar) this.drawScaleBar(out);
  }

  // --- bodies ---------------------------------------------------------------

  drawGlows(ctx, world, cam, stars, settings) {
    ctx.globalCompositeOperation = 'lighter';
    for (const b of world.bodies) {
      let col = null, strength = 0;
      if (b.luminosity > 0) {
        col = blackbodyColor(b.temperature);
        strength = 1;
      } else if (b.temperature > 1100 && b.kind !== 'bh') {
        col = incandescence(b.temperature);
        strength = clamp((b.temperature - 1100) / 2500, 0, 0.8);
      }
      if (!col || strength <= 0) continue;

      const pr = displayRadiusPx(b, cam, settings);
      // A star always has *some* glow, even when it is a single pixel: that is
      // how you find one when zoomed all the way out.
      const glowR = Math.max(pr * (b.luminosity > 0 ? 3.2 : 1.9), b.luminosity > 0 ? 4 : 0);
      if (glowR < 1.5) continue;
      if (!cam.visible(b.x, b.y, glowR / cam.scale, 8)) continue;

      cam.project(b.x, b.y, P);
      const size = pickSize(glowR);
      const sprite = glowSprite(size, col[0] * 0.55, col[1] * 0.5, col[2] * 0.45, 2.6);
      const d = glowR * 2;
      ctx.globalAlpha = clamp(0.55 * strength, 0, 1);
      ctx.drawImage(sprite, Math.round(P[0] - d / 2), Math.round(P[1] - d / 2), Math.round(d), Math.round(d));
      this.stats.spritesDrawn++;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  drawBodies(ctx, world, cam, stars, settings, state) {
    // Back to front by size, so a moon in front of a planet lands on top of it.
    const visible = [];
    for (const b of world.bodies) {
      if (!cam.visible(b.x, b.y, b.radius, 6)) continue;
      visible.push(b);
    }
    visible.sort((a, b) => b.radius - a.radius);
    this.stats.bodiesDrawn = visible.length;

    for (const b of visible) {
      cam.project(b.x, b.y, P);
      const pr = displayRadiusPx(b, cam, settings);

      if (b.kind === 'bh') { this.drawBlackHole(ctx, b, cam, pr); continue; }

      if (pr < 1.45) {
        // Too small for a sprite: one pixel, brightness standing in for size.
        const c = b.luminosity > 0 ? blackbodyColor(b.temperature) : surfaceColor(b.surfaceComposition, b.temperature);
        const a = clamp(0.3 + pr * 0.75, 0.18, 1);
        ctx.globalAlpha = a;
        ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
        ctx.fillRect(P[0] | 0, P[1] | 0, 1, 1);
        ctx.globalAlpha = 1;
        continue;
      }

      if (pr < 1.8) {
        // Two or three pixels: a flat disc in the body's own colour reads
        // better than a texture squeezed into nothing.
        const c = b.luminosity > 0 ? blackbodyColor(b.temperature) : surfaceColor(b.surfaceComposition, b.temperature);
        const size = Math.max(2, Math.round(pr * 2));
        const sprite = dotSprite(clamp(size, 2, 8), c[0], c[1], c[2]);
        ctx.drawImage(sprite, Math.round(P[0] - size / 2), Math.round(P[1] - size / 2), size, size);
        this.stats.spritesDrawn++;
        continue;
      }

      const size = pickSize(pr);
      const tex = bodyTexture(b, size);
      const d = Math.max(2, Math.round(pr * 2));
      const x = Math.round(P[0] - d / 2), y = Math.round(P[1] - d / 2);

      ctx.save();
      // Rotate about the body's centre. Nearest-neighbour sampling keeps the
      // rotated sprite on the pixel grid rather than smearing it.
      ctx.translate(Math.round(P[0]), Math.round(P[1]));
      ctx.rotate(b.rotation + cam.rotation);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tex, -Math.round(d / 2), -Math.round(d / 2), d, d);
      ctx.restore();
      this.stats.spritesDrawn++;

      // Day and night. A star lights itself; everything else is lit by whatever
      // stars are around, weighted by the flux each one delivers.
      if (settings.shading && b.luminosity <= 0 && d >= 4) {
        // With no star anywhere in the scene there is no physical answer, so
        // light it from over the viewer's shoulder rather than blacking out a
        // preset that simply does not include a sun.
        const lit = stars.length ? this.lightDirection(b, stars) : { x: -0.72, y: -0.69 };
        if (lit) {
          const mask = shadeMask(size, settings.shadeBands || 5, settings.ambient != null ? settings.ambient : 0.14);
          ctx.save();
          ctx.translate(Math.round(P[0]), Math.round(P[1]));
          ctx.rotate(Math.atan2(lit.y, lit.x) + cam.rotation);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(mask, -Math.round(d / 2), -Math.round(d / 2), d, d);
          ctx.restore();
        } else {
          // Nothing illuminating it at all: a rogue world in the dark.
          ctx.save();
          ctx.globalAlpha = 0.78;
          ctx.fillStyle = '#06040c';
          ctx.beginPath();
          ctx.arc(Math.round(P[0]), Math.round(P[1]), d / 2, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  /** Flux-weighted direction to the light, in world space. */
  lightDirection(body, stars) {
    let lx = 0, ly = 0, total = 0;
    for (const s of stars) {
      if (s === body) continue;
      const dx = s.x - body.x, dy = s.y - body.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 0) continue;
      const flux = s.luminosity / d2;
      const d = Math.sqrt(d2);
      lx += (dx / d) * flux;
      ly += (dy / d) * flux;
      total += flux;
    }
    if (total <= 0) return null;
    const m = Math.hypot(lx, ly);
    if (m <= 0) return null;
    return { x: lx / m, y: ly / m };
  }

  drawBlackHole(ctx, b, cam, pr) {
    cam.project(b.x, b.y, P);
    const x = Math.round(P[0]), y = Math.round(P[1]);
    // The shadow a distant observer sees is √27/2 ≈ 2.6 Schwarzschild radii,
    // not one. Below a couple of pixels, draw the ring instead of the hole.
    const shadow = Math.max(pr * 2.598, 1.5);

    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(x, y, shadow, 0, TAU);
    ctx.fill();

    // Photon ring.
    ctx.globalCompositeOperation = 'lighter';
    const ringR = shadow * 1.06;
    ctx.strokeStyle = 'rgba(255,214,160,0.85)';
    ctx.lineWidth = Math.max(1, shadow * 0.06);
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, TAU);
    ctx.stroke();

    if (shadow > 4) {
      // A hint of an accretion disc, brighter on the side rotating toward us.
      const outer = shadow * 3.1;
      for (let i = 0; i < 3; i++) {
        const r = shadow * (1.5 + i * 0.7);
        ctx.strokeStyle = `rgba(${255},${190 - i * 30},${120 - i * 30},${0.28 - i * 0.07})`;
        ctx.lineWidth = Math.max(1, shadow * 0.12);
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.94, b.rotation, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    this.stats.spritesDrawn++;
  }

  /**
   * Gravitational lensing, applied as a post-process to the already-drawn
   * buffer.
   *
   * A light ray passing a mass at impact parameter b is deflected by 4GM/c²b.
   * Rather than trace rays, the buffer is resampled: a screen pixel at radius r
   * shows what sits at a larger radius, which reproduces the ring of smeared
   * background that makes a black hole legible against a starfield.
   */
  drawLensing(ctx, world, cam, settings) {
    const holes = world.bodies.filter((b) => b.kind === 'bh' || (b.isCompact && b.mass > 1e30));
    if (!holes.length) return;
    const w = this.buffer.width, h = this.buffer.height;

    for (const b of holes) {
      // Lens at the size the hole is *drawn*, or a hole rendered at its size
      // floor would sit inside a lens too small to see.
      const rs = b.kind === 'bh'
        ? displayRadiusPx(b, cam, settings)
        : Math.max(schwarzschild(b.mass) * cam.scale, 0.5);
      const reach = Math.min(rs * 14, 170);
      if (reach < 4) continue;
      cam.project(b.x, b.y, P);
      const cx = P[0], cy = P[1];
      const x0 = Math.max(0, Math.floor(cx - reach));
      const y0 = Math.max(0, Math.floor(cy - reach));
      const x1 = Math.min(w, Math.ceil(cx + reach));
      const y1 = Math.min(h, Math.ceil(cy + reach));
      const bw = x1 - x0, bh = y1 - y0;
      if (bw <= 0 || bh <= 0) return;

      const src = ctx.getImageData(x0, y0, bw, bh);
      const dst = ctx.createImageData(bw, bh);
      const s = src.data, d = dst.data;
      const shadow = rs * 2.598;

      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          const i = (py * bw + px) * 4;
          const dx = x0 + px + 0.5 - cx;
          const dy = y0 + py + 0.5 - cy;
          const r = Math.hypot(dx, dy);
          if (r >= reach) { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255; continue; }
          if (r <= shadow) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; continue; }

          // Deflection pushes the apparent position inward, so to find what a
          // pixel shows we look outward by the same amount.
          const srcR = r + (2 * rs * rs * 2.598) / r;
          const k = srcR / r;
          const sx = Math.round(cx + dx * k) - x0;
          const sy = Math.round(cy + dy * k) - y0;
          if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) {
            d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255;
            continue;
          }
          const j = (sy * bw + sx) * 4;
          // Magnification brightens the ring just outside the shadow.
          const amp = clamp(1 + (shadow / r) * 1.4, 1, 3.2);
          d[i] = clamp(s[j] * amp, 0, 255);
          d[i + 1] = clamp(s[j + 1] * amp, 0, 255);
          d[i + 2] = clamp(s[j + 2] * amp, 0, 255);
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(dst, x0, y0);
      // The hole itself is redrawn on top: the resample cannot know about it.
      this.drawBlackHole(ctx, b, cam, displayRadiusPx(b, cam, settings));
    }
  }

  // --- effects --------------------------------------------------------------

  drawEffects(ctx, effects, cam, settings) {
    if (!settings.effects) return;
    ctx.globalCompositeOperation = 'lighter';

    for (const f of effects.flashes) {
      const t = 1 - f.age / f.life;
      if (t <= 0) continue;
      const r = f.radius * cam.scale * (0.4 + (1 - t) * 1.4);
      if (r < 1) continue;
      if (!cam.visible(f.x, f.y, f.radius * 2, 12)) continue;
      cam.project(f.x, f.y, P);
      const size = pickSize(r);
      const sprite = glowSprite(size, f.r, f.g, f.b, 2.0);
      const d = Math.round(r * 2);
      ctx.globalAlpha = clamp(t * t, 0, 1);
      ctx.drawImage(sprite, Math.round(P[0] - d / 2), Math.round(P[1] - d / 2), d, d);
    }

    ctx.globalAlpha = 1;
    for (const p of effects.particles) {
      const t = 1 - p.age / p.life;
      if (t <= 0) continue;
      if (!cam.visible(p.x, p.y, 0, 4)) continue;
      cam.project(p.x, p.y, P);
      const x = P[0] | 0, y = P[1] | 0;
      if (x < 0 || y < 0 || x >= cam.width || y >= cam.height) continue;
      // Embers cool as they age, sliding down the incandescence ramp.
      const k = p.cool ? t : 1;
      ctx.globalAlpha = clamp(t * 1.1, 0, 1);
      ctx.fillStyle = `rgb(${clamp(p.r * k, 0, 255) | 0},${clamp(p.g * k * 0.85, 0, 255) | 0},${clamp(p.b * k * 0.7, 0, 255) | 0})`;
      ctx.fillRect(x, y, p.size, p.size);
    }

    ctx.globalAlpha = 1;
    for (const r of effects.rings) {
      const t = 1 - r.age / r.life;
      if (t <= 0) continue;
      const pr = r.r * cam.scale;
      if (pr < 1 || pr > cam.width * 3) continue;
      cam.project(r.x, r.y, P);
      ctx.globalAlpha = clamp(t * t * 0.85, 0, 1);
      ctx.strokeStyle = `rgb(${r.r0 | 0},${r.g0 | 0},${r.b0 | 0})`;
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.arc(Math.round(P[0]) + 0.5, Math.round(P[1]) + 0.5, pr, 0, TAU);
      ctx.stroke();
    }

    for (const beam of effects.beams) {
      cam.project(beam.x0, beam.y0, P);
      const ax = P[0], ay = P[1];
      cam.project(beam.x1, beam.y1, P);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = beam.hue || '#ff5f7a';
      ctx.lineWidth = beam.width + 2;
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.moveTo(Math.round(ax) + 0.5, Math.round(ay) + 0.5);
      ctx.lineTo(Math.round(P[0]) + 0.5, Math.round(P[1]) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = beam.width;
      ctx.beginPath();
      ctx.moveTo(Math.round(ax) + 0.5, Math.round(ay) + 0.5);
      ctx.lineTo(Math.round(P[0]) + 0.5, Math.round(P[1]) + 0.5);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- full-resolution overlay ---------------------------------------------

  drawScanlines(out) {
    const step = Math.max(2, Math.round(this.pixelScale * this.dpr));
    out.globalAlpha = 0.10;
    out.fillStyle = '#000000';
    for (let y = 0; y < out.canvas.height; y += step) {
      out.fillRect(0, y, out.canvas.width, 1);
    }
    out.globalAlpha = 1;
  }

  drawLabels(out) {
    const dpr = this.dpr;
    const scale = this.canvas.width / this.buffer.width;
    out.save();
    out.textBaseline = 'middle';
    out.font = `${Math.round(10 * dpr)}px "JetBrains Mono", ui-monospace, monospace`;

    const placed = [];
    for (const l of this.labels) {
      const x = Math.round(l.x * scale + (l.r * scale) + 11 * dpr);
      const y = Math.round(l.y * scale);
      const text = l.text;
      const wTxt = out.measureText(text).width;
      const box = { x, y: y - 7 * dpr, w: wTxt, h: 14 * dpr };
      // Drop a label rather than stack it on top of another.
      let clash = false;
      for (const b of placed) {
        if (box.x < b.x + b.w + 4 && box.x + box.w + 4 > b.x && box.y < b.y + b.h && box.y + box.h > b.y) {
          clash = true; break;
        }
      }
      if (clash && !l.selected) continue;
      placed.push(box);

      out.fillStyle = 'rgba(8,6,16,0.72)';
      out.fillRect(box.x - 3 * dpr, box.y, wTxt + 6 * dpr, box.h);
      out.fillStyle = l.selected ? '#7ff0d8' : 'rgba(206,200,228,0.78)';
      out.fillText(text, x, y);

      // A tick joining the label to its body.
      out.fillStyle = l.selected ? 'rgba(127,240,216,0.6)' : 'rgba(206,200,228,0.3)';
      out.fillRect(Math.round(l.x * scale + l.r * scale + 2 * dpr), y, 5 * dpr, 1);
    }
    out.restore();
  }

  drawScaleBar(out) {
    const dpr = this.dpr;
    const cam = this.camera;
    const scale = this.canvas.width / this.buffer.width;
    // Aim for about 90 CSS pixels, then round to a distance worth printing.
    const target = (90 / this.cssWidth) * this.buffer.width / cam.scale;
    const m = niceDistance(target);
    const px = m * cam.scale * scale;
    if (!isFinite(px) || px < 8 || px > this.canvas.width * 0.6) return;

    const x = Math.round(24 * dpr);
    const y = Math.round(this.canvas.height - 52 * dpr);
    out.save();
    out.fillStyle = 'rgba(206,200,228,0.75)';
    out.fillRect(x, y, Math.round(px), Math.max(1, Math.round(dpr)));
    out.fillRect(x, y - 3 * dpr, Math.max(1, Math.round(dpr)), 7 * dpr);
    out.fillRect(x + Math.round(px), y - 3 * dpr, Math.max(1, Math.round(dpr)), 7 * dpr);
    out.font = `${Math.round(10 * dpr)}px "JetBrains Mono", ui-monospace, monospace`;
    out.textBaseline = 'bottom';
    out.fillText(formatDistance(m), x, y - 5 * dpr);
    out.restore();
  }
}
