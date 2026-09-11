import { clamp, AU } from '../core/const.js';

/**
 * The view onto the world.
 *
 * Everything is measured in *buffer* pixels, not CSS pixels. The renderer draws
 * into a low-resolution buffer and blows it up with nearest-neighbour sampling,
 * which is what makes the whole thing pixel art rather than a smooth canvas
 * scene that happens to look chunky.
 */
export class Camera {
  constructor() {
    this.x = 0;             // world position at the centre of the view, m
    this.y = 0;
    this.scale = 1 / (AU / 220);  // buffer pixels per metre
    this.targetScale = this.scale;
    this.rotation = 0;
    this.targetRotation = 0;
    this.width = 320;       // buffer size, set by the renderer
    this.height = 180;
    this.follow = null;     // a body to track
    this.followSmoothing = 0.18;
    this.minScale = 1e-22;
    this.maxScale = 1e4;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this._smooth = true;
  }

  resize(w, h) { this.width = w; this.height = h; }

  /** Metres per buffer pixel — the number every "is this worth drawing" test wants. */
  get metersPerPixel() { return 1 / this.scale; }

  zoomBy(factor, anchorX, anchorY) {
    const next = clamp(this.targetScale * factor, this.minScale, this.maxScale);
    if (anchorX != null) {
      // Keep the world point under the cursor fixed while the scale changes.
      const before = this.screenToWorld(anchorX, anchorY);
      this.targetScale = next;
      this.scale = next;
      const after = this.screenToWorld(anchorX, anchorY);
      this.x += before.x - after.x;
      this.y += before.y - after.y;
    } else {
      this.targetScale = next;
    }
  }

  setZoom(scale) { this.targetScale = clamp(scale, this.minScale, this.maxScale); }

  panByPixels(dx, dy) {
    // Pan happens in screen space, so it has to be un-rotated to move the
    // camera the direction the user's hand went.
    const c = Math.cos(-this.rotation), s = Math.sin(-this.rotation);
    const wx = (dx * c - dy * s) / this.scale;
    const wy = (dx * s + dy * c) / this.scale;
    this.x -= wx;
    this.y -= wy;
    this.follow = null;
  }

  update(dt) {
    // Exponential approach, framerate-independent.
    const k = 1 - Math.exp(-dt * 14);
    if (this._smooth) {
      this.scale += (this.targetScale - this.scale) * k;
      let dr = this.targetRotation - this.rotation;
      while (dr > Math.PI) dr -= Math.PI * 2;
      while (dr < -Math.PI) dr += Math.PI * 2;
      this.rotation += dr * k;
    } else {
      this.scale = this.targetScale;
      this.rotation = this.targetRotation;
    }

    if (this.follow && this.follow.alive) {
      // Smooth only a bounded residual. An exponential approach on a wall-clock
      // time constant lags by the body's *apparent* speed times that constant,
      // which grows with the time scale: at a week a second — the solar
      // system's opening speed — the followed body left the screen immediately.
      const f = 1 - Math.exp(-dt / Math.max(1e-4, this.followSmoothing));
      const nx = this.x + (this.follow.x - this.x) * f;
      const ny = this.y + (this.follow.y - this.y) * f;
      const maxLag = (Math.min(this.width, this.height) * 0.25) / this.scale;
      const dx = this.follow.x - nx, dy = this.follow.y - ny;
      const lag = Math.hypot(dx, dy);
      if (lag > maxLag) {
        // Too far behind to catch up smoothly: go the rest of the way now.
        const k = (lag - maxLag) / lag;
        this.x = nx + dx * k;
        this.y = ny + dy * k;
      } else {
        this.x = nx;
        this.y = ny;
      }
    } else if (this.follow && !this.follow.alive) {
      this.follow = null;
    }

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.4);
      const amp = this.shake * this.shake * 3;
      this.shakeX = (Math.random() * 2 - 1) * amp;
      this.shakeY = (Math.random() * 2 - 1) * amp;
    } else {
      this.shakeX = 0; this.shakeY = 0;
    }
  }

  addShake(amount) { this.shake = Math.min(2.2, this.shake + amount); }

  /**
   * World -> buffer pixels. Writes into `out` so the hot loop does not allocate.
   * Positions are deliberately not rounded here: sub-pixel positions are what
   * lets the renderer decide between a dot and a disc.
   */
  project(wx, wy, out) {
    const dx = wx - this.x, dy = wy - this.y;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    out[0] = (dx * c - dy * s) * this.scale + this.width / 2 + this.shakeX;
    out[1] = (dx * s + dy * c) * this.scale + this.height / 2 + this.shakeY;
    return out;
  }

  screenToWorld(px, py) {
    const dx = (px - this.width / 2 - this.shakeX) / this.scale;
    const dy = (py - this.height / 2 - this.shakeY) / this.scale;
    const c = Math.cos(-this.rotation), s = Math.sin(-this.rotation);
    return { x: this.x + (dx * c - dy * s), y: this.y + (dx * s + dy * c) };
  }

  /** Is a world-space circle anywhere near the view? */
  visible(wx, wy, radiusMeters, margin = 64) {
    const out = [0, 0];
    this.project(wx, wy, out);
    const r = radiusMeters * this.scale + margin;
    return out[0] > -r && out[0] < this.width + r && out[1] > -r && out[1] < this.height + r;
  }

  /**
   * Frame a set of bodies. Used by the presets, by "focus selection", and on
   * load, so that a scene never opens on an empty patch of sky.
   */
  frame(bodies, padding = 1.35) {
    if (!bodies.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of bodies) {
      minX = Math.min(minX, b.x - b.radius);
      maxX = Math.max(maxX, b.x + b.radius);
      minY = Math.min(minY, b.y - b.radius);
      maxY = Math.max(maxY, b.y + b.radius);
    }
    this.x = (minX + maxX) / 2;
    this.y = (minY + maxY) / 2;
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    const s = Math.min(this.width / (w * padding), this.height / (h * padding));
    this.setZoom(s);
    this.scale = this.targetScale;
    this.follow = null;
  }
}
