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
flat typed arrays. How accurate that is depends on what the scene looks like, so
both numbers are worth quoting. Against a direct N² sum at θ = 0.5, a
star-dominated system agrees to 5 × 10⁻¹⁰ rms; a cloud of eight hundred equal
masses, where the forces largely cancel and per-body relative error is
unforgiving, comes to 2.6 × 10⁻² rms per body with a 37% worst case. Setting θ
to 0 makes it exact.

Three things the tree gets right that a naive one does not.

A node containing the body being evaluated is never summarised by its centre of
mass, so no body ever attracts itself — the usual opening test allows exactly
that once θ passes 1/√2, and the settings slider goes there.

When two bodies overlap, the force follows Newton's shell theorem, falling
linearly to zero at the centre, rather than a 1/d² singularity. Treating a
touching pair as point masses gives 6.7 × 10¹¹ m/s² at one metre of separation,
which used to turn them into seven hundred fragments at a quarter of light speed
inside a single frame.

And the spurious net force is projected out. Barnes-Hut evaluates each body
against summarised clusters independently, so its forces are not exactly
pairwise antisymmetric and Σm·a comes out near zero rather than at zero — a
residual that integrates straight into a drifting barycentre. For a closed
system that sum *must* be zero, so subtracting the mass-weighted mean removes
approximation error from the one mode whose true value is known. Without it the
solar system's barycentre picks up 4.6 mm/s over twenty years, and relative
momentum error reaches 2 × 10⁻² at a wide opening angle; with it, momentum holds
to 2 × 10⁻¹⁵ at every angle. It is skipped whenever a body is pinned, since a
pinned body exerts force without accepting any and the system genuinely is not
closed.

**Integration** is Yoshida's fourth-order symplectic composition over velocity
Verlet, on a step shared by every body.

*Fourth order*, because second is not enough to see small things. Plain Verlet
at four hundred steps per orbit gives Mercury a **spurious** perihelion advance
of 38 000″ per century, and does not get under 2″ until about twenty-five
thousand steps per orbit — the 43″ relativistic signal is buried in truncation
error at any step you would actually run at. The fourth-order scheme costs three
force evaluations per step and reduces that to 3.3″, and because the error falls
as dt⁴ it is *cheaper* than second order for equal accuracy: at η = 0.09 it uses
fewer force evaluations than Verlet at η = 0.018 and is three times more
accurate. Measured convergence order is 4.00.

*A shared step*, after trying the alternative. An earlier version gave each body
its own power-of-two stride so a fast one could sub-cycle without dragging the
rest down. It was measured and removed, for two reasons. A kick applied to a
subset of bodies is not a symplectic map, and Σm·a over a subset is not zero, so
momentum leaks — 2.6 cm/s on the solar system's barycentre over twenty years
against 6 × 10⁻¹⁴ for a shared step, with energy drift 10⁴ times worse. And the
criterion below scales with acceleration, so it handed the *coarsest* stride to
the most massive body: the two halves of an action-reaction pair were integrated
at different cadences. Getting the cost benefit the scheme was supposed to
deliver needs a neighbour scheme — direct summation over predicted near
neighbours, with the distant field refreshed rarely — not merely a stride per
body. Until that exists, a shared step is both more accurate and, measured, no
slower.

The step itself comes from the local dynamical time, `η·sqrt(r/|a|)`, where r is
the distance to whatever dominates the pull. The obvious alternative,
`η·|v|/|a|`, is not Galilean-invariant: |v| depends on which frame you picked,
and a body whose speed passes through zero in that frame drives the step to
nothing. A Sun-Earth system started with the Sun at rest does exactly that once
per orbit, and that criterion answered with steps of a few microseconds.

The result is quantised to a power of two and held there with hysteresis, since
symplectic integrators are only symplectic at a fixed step and a wandering one
turns a bounded energy oscillation into a secular drift. One step per frame is
still an odd size, where the requested interval runs out.

Over ten simulated years of Earth's orbit, total energy drifts by 1.6 × 10⁻¹⁴
and the semi-major axis does not move in the sixth decimal place.

**Collisions** are swept — the contact test runs over the interval that was just
integrated and rolls the pair back to the instant of contact, so a comet cannot
pass through a planet at a million times realtime, and the impact parameter is
read off the real geometry. Every pair in contact is resolved, not just the
first, so a cluster settling under its own gravity comes apart instead of
leaving bodies interpenetrating. Outcomes follow the Leinhardt & Stewart (2012)
regimes: the specific impact energy is compared against a disruption threshold
Q*_RD corrected for mass ratio and for how much of the projectile actually
intersects, and the result is a merge, a graze-and-merge, a hit-and-run,
cratering, erosion, disruption, or a supercatastrophic shattering. Fragment
masses follow a power law near the Dohnanyi slope. Mass and momentum are
conserved to machine precision in every branch, and the products' kinetic energy
is audited against what the impact brought in — so a collision cannot fling its
own debris out faster than it arrived.

Degenerate matter gets its own path. A neutron star is eighteen orders of
magnitude stronger than rock and fourteen denser, and running it through
scalings calibrated on basalt had one swell from 10 km to 5 000 km after eating
a planet, and two of them bounce off each other at 0.17c. They now accrete, and
what is left is re-derived from the real mass limits — so a neutron-star merger
that crosses the TOV limit collapses to a black hole rather than remaining a
very heavy neutron star.

**Relativity** is optional: the first post-Newtonian Schwarzschild term, off by
default. Turn it on and Mercury's perihelion advances 43.07″ per century against
the 42.98″ general relativity predicts, with a numerical floor of 0.06″.

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
top-down 2D world that is a real constraint, not a random placement — and are
sized by gravity-regime π-group scaling, with the simple-to-complex transition
that makes a large crater collapse outward into a much wider rim. That tracks
both Meteor Crater and Chicxulub to within about half a factor across eight
orders of magnitude in impact energy. A crater deep enough exposes core
material, so a body stripped down to its iron looks like it.

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

What costs: body count, and the spread of timescales in the scene. The step is
shared, so the fastest body sets it for everyone — a scene holding both a tight
pair and a wide orbit pays the tight pair's cadence throughout. The solar system
and the Jovian system keep up at their opening speeds; Saturn's rings manage
about half; the protoplanetary disc — 160 bodies all interacting, all colliding
— runs its clock well below realtime, and says so rather than pretending
otherwise. Fixing that properly means a neighbour scheme, which is not written.

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

## Known limits

- The step is shared by all bodies, so one tight pair slows the whole scene.
- Barnes-Hut's per-body force error at a wide opening angle is percent-level in
  a scene with no dominant mass. Momentum is projected back to exact; energy is
  not.
- Attract and repel are openly unphysical, and a pinned body exerts gravity
  without accepting any — both break momentum conservation while in use, by
  design.
- Fragmentation is capped by the body limit, and by a floor on how small a
  piece is worth tracking — a millionth of the largest body in the scene.
  Without a scene-wide floor, debris sheds smaller debris without limit, since
  a gate expressed as a fraction of the pair that produced it shrinks exactly
  as fast as the pieces do. Mass under the floor stays with its parent, where
  it still gravitates. Mass evicted at the body cap, bodies culled for going
  non-finite, and a step too fine to be meaningful are all counted and shown
  under **Show diagnostics** rather than absorbed silently.
- Porosity is not modelled, so a comet's or a rubble pile's quoted density is
  well under what its materials imply. That is the real number, not an error.
- Atmospheres are not modelled. Venus is drawn as the basalt the Venera landers
  photographed, not as the white disc its clouds present from outside.
- The 2D projection is a real one — concentric gas-giant bands and impact
  bearings follow from it — but it is not a thin slice of a 3D system, and
  orbits that would be inclined simply are not.
