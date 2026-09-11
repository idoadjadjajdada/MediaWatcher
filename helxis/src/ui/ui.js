import { TAU, formatDistance, formatMass, formatSpeed, formatTime } from '../core/const.js';
import { MATERIALS } from '../core/materials.js';
import { CATEGORIES, CATALOG, searchCatalog, thumbnailBody, CATALOG_BY_ID } from './catalog.js';
import { PRESETS } from './presets.js';
import { TOOLS } from './tools.js';
import { SETTING_GROUPS, SETTING_DEFS } from './settings.js';
import { thumbnail } from '../render/texture.js';

const TOOL_ICONS = {
  select: '<path d="M4 3l8 9h-4l-1.5 4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  laser: '<path d="M3 13L13 3M13 3H9M13 3v4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><circle cx="4.5" cy="11.5" r="1.6" fill="currentColor"/>',
  attract: '<circle cx="8" cy="8" r="1.8" fill="currentColor"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M5.4 5.4 3.6 3.6M10.6 10.6l1.8 1.8M10.6 5.4l1.8-1.8M5.4 10.6l-1.8 1.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="square"/>',
  repel: '<circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V1.5M8 11.5v3M4.5 8h-3M11.5 8h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M6 2.6 8 .9l2 1.7M6 13.4 8 15.1l2-1.7" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  explode: '<path d="M8 1l1.7 4.2L14 4l-2.3 3.6L15 10l-4.3.4L10 15l-2-3.4L5.4 15 5 10.4 1 10l3.3-2.4L2 4l4.3 1.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  collapse: '<path d="M8 2a6 6 0 1 1-4.2 10.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/><path d="M8 5a3 3 0 1 0 2.1 5.1" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/>',
  grab: '<path d="M5.5 9V4.2a1.1 1.1 0 0 1 2.2 0V8m0-.5V3.3a1.1 1.1 0 0 1 2.2 0V8m0-.6V4.6a1.1 1.1 0 0 1 2.1 0v5.6c0 2.4-1.7 4.3-4 4.3s-4.1-1.3-4.6-3.5L3 9.4a1.1 1.1 0 0 1 1.9-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  delete: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9M6.8 7v4M9.2 7v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/>',
};

/** Ten speed steps, from slow motion up to a megayear a second. */
export const TIME_SCALES = [
  { label: '0.1× slow', value: 0.1 },
  { label: '1× realtime', value: 1 },
  { label: '1 min/s', value: 60 },
  { label: '1 hour/s', value: 3600 },
  { label: '1 day/s', value: 86400 },
  { label: '1 week/s', value: 604800 },
  { label: '1 month/s', value: 2.628e6 },
  { label: '1 year/s', value: 3.15576e7 },
  { label: '10 yr/s', value: 3.15576e8 },
  { label: '100 yr/s', value: 3.15576e9 },
  { label: '1 kyr/s', value: 3.15576e10 },
  { label: '10 kyr/s', value: 3.15576e11 },
  { label: '100 kyr/s', value: 3.15576e12 },
  { label: '1 Myr/s', value: 3.15576e13 },
];

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(app) {
    this.app = app;
    this.category = 'all';
    this.query = '';
    this.tab = 'objects';
    this.armed = null;         // the catalogue entry waiting to be placed
    this.toasts = [];
    this.radarCtx = $('radar-canvas').getContext('2d');
    this.build();
  }

  build() {
    this.buildTransport();
    this.buildPresetSelect();
    this.buildTools();
    this.buildChips();
    this.buildPresetList();
    this.buildSettings();
    this.buildHelp();
    this.renderObjectList();
    this.bind();
    $('count-objects').textContent = String(CATALOG.length).padStart(2, '0');
    $('count-presets').textContent = String(PRESETS.length).padStart(2, '0');
  }

  // --- construction ---------------------------------------------------------

  buildTransport() {
    const sel = $('time-scale');
    sel.innerHTML = TIME_SCALES
      .map((s, i) => `<option value="${i}">${s.label}</option>`).join('');
    sel.value = String(TIME_SCALES.findIndex((s) => s.value === 86400));
  }

  buildPresetSelect() {
    const sel = $('preset-select');
    sel.innerHTML = `<option value="">Load preset system</option>`
      + PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  }

  buildTools() {
    const row = $('tool-row');
    row.innerHTML = TOOLS.map((t) => `
      <button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})" aria-pressed="false">
        <span class="tool-key">${t.key}</span>
        <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">${TOOL_ICONS[t.id] || ''}</svg>
        <span class="tool-label">${t.label}</span>
      </button>`).join('');
  }

  buildChips() {
    $('chips').innerHTML = CATEGORIES
      .map((c) => `<button class="chip${c.id === 'all' ? ' active' : ''}" data-cat="${c.id}">${c.label}</button>`)
      .join('');
  }

  buildPresetList() {
    $('preset-list').innerHTML = PRESETS.map((p) => `
      <button class="entry preset" data-preset="${p.id}">
        <div class="entry-text">
          <div class="entry-name">${p.name}</div>
          <div class="entry-sub">${p.blurb}</div>
        </div>
      </button>`).join('');
  }

  buildSettings() {
    const body = $('settings-body');
    body.innerHTML = SETTING_GROUPS.map((g) => `
      <div class="setting-group" data-group="${g.id}">
        <span class="eyebrow">${g.label}</span>
        ${g.items.map((i) => this.settingRow(i)).join('')}
      </div>`).join('');
    this.syncSettings();
  }

  settingRow(item) {
    const note = item.note ? `<div class="setting-note">${item.note}</div>` : '';
    if (item.type === 'toggle') {
      return `<div class="setting" data-setting="${item.id}">
        <div class="setting-main">
          <div class="setting-label">${item.label}</div>${note}
        </div>
        <button class="switch" role="switch" data-toggle="${item.id}" aria-checked="false" aria-label="${item.label}"></button>
      </div>`;
    }
    return `<div class="setting range" data-setting="${item.id}">
      <div class="range-head">
        <div class="setting-main"><div class="setting-label">${item.label}</div>${note}</div>
        <span class="setting-value" data-value="${item.id}"></span>
      </div>
      <input type="range" data-range="${item.id}" min="${item.min}" max="${item.max}" step="${item.step}" aria-label="${item.label}">
    </div>`;
  }

  buildHelp() {
    const rows = [
      ['h', 'Simulation'],
      ['Space', 'Play / pause'],
      [', / .', 'Slower / faster'],
      ['Shift + .', 'Step one frame while paused'],
      ['R', 'Restart the current system'],
      ['h', 'View'],
      ['Scroll', 'Zoom about the cursor'],
      ['Drag / middle-drag', 'Pan'],
      ['Q / E', 'Rotate the view'],
      ['F', 'Frame everything'],
      ['G', 'Follow the selected body'],
      ['h', 'Tools'],
      ...TOOLS.map((t) => [t.key, `${t.label} — ${t.hint}`]),
      ['h', 'Building'],
      ['/', 'Search the catalogue'],
      ['Click a catalogue entry', 'Arm it, then click the viewport to place'],
      ['Drag while placing', 'Launch it — the arrow is its velocity'],
      ['Esc', 'Cancel placement, or close a panel'],
      ['Ctrl + Z', 'Undo the last change'],
      ['Delete', 'Remove the selected body'],
    ];
    $('help-grid').innerHTML = rows.map(([k, v]) => (
      k === 'h' ? `<div class="h">${v}</div>` : `<div class="k">${k}</div><div class="v">${v}</div>`
    )).join('');
  }

  // --- binding --------------------------------------------------------------

  bind() {
    const app = this.app;

    $('time-play').addEventListener('click', () => app.togglePause());
    $('time-slower').addEventListener('click', () => app.nudgeSpeed(-1));
    $('time-faster').addEventListener('click', () => app.nudgeSpeed(1));
    $('time-step').addEventListener('click', () => app.stepFrame());
    $('time-reset').addEventListener('click', () => app.restart());
    $('time-scale').addEventListener('change', (e) => app.setSpeedIndex(Number(e.target.value)));

    $('preset-select').addEventListener('change', (e) => {
      if (e.target.value) {
        app.loadPreset(e.target.value);
        e.target.value = '';
      }
    });

    $('btn-save').addEventListener('click', () => app.saveScene());
    $('btn-load').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) app.loadSceneFile(f);
      e.target.value = '';
    });

    $('btn-help').addEventListener('click', () => this.toggleHelp(true));
    $('help-close').addEventListener('click', () => this.toggleHelp(false));
    $('help-modal').addEventListener('click', (e) => {
      if (e.target.id === 'help-modal') this.toggleHelp(false);
    });

    $('btn-settings').addEventListener('click', () => this.toggleSettings());
    $('settings-close').addEventListener('click', () => this.toggleSettings(false));
    $('settings-reset').addEventListener('click', () => app.resetSettings());

    $('picker-collapse').addEventListener('click', () => {
      $('picker').classList.toggle('collapsed');
    });

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => this.setTab(tab.dataset.tab));
    }

    $('chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      this.category = chip.dataset.cat;
      for (const c of $('chips').children) c.classList.toggle('active', c === chip);
      this.renderObjectList();
    });

    const search = $('search');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderObjectList();
    });

    $('object-list').addEventListener('click', (e) => {
      const entry = e.target.closest('.entry');
      if (!entry) return;
      this.arm(entry.dataset.entry);
    });

    $('preset-list').addEventListener('click', (e) => {
      const entry = e.target.closest('.entry');
      if (!entry) return;
      app.loadPreset(entry.dataset.preset);
    });

    $('tool-row').addEventListener('click', (e) => {
      const btn = e.target.closest('.tool');
      if (btn) app.tools.setTool(btn.dataset.tool);
    });

    const intensity = $('intensity');
    intensity.addEventListener('input', () => {
      app.tools.intensity = Number(intensity.value);
      $('intensity-value').textContent = Number(intensity.value).toFixed(1);
    });

    const mass = $('mass-scale');
    mass.addEventListener('input', () => {
      app.massScale = Math.pow(10, Number(mass.value));
      $('mass-scale-value').textContent = formatScale(app.massScale);
    });

    $('auto-orbit').addEventListener('change', (e) => {
      app.setSetting('autoOrbit', e.target.checked);
    });

    $('inspector-close').addEventListener('click', () => app.select(null));
    $('btn-follow').addEventListener('click', () => app.toggleFollow());
    $('btn-delete-body').addEventListener('click', () => app.deleteSelected());

    $('zoom-in').addEventListener('click', () => app.camera.zoomBy(1.6));
    $('zoom-out').addEventListener('click', () => app.camera.zoomBy(1 / 1.6));
    $('rot-ccw').addEventListener('click', () => { app.camera.targetRotation -= Math.PI / 12; });
    $('rot-cw').addEventListener('click', () => { app.camera.targetRotation += Math.PI / 12; });
    $('recenter').addEventListener('click', () => app.frameAll());

    // Settings widgets.
    $('settings-body').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-toggle]');
      if (!sw) return;
      const id = sw.dataset.toggle;
      app.setSetting(id, !app.settings[id]);
      this.syncSettings();
    });
    $('settings-body').addEventListener('input', (e) => {
      const r = e.target.closest('[data-range]');
      if (!r) return;
      app.setSetting(r.dataset.range, Number(r.value));
      this.syncSettings();
    });
  }

  // --- catalogue ------------------------------------------------------------

  setTab(tab) {
    this.tab = tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
    $('tab-objects').hidden = tab !== 'objects';
    $('tab-presets').hidden = tab !== 'presets';
  }

  renderObjectList() {
    const results = searchCatalog(this.query, this.category);
    const list = $('object-list');
    if (!results.length) {
      list.innerHTML = `<div class="empty">Nothing matches “${escapeHtml(this.query)}”.</div>`;
      return;
    }

    // Group by category unless the user has already narrowed to one.
    const groups = new Map();
    for (const e of results) {
      if (!groups.has(e.category)) groups.set(e.category, []);
      groups.get(e.category).push(e);
    }

    let html = '';
    for (const [cat, items] of groups) {
      const label = (CATEGORIES.find((c) => c.id === cat) || {}).label || cat;
      html += `<div class="group-head"><span>${label}</span><span>${items.length} object${items.length === 1 ? '' : 's'}</span></div>`;
      for (const e of items) {
        html += `<button class="entry${this.armed === e.id ? ' armed' : ''}" data-entry="${e.id}" title="${escapeHtml(e.note || '')}">
          <canvas class="thumb" width="34" height="34" data-thumb="${e.id}"></canvas>
          <span class="entry-text">
            <span class="entry-name">${e.name}</span>
            <span class="entry-sub">${label}</span>
          </span>
          ${this.armed === e.id ? '<span class="entry-badge">ARMED</span>' : ''}
        </button>`;
      }
    }
    list.innerHTML = html;
    // Paint the thumbnails after layout so the list appears immediately.
    requestAnimationFrame(() => this.paintThumbs(list));
  }

  paintThumbs(root) {
    for (const c of root.querySelectorAll('canvas[data-thumb]')) {
      if (c.dataset.painted) continue;
      const entry = CATALOG_BY_ID.get(c.dataset.thumb);
      if (!entry) continue;
      const body = thumbnailBody(entry);
      const src = thumbnail(body, 34);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, 34, 34);
      ctx.drawImage(src, 0, 0);
      c.dataset.painted = '1';
    }
  }

  arm(entryId) {
    this.armed = this.armed === entryId ? null : entryId;
    this.app.armed = this.armed ? CATALOG_BY_ID.get(this.armed) : null;
    this.renderObjectList();
    if (this.armed) {
      this.app.tools.setTool('select');
      this.toast(`${this.app.armed.name} armed`);
    }
  }

  disarm() {
    if (!this.armed) return;
    this.armed = null;
    this.app.armed = null;
    this.renderObjectList();
  }

  // --- inspector ------------------------------------------------------------

  updateInspector(body) {
    const panel = $('inspector');
    if (!body) { panel.hidden = true; return; }
    panel.hidden = false;

    $('inspector-name').textContent = body.name;
    $('inspector-kind').textContent = kindLabel(body.kind);

    const thumbCanvas = $('inspector-thumb');
    const ctx = thumbCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 44, 44);
    ctx.drawImage(thumbnail(body, 44), 0, 0);

    const stats = [
      ['Mass', formatMass(body.mass)],
      ['Radius', formatDistance(body.radius)],
      ['Density', `${body.density < 1e6 ? body.density.toFixed(0) : body.density.toExponential(2)} kg/m³`],
      ['Gravity', `${fmtG(body.surfaceGravity)}`],
      ['Temperature', body.kind === 'bh' ? '—' : `${fmtTemp(body.temperature)}`],
      ['Escape vel.', formatSpeed(body.escapeVelocity)],
      ['Speed', formatSpeed(body.speed)],
      ['State', body.describeState()],
    ];
    if (body.spin) stats.push(['Rotation', fmtPeriod(TAU / Math.abs(body.spin), body.spin < 0)]);
    if (body.craters.length) stats.push(['Impacts', `${body.craters.length} recorded`]);
    if (body.mixes.length) stats.push(['Mergers', `${body.mixes.length}`]);

    $('inspector-stats').innerHTML = stats.map(([k, v]) => (
      `<div class="stat"><dt>${k}</dt><dd title="${escapeHtml(String(v))}">${escapeHtml(String(v))}</dd></div>`
    )).join('');

    const comp = Object.entries(body.surfaceComposition)
      .filter(([, f]) => f > 0.001)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    $('composition-rows').innerHTML = comp.map(([k, f]) => {
      const m = MATERIALS[k];
      const c = m ? m.cold : [140, 140, 150];
      const rgb = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
      return `<div class="comp-row">
        <span class="comp-swatch" style="background:${rgb}"></span>
        <span class="comp-name">${m ? m.name : k}</span>
        <span class="comp-pct">${(f * 100).toFixed(1)}%</span>
        <span class="comp-bar"><i style="width:${(f * 100).toFixed(1)}%;background:${rgb}"></i></span>
      </div>`;
    }).join('');

    $('btn-follow').classList.toggle('active', this.app.camera.follow === body);
  }

  // --- status, radar, toasts ------------------------------------------------

  updateStatus(app) {
    const s = $('status');
    s.classList.toggle('paused', app.paused);
    s.classList.toggle('throttled', !app.paused && app.world.throttled);
    $('status-state').textContent = app.paused ? 'PAUSED' : app.world.throttled ? 'TIME LIMITED' : 'SIMULATING';
    $('status-bodies').textContent = `${app.world.bodies.length} ${app.world.bodies.length === 1 ? 'body' : 'bodies'}`;
    $('status-fps').textContent = `${Math.round(app.fps)} FPS`;

    const showDiag = app.settings.showDiagnostics;
    const diag = $('status-diag');
    diag.hidden = !showDiag;
    document.querySelector('.status-sep.diag').hidden = !showDiag;
    if (showDiag) {
      const drift = isFinite(app.world.energyDrift) ? app.world.energyDrift.toExponential(1) : 'n/a';
      // Say how much integration the drift figure covers: zero drift over two
      // steps and zero over a million are not the same claim.
      const over = app.world.energySteps ? ` over ${app.world.energySteps} steps` : '';
      const parts = [
        `${app.world.substepsTaken || 0} substeps`,
        `dE/E ${drift}${over}`,
        `${app.effects.count} fx`,
      ];
      // Mass leaving at the body cap, and a step too fine to be meaningful, are
      // both things the simulation should admit to rather than absorb quietly.
      if (app.world.evictedCount) parts.push(`${app.world.evictedCount} evicted`);
      if (app.world.nonFiniteRemoved) parts.push(`${app.world.nonFiniteRemoved} non-finite culled`);
      if (app.world.underResolved) parts.push('under-resolved');
      diag.textContent = parts.join(' · ');
    }

    $('clock').textContent = `T + ${formatClock(app.world.time)}`;
    const zoomPct = app.camera.scale / app.baseScale;
    $('zoom-label').textContent = formatZoom(zoomPct);
    $('view-mode').textContent = app.camera.rotation === 0 ? 'TOP DOWN' : `${Math.round((-app.camera.rotation * 180) / Math.PI)}°`;

    for (const btn of $('tool-row').children) {
      const on = btn.dataset.tool === app.tools.tool;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }

    const hint = $('tool-hint');
    if (app.armed) {
      hint.textContent = `Placing ${app.armed.name} · Click to place · Drag to launch · Esc to cancel`;
    } else {
      hint.textContent = app.tools.hint;
    }
  }

  /**
   * The radar. Everything within a few view-widths, on a log-compressed radius
   * so a moon and a distant gas giant both fit without one becoming a pixel at
   * the rim.
   */
  drawRadar(app) {
    const ctx = this.radarCtx;
    const n = 164, c = n / 2;
    ctx.clearRect(0, 0, n, n);

    const cam = app.camera;
    const viewSpan = Math.max(cam.width, cam.height) / cam.scale;
    const range = viewSpan * 6;

    ctx.strokeStyle = 'rgba(167,139,250,0.16)';
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(c, c, (c - 2) * f, 0, TAU);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(c, 2); ctx.lineTo(c, n - 2);
    ctx.moveTo(2, c); ctx.lineTo(n - 2, c);
    ctx.stroke();

    // The slice of the radar the viewport actually covers.
    const viewR = ((viewSpan / 2) / range) * (c - 2);
    ctx.strokeStyle = 'rgba(94,234,212,0.3)';
    ctx.strokeRect(c - viewR * (cam.width / Math.max(cam.width, cam.height)),
      c - viewR * (cam.height / Math.max(cam.width, cam.height)),
      viewR * 2 * (cam.width / Math.max(cam.width, cam.height)),
      viewR * 2 * (cam.height / Math.max(cam.width, cam.height)));

    const cosR = Math.cos(cam.rotation), sinR = Math.sin(cam.rotation);
    for (const b of app.world.bodies) {
      const dx = b.x - cam.x, dy = b.y - cam.y;
      const d = Math.hypot(dx, dy);
      if (d > range * 4) continue;
      // Log compression keeps the near field readable and still shows the rim.
      const t = Math.min(1, Math.log10(1 + (d / range) * 9) / 1);
      const rr = t * (c - 3);
      const ang = Math.atan2(dy, dx);
      const rx = Math.cos(ang) * rr, ry = Math.sin(ang) * rr;
      const px = c + rx * cosR - ry * sinR;
      const py = c + rx * sinR + ry * cosR;

      const size = b === app.state.selected ? 3
        : b.mass > 1e29 ? 3 : b.mass > 1e24 ? 2 : 1;
      ctx.fillStyle = b === app.state.selected ? '#5eead4'
        : b.kind === 'star' ? '#fbbf24'
          : b.kind === 'bh' ? '#a78bfa'
            : b.kind === 'debris' ? 'rgba(155,147,180,0.5)'
              : 'rgba(233,228,247,0.75)';
      ctx.fillRect(Math.round(px) - (size >> 1), Math.round(py) - (size >> 1), size, size);
    }
  }

  // --- settings -------------------------------------------------------------

  syncSettings() {
    const s = this.app.settings;
    for (const [id, def] of SETTING_DEFS) {
      const row = document.querySelector(`[data-setting="${id}"]`);
      if (!row) continue;
      if (def.type === 'toggle') {
        const sw = row.querySelector('[data-toggle]');
        if (sw) sw.setAttribute('aria-checked', String(!!s[id]));
      } else {
        const input = row.querySelector('[data-range]');
        const out = row.querySelector('[data-value]');
        if (input) input.value = String(s[id]);
        if (out) out.textContent = def.format ? def.format(s[id]) : String(s[id]);
      }
      if (def.depends) row.classList.toggle('disabled', !s[def.depends]);
    }
    $('auto-orbit').checked = !!s.autoOrbit;
  }

  toggleSettings(force) {
    const d = $('settings-drawer');
    const open = force != null ? force : d.hidden;
    d.hidden = !open;
    if (open) {
      $('inspector').dataset.hiddenBySettings = $('inspector').hidden ? '' : '1';
      $('inspector').hidden = true;
      this.syncSettings();
    } else if ($('inspector').dataset.hiddenBySettings === '1') {
      $('inspector').hidden = !this.app.state.selected;
    }
  }

  toggleHelp(force) {
    const m = $('help-modal');
    m.hidden = force != null ? !force : !m.hidden;
  }

  // --- toasts ---------------------------------------------------------------

  toast(message, ms = 2200) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    $('toasts').appendChild(el);
    const t = setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 320);
    }, ms);
    // Never stack more than four: a shower of collisions should not bury the UI.
    const all = $('toasts').children;
    while (all.length > 4) all[0].remove();
    return () => { clearTimeout(t); el.remove(); };
  }
}

// --- formatting helpers ------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function kindLabel(kind) {
  return {
    star: 'Star', planet: 'Planet', gasgiant: 'Gas giant', moon: 'Moon',
    asteroid: 'Small body', comet: 'Comet', debris: 'Debris',
    bh: 'Black hole', ns: 'Neutron star', wd: 'White dwarf',
  }[kind] || kind;
}

function fmtTemp(t) {
  if (t >= 1e5) return `${t.toExponential(2)} K`;
  if (t >= 1e4) return `${Math.round(t / 100) * 100} K`;
  return `${t.toFixed(t < 100 ? 1 : 0)} K`;
}

function fmtG(a) {
  if (a > 1e6) return `${a.toExponential(2)} m/s²`;
  return `${a.toFixed(2)} m/s² (${(a / 9.80665).toFixed(2)} g)`;
}

function fmtPeriod(seconds, retro) {
  const s = formatTime(seconds);
  return retro ? `${s} retro` : s;
}

function formatClock(seconds) {
  const neg = seconds < 0;
  let t = Math.abs(seconds);
  const yr = Math.floor(t / 3.15576e7);
  if (yr >= 1) {
    t -= yr * 3.15576e7;
    const d = Math.floor(t / 86400);
    return `${neg ? '-' : ''}${yr.toLocaleString()}y ${String(d).padStart(3, '0')}d`;
  }
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${neg ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatZoom(x) {
  if (!isFinite(x) || x <= 0) return '—';
  if (x >= 1000) return `${x.toExponential(1)}×`;
  if (x >= 10) return `${Math.round(x)}00%`.replace('00%', '×');
  if (x >= 0.01) return `${Math.round(x * 100)}%`;
  return `${x.toExponential(1)}×`;
}

function formatScale(x) {
  if (x >= 100) return `${Math.round(x)}×`;
  if (x >= 1) return `${x.toFixed(x < 10 ? 1 : 0)}×`;
  return `${x.toFixed(x < 0.01 ? 3 : 2)}×`;
}
