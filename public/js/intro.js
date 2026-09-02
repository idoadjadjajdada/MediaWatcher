/**
 * The browser's half of intro handling: deciding whether to offer the button.
 *
 * Learning happens on the server, where the observations live. This is only
 * "am I inside the intro right now", which the player asks several times a
 * second and must answer without a round trip.
 */

/** Offered slightly early, so the button is there as the intro arrives. */
const OFFER_LEAD_SECONDS = 12;

export function introKey(located) {
  if (!located || located.type !== 'episode') return null;
  const showId = located.item?.tmdb_id;
  if (!showId) return null;
  const season = Number(located.season);
  if (!Number.isFinite(season)) return null;
  return `show:${showId}:s${season}`;
}

export function shouldOfferSkip(marker, position) {
  if (!marker || !Number.isFinite(position)) return false;
  if (!Number.isFinite(marker.start) || !Number.isFinite(marker.end)) return false;
  return position >= marker.start - OFFER_LEAD_SECONDS && position < marker.end;
}

export default { introKey, shouldOfferSkip };
