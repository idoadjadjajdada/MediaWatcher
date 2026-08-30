# UI Overhaul — Design

**Date:** 2026-08-30
**Status:** Approved, ready for implementation planning

---

## Context

MediaWatcher's frontend grew feature-first: hero, rails, discovery, suggestions and
the player were each added on top of the original layout. It works, but it was never
designed as a whole and it has never been used on a phone — which is about to become
the primary way it's used, once the access work lands.

This is sub-project **D** of four. The others — auth, network access, remote playback
quality — are separate and deliberately not addressed here. Ordering was set with the
user: UI first, then access, then playback quality.

## Goals

- A single coherent visual language across every page, not a restyle of Home alone.
- Genuinely usable on a phone: reachable navigation, thumb-sized targets, touch scrolling.
- Owned and discoverable titles distinguishable at a glance.
- A player that works under a thumb as well as under a mouse.

## Non-goals

- Authentication, network exposure, TLS. Separate sub-project, lands after this.
- Adaptive bitrate or bandwidth-aware transcoding. Separate sub-project.
- Changing what the API returns. This is a frontend change; server routes are untouched
  except where noted for the accent colour, which is **not** in scope (monochrome was
  chosen, so no colour extraction is needed).

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Depth | **Full redesign, new visual language** | Chosen over restyle and restructure. |
| Direction | **Cinematic** | Black, full-bleed, artwork does the work, large tight-tracked type, minimal chrome. Rejected: editorial serif, neon glass, control-room. |
| Accent | **Monochrome** | White on black; every colour on screen comes from poster artwork. Rejected: keeping purple→pink, and per-title colour extracted from artwork. |
| Player | **Classic control bar** | Scrub, times, one control row, everything visible. Rejected: floating capsule, gesture-only. |
| Touch seeking | **Double-tap ±10s, added to the classic bar** | The bar's skip buttons are small under a thumb and this is the gesture people already expect. Flagged to the user as a judgment call rather than asked. |
| Mobile navigation | **Bottom tab bar** | Replaces the drawer outright. |

**Consequence accepted:** the web app and the WPF launcher stop sharing a palette, since
the launcher is purple→pink. Re-skinning the launcher is out of scope and optional.

---

## The bug this replaces

`renderShell` builds the drawer toggle as:

```js
<button class="btn btn--ghost btn--icon topbar__menu" ...>${icon('menu')}</button>
```

`icon(name, className = '')` emits `<svg class="">`. Every other icon is given a sizing
class — `nav__icon`, `btn__icon` — and this one is not, so the SVG has only a `viewBox`
and lays out at **0×0**. On a phone the navigation button is invisible; the 36×36 button
still accepts taps, so the drawer is reachable only by tapping a blank area.

Verified in a 375px viewport: `getBoundingClientRect()` on the SVG returns `0×0` while
the button measures 36×36.

The bottom tab bar removes the drawer, so this stops being possible rather than being
patched. `icon()` is still given a default size so no future caller can reproduce it.

**Not a bug:** during investigation the drawer appeared stuck at `translateX(-260px)`
with `.is-open` applied. Setting `transition: none` snapped it to `x: 0` immediately, so
the cascade is correct and the transition simply wasn't progressing in the headless
pane. No fix needed; noted so nobody "fixes" it later.

---

## Visual language

**Colour.** Two families only.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#000000` | Page. True black, not near-black — artwork sits on it. |
| `--surface` | `#0d0d0d` | Cards, menus, elevated panels |
| `--surface-2` | `#171717` | Hover, pressed, inputs |
| `--line` | `rgba(255,255,255,.09)` | Hairline separators |
| `--fg` | `#ffffff` | Primary text, primary button fill |
| `--fg-2` | `rgba(255,255,255,.68)` | Secondary text |
| `--fg-3` | `rgba(255,255,255,.42)` | Labels, meta, inactive nav |
| `--danger` | `#ef4444` | Destructive only — cancel, delete, errors |
| `--warn` | `#f59e0b` | Warnings only |

`--danger` and `--warn` are the sole exceptions to monochrome and appear only on state,
never on decoration.

**Type.** One family, system sans. Scale, all with `letter-spacing` tightening as size
grows: hero title 44/30/21px (desktop/tablet/mobile) at `-1.1px` and weight 800; section
heading 15px/700; card title 12px/600; body 13px/400; meta and labels 10px/600 uppercase
at `+0.9px`. Numerals in the player use `font-variant-numeric: tabular-nums` so times
don't jitter.

**Elevation.** No coloured glows. One shadow token for modals and menus; cards lift with
a 1.04 scale and a brightness change, not a shadow.

**Motion.** 160ms for hover and state, 240ms for entrances and pane changes, both on
`cubic-bezier(.22,1,.36,1)`. Only `opacity` and `transform` animate. The existing
`prefers-reduced-motion` block is kept and extended to cover new motion.

---

## Layout

### Shell

Desktop (≥1024px) keeps a left rail, narrowed to **64px, icon-only**, with the label as
a tooltip. The current 240px sidebar spends a fifth of the width on five words. Tablet
(768–1023px) is the same rail. Mobile (<768px) drops the rail entirely for a **bottom
tab bar**: Home, Movies, Shows, Search, Downloads — icon over a 10px label, 56px tall
plus `env(safe-area-inset-bottom)`, active tab in `--fg`, the rest in `--fg-3`.

The drawer, the scrim, and `toggle-drawer` are removed.

Search moves into the Search page on mobile rather than living in a top bar that
truncates to "Search your lil" at 375px. Desktop keeps the top search field.

### Home

One hero, then a stack of identical rails.

**Rail order and collapsing.** Continue watching, then the library rails, then the
discovery rails as returned by `/api/discover`.

The library currently holds **three titles**. Rendering "In your library" and "Recently
added" as separate rails would show the same three posters twice, directly under a
Continue watching rail showing the same three again. So the library rails collapse by
size:

| Library titles | Library rails shown |
|---|---|
| ≤ 8 | One rail, "Your library", newest first |
| > 8 | "Recently added" (newest 20) then "Your library" |

Continue watching is independent of this and appears whenever there is watch progress,
even though today it overlaps heavily — it is the rail with the resume positions on it.

**Hero.** Full-bleed, `60vh` desktop capped at 520px, `42vh` mobile with a 280px floor.
Two-layer scrim: a horizontal ramp on desktop (`90deg, #000 6%, rgba(0,0,0,.78) 36%,
transparent 72%`) and a vertical one on mobile, plus a bottom fade into the page on both.
Title, one meta line, two lines of overview on desktop and none on mobile, then Resume
(white fill, black text) and More info (translucent white).

**Hero selection is a behaviour change.** Today `renderHome` picks a *random* library
item with a backdrop on every render, so the hero changes identity each time state
updates. It will instead show the most recently watched unfinished title, falling back to
the newest library title with a backdrop, and only then to a random one. That makes the
hero's Resume button meaningful and stops it flickering between titles — the mockup's
"S09E10 · 21m left · Resume" depends on it.

### Rails — one component, used everywhere

`Recently Added` stops being a grid. Every row is the same component:

- Horizontal `overflow-x: auto`, `scroll-snap-type: x mandatory`, snap on each card
- `scrollbar-width: none` and `::-webkit-scrollbar { display: none }` — the visible grey
  track is removed
- Desktop: an arrow appears on hover at whichever end can still scroll, over a fade to
  `--bg`. Hidden entirely on touch (`@media (hover: hover)`)
- Card widths: 150px desktop, 120px tablet, 108px mobile, all 2:3 posters

**Owned marking.** A card for a title in the library carries a 2.5px white bar inset 5px
from the bottom of the poster. Full bar = owned; partial = watch progress; absent =
discoverable. This is the only signal distinguishing the two, and it currently doesn't
exist — owned and browsable titles are visually identical until clicked.

### Detail modal

Full-screen sheet on mobile (already partly true), centred panel on desktop. Same
structure as today — backdrop, title, chips, overview, cast, episodes — restyled. The
`Find torrents` / `Play` split and the `open-discover` path are unchanged in behaviour.

---

## Player

Classic bar, restyled, plus touch affordances.

**Top:** back chevron, title and subtitle stacked, playback-mode badge right-aligned.
The badge already exists in `renderPlayer` as `modeLabel`; it stays and gets a proper
treatment, because with a 4K HEVC library "Remux · lossless" versus "Transcode" is
genuinely useful and currently easy to miss.

**Bottom:** scrub with a buffered band behind the fill and a knob that appears on hover
or drag; elapsed and remaining times below it in tabular numerals; then one control row —
skip back 10, play/pause, skip forward 10, volume (desktop only), spacer, subtitles,
settings, fullscreen.

Chrome fades after 2.5s idle while playing, returns on pointer move, tap, or any key.

**Touch, in addition:**

- Double-tap the left or right third seeks ∓10s, with a brief ripple and a `-10s` label
- Single tap toggles the chrome
- Drag on the scrub works with a finger; the knob grows on contact
- Volume row hidden (hardware buttons own it), matching the existing mobile rule
- All controls ≥44px touch targets

Double-tap must not fire when the tap lands on the control bar, and a double-tap must not
also register as two chrome toggles.

`shouldOfferNext` / `secondsRemaining` and the next-up countdown keep their current
behaviour and tests; only their presentation changes.

---

## Files

| File | Change |
|---|---|
| `public/css/styles.css` | Rewritten against the new tokens. Largest single piece of work. |
| `public/js/views.js` | `renderShell`, `updateShell`, `renderHome`, `renderPlayer`, card and rail helpers |
| `public/js/player.js` | Touch gestures, control-bar markup wiring, idle behaviour |
| `public/js/app.js` | Drop `toggle-drawer`; add tab-bar navigation and gesture actions |
| `public/js/search.js` | Restyle results and suggestions against the new tokens |
| `public/index.html` | `theme-color` meta, `viewport-fit=cover` already present |

`state.js` and `api.js` are untouched — no state shape or endpoint changes.

**On file size:** `styles.css` is 1352 lines and rewriting it wholesale in one task is
both risky and hard to review. It gets split into `base.css` (reset, tokens, type),
`shell.css` (rail, tab bar, top bar), `content.css` (hero, rails, cards, modal, pages)
and `player.css`, imported in that order from a slim `styles.css`. This is a targeted
improvement to code being rewritten anyway, not unrelated refactoring.

---

## Verification

Three separate UI bugs in this codebase have passed render-shape assertions and only
appeared when a browser actually drove the page: a re-entrant `innerHTML` crash, a
zero-width flex card, and a modal throwing on `item.seasons.map`. The invisible menu icon
is a fourth. **Shape assertions are not sufficient here.**

Every task is verified in a real browser at three viewports — 1440px, 768px and 375px —
using the installed Playwright and Chromium, checking:

- Computed geometry, not just presence: nothing is 0×0, nothing overflows horizontally
  (`document.body.scrollWidth <= innerWidth`)
- Every interactive element ≥44px on the 375px viewport
- Navigation reachable and functional at each viewport
- Rails scroll and snap; no visible scrollbar track
- Player controls operate, chrome fades and returns, double-tap seeks by exactly 10s
- Console is free of errors after each interaction

The existing node suites (`npm test`) and the launcher suite must stay green; neither
covers this work directly, so they serve as regression guards.

---

## Risks

**The stylesheet rewrite is the whole risk.** Every page shares it, so a mistake in the
tokens is a mistake everywhere. Mitigated by splitting the file, doing tokens and base
first as their own verifiable task, and browser-checking each subsequent task at all three
viewports before moving on.

**Bottom tabs cost vertical space** on a phone — 56px plus safe area. Accounted for by
letting content scroll under a translucent bar rather than being inset by it.

**Gesture conflicts.** Double-tap can fight the browser's own double-tap-to-zoom.
`touch-action: manipulation` on the video surface removes that, and it is applied.
