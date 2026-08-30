/**
 * Library path construction.
 *
 * Movies: library/movies/{Title} ({year})/{Title} ({year}).{ext}
 * Shows:  library/shows/{Title}/Season {NN}/{Title} - S{NN}E{NN} - {Episode}.{ext}
 *
 * Sanitising is Windows-first because that is the strictest target: illegal
 * characters, reserved device names, and trailing dots/spaces all break there
 * while passing silently on POSIX.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config, { createLogger } from '../config/index.js';

const log = createLogger('organizer');

const ILLEGAL = /[/\\:*?"<>|]/g;
// C0 control characters are stripped by stripControl(), see below.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Drop C0 control characters (code points below 0x20), which no path may contain. */
function stripControl(value) {
  let out = '';
  for (const char of value) {
    if (char.codePointAt(0) >= 32) out += char;
  }
  return out;
}

/** Strip characters no filesystem will take, then tidy the result. */
export function sanitizeName(name, fallback = 'Untitled') {
  let clean = stripControl(String(name ?? ''))
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // Windows drops trailing dots and spaces

  if (RESERVED.test(clean)) clean = `${clean}_`;
  if (clean.length > 180) clean = clean.slice(0, 180).trim();
  return clean || fallback;
}

export const pad2 = (value) => String(Number(value) || 0).padStart(2, '0');

/** "S01E05" */
export const episodeTag = (season, episode) => `S${pad2(season)}E${pad2(episode)}`;

/** "Title (2023)", or just "Title" when the year is unknown. */
export function movieFolderName(title, year) {
  const clean = sanitizeName(title);
  return year ? `${clean} (${year})` : clean;
}

export function movieFolder(title, year) {
  return path.join(config.moviesPath, movieFolderName(title, year));
}

export function showFolder(title) {
  return path.join(config.showsPath, sanitizeName(title));
}

export function seasonFolder(title, season) {
  return path.join(showFolder(title), `Season ${pad2(season)}`);
}

/** Normalise an extension from a filename or URL; falls back to .mkv. */
export function extensionFrom(source, fallback = '.mkv') {
  if (!source) return fallback;
  const withoutQuery = String(source).split(/[?#]/)[0];
  const ext = path.extname(withoutQuery).toLowerCase();
  return config.videoExtensions.includes(ext) ? ext : fallback;
}

/**
 * Absolute destination for a finished download.
 *
 * @param {object} item
 * @param {'movie'|'episode'} item.type
 * @param {string} item.title           Movie title, or show title for episodes
 * @param {number} [item.year]
 * @param {number} [item.season]
 * @param {number} [item.episode]
 * @param {string} [item.episodeTitle]
 * @param {string} [item.ext]           Defaults to .mkv
 */
export function targetPath(item) {
  const ext = item.ext || '.mkv';

  if (item.type === 'episode') {
    const show = sanitizeName(item.title);
    const parts = [show, episodeTag(item.season, item.episode)];
    if (item.episodeTitle) parts.push(sanitizeName(item.episodeTitle));
    return path.join(seasonFolder(item.title, item.season), `${parts.join(' - ')}${ext}`);
  }

  const folder = movieFolder(item.title, item.year);
  return path.join(folder, `${movieFolderName(item.title, item.year)}${ext}`);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append " (2)", " (3)"… rather than overwrite an existing file. */
export function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);

  for (let n = 2; n < 1000; n += 1) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * Move a finished temp file into the library.
 *
 * rename() is atomic but fails across volumes (EXDEV) — common when temp/ and
 * library/ sit on different drives — so it falls back to copy + unlink.
 */
export async function moveInto(sourcePath, destinationPath) {
  const finalPath = uniquePath(destinationPath);
  ensureDir(path.dirname(finalPath));

  try {
    await fsp.rename(sourcePath, finalPath);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    log.debug(`cross-device move, copying instead: ${path.basename(sourcePath)}`);
    await fsp.copyFile(sourcePath, finalPath);
    await fsp.unlink(sourcePath);
  }

  return finalPath;
}

/**
 * Guard for anything that takes a path from the client (/api/stream, /api/subs).
 * Resolves symlinks so a link inside the library cannot point outside it.
 */
export function isInsideLibrary(candidate) {
  if (!candidate) return false;

  try {
    const root = fs.realpathSync(config.libraryPath);

    // Resolve the nearest ancestor that exists, then re-attach the rest. A file
    // that is missing is still *inside* the library, and the caller should get
    // a 404 for it rather than a misleading 403.
    let existing = path.resolve(candidate);
    const trailing = [];

    for (;;) {
      try {
        existing = fs.realpathSync(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return false; // walked past the drive root
        trailing.unshift(path.basename(existing));
        existing = parent;
      }
    }

    const resolved = path.resolve(existing, ...trailing);
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export default {
  sanitizeName,
  pad2,
  episodeTag,
  movieFolderName,
  movieFolder,
  showFolder,
  seasonFolder,
  extensionFrom,
  targetPath,
  ensureDir,
  uniquePath,
  moveInto,
  isInsideLibrary
};
