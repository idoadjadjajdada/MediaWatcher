// Barnes-Hut quadtree.
//
// The tree is stored in flat typed arrays rather than as objects: at a few
// thousand bodies, rebuilt every substep, allocation is the whole cost. Nodes
// are appended as they are needed and the arrays grow geometrically.
//
// Each node keeps its centre of mass, its total mass, and the largest body
// radius anywhere beneath it. The radius lets the same tree answer collision
// broad-phase queries, so we build one structure per step instead of two.

const NW = 0, NE = 1, SW = 2, SE = 3;

// How far a body moved over the step just integrated. Falls back to a velocity
// estimate for callers that build the tree outside the integrator.
function sweepMagnitude(b) {
  if (b.x0 != null) return Math.abs(b.x - b.x0) + Math.abs(b.y - b.y0);
  return Math.abs(b.vx) + Math.abs(b.vy);
}

export class Quadtree {
  constructor(capacity = 4096) {
    this.alloc(capacity);
    this.count = 0;
    this.theta = 0.5;
    this.softening = 0;
  }

  alloc(n) {
    this.cx = new Float64Array(n);
    this.cy = new Float64Array(n);
    this.half = new Float64Array(n);
    this.mass = new Float64Array(n);
    this.comX = new Float64Array(n);
    this.comY = new Float64Array(n);
    this.maxR = new Float64Array(n);
    this.maxV = new Float64Array(n);
    this.child = new Int32Array(n * 4).fill(-1);
    this.bodyIndex = new Int32Array(n).fill(-1);
    this.isLeaf = new Uint8Array(n);
    this.capacity = n;
  }

  grow() {
    const n = this.capacity * 2;
    const old = {
      cx: this.cx, cy: this.cy, half: this.half, mass: this.mass,
      comX: this.comX, comY: this.comY, maxR: this.maxR, maxV: this.maxV,
      child: this.child, bodyIndex: this.bodyIndex, isLeaf: this.isLeaf,
      count: this.count,
    };
    this.alloc(n);
    this.cx.set(old.cx); this.cy.set(old.cy); this.half.set(old.half);
    this.mass.set(old.mass); this.comX.set(old.comX); this.comY.set(old.comY);
    this.maxR.set(old.maxR); this.maxV.set(old.maxV); this.child.set(old.child);
    this.bodyIndex.set(old.bodyIndex); this.isLeaf.set(old.isLeaf);
    this.count = old.count;
  }

  newNode(cx, cy, half) {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    this.cx[i] = cx; this.cy[i] = cy; this.half[i] = half;
    this.mass[i] = 0; this.comX[i] = 0; this.comY[i] = 0;
    this.maxR[i] = 0; this.maxV[i] = 0;
    this.child[i * 4] = -1; this.child[i * 4 + 1] = -1;
    this.child[i * 4 + 2] = -1; this.child[i * 4 + 3] = -1;
    this.bodyIndex[i] = -1;
    this.isLeaf[i] = 1;
    return i;
  }

  /**
   * Build the tree over `bodies`. Positions are read once here; the caller must
   * not move bodies until the next rebuild.
   */
  build(bodies) {
    this.count = 0;
    this.bodies = bodies;
    // Node indices are reused on every build, so stale overflow lists from the
    // previous build would alias onto unrelated nodes.
    this.overflow = null;
    const n = bodies.length;
    if (n === 0) { this.root = -1; return; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.x < minX) minX = b.x;
      if (b.x > maxX) maxX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.y > maxY) maxY = b.y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // A hair of slack keeps a body sitting exactly on the boundary inside.
    let half = Math.max(maxX - minX, maxY - minY) / 2 * 1.0001;
    if (!(half > 0) || !isFinite(half)) half = 1;

    this.root = this.newNode(cx, cy, half);
    for (let i = 0; i < n; i++) this.insert(this.root, i, 0);

    this.computeMoments(this.root);
  }

  insert(node, bi, depth) {
    const bodies = this.bodies;
    // Below about 1e-10 of the root size, two bodies are numerically coincident
    // and subdividing further will not separate them. Stack them in one leaf.
    if (depth > 60) {
      if (this.bodyIndex[node] === -1) this.bodyIndex[node] = bi;
      else {
        if (!this.overflow) this.overflow = new Map();
        let list = this.overflow.get(node);
        if (!list) { list = []; this.overflow.set(node, list); }
        list.push(bi);
      }
      return;
    }

    if (this.isLeaf[node]) {
      if (this.bodyIndex[node] === -1) { this.bodyIndex[node] = bi; return; }
      // Occupied leaf: push the resident down, then continue with the new body.
      const resident = this.bodyIndex[node];
      this.bodyIndex[node] = -1;
      this.isLeaf[node] = 0;
      this.insertIntoChild(node, resident, depth);
      this.insertIntoChild(node, bi, depth);
      return;
    }
    this.insertIntoChild(node, bi, depth);
  }

  insertIntoChild(node, bi, depth) {
    const b = this.bodies[bi];
    const cx = this.cx[node], cy = this.cy[node], half = this.half[node];
    const east = b.x >= cx ? 1 : 0;
    const south = b.y >= cy ? 1 : 0;
    const q = south ? (east ? SE : SW) : (east ? NE : NW);
    let c = this.child[node * 4 + q];
    if (c === -1) {
      const h = half / 2;
      const nx = cx + (east ? h : -h);
      const ny = cy + (south ? h : -h);
      c = this.newNode(nx, ny, h);
      this.child[node * 4 + q] = c;
    }
    this.insert(c, bi, depth + 1);
  }

  /** Post-order accumulation of mass, centre of mass and subtree max radius. */
  computeMoments(root) {
    // Explicit stack: recursion depth can reach 60+ and this runs every substep.
    const stack = [root];
    const order = [];
    while (stack.length) {
      const node = stack.pop();
      order.push(node);
      if (!this.isLeaf[node]) {
        for (let q = 0; q < 4; q++) {
          const c = this.child[node * 4 + q];
          if (c !== -1) stack.push(c);
        }
      }
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const node = order[i];
      if (this.isLeaf[node]) {
        const bi = this.bodyIndex[node];
        if (bi === -1) { this.mass[node] = 0; this.maxR[node] = 0; continue; }
        const b = this.bodies[bi];
        let m = b.mass, mx = b.mass * b.x, my = b.mass * b.y, mr = b.radius;
        let mv = sweepMagnitude(b);
        const extra = this.overflow && this.overflow.get(node);
        if (extra) {
          for (const j of extra) {
            const o = this.bodies[j];
            m += o.mass; mx += o.mass * o.x; my += o.mass * o.y;
            if (o.radius > mr) mr = o.radius;
            const ov = sweepMagnitude(o);
            if (ov > mv) mv = ov;
          }
        }
        this.mass[node] = m;
        this.comX[node] = m > 0 ? mx / m : b.x;
        this.comY[node] = m > 0 ? my / m : b.y;
        this.maxR[node] = mr;
        this.maxV[node] = mv;
      } else {
        let m = 0, mx = 0, my = 0, mr = 0, mv = 0;
        for (let q = 0; q < 4; q++) {
          const c = this.child[node * 4 + q];
          if (c === -1) continue;
          const cm = this.mass[c];
          m += cm; mx += cm * this.comX[c]; my += cm * this.comY[c];
          if (this.maxR[c] > mr) mr = this.maxR[c];
          if (this.maxV[c] > mv) mv = this.maxV[c];
        }
        this.mass[node] = m;
        this.comX[node] = m > 0 ? mx / m : this.cx[node];
        this.comY[node] = m > 0 ? my / m : this.cy[node];
        this.maxR[node] = mr;
        this.maxV[node] = mv;
      }
    }
  }

  /**
   * Acceleration on body `bi` from the whole tree, using the standard
   * s/d < theta opening criterion with Plummer softening.
   *
   * Returns [ax, ay] and, as a side effect, accumulates the potential energy
   * term into `this.potentialAccum` when `wantPotential` is set.
   */
  accelerate(bi, G, theta, softening, out) {
    const b = this.bodies[bi];
    const bx = b.x, by = b.y;
    let ax = 0, ay = 0;
    const eps2 = softening * softening;
    const theta2 = theta * theta;
    const stack = this._stack || (this._stack = new Int32Array(4096));
    let sp = 0;
    if (this.root === -1) { out[0] = 0; out[1] = 0; return out; }
    stack[sp++] = this.root;

    while (sp > 0) {
      const node = stack[--sp];
      const m = this.mass[node];
      if (m === 0) continue;

      const dx = this.comX[node] - bx;
      const dy = this.comY[node] - by;
      const d2 = dx * dx + dy * dy;

      if (this.isLeaf[node]) {
        const j = this.bodyIndex[node];
        if (j === bi && !(this.overflow && this.overflow.has(node))) continue;
        // A leaf may hold several coincident bodies; treat them as one mass but
        // subtract self-attraction if this body is among them.
        let mm = m, mdx = dx, mdy = dy, md2 = d2;
        if (this.overflow && this.overflow.has(node)) {
          const list = this.overflow.get(node);
          if (j === bi || list.includes(bi)) {
            mm = m - b.mass;
            if (mm <= 0) continue;
            const cmx = (this.comX[node] * m - b.mass * bx) / mm;
            const cmy = (this.comY[node] * m - b.mass * by) / mm;
            mdx = cmx - bx; mdy = cmy - by;
            md2 = mdx * mdx + mdy * mdy;
          }
        }
        const r2 = md2 + eps2;
        const inv = 1 / (r2 * Math.sqrt(r2));
        const f = G * mm * inv;
        ax += f * mdx; ay += f * mdy;
        continue;
      }

      const s = this.half[node] * 2;
      if (s * s < theta2 * d2) {
        const r2 = d2 + eps2;
        const inv = 1 / (r2 * Math.sqrt(r2));
        const f = G * m * inv;
        ax += f * dx; ay += f * dy;
      } else {
        for (let q = 0; q < 4; q++) {
          const c = this.child[node * 4 + q];
          if (c !== -1 && this.mass[c] !== 0) {
            if (sp >= stack.length) { out[0] = ax; out[1] = ay; return out; }
            stack[sp++] = c;
          }
        }
      }
    }
    out[0] = ax; out[1] = ay;
    return out;
  }

  /**
   * Every body whose swept path over `dt` could reach within `pad` of body
   * `bi`'s swept path. Used as the collision broad phase: a node is opened only
   * if the query box overlaps it, where the box is inflated by the node's own
   * largest body radius so no large body is missed by a small querent.
   */
  queryNeighbors(bi, out) {
    out.length = 0;
    if (this.root === -1) return out;
    const b = this.bodies[bi];
    // The tree holds post-step positions, so this body's swept segment runs
    // backwards from where it is now to where it started the step.
    const px = b.x0 != null ? b.x0 : b.x;
    const py = b.y0 != null ? b.y0 : b.y;
    const x0 = Math.min(b.x, px), x1 = Math.max(b.x, px);
    const y0 = Math.min(b.y, py), y1 = Math.max(b.y, py);

    const stack = this._qstack || (this._qstack = []);
    stack.length = 0;
    stack.push(this.root);
    while (stack.length) {
      const node = stack.pop();
      if (this.mass[node] === 0) continue;
      // Inflate by this subtree's largest radius and the furthest any body
      // under it moved this step. Our own sweep is already in the query box, so
      // together the two cover the full relative motion.
      const pad = this.maxR[node] + b.radius + this.maxV[node];
      const nx = this.cx[node], ny = this.cy[node], h = this.half[node] + pad;
      if (x1 < nx - h || x0 > nx + h || y1 < ny - h || y0 > ny + h) continue;
      if (this.isLeaf[node]) {
        const j = this.bodyIndex[node];
        if (j !== -1 && j !== bi) out.push(j);
        const extra = this.overflow && this.overflow.get(node);
        if (extra) for (const k of extra) if (k !== bi) out.push(k);
        continue;
      }
      for (let q = 0; q < 4; q++) {
        const c = this.child[node * 4 + q];
        if (c !== -1) stack.push(c);
      }
    }
    return out;
  }
}
