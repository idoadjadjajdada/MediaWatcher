# Feature checklist

**Round 4.** 26 confirmed at the top — no action needed on those. Below,
**52 candidates**, regrouped by theme rather than by round.

Tick what you want. Unticked doesn't get built.

Effort: **S** an afternoon, **M** a day, **L** its own spec and plan.

---

## Confirmed — building these

**Removals** — sleep timer out; chapters reduced to Skip Intro only.

**Player** — Skip Intro (learned) · Subtitle appearance · Subtitle download ·
Remember audio + subtitle choice per show · Resume prompt · Shortcut overlay

**Mobile** — Lock-screen controls · Install to home screen (PWA) · AirPlay ·
Save for offline

**Library** — Missing episodes · Storage view · Bulk subtitle fetch

**Launcher** — Tailscale panel · Cache management · Run as a Windows service
(replaces "Start with Windows") · Auto-restart on crash · Download
notifications · Throughput graph

**Settings** — Web settings page · Per-device defaults · Playback defaults ·
Diagnostics page · Devices in the web UI · Login history · Appearance

---

# Candidates

## Acquisition

Search, AllDebrid, Torrentio, Jackett and a quality ranker are all wired up,
and every download is still manual, one title at a time.

- [ ] **Follow a show** — new episodes found and downloaded as they appear.
      The largest functional addition available. **L**
- [ ] **Download quality profiles** — "1080p x265 under 4 GB, never HDR".
      `qualityRanker.js` already scores releases; this makes it a rule. **M**
- [ ] **Auto-upgrade** — a better release replaces the one you have. **M**
- [x] **Queue management** — reorder, pause, retry, prioritise. **M**
- [ ] **Paste a magnet** — add a link directly, skipping search. **S**
- [ ] **Retry with another source** — a failed download tries the next best
      release instead of stopping. **S**

## Streaming & quality

- [x] **Adaptive bitrate** — several renditions so the player drops quality by
      itself on bad wifi instead of stalling. The natural completion of the
      HLS work. **L**
- [ ] **Multi-audio in the playlist** — switch language mid-stream instead of
      restarting the encoder. **M**
- [x] **HDR passthrough** — stop tone-mapping for displays that can actually
      show HDR. Everything is flattened to SDR today, including on your
      iPhone, which can display it. **M**
- [x] **Pre-transcode on download** — warm the cache when a download finishes
      so first play is instant. **M**
- [x] **Transcode priority** — background conversions must never starve live
      playback of GPU. **M**
- [ ] **Stereo downmix with dialogue lift** — for headphones on a 5.1 source,
      where the centre channel is what you want. **S**
- [x] **Playback error recovery** — retry a failed segment or reattach the
      stream instead of surfacing a dead player. **S**
- [ ] **Playback quality history** — record stalls and dropped frames per file
      so a consistently bad rip is identifiable rather than just annoying. **M**

## Subtitles

- [ ] **Burn in image subtitles** — your MKVs carry PGS subtitles, which are
      pictures, not text. A browser cannot display them at all, so they are
      currently invisible; burning them into the video is the only way. **M**
- [x] **Styled ASS/SSA rendering** — positioned and styled subtitles rendered
      properly instead of flattened to plain text. **M**
- [ ] **Forced subtitles automatically** — the ones for foreign dialogue in an
      otherwise English film. The probe already flags them. **S**
- [ ] **Subtitle text search** — search the dialogue and jump to the line.
      "Find the bit where they say…". **M**

## Big screen & control

- [ ] **TV mode** — a 10-foot layout with arrow-key navigation. **L**
- [ ] **Phone as remote** — your phone drives playback on another device.
      Everything is already authenticated on one tailnet, so this is a command
      channel rather than new infrastructure. **L**
- [ ] **Watch party** — two devices kept in sync. **L**

## Library & metadata

- [ ] **Multiple library roots** — more than one folder, or a second drive. **M**
- [ ] **Network / NAS paths** — a library on another machine. **M**
- [ ] **Upcoming episode calendar** — air dates from TMDB, so you know what is
      coming. Pairs with Follow a show. **M**
- [ ] **Series status & next air date** — ended or continuing, and when the
      next one lands. **S**
- [ ] **Cast & crew** — browse by actor or director. **M**
- [ ] **Extras** — behind-the-scenes and deleted scenes as their own section
      rather than stray files. **M**
- [ ] **Tags & notes** — your own labels and a note per title. **S**
- [ ] **Personal ratings** — rate what you have watched, feed it into
      recommendations. **M**
- [ ] **Organise preview** — a dry run of exactly what the organiser will move
      and rename, before it touches anything. **M**
- [ ] **Undo a move** — a trash bin for the organiser. **S**
- [ ] **Ignore patterns** — never scan samples, extras or a given folder. **S**

## Browsing & input

- [ ] **Command palette** (`Ctrl+K`) — jump to any title, action or setting
      without navigating. **M**
- [ ] **Bulk select** — act on many titles at once. **M**
- [ ] **Drag and drop import** — drop files onto the window to add them. **S**

## Automation

- [x] **Automatic intro detection** — find intros by black frames and silence
      rather than waiting for you to skip one. Complements the learned Skip
      Intro; catches season one, episode one. **L**
- [x] **Pre-generate seek thumbnails** — build them when a file is added, so
      scrubbing is instant the first time too. **S**

## Multi-user & sharing

- [ ] **Profiles** — separate watch progress per person. It is one shared
      table today, so a second viewer silently overwrites your positions. **L**
- [ ] **Guest link** — a time-limited link to one title, without a device or
      the password. **M**
- [ ] **Restricted devices** — can watch, cannot download, delete or reach
      settings. **M**

## Maintenance & safety

- [ ] **Backup & restore** — nothing protects your watch progress, device list
      or metadata cache today. The only item here guarding data you cannot
      regenerate. **M**
- [ ] **Database maintenance** — periodic vacuum and an integrity check. The
      database is 1.5 GB with a 4 GB write-ahead log. **S**
- [ ] **Rotating log file** — logs live only in the launcher window today, so
      anything that happened before you opened it is gone. **S**
- [ ] **Error digest** — a summary of what went wrong since you last looked,
      instead of scrolling. **M**
- [ ] **Storage forecast** — at the current rate, the drive fills in N weeks. **S**
- [ ] **Device expiry** — auto-revoke devices not seen for N days. **S**
- [ ] **Export watch history** — CSV or JSON, yours to keep. **S**
- [ ] **Trakt sync** — scrobble what you watch. **M**

## Security & access

- [ ] **HTTPS on the LAN** — the tunnel is secure but local access is plain
      HTTP, so the same browser features behave differently at home. **M**
- [ ] **Sign out this device** — from the player itself, not only the
      launcher. **S**
- [ ] **Failed-login alerts** — tell you when someone is guessing at the
      password. **S**

## Onboarding

- [ ] **First-run wizard** — walk through paths, API keys, password and
      Tailscale instead of hand-editing `.env`. **M**

---

## Anything else

- [ ]
- [ ]
- [ ]
