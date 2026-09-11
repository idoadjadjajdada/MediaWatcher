import { G, C, clamp, formatMass } from './core/const.js';
import { World } from './core/world.js';
import { dominantAttractor } from './core/kepler.js';
import { Camera } from './render/camera.js';
import { Renderer } from './render/renderer.js';
import { Effects } from './render/effects.js';
import { clearTextureCache } from './render/texture.js';
import { ToolController, toolRadiusPixels, toolRingColor, pickBody } from './ui/tools.js';
import { UI, TIME_SCALES } from './ui/ui.js';
import { instantiate } from './ui/catalog.js';
import { loadPreset } from './ui/presets.js';
import {
  defaultSettings, applyToWorld, loadSettings, saveSettings, SETTING_DEFS,
} from './ui/settings.js';

const STORAGE_KEY = 'helxis.settings.v1';
const UNDO_LIMIT = 24;

class App {
  constructor() {
    this.canvas = document.getElementById('stage');
    this.settings = loadSettings(STORAGE_KEY);
    this.camera = new Camera();
    this.world = new World();
    this.effects = new Effects();
    this.renderer = new Renderer(this.canvas, this.camera);
    this.tools = new ToolController(this);
    this.listeners = {};

    this.state = { selected: null, pulse: 0, placement: null, toolRing: null, dragLine: null };
    this.paused = false;
    // Realtime is technically correct and shows nothing moving; a day a second
    // puts the inner planets in visible motion the moment the page opens.
    this.speedIndex = TIME_SCALES.findIndex((s) => s.value === 86400);
    this.massScale = 1;
    this.armed = null;
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.undoStack = [];
    this.baseScale = 1;
    this.pointer = { down: false, panning: false, id: null, lastX: 0, lastY: 0, cssX: 0, cssY: 0 };
    this.placing = null;

    this.ui = new UI(this);
    this.applySettings();
    this.bindInput();

    this.world.on('collision', (r) => this.onCollision(r));

    this.loadPreset('solar-system', { silent: true });
    this.ui.toast('Helxis ready — pick a system, or build one');

    this.last = performance.now();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  on(evt, fn) { (this.listeners[evt] || (this.listeners[evt] = [])).push(fn); }
  emit(evt, payload) { for (const fn of this.listeners[evt] || []) fn(payload); }

  // --- settings -------------------------------------------------------------

  setSetting(id, value) {
    const def = SETTING_DEFS.get(id);
    if (!def) return;
    this.settings[id] = value;
    saveSettings(STORAGE_KEY, this.settings);
    this.applySettings();
    this.ui.syncSettings();
  }

  resetSettings() {
    this.settings = defaultSettings();
    saveSettings(STORAGE_KEY, this.settings);
    this.applySettings();
    this.ui.syncSettings();
    this.ui.toast('Settings restored to defaults');
  }

  applySettings() {
    applyToWorld(this.settings, this.world);
    this.renderer.setPixelScale(this.settings.pixelScale);
    this.camera._smooth = this.settings.smoothCamera !== false;
    if (!this.settings.trails) this.world.clearTrails();
    document.getElementById('intensity').value = String(this.tools.intensity);
    document.getElementById('intensity-value').textContent = this.tools.intensity.toFixed(1);
  }

  // --- scene ----------------------------------------------------------------

  loadPreset(id, opts = {}) {
    // Push the undo entry only once the preset is known to exist, or a typo in
    // an id leaves a junk snapshot on the stack.
    const before = this.world.snapshot();
    const info = loadPreset(this.world, id);
    if (!info) return;
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.currentPreset = id;
    this.effects.clear();
    this.select(null);
    clearTextureCache();
    applyToWorld(this.settings, this.world);

    if (info.zoom) {
      this.camera.x = info.focus ? info.focus.x : 0;
      this.camera.y = info.focus ? info.focus.y : 0;
      this.camera.setZoom(Math.min(this.camera.width, this.camera.height) / (info.zoom * 2));
      this.camera.scale = this.camera.targetScale;
    } else {
      this.frameAll();
    }
    this.baseScale = this.camera.scale;
    this.camera.follow = null;
    if (info.speed) {
      // Each system has its own natural pace; opening the rings at a day a
      // second or the solar system at a minute a second shows nothing.
      let best = 0, bestErr = Infinity;
      for (let i = 0; i < TIME_SCALES.length; i++) {
        const err = Math.abs(Math.log(TIME_SCALES[i].value / info.speed));
        if (err < bestErr) { bestErr = err; best = i; }
      }
      this.setSpeedIndex(best);
    }
    // A queued hint from the preset you just left would otherwise arrive after
    // you have already loaded another one.
    if (this._hintTimer) clearTimeout(this._hintTimer);
    if (!opts.silent) {
      this.ui.toast(`${info.preset.name} loaded`);
      if (info.hint) {
        this._hintTimer = setTimeout(() => { this._hintTimer = null; this.ui.toast(info.hint, 4200); }, 900);
      }
    }
  }

  restart() {
    if (this.currentPreset) this.loadPreset(this.currentPreset);
  }

  frameAll() {
    if (!this.world.bodies.length) return;
    // Ignore far-flung debris so one escaping fragment does not zoom the whole
    // system down to a pixel.
    const bodies = this.world.bodies.slice().sort((a, b) => b.mass - a.mass);
    const keep = bodies.slice(0, Math.max(1, Math.ceil(bodies.length * 0.94)));
    this.camera.frame(keep);
    this.baseScale = this.camera.scale;
  }

  select(body) {
    if (this.state.selected) this.state.selected.selected = false;
    this.state.selected = body || null;
    if (body) body.selected = true;
    this.ui.updateInspector(body);
    if (!body) this.camera.follow = null;
  }

  markDirty(body) {
    if (this.state.selected === body) this.ui.updateInspector(body);
  }

  toggleFollow() {
    const b = this.state.selected;
    if (!b) return;
    this.camera.follow = this.camera.follow === b ? null : b;
    this.ui.updateInspector(b);
  }

  deleteSelected() {
    const b = this.state.selected;
    if (!b) return;
    this.pushUndo();
    this.world.remove(b);
    this.select(null);
    this.ui.toast(`Removed ${b.name}`);
  }

  onCollision(result) {
    if (!result.regime) return;
    // If the selection was consumed, follow it into whatever it became.
    const sel = this.state.selected;
    if (sel && result.removed && result.removed.includes(sel)) {
      const heir = (result.added && result.added[0]) || null;
      this.select(heir);
      if (heir && this.camera.follow) this.camera.follow = heir;
    }
    if (result.regime === 'merge' && result.added[0] && result.added[0].mass > 1e23) {
      this.ui.toast(`${result.added[0].name} — merged, ${formatMass(result.added[0].mass)}`);
    } else if (result.regime === 'supercatastrophic') {
      this.ui.toast('Supercatastrophic impact — body destroyed');
    } else if (result.regime === 'tidal') {
      this.ui.toast('Tidally disrupted inside the Roche limit');
    }
  }

  // --- undo, save, load -----------------------------------------------------

  pushUndo() {
    try {
      this.undoStack.push(this.world.snapshot());
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    } catch (e) {
      // A scene too large to serialise is a scene not worth an exception.
    }
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) { this.ui.toast('Nothing to undo'); return; }
    this.world.restore(snap);
    applyToWorld(this.settings, this.world);
    this.select(null);
    this.effects.clear();
    this.ui.toast('Undone');
  }

  saveScene() {
    const data = { ...this.world.toJSON(), helxis: 1, preset: this.currentPreset };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `helxis-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.ui.toast(`Saved ${this.world.bodies.length} bodies`);
  }

  async loadSceneFile(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.bodies)) throw new Error('not a Helxis scene');
      this.pushUndo();
      this.world.loadJSON(data);
      applyToWorld(this.settings, this.world);
      this.currentPreset = data.preset || null;
      this.effects.clear();
      clearTextureCache();
      this.select(null);
      this.frameAll();
      this.ui.toast(`Loaded ${this.world.bodies.length} bodies`);
    } catch (err) {
      this.ui.toast(`Could not load that file: ${err.message}`);
    }
  }

  // --- time -----------------------------------------------------------------

  togglePause() {
    this.paused = !this.paused;
    document.getElementById('icon-play').hidden = !this.paused;
    document.getElementById('icon-pause').hidden = this.paused;
    document.getElementById('time-play').classList.toggle('primary', !this.paused);
  }

  setSpeedIndex(i) {
    this.speedIndex = clamp(i, 0, TIME_SCALES.length - 1);
    document.getElementById('time-scale').value = String(this.speedIndex);
    if (this.paused) this.togglePause();
  }

  nudgeSpeed(dir) { this.setSpeedIndex(this.speedIndex + dir); }

  get timeScale() { return TIME_SCALES[this.speedIndex].value; }

  /** One frame's worth of simulation while paused. */
  stepFrame() {
    const dt = this.timeScale * (1 / 60);
    this.world.advance(dt);
    this.effects.update(dt, 1 / 60);
    this.drainEvents();
  }

  // --- placement ------------------------------------------------------------

  beginPlacement(worldPos) {
    if (!this.armed) return false;
    const entry = this.armed;
    const body = instantiate(entry, {
      massScale: this.massScale, x: worldPos.x, y: worldPos.y,
    });
    this.placing = { body, origin: { ...worldPos }, launchTime: 1.1 };
    this.state.placement = {
      x: worldPos.x, y: worldPos.y, radius: body.radius,
      vx: 0, vy: 0, launchTime: 1.1,
    };
    return true;
  }

  updatePlacement(worldPos) {
    if (!this.placing) return;
    const p = this.placing;
    p.body.x = p.origin.x;
    p.body.y = p.origin.y;
    // Drag away from the target to set a launch velocity, catapult-style.
    const dx = p.origin.x - worldPos.x;
    const dy = p.origin.y - worldPos.y;
    const vx = dx / p.launchTime;
    const vy = dy / p.launchTime;
    const s = Math.hypot(vx, vy);
    const cap = 0.1 * C;
    p.vx = s > cap ? (vx * cap) / s : vx;
    p.vy = s > cap ? (vy * cap) / s : vy;
    this.state.placement.vx = p.vx;
    this.state.placement.vy = p.vy;
    this.state.placement.radius = p.body.radius;
  }

  commitPlacement(dragged) {
    const p = this.placing;
    this.placing = null;
    this.state.placement = null;
    if (!p) return;

    this.pushUndo();
    const body = p.body;

    if (dragged && (p.vx || p.vy)) {
      body.vx = p.vx;
      body.vy = p.vy;
    } else if (this.settings.autoOrbit) {
      // Give it the velocity for a circular orbit about whatever dominates
      // here, so a planet dropped near a star actually orbits it.
      const primary = dominantAttractor(body, this.world.bodies);
      if (primary) {
        const dx = body.x - primary.x, dy = body.y - primary.y;
        const d = Math.hypot(dx, dy);
        if (d > primary.radius) {
          const v = Math.sqrt((G * (primary.mass + body.mass)) / d);
          body.vx = primary.vx + (-dy / d) * v;
          body.vy = primary.vy + (dx / d) * v;
        } else {
          body.vx = primary.vx;
          body.vy = primary.vy;
        }
      }
    }

    this.world.add(body);
    this.select(body);
    this.ui.toast(`${body.name} added`);
    if (!this.keys.shift) this.ui.disarm();
  }

  cancelPlacement() {
    this.placing = null;
    this.state.placement = null;
    this.ui.disarm();
  }

  toast(m) { this.ui.toast(m); }

  // --- input ----------------------------------------------------------------

  bindInput() {
    const c = this.canvas;
    this.keys = { shift: false };

    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const b = this.renderer.toBuffer(e.clientX - rect.left, e.clientY - rect.top);
      // Trackpads send many small deltas; normalise so both feel the same.
      const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) / 100, 1.5);
      this.camera.zoomBy(Math.pow(0.86, step * 1.6), b.x, b.y);
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.keys.shift = false; });
    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('blur', () => { this.pointer.down = false; this.tools.up(); });
  }

  pointerWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    const b = this.renderer.toBuffer(e.clientX - rect.left, e.clientY - rect.top);
    return { ...this.camera.screenToWorld(b.x, b.y), bx: b.x, by: b.y };
  }

  onPointerDown(e) {
    if (e.button === 2) return;
    this.canvas.setPointerCapture(e.pointerId);
    const w = this.pointerWorld(e);
    this.pointer.down = true;
    this.pointer.id = e.pointerId;
    this.pointer.lastX = e.clientX;
    this.pointer.lastY = e.clientY;
    this.pointer.moved = false;

    if (this.armed && this.beginPlacement(w)) return;

    // Middle button always pans; the select tool pans when it hits nothing.
    const hit = pickBody(this.world, w.x, w.y, this.camera, 6, this.settings);
    if (e.button === 1 || (this.tools.tool === 'select' && !hit)) {
      this.pointer.panning = true;
      this.canvas.classList.add('panning');
      if (this.tools.tool === 'select' && !hit) this.select(null);
      return;
    }

    this.tools.down(w, e);
    this.canvas.classList.toggle('dragging', this.tools.tool === 'grab' && !!this.tools.grabbed);
  }

  onPointerMove(e) {
    const w = this.pointerWorld(e);
    this.pointer.cssX = e.clientX;
    this.pointer.cssY = e.clientY;
    this.pointer.bufX = w.bx;
    this.pointer.bufY = w.by;
    this.tools.world = { x: w.x, y: w.y };

    if (!this.pointer.down) return;
    const dx = e.clientX - this.pointer.lastX;
    const dy = e.clientY - this.pointer.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.pointer.moved = true;
    this.pointer.lastX = e.clientX;
    this.pointer.lastY = e.clientY;

    if (this.pointer.panning) {
      const scale = this.renderer.buffer.width / this.renderer.cssWidth;
      this.camera.panByPixels(dx * scale, dy * scale);
      return;
    }
    if (this.placing) { this.updatePlacement(w); return; }
    this.tools.move(w);
  }

  onPointerUp(e) {
    if (!this.pointer.down) return;
    this.pointer.down = false;
    this.canvas.classList.remove('panning', 'dragging');
    if (this.pointer.panning) { this.pointer.panning = false; return; }
    if (this.placing) { this.commitPlacement(this.pointer.moved); return; }
    this.tools.up();
  }

  onKeyDown(e) {
    if (e.key === 'Shift') this.keys.shift = true;
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === 'Escape') {
      if (this.placing || this.armed) { this.cancelPlacement(); return; }
      if (!document.getElementById('help-modal').hidden) { this.ui.toggleHelp(false); return; }
      if (!document.getElementById('settings-drawer').hidden) { this.ui.toggleSettings(false); return; }
      if (typing) { e.target.blur(); return; }
      this.select(null);
      return;
    }

    if (typing) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const tool = ['select', 'laser', 'attract', 'repel', 'explode', 'collapse', 'grab', 'delete'][Number(e.key) - 1];
    if (tool) { this.tools.setTool(tool); return; }

    switch (e.key) {
      case ' ': e.preventDefault(); this.togglePause(); break;
      case ',': this.nudgeSpeed(-1); break;
      case '.': e.shiftKey ? this.stepFrame() : this.nudgeSpeed(1); break;
      case 'f': case 'F': this.frameAll(); break;
      case 'g': case 'G': this.toggleFollow(); break;
      case 'q': case 'Q': this.camera.targetRotation -= Math.PI / 12; break;
      case 'e': case 'E': this.camera.targetRotation += Math.PI / 12; break;
      case 'r': case 'R': this.restart(); break;
      case '/': e.preventDefault(); document.getElementById('search').focus(); break;
      case '?': this.ui.toggleHelp(); break;
      case 'Delete': case 'Backspace': this.deleteSelected(); break;
      default: break;
    }
  }

  // --- loop -----------------------------------------------------------------

  drainEvents() {
    const events = this.world.events;
    if (!events.length) return;
    const cam = this.settings.shake ? this.camera : null;
    // A hundred simultaneous impacts should not cost a hundred particle bursts.
    const limit = Math.min(events.length, 24);
    for (let i = 0; i < limit; i++) this.effects.consume(events[i], cam);
    events.length = 0;
  }

  frame(now) {
    requestAnimationFrame(this.frame);
    let dtReal = (now - this.last) / 1000;
    this.last = now;
    // A backgrounded tab can hand back a gap of minutes; do not simulate it.
    if (!(dtReal > 0)) dtReal = 1 / 60;
    dtReal = Math.min(dtReal, 1 / 15);

    this._fpsAccum += dtReal;
    this._fpsFrames++;
    if (this._fpsAccum > 0.4) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    this.state.pulse += dtReal;
    this.camera.update(dtReal);

    const requested = this.paused ? 0 : this.timeScale * dtReal;
    this.tools.update(dtReal, requested);
    const advanced = this.paused ? 0 : this.world.advance(requested);
    this.world.achievedRate = dtReal > 0 ? advanced / dtReal : 0;

    this.effects.update(advanced, dtReal);
    this.drainEvents();

    // The cursor ring for the field tools.
    const t = this.tools.tool;
    const rPx = toolRadiusPixels(t, this.tools.intensity, this.camera);
    this.state.toolRing = rPx > 0 && this.pointer.bufX != null
      ? { x: this.pointer.bufX, y: this.pointer.bufY, r: rPx, color: toolRingColor(t), dashed: true }
      : null;

    this.state.dragLine = null;
    if (this.tools.tool === 'grab' && this.tools.grabbed) {
      const b = this.tools.grabbed;
      const p = [0, 0];
      this.camera.project(b.x, b.y, p);
      this.state.dragLine = { x0: p[0], y0: p[1], x1: this.pointer.bufX, y1: this.pointer.bufY };
    }

    this.renderer.render(this.world, this.effects, this.settings, this.state);

    this.canvas.className = `tool-${t}${this.pointer.panning ? ' panning' : ''}`;
    this.ui.updateStatus(this);
    this.ui.drawRadar(this);
    // The inspector's numbers change every step, but nobody can read them at
    // 60 Hz — refresh a few times a second instead.
    this._inspectorTick = ((this._inspectorTick || 0) + 1) % 10;
    if (this._inspectorTick === 0 && this.state.selected) {
      this.ui.updateInspector(this.state.selected);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.helxis = new App();
});
