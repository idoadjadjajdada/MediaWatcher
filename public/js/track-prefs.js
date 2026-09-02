/**
 * Matching a remembered track choice against the file being opened.
 *
 * A preference is stored as language and source, never as an index, because
 * embedded stream numbering belongs to the file rather than the show: one
 * release muxes the commentary second, the next muxes it fifth, and an index
 * carried between episodes selects whatever happens to sit in that slot.
 *
 * So the stored choice has to be matched back to a real track list every time
 * a file opens, which is what this does. Pure and browser-safe on purpose -
 * the player is what applies the result, and the server only stores it.
 */

const sameLang = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The key a title's preferences live under.
 *
 * Per show rather than per season: which language you watch in is a decision
 * about the show, and remaking it at every season premiere would be the same
 * annoyance this exists to remove.
 */
export function prefsKey(located) {
  if (!located || !located.item?.tmdb_id) return null;
  return located.type === 'episode'
    ? `show:${located.item.tmdb_id}`
    : `movie:${located.item.tmdb_id}`;
}

/**
 * Which audio track index to use, or null to leave the default alone.
 *
 * Language first. The stored index is a fallback only for a choice that had no
 * language to record, and only when it still points inside this file's list -
 * a five-track episode followed by a two-track one must not select nothing.
 */
export function matchAudio(prefs, tracks) {
  if (!prefs || !Array.isArray(tracks) || tracks.length === 0) return null;

  if (prefs.audioLang) {
    const index = tracks.findIndex((track) => sameLang(track.language, prefs.audioLang));
    // A language that was recorded and is now absent means no opinion, not a
    // fallback to a position: that would select a track nobody chose, quietly.
    return index === -1 ? null : index;
  }

  if (Number.isInteger(prefs.audioIndex) && prefs.audioIndex >= 0 && prefs.audioIndex < tracks.length) {
    return prefs.audioIndex;
  }

  return null;
}

/**
 * Which subtitle track to use.
 *
 * Three outcomes, deliberately distinct: an index into `tracks`, `-1` for
 * "deliberately off", and `null` for "no opinion, keep the default". Someone
 * who switched subtitles off wants them off on the next episode too, which is
 * not the same as never having chosen.
 */
export function matchSubtitle(prefs, tracks) {
  if (!prefs) return null;
  if (prefs.subtitleOff) return -1;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  if (!prefs.subtitleLang && !prefs.subtitleSource) return null;

  // Both, then language, then source. A language match from the other source
  // is still the right subtitle; a source match in another language is not,
  // so source alone only decides when no language was ever recorded.
  const exact = tracks.findIndex((track) =>
    sameLang(track.lang, prefs.subtitleLang) && track.source === prefs.subtitleSource);
  if (exact !== -1) return exact;

  if (prefs.subtitleLang) {
    const byLang = tracks.findIndex((track) => sameLang(track.lang, prefs.subtitleLang));
    // The remembered language is genuinely absent. Falling through to "any
    // subtitle" would start Spanish at someone who asked for English.
    return byLang === -1 ? null : byLang;
  }

  const bySource = tracks.findIndex((track) => track.source === prefs.subtitleSource);
  return bySource === -1 ? null : bySource;
}

/** The stored shape for a chosen audio track. */
export function describeAudio(tracks, index) {
  const track = Array.isArray(tracks) ? tracks[index] : null;
  return {
    audioLang: track?.language || null,
    audioIndex: Number.isInteger(index) ? index : null
  };
}

/** The stored shape for a chosen subtitle track, or for turning them off. */
export function describeSubtitle(track) {
  if (!track) return { subtitleOff: true, subtitleLang: null, subtitleSource: null };
  return {
    subtitleOff: false,
    subtitleLang: track.lang || null,
    subtitleSource: track.source || null
  };
}

export default { prefsKey, matchAudio, matchSubtitle, describeAudio, describeSubtitle };
