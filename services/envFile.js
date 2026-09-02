/**
 * Reading and rewriting `.env` without destroying it.
 *
 * Every setting this app has lives in one file that could only be changed by
 * opening a text editor on the machine itself — which is fine until the thing
 * you need to change is why you cannot reach the machine. Editing it from the
 * app has one hard requirement and one soft one.
 *
 * Hard: never lose the file. A rewrite that drops a comment, reorders keys, or
 * half-writes on a full disk turns a settings page into a way to break the
 * install. Parsing keeps every line, writes go through a temporary file and a
 * rename, and the previous contents are kept beside it.
 *
 * Soft: never hand a secret back out. Values are masked on read, and a value
 * that comes back still masked means "leave it alone" rather than "set it to
 * five dots".
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, createLogger } from '../config/index.js';

const log = createLogger('env');

export const ENV_PATH = path.join(ROOT_DIR, '.env');
export const EXAMPLE_PATH = path.join(ROOT_DIR, '.env.example');

/** What a masked value looks like coming back. Never a legal real value. */
export const MASK = '••••••••';

/** Keys whose value never leaves the machine in the clear. */
export const isSecret = (key) => /(KEY|PASSWORD|SECRET|TOKEN)$/i.test(String(key));

/** Keys the app refuses to start without. */
export const REQUIRED = ['TMDB_API_KEY', 'ALLDEBRID_API_KEY', 'AUTH_PASSWORD'];

/** Keys that must parse as a number if they are set at all. */
const NUMERIC = /(_MS|_SECONDS|_HOURS|_DAYS|_GB|_HEIGHT|_CRF|_PROCESSES|_RESULTS|_CHANNELS)$|^PORT$/;

/* --------------------------------------------------------------------------
 * Parsing
 * ----------------------------------------------------------------------- */

/**
 * Every line of a dotenv file, classified but never discarded.
 *
 * A `pair` carries its key and value; everything else is kept verbatim as
 * `raw`, which is what makes a rewrite preserve the comments that explain what
 * each of these settings is for.
 */
export function parseEnvText(text) {
  const raws = String(text).split(/\r?\n/);
  /*
   * A file ending in a newline splits to a final empty string that is not a
   * line. Keeping it meant every read-write cycle appended a blank line, so a
   * file saved ten times grew ten of them.
   */
  if (raws.length > 1 && raws[raws.length - 1] === '') raws.pop();

  return raws.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') return { kind: 'blank', raw };
    if (trimmed.startsWith('#')) return { kind: 'comment', raw };

    const at = raw.indexOf('=');
    // A line with no `=` is not a pair and not ours to interpret.
    if (at <= 0) return { kind: 'other', raw };

    const key = raw.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { kind: 'other', raw };

    /*
     * The tail of the line is not all value. `.env.example` documents nearly
     * every setting with a trailing comment —
     *
     *   LIBRARY_PATH=./library        # Where your media files live
     *
     * — and dotenv reads that as `./library`, stopping at the whitespace
     * before the `#`. Reading it as the whole tail would show the comment
     * inside the input box, and saving any *other* key would then rewrite this
     * one with the comment quoted into the value, silently pointing the
     * library at a path that does not exist. So the comment is split off and
     * kept, to be put back exactly where it was.
     */
    let value = raw.slice(at + 1);
    let comment = '';

    const quoted = /^(\s*)(['"])([\s\S]*?)\2(.*)$/.exec(value);
    if (quoted) {
      // Quoted values end at their closing quote; a `#` inside them is content.
      value = quoted[3];
      comment = quoted[4];
    } else {
      // The whole whitespace run, not just the character next to the `#`, so
      // the column the comments are aligned in survives a save.
      const hash = value.search(/\s+#/);
      if (hash >= 0) {
        comment = value.slice(hash);
        value = value.slice(0, hash);
      } else if (value.trimStart().startsWith('#')) {
        comment = value;
        value = '';
      }
      value = value.trim();
    }

    return { kind: 'pair', raw, key, value, comment };
  });
}

/**
 * Lines back to a file.
 *
 * A value that needs quoting gets them — leading or trailing space, or a `#`
 * that would otherwise read as the start of a comment.
 */
export function serialiseEnv(lines) {
  return `${lines.map((line) => {
    if (line.kind !== 'pair') return line.raw;
    // A `#` only needs quoting when something could read it as the start of a
    // comment, which is when whitespace precedes it — or when the value opens
    // with one.
    const needsQuotes = /^\s|\s$|\s#|^#/.test(line.value);
    const value = needsQuotes ? `"${line.value}"` : line.value;
    return `${line.key}=${value}${line.comment || ''}`;
  }).join('\n')}\n`;
}

/* --------------------------------------------------------------------------
 * Reading
 * ----------------------------------------------------------------------- */

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** Every key `.env.example` documents, in the order it documents them. */
export function knownKeys() {
  return parseEnvText(readText(EXAMPLE_PATH))
    .filter((line) => line.kind === 'pair')
    .map((line) => line.key);
}

/**
 * The current settings, safe to send anywhere the signed-in user can reach.
 *
 * `undocumented` and `missing` are the drift between the file and the example:
 * a key that nothing reads, usually a typo, and a key that has never been set.
 * Both are silent failures otherwise — a misspelled variable simply has no
 * effect, and that is a difficult thing to notice from the outside.
 */
export function readEnv() {
  const lines = parseEnvText(readText(ENV_PATH));
  const known = new Set(knownKeys());
  const present = new Set();

  const entries = [];
  for (const line of lines) {
    if (line.kind !== 'pair') continue;
    present.add(line.key);
    const secret = isSecret(line.key);
    entries.push({
      key: line.key,
      value: secret && line.value !== '' ? MASK : line.value,
      secret,
      set: line.value !== '',
      required: REQUIRED.includes(line.key),
      documented: known.has(line.key)
    });
  }

  return {
    path: ENV_PATH,
    entries,
    undocumented: entries.filter((entry) => !entry.documented).map((entry) => entry.key),
    missing: knownKeys().filter((key) => !present.has(key))
  };
}

/* --------------------------------------------------------------------------
 * Writing
 * ----------------------------------------------------------------------- */

/**
 * Is this a value the app can actually start with? Returns a reason, or null.
 *
 * Checked here rather than at boot because at boot it is already too late: the
 * process exits with a message nobody is in a position to read, and the way
 * back is the text editor this feature exists to avoid.
 */
export function validate(key, value) {
  const text = String(value ?? '');

  if (REQUIRED.includes(key) && text.trim() === '') {
    return `${key} is required — the server will not start without it`;
  }
  if (key === 'AUTH_PASSWORD' && text !== MASK && text.length < 8) {
    return 'AUTH_PASSWORD must be at least 8 characters';
  }
  if (NUMERIC.test(key) && text !== '' && !Number.isFinite(Number(text))) {
    return `${key} must be a number`;
  }
  if (/[\r\n]/.test(text)) {
    return `${key} cannot contain a line break`;
  }
  return null;
}

/**
 * Apply a set of changes, keeping everything else exactly as it was.
 *
 * A value of MASK means the client is echoing back a secret it was never
 * shown, so the stored value stays. A key that is not in the file yet is
 * appended rather than rejected — that is how a setting documented in the
 * example but never set gets its first value.
 */
export function applyChanges(lines, changes) {
  const result = lines.map((line) => ({ ...line }));
  const applied = [];

  for (const [key, raw] of Object.entries(changes)) {
    const value = String(raw ?? '');
    if (value === MASK) continue;

    const existing = result.find((line) => line.kind === 'pair' && line.key === key);
    if (existing) {
      if (existing.value === value) continue;
      existing.value = value;
    } else {
      result.push({ kind: 'pair', raw: `${key}=${value}`, key, value });
    }
    applied.push(key);
  }

  return { lines: result, applied };
}

/**
 * Write the file, atomically, keeping the previous contents beside it.
 *
 * The rename is what makes it atomic: a reader either sees the whole old file
 * or the whole new one, never a partial write. `.env.bak` is the way back from
 * a change that turns out to be wrong, and it is one file rather than a
 * history because the interesting version is always the one before this.
 */
export function writeEnv(changes) {
  const text = readText(ENV_PATH);
  const { lines, applied } = applyChanges(parseEnvText(text), changes);

  const problems = Object.entries(changes)
    .map(([key, value]) => validate(key, value))
    .filter(Boolean);
  if (problems.length > 0) return { ok: false, problems, applied: [] };

  if (applied.length === 0) return { ok: true, problems: [], applied: [], changed: false };

  const temporary = `${ENV_PATH}.tmp`;
  fs.writeFileSync(temporary, serialiseEnv(lines), { mode: 0o600 });
  // Best effort: a first run with no .env yet has nothing to keep.
  try { fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak`); } catch { /* nothing there */ }
  fs.renameSync(temporary, ENV_PATH);

  log.info(`.env updated: ${applied.join(', ')}`);
  return { ok: true, problems: [], applied, changed: true };
}

/**
 * Does a change only take effect after a restart?
 *
 * All of them do. config is read once at boot and deeply frozen, which is
 * deliberate — nothing downstream has to defend against a value changing under
 * it — and the honest thing is to say so rather than to appear to apply
 * something that has not been applied.
 */
export const needsRestart = () => true;

export default {
  ENV_PATH, MASK, REQUIRED, isSecret, knownKeys,
  parseEnvText, serialiseEnv, applyChanges, readEnv, writeEnv, validate, needsRestart
};
