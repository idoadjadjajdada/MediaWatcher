/**
 * ASS/SSA parsing.
 *
 * A `<track>` element understands WebVTT and nothing else, so the only way to
 * show an ASS subtitle through it is to strip the file down to plain text -
 * which is what the server did, and it throws away exactly the part that makes
 * ASS worth having. Signs, translation notes and anything positioned end up
 * stacked at the bottom of the screen in the same font as the dialogue.
 *
 * So ASS is parsed here and drawn into an overlay instead.
 *
 * What is supported: [V4+ Styles] and [Events], per-style font, size, colours,
 * bold/italic/underline/strikeout, outline and shadow, alignment and margins;
 * and the inline tags that actually appear in practice - \b \i \u \s, \c and
 * \1c and \3c, \fs, \fn, \an and \a, \pos, \N \n \h, and \r to reset.
 *
 * What is not: karaoke (\k and friends), animated transforms (\t, \move,
 * \fade), vector drawings (\p), rotation and shear (\frx \fax), and clipping
 * (\clip). Those are dropped rather than approximated - a half-drawn transform
 * looks broken, whereas the line without it just looks plain. Anything using
 * them is rare outside anime typesetting, and this is a media player, not a
 * subtitle editor.
 */

/** `0:00:01.23` and `0:00:01:23` both appear in the wild. */
export function parseAssTime(value) {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/.exec(String(value || '').trim());
  if (!match) return null;

  const [, hours, minutes, seconds, fraction] = match;
  // The fractional part is centiseconds in ASS, so two digits, but files with
  // one or three turn up; pad rather than reject.
  const centis = Number(fraction.padEnd(2, '0').slice(0, 2));
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + centis / 100;
}

/**
 * `&HAABBGGRR` to a CSS colour.
 *
 * Byte order is reversed from CSS and the alpha channel is inverted: 00 is
 * fully opaque, FF fully transparent. Short forms omit leading bytes, which
 * means an alpha of 00 - so a bare `&HFFFFFF` is opaque white, not white with
 * no alpha.
 */
export function parseAssColour(value) {
  const raw = String(value || '').trim().replace(/^&H/i, '').replace(/&$/, '');
  if (!/^[0-9a-f]{1,8}$/i.test(raw)) return null;

  const padded = raw.padStart(8, '0');
  const alpha = Number.parseInt(padded.slice(0, 2), 16);
  const blue = Number.parseInt(padded.slice(2, 4), 16);
  const green = Number.parseInt(padded.slice(4, 6), 16);
  const red = Number.parseInt(padded.slice(6, 8), 16);

  const opacity = (255 - alpha) / 255;
  return `rgba(${red}, ${green}, ${blue}, ${opacity.toFixed(3)})`;
}

/** ASS numpad alignment to the CSS anchors an overlay needs. */
export function alignmentToAnchor(alignment) {
  const value = Number(alignment);
  const n = Number.isInteger(value) && value >= 1 && value <= 9 ? value : 2;

  // 1-3 bottom, 4-6 middle, 7-9 top; within each row left, centre, right.
  const vertical = n <= 3 ? 'bottom' : n <= 6 ? 'middle' : 'top';
  const horizontal = n % 3 === 1 ? 'left' : n % 3 === 2 ? 'center' : 'right';
  return { vertical, horizontal };
}

/**
 * Legacy SSA alignment (\a) to the V4+ numpad scheme.
 *
 * SSA packed the vertical position into bits 2 and 3 rather than using the
 * numpad layout, so 5 means top-left there and centre-centre in V4+. A file
 * mixing the two is not something to guess at, but reading \a as \an would put
 * a top-of-screen sign in the middle of the picture.
 */
export function legacyAlignment(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 2;
  const horizontal = n & 3;             // 1 left, 2 centre, 3 right
  // Bit 3 is top and bit 4 is middle, not the other way round: \a5 (4+1) is
  // top-left and \a9 (8+1) is middle-left.
  const vertical = (n & 4) ? 'top' : (n & 8) ? 'middle' : 'bottom';
  const base = vertical === 'top' ? 7 : vertical === 'middle' ? 4 : 1;
  return base + (horizontal === 0 ? 1 : horizontal - 1);
}

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Split a `Format:` line into field names, lowercased for lookup.
 *
 * Field order is declared per-section and is not fixed, so nothing may be read
 * positionally - a file that lists Text before Effect is legal.
 */
const parseFormat = (line) => line
  .slice(line.indexOf(':') + 1)
  .split(',')
  .map((name) => name.trim().toLowerCase());

/**
 * Split a record, keeping the last field intact.
 *
 * Dialogue text routinely contains commas, and it is always the final field,
 * so the split is bounded by the number of declared fields rather than greedy.
 */
function splitRecord(line, fieldCount) {
  const body = line.slice(line.indexOf(':') + 1);
  const parts = [];
  let rest = body;
  for (let i = 0; i < fieldCount - 1; i += 1) {
    const comma = rest.indexOf(',');
    if (comma === -1) break;
    parts.push(rest.slice(0, comma).trim());
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return parts;
}

const BOOL = (value) => value === '1' || value === '-1' || String(value).toLowerCase() === 'yes';

/**
 * Parse a whole ASS or SSA file.
 *
 * Returns the play resolution (positions are expressed in it, so the overlay
 * has to scale by it), the styles table, and the events in time order.
 */
export function parseAss(text) {
  const result = {
    playResX: 384,
    playResY: 288,
    styles: new Map(),
    events: []
  };
  if (typeof text !== 'string' || text.trim() === '') return result;

  let section = '';
  let styleFormat = null;
  let eventFormat = null;

  for (const rawLine of text.replace(/\r\n|\r/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';')) continue;

    if (line.startsWith('[')) {
      section = line.toLowerCase();
      continue;
    }

    if (section.includes('script info')) {
      const [key, value] = line.split(':').map((part) => part.trim());
      if (/^playresx$/i.test(key) && Number(value) > 0) result.playResX = Number(value);
      if (/^playresy$/i.test(key) && Number(value) > 0) result.playResY = Number(value);
      continue;
    }

    if (section.includes('styles')) {
      if (/^format\s*:/i.test(line)) { styleFormat = parseFormat(line); continue; }
      if (/^style\s*:/i.test(line) && styleFormat) {
        const values = splitRecord(line, styleFormat.length);
        const row = Object.fromEntries(styleFormat.map((name, i) => [name, values[i]]));
        result.styles.set(row.name, {
          name: row.name,
          font: row.fontname || 'sans-serif',
          size: Number(row.fontsize) || 48,
          primary: parseAssColour(row.primarycolour) || 'rgba(255, 255, 255, 1.000)',
          outlineColour: parseAssColour(row.outlinecolour) || 'rgba(0, 0, 0, 1.000)',
          shadowColour: parseAssColour(row.backcolour) || 'rgba(0, 0, 0, 1.000)',
          bold: BOOL(row.bold),
          italic: BOOL(row.italic),
          underline: BOOL(row.underline),
          strikeout: BOOL(row.strikeout),
          outline: Number(row.outline) || 0,
          shadow: Number(row.shadow) || 0,
          alignment: Number(row.alignment) || 2,
          marginL: Number(row.marginl) || 0,
          marginR: Number(row.marginr) || 0,
          marginV: Number(row.marginv) || 0
        });
      }
      continue;
    }

    if (section.includes('events')) {
      if (/^format\s*:/i.test(line)) { eventFormat = parseFormat(line); continue; }
      // Comment: lines are the format's own way of disabling a line.
      if (/^dialogue\s*:/i.test(line) && eventFormat) {
        const values = splitRecord(line, eventFormat.length);
        const row = Object.fromEntries(eventFormat.map((name, i) => [name, values[i]]));
        const start = parseAssTime(row.start);
        const end = parseAssTime(row.end);
        if (start === null || end === null || end <= start) continue;

        result.events.push({
          start,
          end,
          layer: Number(row.layer) || 0,
          style: row.style || 'Default',
          marginL: Number(row.marginl) || 0,
          marginR: Number(row.marginr) || 0,
          marginV: Number(row.marginv) || 0,
          text: row.text ?? ''
        });
      }
    }
  }

  // Layer decides what draws on top of what, and is only meaningful among
  // events that overlap in time.
  result.events.sort((a, b) => a.start - b.start || a.layer - b.layer);
  return result;
}

/* --------------------------------------------------------------------------
 * Inline tags
 * ----------------------------------------------------------------------- */

/**
 * Turn one Dialogue text into HTML plus the overrides that affect the whole
 * line (alignment and absolute position).
 *
 * Tags are applied by opening a span whenever the active set changes, which
 * keeps nesting correct without tracking a stack: each override block closes
 * the previous span and opens a new one carrying the accumulated state.
 */
export function renderAssText(text, style) {
  const base = {
    bold: style?.bold || false,
    italic: style?.italic || false,
    underline: style?.underline || false,
    strikeout: style?.strikeout || false,
    colour: null,
    outlineColour: null,
    size: null,
    font: null
  };

  let current = { ...base };
  let alignment = null;
  let position = null;
  let html = '';
  let open = false;

  const openSpan = () => {
    const css = [];
    if (current.bold) css.push('font-weight:700');
    if (current.italic) css.push('font-style:italic');
    const decoration = [current.underline && 'underline', current.strikeout && 'line-through'].filter(Boolean);
    if (decoration.length) css.push(`text-decoration:${decoration.join(' ')}`);
    if (current.colour) css.push(`color:${current.colour}`);
    if (current.size) css.push(`font-size:${current.size}px`);
    if (current.font) css.push(`font-family:${JSON.stringify(current.font)}, sans-serif`);
    // An outline override only changes the shadow colour; the geometry stays
    // with the style, so it is recomputed by the caller, not here.
    if (current.outlineColour) css.push(`--ass-outline:${current.outlineColour}`);

    html += `<span style="${escapeHtml(css.join(';'))}">`;
    open = true;
  };
  const closeSpan = () => { if (open) { html += '</span>'; open = false; } };

  openSpan();

  const source = String(text ?? '');
  let i = 0;
  while (i < source.length) {
    if (source[i] === '\\' && i + 1 < source.length) {
      const next = source[i + 1];
      // \N is a hard break; \n is a soft one, which only breaks when the line
      // does not wrap - close enough to treat both as a break.
      if (next === 'N' || next === 'n') { html += '<br>'; i += 2; continue; }
      if (next === 'h') { html += '&nbsp;'; i += 2; continue; }
    }

    if (source[i] !== '{') {
      html += escapeHtml(source[i]);
      i += 1;
      continue;
    }

    const close = source.indexOf('}', i);
    // An unclosed brace is literal text, not the start of an override.
    if (close === -1) { html += escapeHtml(source.slice(i)); break; }

    const block = source.slice(i + 1, close);
    i = close + 1;

    let changed = false;
    // Tags run together inside one block: {\i1\c&HFF&\fs30}
    for (const tag of block.split('\\')) {
      if (tag === '') continue;
      let match;

      if ((match = /^r(.*)$/.exec(tag)) && !/^rnd/.test(tag)) {
        // \r with a name resets to that style; without one, to the line's own.
        current = { ...base };
        changed = true;
      } else if ((match = /^b([01])$/.exec(tag))) {
        current.bold = match[1] === '1'; changed = true;
      } else if (/^b\d{3}$/.test(tag)) {
        // A weight rather than a flag: anything at or above 600 reads as bold.
        current.bold = Number(tag.slice(1)) >= 600; changed = true;
      } else if ((match = /^i([01])$/.exec(tag))) {
        current.italic = match[1] === '1'; changed = true;
      } else if ((match = /^u([01])$/.exec(tag))) {
        current.underline = match[1] === '1'; changed = true;
      } else if ((match = /^s([01])$/.exec(tag))) {
        current.strikeout = match[1] === '1'; changed = true;
      } else if ((match = /^(?:1?c|1a?c)&?H?([0-9a-f]+)&?$/i.exec(tag))) {
        current.colour = parseAssColour(match[1]); changed = true;
      } else if ((match = /^3c&?H?([0-9a-f]+)&?$/i.exec(tag))) {
        current.outlineColour = parseAssColour(match[1]); changed = true;
      } else if ((match = /^fs(\d+(?:\.\d+)?)$/.exec(tag))) {
        current.size = Number(match[1]); changed = true;
      } else if ((match = /^fn(.+)$/.exec(tag))) {
        current.font = match[1].trim(); changed = true;
      } else if ((match = /^an([1-9])$/.exec(tag))) {
        alignment = Number(match[1]);
      } else if ((match = /^a(\d{1,2})$/.exec(tag))) {
        alignment = legacyAlignment(match[1]);
      } else if ((match = /^pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(tag))) {
        position = { x: Number(match[1]), y: Number(match[2]) };
      }
      // Everything else - karaoke, transforms, drawings, clips - is dropped.
    }

    if (changed) { closeSpan(); openSpan(); }
  }

  closeSpan();
  return { html, alignment, position };
}

/** Events playing at `time`, in draw order. */
export function eventsAt(events, time) {
  if (!Array.isArray(events)) return [];
  return events.filter((event) => time >= event.start && time < event.end);
}

export default {
  parseAss, parseAssTime, parseAssColour, alignmentToAnchor, legacyAlignment,
  renderAssText, eventsAt
};
