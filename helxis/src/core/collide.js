import { G, C, TAU, clamp, escapeVelocity, schwarzschild } from './const.js';
import { Body, classifyCompact, compactRadius } from './body.js';
import { mixCompositions, compositionProperty, radiusFromMass } from './materials.js';
import { makeRng, gaussian, powerLawSample, hashSeed } from './rng.js';

/** Bodies held up by degeneracy pressure, or by nothing at all. */
const isCompact = (b) => b.kind === 'bh' || b.kind === 'ns' || b.kind === 'wd';

/**
 * The smallest thing worth tracking as a body.
 *
 * Every debris gate used to be a fraction of the pair that produced it, which
 * is scale-free: debris sheds smaller debris, which sheds smaller debris still,
 * with nothing to stop it. A settling cluster of six asteroids could run away
 * into five hundred fragments reaching down to eighty tonnes — objects no
 * larger than a car, individually integrated, each able to start the cycle
 * again. The floor comes from the scene, so it does not shrink as the debris
 * does; anything under it stays with its parent, where its mass is still
 * conserved and still gravitates.
 */
function fragmentFloor(opts, fallback) {
  const floor = opts && opts.minFragmentMass;
  return floor > 0 ? Math.max(floor, fallback) : fallback;
}

// Leinhardt & Stewart (2012) parameters.
const RHO1 = 1000;        // kg/m^3, the reference density their scaling uses
const C_STAR = 5.0;       // dissipation constant; ~5 for hydrodynamic bodies
const MU_BAR = 0.36;      // velocity exponent, gravity regime (rock)
const SUPERCAT = 1.8;     // Q_R/Q*_RD above which the outcome is supercatastrophic
const FRAG_SLOPE = 1.83;  // differential mass distribution slope, ~Dohnanyi 11/6

/**
 * Translate a set of products so their centre of mass sits where it did before.
 *
 * Spawning debris on a ring while leaving the body it came from where it was
 * teleports mass: the ring carries a mass-weighted offset that nothing answers
 * for. It is invisible to a momentum check — momentum stays exact — but it
 * steps the barycentre's *position*, and with it the system's potential energy.
 * A supercatastrophic impact was moving the centre of mass by 1.2 contact radii.
 *
 * The correction is a rigid translation of the whole set, not a nudge to one
 * member. Moving only the survivor fixes the sum, but when the survivor is
 * light next to its own debris the shift is large — and it lands inside the
 * ring it just threw off.
 */
function recenterProducts(products, comX, comY) {
  let m = 0, cx = 0, cy = 0;
  for (const p of products) { m += p.mass; cx += p.mass * p.x; cy += p.mass * p.y; }
  if (!(m > 0)) return;
  const dx = comX - cx / m, dy = comY - cy / m;
  for (const p of products) { p.x += dx; p.y += dy; }
}

/**
 * Lay a swarm of pieces out on a ring without any of them starting inside one
 * another.
 *
 * A power-law swarm is mostly small pieces and a few large ones, so equal
 * angular spacing does not work: each piece gets an arc proportional to its own
 * size, on a ring whose circumference is comfortably larger than the total arc
 * the swarm needs. Pieces born overlapping are shattered again by the very next
 * contact pass, which is how eighteen asteroids once became twelve hundred
 * fragments sitting in seven thousand interpenetrating pairs.
 *
 * Returns the ring radius and the angle for each piece.
 */
function ringLayout(radii, clearance, startAngle = 0, span = TAU) {
  let sum = 0, max = 0;
  for (const r of radii) { sum += r; if (r > max) max = r; }
  if (sum <= 0) return { ringR: clearance, angles: radii.map(() => startAngle) };
  // The pieces occupy 2*sum of arc. Spread over an angle `span`, the ring has
  // to be large enough that span*R covers it — which is why the cone this is
  // used for has to pass its own span rather than take a full circle's layout
  // and squeeze it, as an earlier version did.
  const ringR = Math.max((2 * sum * 1.4) / span, clearance + max);
  const total = sum * 2;
  const angles = [];
  let arc = 0;
  for (let i = 0; i < radii.length; i++) {
    angles.push(startAngle + (((arc + radii[i]) / total) - 0.5) * span);
    arc += radii[i] * 2;
  }
  return { ringR, angles };
}

/**
 * Earliest contact along two straight displacements, as a fraction of the step.
 *
 * The swept test has to run over the interval that was just integrated, not the
 * one coming, so the caller passes the displacement each body actually took and
 * rolls the pair back to the fraction returned.
 */
export function sweptContactDisp(a, b) {
  const dx = b.x0 - a.x0, dy = b.y0 - a.y0;
  const wx = (b.x - b.x0) - (a.x - a.x0);
  const wy = (b.y - b.y0) - (a.y - a.y0);
  const R = a.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  if (d2 <= R * R) return 0;                   // already touching at step start

  const ww = wx * wx + wy * wy;
  if (ww === 0) return null;
  const dw = dx * wx + dy * wy;
  if (dw >= 0) return null;                    // separating over the step
  const disc = dw * dw - ww * (d2 - R * R);
  if (disc < 0) return null;
  const t = (-dw - Math.sqrt(disc)) / ww;
  // Written as a positive test: every comparison against NaN is false, so
  // `t < 0 || t > 1` *accepts* NaN, and a single non-finite coordinate anywhere
  // then propagated into a contact time, into rolled-back positions, and out of
  // the frame loop as an exception that froze the canvas permanently.
  if (!(t >= 0 && t <= 1)) return null;
  return t;
}

/**
 * Classify a contact and produce the resulting bodies.
 *
 * Everything here is built in the centre-of-mass frame and transformed back, so
 * total momentum is conserved by construction rather than by correction.
 */
export function resolveCollision(a, b, opts = {}) {
  // The larger body is the target; LS12's scaling is written that way.
  const target = a.mass >= b.mass ? a : b;
  const proj = a.mass >= b.mass ? b : a;

  const Mt = target.mass, Mp = proj.mass;
  const Mtot = Mt + Mp;
  const reduced = (Mt * Mp) / Mtot;
  const Rsum = target.radius + proj.radius;

  // Contact geometry.
  const dx = proj.x - target.x, dy = proj.y - target.y;
  const dist = Math.hypot(dx, dy) || 1e-9;
  const nx = dx / dist, ny = dy / dist;         // contact normal, target -> proj
  const wx = proj.vx - target.vx, wy = proj.vy - target.vy;
  const vImp = Math.hypot(wx, wy);

  // Impact parameter b = sin(theta), 0 head-on, 1 grazing.
  let bImp = 0;
  if (vImp > 0) {
    const cross = Math.abs(dx * wy - dy * wx) / vImp;
    bImp = clamp(cross / Math.max(dist, 1e-9), 0, 1);
  }

  // Centre of mass state. Both outcomes and heat are computed here.
  const comX = (target.x * Mt + proj.x * Mp) / Mtot;
  const comY = (target.y * Mt + proj.y * Mp) / Mtot;
  const comVx = (target.vx * Mt + proj.vx * Mp) / Mtot;
  const comVy = (target.vy * Mt + proj.vy * Mp) / Mtot;

  const vEsc = Math.sqrt((2 * G * Mtot) / Rsum);
  // Kinetic energy available in the collision, i.e. in the COM frame.
  const kImpact = 0.5 * reduced * vImp * vImp;

  const rng = makeRng(hashSeed(target.id, proj.id, Math.round(vImp), target.craters.length));

  // Degenerate matter does not participate in any of the scalings below. LS12
  // is calibrated on rock and ice; a neutron star has a strength eighteen
  // orders of magnitude higher and a density fourteen. Feeding it through the
  // ordinary path had a neutron star swell from 10 km to 5000 km after eating a
  // planet — because the radius came from harmonically mixing neutronium with
  // silicate — and had two of them bounce off each other at 0.17c, because the
  // bounce test only asked whether they were small and strong.
  if (isCompact(target) || isCompact(proj)) {
    return accreteIntoCompact(target, proj, { comX, comY, comVx, comVy, Mtot, kImpact, vImp });
  }

  // --- Interacting mass -----------------------------------------------------
  // In a grazing impact only part of the projectile ever touches the target.
  // The rest keeps going: that is what makes hit-and-run a distinct outcome
  // rather than a weak merge.
  const overlap = Rsum * (1 - bImp);
  let alpha = 1;
  if (overlap < 2 * proj.radius) {
    const l = clamp(overlap, 0, 2 * proj.radius);
    alpha = clamp((l * l * (3 * proj.radius - l)) / (4 * Math.pow(proj.radius, 3)), 0.001, 1);
  }
  const Minteract = alpha * Mp;

  // --- Disruption threshold -------------------------------------------------
  // Q*_RD in the gravity regime, for the equal-mass head-on case, then
  // corrected for mass ratio and for the reduced interacting mass.
  const Rc1 = Math.cbrt((3 * Mtot) / (4 * Math.PI * RHO1));
  const qStarEqual = C_STAR * (4 / 5) * Math.PI * RHO1 * G * Rc1 * Rc1;

  // Mass-ratio correction (LS12 eq. 23): unequal impactors are less efficient.
  const gamma = Mp / Mt;
  const massRatioFactor = Math.pow(Math.pow(1 + gamma, 2) / (4 * gamma), 2 / (3 * MU_BAR) - 1);
  // Reduced interacting mass raises the threshold the same way.
  const reducedInteract = (Mt * Minteract) / (Mt + Minteract);
  const alphaFactor = Math.pow(reduced / Math.max(reducedInteract, 1e-30), 2 - 3 * MU_BAR / 2);
  const qStar = qStarEqual * massRatioFactor * alphaFactor;

  // Strength matters below roughly a kilometre; take whichever binding is
  // larger so small rubble does not shatter at walking pace.
  const strengthQ = compositionProperty(target.composition, 'strength') / Math.max(target.density, 1);
  const qStarEff = Math.max(qStar, strengthQ);

  const qR = kImpact / Mtot;
  const ratio = qR / Math.max(qStarEff, 1e-30);

  // --- Regime selection -----------------------------------------------------
  const bCrit = target.radius / Rsum;
  const grazing = bImp > bCrit;

  // Between plain merging and true hit-and-run there is a band where the
  // impactor loses enough energy on the pass to stay bound, and merges on a
  // later one — Genda et al. (2012).
  //
  // Rather than fit a curve to that band, ask the question directly. Only the
  // parts that actually touch are brought to rest against each other, so the
  // energy dissipated is roughly the interacting pair's kinetic energy in the
  // centre-of-mass frame. The pair stays bound when that exceeds the surplus
  // over escape:
  //
  //     ½·mu_i·v²  >  ½·mu·(v² − v_esc²)      =>      v < v_esc·sqrt(mu/(mu − mu_i))
  //
  // which behaves correctly at both ends: a head-on hit has mu_i -> mu and
  // always merges, and a tangent brush has mu_i -> 0 and separates the moment
  // it beats escape velocity. An earlier fitted version put the boundary at
  // 1.05 v_esc for anything grazing, which made two rubble piles falling
  // together at 1.1 v_esc a hit-and-run that shed debris — and in a settling
  // cluster that ran away, six asteroids becoming five hundred fragments.
  const muInteract = (Mt * Minteract) / (Mt + Minteract);
  const vGrazeMerge = muInteract >= reduced
    ? vEsc * 8
    : Math.min(vEsc * 8, vEsc * Math.sqrt(reduced / (reduced - muInteract)));

  let regime;
  if (vImp < vEsc * 1.02) {
    regime = 'merge';
  } else if (grazing) {
    // A grazing impact well below threshold is the same physical event as a
    // head-on one well below threshold — the target survives and absorbs the
    // projectile. Calling one "merge" and the other "cratering" made the
    // outcome map non-monotonic in impact parameter across that boundary.
    if (vImp < vGrazeMerge && ratio < 1) {
      regime = (ratio < 0.1 && Mp < 0.1 * Mt) ? 'cratering' : 'merge';
    }
    else if (ratio < 1 && Minteract < 0.5 * Mp) regime = 'hitrun';
    else if (ratio < SUPERCAT) regime = 'disruption';
    else regime = 'supercatastrophic';
  } else if (ratio < 0.1) {
    regime = 'cratering';
  } else if (ratio < 1) {
    regime = 'erosion';
  } else if (ratio < SUPERCAT) {
    regime = 'disruption';
  } else {
    regime = 'supercatastrophic';
  }

  // A strength-dominated pair below its own escape velocity may simply bounce.
  if (
    regime === 'merge' && opts.allowBounce !== false &&
    vImp > 0.2 * vEsc && Math.min(target.radius, proj.radius) < 5e5 &&
    compositionProperty(target.composition, 'strength') > 1e6
  ) {
    regime = 'bounce';
  }

  switch (regime) {
    case 'bounce': return doBounce(target, proj, nx, ny, vImp, kImpact, opts);
    case 'merge': return doMerge(target, proj, { comX, comY, comVx, comVy, kImpact, vImp, nx, ny, bImp, bCrit, vEsc, rng, opts });
    case 'hitrun': return doHitAndRun(target, proj, { nx, ny, vImp, alpha, kImpact, bImp, rng, opts });
    case 'cratering': return doCratering(target, proj, { nx, ny, vImp, kImpact, Minteract, bImp, rng, opts });
    default: return doDisruption(target, proj, {
      regime, ratio, qStarEff, comX, comY, comVx, comVy, Mtot, vEsc, kImpact,
      vImp, nx, ny, bImp, rng, opts,
    });
  }
}

// ---------------------------------------------------------------------------

function doBounce(target, proj, nx, ny, vImp, kImpact, opts) {
  // Coefficient of restitution falls with impact speed: real regolith absorbs
  // more of a fast hit than a slow one.
  const e = clamp(0.6 * Math.pow(Math.max(vImp, 1) / 10, -0.25), 0.02, 0.85);
  const Mt = target.mass, Mp = proj.mass;
  const wx = proj.vx - target.vx, wy = proj.vy - target.vy;
  const vn = wx * nx + wy * ny;
  if (vn >= 0) return { events: [] };

  const j = (-(1 + e) * vn) / (1 / Mt + 1 / Mp);
  target.vx -= (j * nx) / Mt; target.vy -= (j * ny) / Mt;
  proj.vx += (j * nx) / Mp; proj.vy += (j * ny) / Mp;

  // Tangential friction converts grazing motion into spin.
  const tx = -ny, ty = nx;
  const vt = wx * tx + wy * ty;
  const spinTransfer = clamp(vt / Math.max(target.radius + proj.radius, 1), -1e-2, 1e-2);
  target.spin += spinTransfer * (Mp / (Mt + Mp)) * 0.4;
  proj.spin -= spinTransfer * (Mt / (Mt + Mp)) * 0.4;

  // The energy the restitution did not return became heat, split by mass.
  const lost = kImpact * (1 - e * e);
  target.addHeat((lost * Mp) / (Mt + Mp));
  proj.addHeat((lost * Mt) / (Mt + Mp));

  // Separate them so the next step does not re-detect the same contact.
  const R = target.radius + proj.radius;
  const dx = proj.x - target.x, dy = proj.y - target.y;
  const d = Math.hypot(dx, dy) || 1e-9;
  const push = (R - d) + R * 1e-6;
  if (push > 0) {
    const ux = dx / d, uy = dy / d;
    target.x -= ux * push * (Mp / (Mt + Mp));
    target.y -= uy * push * (Mp / (Mt + Mp));
    proj.x += ux * push * (Mt / (Mt + Mp));
    proj.y += uy * push * (Mt / (Mt + Mp));
  }

  return {
    regime: 'bounce', removed: [], added: [],
    events: [{ type: 'bounce', x: proj.x, y: proj.y, energy: lost, vImp, scale: Math.min(target.radius, proj.radius) }],
  };
}

function doMerge(target, proj, ctx) {
  const { comX, comY, comVx, comVy, kImpact, vImp, nx, ny, bImp, rng } = ctx;
  const Mt = target.mass, Mp = proj.mass;
  const Mtot = Mt + Mp;

  const merged = new Body({
    name: Mp > 0.4 * Mt ? `${target.name}-${proj.name}` : target.name,
    kind: mergedKind(target, proj),
    catalogId: Mp > 0.4 * Mt ? null : target.catalogId,
    x: comX, y: comY, vx: comVx, vy: comVy,
    mass: Mtot,
    composition: mixCompositions(target.composition, Mt, proj.composition, Mp),
    // Crusts mix too, in the same proportion the bulk does.
    crust: (target.crust || proj.crust)
      ? mixCompositions(target.surfaceComposition, Mt, proj.surfaceComposition, Mp)
      : null,
    temperature: (target.temperature * Mt + proj.temperature * Mp) / Mtot,
    differentiation: (target.differentiation * Mt + proj.differentiation * Mp) / Mtot,
    seed: target.seed,
    craters: target.craters,
    // Carry the history forward. Leaving `mixes` out of the options meant the
    // constructor started the merged body with an empty list, so every merge
    // erased every earlier one and a body could only ever remember the last
    // thing that hit it — which is precisely the claim the textures rest on.
    mixes: target.mixes.concat(proj.mixes),
    rotation: target.rotation,
    spin: target.spin,
    luminosity: target.luminosity + proj.luminosity,
  });

  // Angular momentum of the impact goes into spin. The lever arm is the impact
  // parameter times the contact radius; the moment of inertia is that of a
  // uniform sphere, 2/5 M R^2.
  const R = merged.radius;
  const lever = bImp * (target.radius + proj.radius);
  const Lspin = ((Mt * Mp) / Mtot) * vImp * lever;
  const I = 0.4 * Mtot * R * R;
  const sense = Math.sign((proj.x - target.x) * (proj.vy - target.vy) - (proj.y - target.y) * (proj.vx - target.vx)) || 1;
  merged.spin += I > 0 ? sense * (Lspin / I) : 0;
  // Keep the spin below break-up; anything faster would have shed a disc.
  const spinMax = Math.sqrt((G * Mtot) / (R * R * R));
  merged.spin = clamp(merged.spin, -spinMax, spinMax);

  // All of the COM-frame kinetic energy is dissipated in a merge.
  merged.addHeat(kImpact);

  // --- circumplanetary disc ------------------------------------------------
  // A grazing merge at around the escape velocity does not simply swallow the
  // impactor: it flings a sheet of mantle into orbit. That sheet is where the
  // Moon came from, and because it is drawn from the two *mantles* rather than
  // from whole bodies, it is depleted in iron — exactly the lunar composition
  // problem that the giant-impact hypothesis was invented to solve.
  const discBodies = [];
  const { bCrit = 0.5, vEsc = 0 } = ctx;
  if (vEsc > 0 && bImp > bCrit * 0.5 && vImp > vEsc * 0.75 && Mp > 0.02 * Mt) {
    const discFrac = clamp(0.16 * bImp * bImp * (vImp / vEsc) * (Mp / Mtot) * 2.2, 0, 0.055);
    const discMass = discFrac * Mtot;
    if (discMass > 1e17) {
      // Mantle material: mostly the impactor's, since it is the one that was
      // sheared apart.
      const discComp = mixCompositions(proj.surfaceComposition, 0.72, target.surfaceComposition, 0.28);
      // A circumplanetary disc is a sheet of molten rock, not a handful of
      // rocks. Splitting it into a dozen tracked bodies costs a dozen bodies
      // per grazing merge — which in an accreting disc of planetesimals meant
      // the body count rose while the bodies were merging — and buys nothing,
      // since they re-accrete into one or two clumps within a few orbits
      // anyway. Start from the clumps.
      const n = 1 + Math.floor(rng() * 3);
      const R = merged.radius;
      // Just outside the Roche limit, where the sheet can re-accrete.
      const r = R * (2.2 + rng() * 2.0);
      const masses = [];
      let left = discMass;
      for (let i = 0; i < n; i++) {
        const m = i === n - 1 ? left : left * (0.25 + rng() * 0.4);
        left -= m;
        masses.push(m);
      }
      const discLayout = ringLayout(
        masses.map((m) => radiusFromMass(m, discComp)), R * 1.2, rng() * TAU
      );
      for (let i = 0; i < n; i++) {
        const m = masses[i];
        if (m <= 0) continue;
        const th = discLayout.angles[i];
        // Prograde with the impact, so the moon orbits the way the blow came.
        const vOrb = Math.sqrt((G * Mtot) / r) * sense;
        discBodies.push(new Body({
          name: 'Impact debris', kind: 'debris',
          x: comX + Math.cos(th) * r,
          y: comY + Math.sin(th) * r,
          vx: comVx - Math.sin(th) * vOrb,
          vy: comVy + Math.cos(th) * vOrb,
          mass: m,
          composition: discComp,
          temperature: Math.max(2000, merged.temperature),
          seed: hashSeed(target.seed, proj.seed, i, 'disc'),
          spin: (rng() - 0.5) * 1e-4,
        }));
      }
      // Take the disc's mass out of the merged body, and rebalance both
      // momentum *and* position. Spawning bodies on a ring while leaving the
      // remnant at the centre of mass teleports mass: the ring carries a
      // mass-weighted offset that has to be answered by moving the remnant the
      // other way, or the pair's centre of mass jumps by a few planetary radii.
      let dm = 0, dpx = 0, dpy = 0, dx = 0, dy = 0;
      for (const d of discBodies) {
        dm += d.mass;
        dpx += d.mass * d.vx; dpy += d.mass * d.vy;
        dx += d.mass * (d.x - comX); dy += d.mass * (d.y - comY);
      }
      const newM = Mtot - dm;
      if (newM > 0) {
        merged.vx = (Mtot * comVx - dpx) / newM;
        merged.vy = (Mtot * comVy - dpy) / newM;
        merged.mass = newM;
        merged.refresh();
        recenterProducts([merged].concat(discBodies), comX, comY);

        // And audit the energy, as the disruption branch does. The disc bodies
        // were handed Keplerian velocities outright; between that and the work
        // done lifting them clear of the remnant, the products can carry more
        // than the impact brought in. Scale the spread about the centre of mass
        // until they do not — which leaves momentum untouched, since scaling
        // velocities about the centre of mass is exactly the operation that
        // holds the total at zero in that frame.
        const all = [merged, ...discBodies];
        let keCom = 0, dPE = 0;
        for (const f of all) {
          const rx = f.vx - comVx, ry = f.vy - comVy;
          keCom += 0.5 * f.mass * (rx * rx + ry * ry);
        }
        for (const d of discBodies) {
          const r = Math.max(Math.hypot(d.x - merged.x, d.y - merged.y), merged.radius);
          dPE += (G * merged.mass * d.mass) * (1 / merged.radius - 1 / r);
        }
        const budget = kImpact;
        if (keCom + dPE > budget && keCom > 0) {
          const k = Math.sqrt(Math.max(0, budget - dPE) / keCom);
          for (const f of all) {
            f.vx = comVx + (f.vx - comVx) * k;
            f.vy = comVy + (f.vy - comVy) * k;
          }
        }
      } else {
        discBodies.length = 0;
      }
    }
  }

  // Record how the two surfaces mixed, along the impact axis. The texture
  // generator reads this to draw the actual boundary between the parents.
  merged.mixes.push({
    seedA: target.seed,
    seedB: proj.seed,
    fracB: Mp / Mtot,
    angle: Math.atan2(ny, nx) - merged.rotation,
    // A fast impact stirs the two together; a slow one leaves a visible seam.
    // Measured against the escape velocity *at contact*, which is the speed
    // that decides the regime. Normalising against the merged body's surface
    // escape velocity instead — six times it, at that — put every possible
    // merge above 0.83, so the marbling this exists to produce could never
    // happen from a merge at all.
    sharpness: clamp(1.05 - vImp / Math.max(vEsc, 1), 0.05, 1),
    compB: proj.surfaceComposition,
  });
  if (merged.mixes.length > 6) merged.mixes.shift();
  merged.refresh();

  return {
    regime: discBodies.length ? 'graze-and-merge' : 'merge',
    removed: [target, proj],
    added: [merged, ...discBodies],
    events: [{
      type: 'merge', x: comX, y: comY, energy: kImpact, vImp,
      scale: merged.radius, body: merged,
    }],
  };
}

function doCratering(target, proj, ctx) {
  const { nx, ny, vImp, kImpact, rng, opts } = ctx;
  // The projectile is absorbed; the target keeps its identity and gains a scar.
  const Mt = target.mass, Mp = proj.mass;
  const Mtot = Mt + Mp;

  // Ejecta: the part of the excavated mass that actually gets away.
  //
  // Escaping mass goes to zero as the impact speed falls to the target's own
  // escape velocity — at that point the ejecta is on a ballistic arc that lands
  // again — and climbs steeply above it. An earlier version returned a floor of
  // about one percent even at exactly v_esc, which in a disc of planetesimals
  // meant every routine cratering impact minted a dozen new bodies: a run that
  // should have merged 160 objects into a handful instead turned them into
  // seventeen hundred.
  const vEscT = escapeVelocity(Mt, target.radius);
  const speedRatio = vImp / Math.max(vEscT, 1);
  const ejectaFrac = clamp(0.05 * (speedRatio * speedRatio - 1), 0, 0.3);
  let ejectaMass = ejectaFrac * Mp;
  // Anything below this is dust: unresolvable as a body, and it re-accretes.
  // Leave it on the target rather than tracking or deleting it.
  if (ejectaMass <= fragmentFloor(opts, 1e-5 * Mt) * 2) ejectaMass = 0;

  // Momentum first: the survivor takes everything the ejecta does not.
  const pX = Mt * target.vx + Mp * proj.vx;
  const pY = Mt * target.vy + Mp * proj.vy;

  const fragments = [];
  if (ejectaMass > 0) {
    const n = clamp(Math.round(2 + rng() * 4), 1, 6);
    const each = ejectaMass / n;
    const radii = [];
    for (let i = 0; i < n; i++) radii.push(radiusFromMass(each, target.surfaceComposition));
    // Ejecta leaves along a cone about the impact normal, laid out around the
    // impact point so the pieces do not start inside one another.
    const normalAng = Math.atan2(-ny, -nx);
    const layout = ringLayout(radii, target.radius * 0.08, normalAng, 1.6);
    for (let i = 0; i < n; i++) {
      const ang = layout.angles[i];
      const speed = vEscT * (1.05 + rng() * 0.9);
      const f = new Body({
        name: 'Ejecta', kind: 'debris',
        x: target.x + nx * (target.radius + layout.ringR) + Math.cos(ang) * layout.ringR,
        y: target.y + ny * (target.radius + layout.ringR) + Math.sin(ang) * layout.ringR,
        vx: target.vx + Math.cos(ang) * speed,
        vy: target.vy + Math.sin(ang) * speed,
        mass: each,
        composition: target.surfaceComposition,
        temperature: target.temperature + 400,
        seed: hashSeed(target.seed, i, 'ejecta'),
      });
      fragments.push(f);
    }
  }

  let sumPx = 0, sumPy = 0, sumM = 0;
  for (const f of fragments) { sumPx += f.mass * f.vx; sumPy += f.mass * f.vy; sumM += f.mass; }

  // Take the survivor's mass from what the fragments actually carried away, not
  // from the requested ejecta budget: rounding in the split must not leak mass.
  const survivorMass = Mtot - sumM;
  const comX = (target.x * Mt + proj.x * Mp) / Mtot;
  const comY = (target.y * Mt + proj.y * Mp) / Mtot;
  target.mass = survivorMass;
  recenterProducts([target].concat(fragments), comX, comY);
  target.composition = mixCompositions(target.composition, Mt, proj.composition, Math.max(0, Mp - sumM));
  target.vx = (pX - sumPx) / survivorMass;
  target.vy = (pY - sumPy) / survivorMass;
  target.addHeat(kImpact * 0.6);
  target.addCrater(nx, ny, proj.mass, proj.radius, vImp, rng);
  target.spin += clamp(
    (ctx.bImp || 0) * vImp * (Mp / Mtot) / Math.max(target.radius, 1) * 0.5, -1e-3, 1e-3
  );
  target.refresh();

  return {
    regime: 'cratering', removed: [proj], added: fragments,
    events: [{
      type: 'impact',
      x: target.x + nx * target.radius, y: target.y + ny * target.radius,
      energy: kImpact, vImp, scale: proj.radius * 4, nx, ny,
    }],
  };
}

function doHitAndRun(target, proj, ctx) {
  const { nx, ny, vImp, alpha, kImpact, rng, opts } = ctx;
  const Mt = target.mass, Mp = proj.mass;

  // Only the interacting cap is stripped from the projectile; the rest of it
  // carries on, decelerated by the momentum it gave up.
  const stripped = alpha * Mp * clamp(0.35 + rng() * 0.4, 0.1, 0.9);
  const survivorMp = Mp - stripped;

  const pX = Mt * target.vx + Mp * proj.vx;
  const pY = Mt * target.vy + Mp * proj.vy;

  // Half the stripped mass is captured by the target, half becomes debris.
  const captured = stripped * 0.5;
  const debrisMass = stripped - captured;

  // Anything not spun off as tracked debris stays with the target, so the
  // dust threshold above changes what is *resolved*, never what is conserved.
  target.composition = mixCompositions(target.composition, Mt, proj.surfaceComposition, captured);
  target.mass = Mt + captured;
  target.addHeat(kImpact * 0.35);
  target.addCrater(nx, ny, proj.mass * alpha, proj.radius, vImp, rng);
  target.refresh();

  const fragments = [];
  const relDir = Math.atan2(proj.vy - target.vy, proj.vx - target.vx);
  // As with cratering ejecta, debris below this is dust rather than bodies.
  if (debrisMass > fragmentFloor(opts, 1e-4 * Mt) * 2) {
    const n = clamp(Math.round(4 + rng() * 8), 1, 16);
    const each = debrisMass / n;
    const vEsc = Math.sqrt((2 * G * (Mt + Mp)) / (target.radius + proj.radius));
    const radii = [];
    for (let i = 0; i < n; i++) radii.push(radiusFromMass(each, proj.surfaceComposition));
    const layout = ringLayout(radii, proj.radius * 1.1, relDir, 1.2);
    for (let i = 0; i < n; i++) {
      const ang = layout.angles[i];
      const speed = vEsc * (0.9 + rng() * 1.2);
      fragments.push(new Body({
        name: 'Debris', kind: 'debris',
        x: proj.x + Math.cos(ang) * layout.ringR,
        y: proj.y + Math.sin(ang) * layout.ringR,
        vx: (target.vx + proj.vx) / 2 + Math.cos(ang) * speed,
        vy: (target.vy + proj.vy) / 2 + Math.sin(ang) * speed,
        mass: each,
        composition: proj.surfaceComposition,
        temperature: Math.max(proj.temperature, 900),
        seed: hashSeed(proj.seed, i, 'hnr'),
      }));
    }
  }

  // `stripped` is at most 0.9·Mp by construction, so the projectile always
  // survives a hit-and-run — but assert it rather than leaving a branch that
  // would silently delete its mass if the constants above ever changed.
  if (!(survivorMp > 0)) {
    throw new Error(`hit-and-run stripped the whole projectile: ${survivorMp} of ${Mp}`);
  }
  const removed = [];
  const added = fragments.slice();
  proj.mass = survivorMp;
  proj.addHeat(kImpact * 0.25);
  proj.refresh();

  // Close the momentum books on the target, which is the only body whose
  // velocity is still free.
  let sumM = proj.mass, sumPx = proj.mass * proj.vx, sumPy = proj.mass * proj.vy;
  for (const f of added) { sumM += f.mass; sumPx += f.mass * f.vx; sumPy += f.mass * f.vy; }
  target.mass = Mt + Mp - sumM;
  target.vx = (pX - sumPx) / target.mass;
  target.vy = (pY - sumPy) / target.mass;

  // The debris was spawned on a ring around the projectile; move the target to
  // answer for it, so the trio's centre of mass does not jump.
  if (added.length) {
    const comX = (target.x * Mt + proj.x * Mp) / (Mt + Mp);
    const comY = (target.y * Mt + proj.y * Mp) / (Mt + Mp);
    recenterProducts([target, proj].concat(added), comX, comY);
  }

  // Push them apart so the pair is not re-detected while still overlapping.
  separate(target, proj);

  return {
    regime: 'hitrun', removed, added,
    events: [{
      type: 'impact', x: proj.x, y: proj.y, energy: kImpact * 0.5, vImp,
      scale: proj.radius * 3, nx, ny,
    }],
  };
}

function doDisruption(target, proj, ctx) {
  const {
    regime, ratio, comX, comY, comVx, comVy, Mtot, vEsc, kImpact, vImp, nx, ny, rng,
  } = ctx;

  // Largest-remnant mass from the LS12 universal law, then the
  // supercatastrophic power law once the impact is well past threshold.
  let lrFrac;
  if (ratio < SUPERCAT) {
    lrFrac = clamp(-0.5 * (ratio - 1) + 0.5, 0.02, 1);
  } else {
    lrFrac = clamp(0.1 * Math.pow(ratio / SUPERCAT, -1.5), 0.001, 0.2);
  }

  const lrMass = lrFrac * Mtot;
  let remainder = Mtot - lrMass;

  const comp = mixCompositions(target.composition, target.mass, proj.composition, proj.mass);
  // A disruptive impact strips the light outer layers first, so the largest
  // remnant is enriched in whatever was deepest.
  const remnantComp = lrFrac < 0.4
    ? mixCompositions(target.coreComposition, 0.7, comp, 0.3)
    : comp;

  const added = [];
  const largest = new Body({
    name: lrFrac > 0.5 ? target.name : `${target.name} remnant`,
    kind: lrFrac > 0.35 ? mergedKind(target, proj) : 'asteroid',
    x: comX, y: comY, vx: comVx, vy: comVy,
    mass: lrMass,
    composition: remnantComp,
    temperature: (target.temperature * target.mass + proj.temperature * proj.mass) / Mtot,
    differentiation: Math.max(target.differentiation, proj.differentiation),
    seed: hashSeed(target.seed, proj.seed, 'lr'),
    mixes: target.mixes.concat(proj.mixes),
  });
  largest.mixes.push({
    seedA: target.seed, seedB: proj.seed,
    fracB: proj.mass / Mtot,
    // In the body's own frame, as `addCrater` and the merge path both store it.
    // Left in the world frame, the seam was drawn at a bearing unrelated to
    // where the impact came from, while the craters beside it were correct.
    angle: Math.atan2(ny, nx) - largest.rotation,
    sharpness: 0.1,
    compB: proj.surfaceComposition,
  });
  // Disruption deposits energy in proportion to how much of the body survived.
  largest.addHeat(kImpact * 0.45 * lrFrac);
  largest.refresh();
  added.push(largest);

  // Fragments: a power-law mass distribution capped at half the largest
  // remnant, which is what the second-remnant relation gives near threshold.
  const maxFrag = Math.min(remainder, lrMass * 0.5);
  const minFrag = Math.max(remainder * 1e-4, Mtot * 1e-6, fragmentFloor(ctx.opts, 0));
  const fragments = [];
  let guard = 0;
  const cap = ctx.opts && ctx.opts.maxFragments ? ctx.opts.maxFragments : 48;
  while (remainder > minFrag && fragments.length < cap && guard++ < 5000) {
    let m = powerLawSample(rng, minFrag, Math.max(minFrag * 1.001, maxFrag), FRAG_SLOPE);
    if (m > remainder) m = remainder;
    fragments.push(m);
    remainder -= m;
  }
  // Whatever is left over joins the last fragment rather than vanishing.
  if (remainder > 0) {
    if (fragments.length) fragments[fragments.length - 1] += remainder;
    else largest.mass += remainder;
    remainder = 0;
  }

  // Energy left after binding is spent goes into dispersing the fragments.
  const bindingSpent = Math.min(kImpact, target.bindingEnergy + proj.bindingEnergy);
  const dispersal = Math.max(0, kImpact - bindingSpent) * 0.5;
  const fragTotal = fragments.reduce((s, m) => s + m, 0);
  // Characteristic dispersal speed from equipartition of the surplus energy.
  // It is floored at escape velocity so a disrupted body actually comes apart,
  // but the floor is itself capped by the impact speed: a collision cannot
  // throw its own debris faster than it arrived, and an unconditional escape
  // floor was quietly minting GM²/R of kinetic energy out of nothing.
  const vChar = fragTotal > 0
    ? Math.min(Math.max(Math.min(vEsc * 1.05, vImp), Math.sqrt((2 * dispersal) / fragTotal)), vImp)
    : Math.min(vEsc, vImp);

  // Fragments are laid out on a ring, so the ring has to be big enough to hold
  // them. Forty-eight pieces placed at the remnant's own radius overlap their
  // neighbours the moment they are created, and the contact pass then shatters
  // them again — eighteen asteroids became twelve hundred fragments sitting in
  // seven thousand interpenetrating pairs. Size the ring from the pieces.
  // A power-law swarm is mostly small pieces and a few large ones, so equal
  // angular spacing does not work: give each piece an arc proportional to its
  // own size, on a ring sized to hold the lot.
  const fragRadii = fragments.map((m) => radiusFromMass(m, comp));
  const layout = ringLayout(fragRadii, largest.radius * 1.2, rng() * TAU);

  const bodies = [];
  for (let i = 0; i < fragments.length; i++) {
    const m = fragments[i];
    const ang = layout.angles[i];
    // Fragments are launched preferentially along the impact axis, which is
    // where the shock actually goes.
    const bias = 0.45;
    const impactAng = Math.atan2(ny, nx);
    const dir = ang * (1 - bias) + (impactAng + (rng() < 0.5 ? 0 : Math.PI) + gaussian(rng) * 0.5) * bias;
    const speed = Math.abs(vChar * (0.5 + Math.abs(gaussian(rng)) * 0.6));
    const rad = fragRadii[i];
    const launchR = layout.ringR;
    bodies.push(new Body({
      name: 'Fragment', kind: 'debris',
      x: comX + Math.cos(ang) * launchR,
      y: comY + Math.sin(ang) * launchR,
      vx: comVx + Math.cos(dir) * speed,
      vy: comVy + Math.sin(dir) * speed,
      mass: m,
      composition: rng() < 0.3 ? mixCompositions(comp, 0.5, target.coreComposition, 0.5) : comp,
      temperature: Math.max(600, (target.temperature + proj.temperature) / 2 + 800 * (kImpact / Math.max(1, Mtot * 1e5))),
      seed: hashSeed(target.seed, i, 'frag'),
      spin: (rng() - 0.5) * 1e-3,
    }));
  }

  recenterProducts(largest.mass > 0 ? [largest].concat(bodies) : bodies, comX, comY);

  // Close the books on mass first, so the products sum to exactly what went in.
  let sumM = 0;
  for (const f of bodies) sumM += f.mass;
  largest.mass = Mtot - sumM;
  if (largest.mass <= 0) {
    // Nothing survived as a remnant: rescale the fragments to carry it all.
    const k = Mtot / sumM;
    for (const f of bodies) { f.mass *= k; f.refresh(); }
    largest.mass = 0;
  } else {
    largest.refresh();
  }

  // Then momentum. The fragments were given free velocities, so the totals do
  // not match; the fix is a single boost applied to every product alike, not a
  // correction dumped on one of them. Dumping it on the largest remnant is what
  // an earlier version did, and when a supercatastrophic impact leaves a
  // remnant of a thousandth of the mass, that residual divided by that mass is
  // a body moving at several times the speed of light.
  const pX = target.mass * target.vx + proj.mass * proj.vx;
  const pY = target.mass * target.vy + proj.mass * proj.vy;
  const products = (largest.mass > 0 ? [largest] : []).concat(bodies);
  let sumPx = 0, sumPy = 0, totalM = 0;
  for (const f of products) { sumPx += f.mass * f.vx; sumPy += f.mass * f.vy; totalM += f.mass; }
  if (totalM > 0) {
    const dvx = (pX - sumPx) / totalM;
    const dvy = (pY - sumPy) / totalM;
    for (const f of products) { f.vx += dvx; f.vy += dvy; }
  }

  // Audit the books. The centre-of-mass kinetic energy of the products cannot
  // exceed what the impact brought in; if the sampling overshot, scale the
  // spread about the centre of mass until it does not. Momentum is untouched by
  // this, because scaling velocities about the centre of mass is exactly the
  // operation that leaves the total at zero in that frame.
  let keCom = 0;
  for (const f of products) {
    const rx = f.vx - comVx, ry = f.vy - comVy;
    keCom += 0.5 * f.mass * (rx * rx + ry * ry);
  }
  // Pulling the pieces apart costs potential energy too, and that comes out of
  // the same budget. Charging only for the kinetic part let a disruption net
  // out ahead.
  const separationWork = Math.max(0, target.bindingEnergy + proj.bindingEnergy - bindingSpent);
  if (keCom + separationWork > kImpact && keCom > 0) {
    const k = Math.sqrt(Math.max(0, kImpact - separationWork) / keCom);
    for (const f of products) {
      f.vx = comVx + (f.vx - comVx) * k;
      f.vy = comVy + (f.vy - comVy) * k;
    }
  }

  const out = {
    regime, removed: [target, proj],
    added: products,
    events: [{
      type: regime === 'supercatastrophic' ? 'shatter' : 'disrupt',
      x: comX, y: comY, energy: kImpact, vImp,
      scale: Math.max(target.radius, proj.radius) * 3,
    }],
  };
  return out;
}

/**
 * Anything striking a degenerate object.
 *
 * Mass and momentum go in; the remnant is re-derived from the real limits
 * rather than from a composition mix. Below the Chandrasekhar mass electron
 * degeneracy holds, below the TOV limit neutron degeneracy does, and above that
 * nothing does — so a neutron-star merger that crosses 2.9 M☉ collapses to a
 * black hole instead of remaining a very heavy neutron star.
 *
 * The infalling rest mass is partly radiated: about 5.7% for a Schwarzschild
 * horizon, more for a hard surface to land on. That energy really does leave
 * the system, so it is deducted from the remnant's mass rather than only being
 * reported.
 */
function accreteIntoCompact(target, proj, ctx) {
  const { vImp, comX, comY } = ctx;
  // Whichever is denser is the one doing the eating.
  const host = isCompact(target) && (!isCompact(proj) || target.mass >= proj.mass) ? target : proj;
  const other = host === target ? proj : target;

  // Radiative efficiency: the fraction of infalling rest mass that leaves as
  // energy rather than joining the remnant. ~5.7% for matter spiralling to a
  // Schwarzschild horizon, and well under 1% for a neutron-star merger — the
  // 20% an earlier version used is a *surface accretion* figure, and applying
  // it to a merger took away so much mass that a 1.5 + 1.6 M☉ pair landed at
  // 2.80 M☉ and stayed a neutron star, so the TOV collapse this branch exists
  // to show could never happen.
  const merger = isCompact(other);
  const eff = host.kind === 'bh' ? 0.057 : (merger ? 0.005 : 0.002);
  const radiated = other.mass * C * C * eff;
  const massLost = Math.min(other.mass * eff, other.mass * 0.5);

  const pX = host.mass * host.vx + other.mass * other.vx;
  const pY = host.mass * host.vy + other.mass * other.vy;
  const Mtot = host.mass + other.mass - massLost;

  // The radiation is isotropic in the centre-of-mass frame, so it carries away
  // mass but no net momentum: the remnant keeps the pair's centre-of-mass
  // velocity, and the books balance against (mass + radiated), not against the
  // remnant's mass alone.
  host.mass = Mtot;
  host.vx = pX / (Mtot + massLost);
  host.vy = pY / (Mtot + massLost);

  // Re-derive what it now is from its mass alone.
  const wasKind = host.kind;
  const kind = host.kind === 'bh' ? 'bh' : classifyCompact(Mtot);
  host.kind = kind;
  host.composition = kind === 'bh' ? { degenerate: 1 }
    : kind === 'ns' ? { neutronium: 1 }
      : { carbon: 0.5, degenerate: 0.5 };
  host.crust = null;
  host.explicitRadius = kind !== 'bh';
  host.radius = kind === 'bh' ? schwarzschild(Mtot) : compactRadius(kind, Mtot);
  if (kind !== wasKind) {
    host.name = kind === 'bh' ? 'Black hole' : kind === 'ns' ? 'Neutron star' : 'White dwarf';
  }
  host.differentiation = 1;
  host.luminosity = 0;
  host.craters.length = 0;
  host.mixes.length = 0;
  host.revision++;
  host.refresh();

  // The remnant has to stand where the pair's centre of mass was. Leaving it
  // where the host happened to be moved the barycentre by up to a contact
  // radius — five million kilometres for a blue giant swallowing a white dwarf
  // — which steps the system's potential energy for free. Every other branch
  // does this; this one was missed.
  recenterProducts([host], comX, comY);

  return {
    regime: kind === 'bh' ? 'accretion' : 'compact-merger',
    removed: [other], added: [],
    events: [{
      type: 'accretion', x: other.x, y: other.y, energy: radiated,
      vImp: vImp || 0,
      scale: Math.max(host.radius * 40, other.radius * 3),
    }],
  };
}

function separate(a, b) {
  const R = a.radius + b.radius;
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1e-9;
  const push = R - d;
  if (push <= 0) return;
  const ux = dx / d, uy = dy / d;
  const total = a.mass + b.mass;
  a.x -= ux * push * (b.mass / total) * 1.02;
  a.y -= uy * push * (b.mass / total) * 1.02;
  b.x += ux * push * (a.mass / total) * 1.02;
  b.y += uy * push * (a.mass / total) * 1.02;
}

function mergedKind(a, b) {
  const rank = { debris: 0, asteroid: 1, comet: 1, moon: 2, planet: 3, gasgiant: 4, wd: 5, ns: 6, star: 7, bh: 8 };
  const ka = rank[a.kind] ?? 3, kb = rank[b.kind] ?? 3;
  return ka >= kb ? a.kind : b.kind;
}

/**
 * Tidal disruption. Inside the Roche limit a body held together only by its own
 * gravity is pulled apart into a stream of fragments along its orbit — how ring
 * systems form, and what happened to Shoemaker-Levy 9.
 */
export function tidallyDisrupt(body, primary, opts = {}) {
  const rng = makeRng(hashSeed(body.seed, 'tidal'));
  const n = clamp(opts.pieces || Math.round(6 + rng() * 10), 2, 40);
  const dx = body.x - primary.x, dy = body.y - primary.y;
  const d = Math.hypot(dx, dy) || 1;
  // The stream lies along the orbit, not along the radius vector.
  const tx = -dy / d, ty = dx / d;

  const pieces = [];
  let remaining = body.mass;
  const each = body.mass / n;
  for (let i = 0; i < n; i++) {
    const m = i === n - 1 ? remaining : each;
    remaining -= m;
    const offset = (i - (n - 1) / 2) * body.radius * 2.2;
    // Pieces further along the stream lead or trail slightly, which is what
    // stretches the chain over time.
    const shear = (offset / d) * Math.sqrt((G * primary.mass) / d) * 0.5;
    pieces.push(new Body({
      name: `${body.name} ${String.fromCharCode(65 + (i % 26))}`,
      kind: 'debris',
      x: body.x + tx * offset, y: body.y + ty * offset,
      vx: body.vx + tx * shear * 0.02, vy: body.vy + ty * shear * 0.02,
      mass: m,
      composition: body.composition,
      temperature: body.temperature,
      seed: hashSeed(body.seed, i, 'tidal'),
      spin: (rng() - 0.5) * 1e-4,
    }));
  }

  // Correct the stream's net momentum back to the parent's.
  let sx = 0, sy = 0, sm = 0;
  for (const p of pieces) { sx += p.mass * p.vx; sy += p.mass * p.vy; sm += p.mass; }
  const cvx = sx / sm, cvy = sy / sm;
  for (const p of pieces) { p.vx += body.vx - cvx; p.vy += body.vy - cvy; }

  return {
    regime: 'tidal', removed: [body], added: pieces,
    events: [{ type: 'tidal', x: body.x, y: body.y, energy: body.bindingEnergy, scale: body.radius * 4 }],
  };
}
