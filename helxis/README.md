# Helxis

An N-body physics sandbox. Real gravity, real collisions, and pixel worlds that
melt, mix and come apart according to what actually hit them.

```
npm run helxis     # then open http://localhost:4173/helxis/
```

No build step. It is vanilla ES modules and one canvas; the server exists only
because modules will not load over `file://`.

---

## What it actually simulates

Everything is SI internally — metres, kilograms, seconds — and converted only on
the way to the screen.

**Gravity** is a Barnes-Hut quadtree with an adjustable opening angle, stored in
flat typed arrays and rebuilt every substep. At θ = 0.5 it agrees with a direct
N² sum to about 5 parts in 10⁸. Setting θ to 0 makes it exact.

**Integration** is velocity Verlet with an adaptive step from the usual
`dt = η·|v|/|a|` criterion, which puts roughly 350 steps in an orbit at the
default η. Over ten simulated years of Earth's orbit, total energy drifts by
7 × 10⁻¹⁴ and the semi-major axis does not move in the sixth decimal place.

**Collisions** are swept — the contact test runs over the interval that was just
integrated and rolls the pair back to the instant of contact, so a comet cannot
pass through a planet at a million times realtime, and the impact parameter is
read off the real geometry. Outcomes follow the Leinhardt & Stewart (2012)
regimes: the specific impact energy is compared against a disruption threshold
Q*_RD corrected for mass ratio and for how much of the projectile actually
intersects, and the result is a merge, a graze-and-merge, a hit-and-run,
cratering, erosion, disruption, or a supercatastrophic shattering. Fragment
masses follow a power law near the Dohnanyi slope. Mass and momentum are
conserved to machine precision in every branch.

**Relativity** is optional: the first post-Newtonian Schwarzschild term, off by
default. Turn it on and Mercury's perihelion advances 42.8″ per century against
the 42.98″ general relativity predicts, while the Newtonian run gives −0.25″ of
numerical noise.

**Thermal evolution** runs on absorbed starlight against Stefan-Boltzmann
cooling, with latent heat spent on melting before the temperature moves again.
Bodies settle at their equilibrium temperature without that number being written
down anywhere. Melting drives density differentiation, which changes what the
surface is made of, which changes what it looks like.

**Tides** shred a body that spends long enough inside its primary's Roche limit,
which is how you get a ring.

### Things that fall out rather than being scripted

Load **Giant impact** and let it run. A Mars-sized body hits the proto-Earth at
4 km/s with an impact parameter of 0.7, the two merge, and about 1.9 lunar
masses are thrown into a circumplanetary disc. Because that disc is drawn from
the two *mantles* and not from whole bodies, it comes out at 1.3% iron against
the planet's 31.8% — which is the lunar iron depletion that the giant-impact
hypothesis was invented to explain. Nothing in the code knows about the Moon.

Load **Figure-eight choreography** for three equal masses on the
Chenciner-Montgomery orbit. After a full period each returns to its start within
7 × 10⁻⁵ AU.

Load **Protoplanetary disc** and leave it: 400 planetesimals on a minimum-mass
nebula profile, accreting.

---

## Textures

Every body's surface is generated from its own history, and the seed is carried
in the save file, so a world regenerates exactly as it was.

The composition picks the palette. Elevation comes from domain-warped fBm, with
ridged noise for mountains. Oceans appear where there is water and the
temperature is between freezing and boiling; frost appears where it is not.
Above the melting point, fissures open along a ridged field and spread until the
whole surface is incandescent — and incandescence is a blackbody ramp, so how
hot it is decides what colour it is.

Craters are stamped at the bearing the impactor actually arrived from — in a
top-down 2D world that is a real constraint, not a random placement — and scale
with impact energy through the usual π-group exponent. A crater deep enough
exposes core material, so a body stripped down to its iron looks like it.

Merges record what mixed with what, in what proportion, along which axis, and
how violently. A gentle merge leaves a visible seam. A fast one warps the
boundary with noise and twists it with a radial swirl, so the two parents end up
marbled together. That record survives into the next merge, so a body that has
been hit repeatedly carries all of it.

Gas giants get concentric bands, because seen from directly above, a rotating
fluid planet's jets *are* concentric — the axis points at the viewer.

---

## Rendering

Everything draws into a buffer a third or a quarter of the window and is blown
up with nearest-neighbour sampling. Sprites are dithered with a 4×4 Bayer matrix
against a 22-step palette. Shading is a quantised terminator rotated to the
flux-weighted direction of the stars, so planets show phases. Black holes
resample the buffer around them to smear the background into a ring, and their
shadow is drawn at 2.6 Schwarzschild radii rather than one.

At system scale a true-to-life Sun is a third of a pixel across, so bodies get a
floor on their apparent radius, blended in by the **Body size boost** setting.
Turn it to zero for true scale. It affects only what is drawn and what you can
click; nothing in `core/` imports it.

---

## Controls

| | |
|---|---|
| `Space` | play / pause |
| `,` `.` | slower / faster, `Shift+.` steps one frame |
| `1`–`8` | select, laser, attract, repel, explode, collapse, grab, delete |
| Scroll | zoom about the cursor |
| Drag | pan (or middle-drag with any tool) |
| `Q` `E` | rotate the view |
| `F` / `G` | frame everything / follow the selection |
| `/` | search the catalogue |
| `Ctrl+Z` | undo |
| `?` | full reference |

Click a catalogue entry to arm it, then click the viewport to place it. Drag
while placing to launch it — the arrow is its velocity. Hold `Shift` on place to
keep it armed and place more.

### The tools

**Laser** deposits real joules. It warms the surface, spends latent heat melting
it, and then boils it off; vapour leaves at its thermal speed and the body takes
the recoil, which is how laser ablation propulsion works.

**Explode** compares its yield against each body's own gravitational binding
energy. Under it, you get an impulse and a crater. Over it, the body comes apart
into fragments with the same power-law mass distribution collisions use.

**Collapse** crushes a body and checks the real mass limits on the way down:
under 1.4 M☉ electron degeneracy holds and you get a white dwarf, under about
2.9 M☉ neutron degeneracy holds, and above that nothing does. Compression is
real work, so it heats up as it shrinks.

**Attract** and **repel** are the two honestly unphysical ones. They are a hand
reaching into the simulation — a uniform acceleration field, so they move a moon
and a star at the same rate.

---

## Performance

Each `advance()` is given a wall-clock budget rather than a substep count. A
scene that cannot keep up runs the clock slower instead of dropping frames, and
the status line says **TIME LIMITED** when that is happening rather than
pretending the requested rate was achieved. Raise **Physics time budget** to
trade frame rate for simulated rate.

Turning on **Show diagnostics** puts substeps taken, fractional energy drift and
the live effect count in the status bar.

---

## Layout

```
src/core/      the simulation. No DOM, no canvas, no rendering imports.
  const.js       constants, unit formatting
  rng.js         seeded PRNG, value noise, fBm, power-law sampling
  materials.js   material table, mixing, differentiation, colour
  body.js        Body: state, thermal response, craters, merge record
  quadtree.js    Barnes-Hut tree, also the collision broad phase
  kepler.js      orbital elements both ways, conic sampling
  collide.js     contact detection and the LS12 outcome regimes
  world.js       integrator, collision pipeline, thermal pass, diagnostics
src/render/    camera, pixel renderer, procedural textures, effects, overlays
src/ui/        catalogue, presets, tools, settings, DOM
```

`core/` has no idea the renderer exists. You can run the whole simulation under
Node — the tests do.
