/**
 * The audio and subtitle track someone chose, remembered per title.
 *
 * The point is the second episode: pick the Japanese audio and the English
 * subtitles once, and the rest of the season opens that way.
 *
 * Nothing is stored as an index. Embedded stream numbering is a property of
 * how a particular file was muxed, not of the show - one release puts the
 * commentary second, the next puts it fifth - so an index carried from one
 * episode to the next selects whatever happens to sit in that slot. What is
 * stored is what identifies the track to a person: its language and where it
 * came from. Matching that back to a real track list is public/js/track-prefs.js,
 * which is browser-safe because the player is what does the matching.
 */
import { db } from './index.js';

const stmt = {
  get: db.prepare('SELECT * FROM track_prefs WHERE key = ?'),
  upsert: db.prepare(`
    INSERT INTO track_prefs (key, audio_lang, audio_index, subtitle_off, subtitle_lang, subtitle_src, updated_at)
    VALUES (@key, @audio_lang, @audio_index, @subtitle_off, @subtitle_lang, @subtitle_src, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      audio_lang = excluded.audio_lang,
      audio_index = excluded.audio_index,
      subtitle_off = excluded.subtitle_off,
      subtitle_lang = excluded.subtitle_lang,
      subtitle_src = excluded.subtitle_src,
      updated_at = excluded.updated_at
  `),
  remove: db.prepare('DELETE FROM track_prefs WHERE key = ?')
};

export function getTrackPrefs(key) {
  const row = key ? stmt.get.get(key) : null;
  if (!row) return null;
  return {
    audioLang: row.audio_lang || null,
    audioIndex: row.audio_index === null ? null : Number(row.audio_index),
    subtitleOff: row.subtitle_off === 1,
    subtitleLang: row.subtitle_lang || null,
    subtitleSource: row.subtitle_src || null,
    updatedAt: row.updated_at
  };
}

export function saveTrackPrefs(key, prefs = {}) {
  if (!key) return null;
  stmt.upsert.run({
    key,
    audio_lang: prefs.audioLang ?? null,
    audio_index: Number.isInteger(prefs.audioIndex) ? prefs.audioIndex : null,
    subtitle_off: prefs.subtitleOff ? 1 : 0,
    subtitle_lang: prefs.subtitleLang ?? null,
    subtitle_src: prefs.subtitleSource ?? null,
    updated_at: Date.now()
  });
  return getTrackPrefs(key);
}

export function forgetTrackPrefs(key) {
  if (key) stmt.remove.run(key);
}

export default { getTrackPrefs, saveTrackPrefs, forgetTrackPrefs };
