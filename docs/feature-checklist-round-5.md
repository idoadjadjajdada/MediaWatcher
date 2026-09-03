# Feature checklist — Round 5

**Every ticked item on this page is built.** Eighteen of them, across seven
commits — see `git log` from `9ba11eb` onwards. The unticked ones below are
still candidates; Round 4's leftovers are in `feature-checklist.md`.

Two carry a caveat, both because they need hardware that is not here:
Chromecast is unverified past the signing and the refusals, and the encode
worker was proved against a second server on this machine rather than a second
machine. One was delivered differently from how it was written down — the
cached-or-not badge, because AllDebrid removed the endpoint it needed; see the
note under Acquisition.

Tick what you want. Unticked doesn't get built.

Effort: **S** an afternoon, **M** a day, **L** its own spec and plan.

---

## Built

**Encoding**

- [x] ~~**Reuse a finished encode**~~ — two devices at the same quality get two
      encoders. Once a run has completed a stretch, its segments are the same
      bytes for everyone; cache them under the existing session key. **M**
- [x] ~~**Encode-ahead that adapts**~~ — 300s per run regardless of what is playing.
      A title you have never abandoned deserves a longer run; a browse-and-quit
      deserves less. **S**
- [x] ~~**Machine benchmark in Settings**~~ — measure this box once, report the
      realtime factor per path, and say plainly what it cannot keep up with.
      Those numbers currently live in code comments. **S**

**Acquisition**

- [x] ~~**Season packs**~~ — the common real-world release is one torrent holding a
      whole season. A job is one file today; splitting a pack and filing each
      episode is what would let those releases be used at all. **L**
- [x] ~~**Cached-or-not badge on every result**~~ — delivered as a badge on the
      *job* rather than on the search result. A search-time badge needs an
      instant-availability lookup by hash, and AllDebrid has removed it —
      `/magnet/instant` answers "Endpoint doesn't exist" on both v4 and v4.1,
      checked against the live API. The first status poll answers the same
      question at the only point it can be asked, so a download now says "not
      cached — AllDebrid is fetching it first" instead of sitting at 50%
      looking stuck. **S**
- [x] ~~**AllDebrid account panel**~~ — traffic left, link status, recent magnets. **S**

**Elsewhere**

- [x] ~~**Chromecast**~~ — AirPlay covers half the room. Everything already speaks
      HLS, which is what Cast wants. **L**
- [x] ~~**Web Push**~~ — the PWA is installed on the phone already. A finished
      download should reach it. **M**
- [x] ~~**Out-of-sync warning**~~ — compare the first cue against the first speech
      in the audio and say so when they disagree by seconds, instead of leaving
      you to notice. **M**
- [x] ~~**What changed since you last looked**~~ — added, removed, upgraded, since
      your last visit, on the Home page. **S**
- [x] ~~**`.env` editor in Settings**~~ — validated, using the same pre-flight the
      launcher already runs. Pairs with Round 4's first-run wizard. **M**

---

# Candidates

## Encoding and performance

- [ ] **Remember what each device can decode** — capabilities arrive as
      `?hevc=1&ac3=1` on every request and are thrown away after it. Stored on
      the device row, warmup could convert for the four screens you actually
      own rather than for a generic browser, and a first play would not have to
      ask. **M**
- [ ] **AV1 and VP9 are not universal** — `BROWSER_VIDEO` treats both as
      always-decodable, alongside H.264. Safari before 17 and most TV browsers
      cannot, so an AV1 release is handed over direct and simply fails instead
      of being transcoded. They belong in `OPTIONAL_VIDEO` with HEVC. **S**
- [ ] **Background encoders at low OS priority** — `ffmpegPool` decides *how
      many* processes run and lets playback jump the queue, but every one of
      them runs at the same Windows priority. A background conversion competes
      with whatever you are doing on the machine. **S**
- [ ] **Yield to the machine, not just to playback** — no conversions while a
      full-screen app is running or while on battery. The launcher already
      watches the system for its own panel. **S**
- [x] ~~**Encoder page**~~ — every ffmpeg process running right now: what it is
      for, its realtime factor, how far ahead it has reached, and a kill. The
      pool knows all of it and shows none of it. **M**
- [ ] **Cache the converted subtitles** — every WebVTT is re-extracted from the
      container on each play, including the ones you play every night. **S**
- [ ] **Encode VP9 or AV1 for the tunnel** — roughly half the bitrate at the
      same quality, on the one link where bitrate is the constraint. Only for
      clients that say they can decode it, which is the device-capability item
      above. **L**
- [ ] **Two-stage seek** — serve one cheap low-resolution segment at the seek
      point immediately, then swap to the real encoder's output when it catches
      up. A seek into transcoded 4K costs a few seconds of nothing today. **L**
- [x] ~~**Encode on a second machine**~~ — another PC on the tailnet takes a
      conversion job. Everything needed to address it is already there, and the
      slow path here is always CPU, never network. **L**

## Acquisition

- [x] ~~**Multi-file torrent picker**~~ — see inside a torrent and choose before
      committing. Season packs are the ticked case; this also covers extras,
      samples, and the release that ships two qualities in one. **M**
- [ ] **A second debrid provider** — Real-Debrid or Premiumize behind the same
      interface `alldebrid.js` already implies. One paid account is currently a
      single point of failure for every download in the app. **M**
- [ ] **Blocklist a release or a group** — after one bad rip, never be offered
      it again. A hard filter in the ranker rather than another score. **S**
- [ ] **Import a folder you filled yourself** — point the organiser at a
      download folder outside the library and let it file what lands there.
      Anything downloaded elsewhere is currently yours to sort by hand. **M**
- [ ] **Queue from a list** — paste ten titles, take the best release for each.
      **M**
- [ ] **Search history** — re-run last week's search without retyping it. **S**
- [ ] **Verify a finished download** — a size match is the whole test today. A
      quick ffprobe would catch the truncated file, and the one that is not
      video at all, before either is filed into the library. **S**
- [ ] **Estimated wait on a queued job** — its position, its size and the
      current throughput are a number, and the queue shows none of them. **S**
- [x] ~~**Per-source search timing**~~ — which indexer is slow, which times out,
      which quietly returns nothing, tracked over time.
      `SEARCH_SOURCE_TIMEOUT_MS` is a guess without it. **S**
- [ ] **Refresh metadata on a schedule** — the TMDB cache is 30 days flat. A
      continuing show's episode list changes weekly; an ended show's never
      changes again. **S**

## Away from the machine

- [ ] **Alert rules** — push when free space drops under N GB, when a job has
      not moved in an hour, when a scan throws. Web Push is the transport you
      ticked; this decides what is worth sending. **S**
- [ ] **Quiet hours** — nothing pushed between the hours you set. **S**
- [x] ~~**Restart the server from the web UI**~~ — admin-key gated. The launcher is
      at the desk and the tunnel is not, so a wedged server currently means
      going home. **M**
- [ ] **Crash bundle** — one button collects the last N log lines, the config
      with secrets stripped, versions, and the ffmpeg build. Exactly what you
      would otherwise assemble by hand before asking anyone for help. **S**
- [x] ~~**Log viewer in Settings**~~ — the launcher's colour-coded stream, reachable
      over the tunnel. **M**
- [ ] **Nightly maintenance** — vacuum, integrity check, cache sweep and health
      check at an hour nobody is watching. **S**
- [ ] **A health check that means something** — `/api/health` reports that the
      process is up. A deeper one reports that TMDB answered, AllDebrid
      answered, ffmpeg ran, the disk has room and the database opened. **S**
- [ ] **Per-device streaming totals** — how much each device pulled this month,
      which matters the moment one of them is on a metered link. **S**

## Phone

- [ ] **Save offline at a smaller size** — `/api/offline/file` hands over the
      file as it is, so a 4K remux is a 60 GB download onto a phone. Offer 720p
      instead. **S**
- [ ] **Keep the next few episodes offline** — top up over home wifi, drop what
      has been watched, so leaving the house never needs planning. **M**
- [ ] **Offline saves that survive backgrounding** — a save dies when the app
      goes to the background. Background Fetch does not. **M**
- [x] ~~**Enrol a device by QR**~~ — a signed one-time link instead of typing a
      password on a TV remote. The launcher already draws a QR for the URL. **M**

## Durability and access

- [ ] **Progress that survives a move** — `progress` is keyed on the absolute
      `file_path`. Rename a file, move it to another drive, or let the organiser
      tidy it, and the position, the track choice and the intro marker all go
      with it. Key on the file itself instead. **M**
- [ ] **Lock out repeated failures** — Round 4's failed-login alert tells you it
      happened. This stops it: back off, then refuse that origin for a while. **S**
- [ ] **A read-only API token** — `config/admin-key` is all-or-nothing, so
      anything you script holds the keys to the whole app. **S**

## Watching

- [ ] **Play something** — a channel of unwatched episodes, one after another,
      with no picking. **M**
- [ ] **Stop after a few unattended episodes** — autoplay runs to the end of the
      season whether or not anyone is in the room, and every one of those
      episodes is a live encode. **S**
- [ ] **Watch a download in progress** — start at 20% and let the transfer stay
      ahead of you. `temp/` already holds the partial file; the library only
      ever sees a finished one. **L**

---

## Anything else

- [ ]
- [ ]
- [ ]
