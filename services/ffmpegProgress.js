/**
 * ffmpeg's `-progress` stream, turned into numbers.
 *
 * ffmpeg will report its own progress as `key=value` lines, one block at a
 * time, each block terminated by a `progress=continue` (or `progress=end`).
 * That is a far better source than stderr: stderr carries a status line
 * formatted for a terminal, and reading it means matching a layout that is not
 * stable between builds and that interleaves with actual errors.
 *
 * Pure on purpose — the parser is exercised without an encoder, and the only
 * thing the caller supplies is bytes.
 */

/** Microseconds ffmpeg reports for a position, whichever key this build uses. */
function positionSeconds(fields) {
  /*
   * `out_time_ms` is misnamed: ffmpeg writes microseconds into it, the same
   * value as `out_time_us`. Reading it as milliseconds puts the encoder a
   * thousand times further ahead than it is, which is exactly the kind of
   * wrong that looks plausible on screen.
   */
  const micros = fields.out_time_us ?? fields.out_time_ms;
  const parsed = Number.parseInt(micros, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed / 1_000_000;

  // Some builds only emit the formatted `out_time`, e.g. 00:01:23.456000.
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(fields.out_time || '').trim());
  if (!match) return null;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

/** `1.53x` → 1.53. `N/A` early in a run → null. */
function speedFactor(raw) {
  const parsed = Number.parseFloat(String(raw || '').replace(/x$/, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * One complete block of `key=value` lines, as the fields worth keeping.
 *
 * Returns null for a block that carries neither a position nor a speed, so a
 * caller can ignore it rather than overwrite good numbers with nothing.
 */
export function parseProgressBlock(text) {
  const fields = {};
  for (const line of String(text).split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }

  const outSeconds = positionSeconds(fields);
  const speed = speedFactor(fields.speed);
  if (outSeconds === null && speed === null) return null;

  const frames = Number.parseInt(fields.frame, 10);
  return {
    outSeconds,
    speed,
    frames: Number.isFinite(frames) ? frames : null,
    ended: fields.progress === 'end'
  };
}

/**
 * A sink for ffmpeg's progress output.
 *
 * Buffers whatever arrives and calls `onUpdate` once per complete block. A
 * block is not a chunk: the writes land on pipe boundaries, so one read can
 * hold two blocks or half of one, and reporting per read would report
 * fragments.
 */
export function createProgressReader(onUpdate) {
  let buffer = '';

  return function write(chunk) {
    buffer += String(chunk);

    for (;;) {
      // Every block ends with a progress= line; anything after the last one is
      // an incomplete block and stays in the buffer for the next write.
      const end = buffer.indexOf('progress=');
      if (end === -1) break;
      const lineEnd = buffer.indexOf('\n', end);
      if (lineEnd === -1) break;

      const block = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);

      const update = parseProgressBlock(block);
      if (update) onUpdate(update);
    }

    // A stream that never completes a block must not grow without bound.
    if (buffer.length > 8192) buffer = buffer.slice(-2048);
  };
}

export default { parseProgressBlock, createProgressReader };
