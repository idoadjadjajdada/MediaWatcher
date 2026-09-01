/**
 * The playlist, computed rather than observed.
 *
 * Pure arithmetic on the duration ffprobe already gave us, so the whole
 * playlist exists before the encoder has produced anything. That is what makes
 * the scrub bar accurate from the first frame and what lets the encoder be
 * restarted at any segment without the player noticing — the timeline is ours,
 * not ffmpeg's.
 */

/**
 * Six seconds is the usual HLS compromise: short enough that a seek only wastes
 * a few seconds of encoding, long enough that a two-hour film does not need
 * thousands of playlist entries.
 */
export const SEGMENT_SECONDS = 6;

const usable = (duration) => (Number.isFinite(duration) && duration > 0 ? duration : 0);

/** How many segments a file of this duration is cut into. */
export function segmentCount(duration) {
  const seconds = usable(duration);
  if (seconds === 0) return 0;
  return Math.ceil(seconds / SEGMENT_SECONDS);
}

/**
 * The length of one segment. Every segment is SEGMENT_SECONDS except the last,
 * which carries whatever is left — if it claimed a full length the playlist
 * would overrun the file and the scrub bar would be wrong at the end.
 */
export function segmentDuration(index, duration) {
  const seconds = usable(duration);
  const count = segmentCount(seconds);
  if (index < 0 || index >= count) return 0;

  const remaining = seconds - (index * SEGMENT_SECONDS);
  return remaining >= SEGMENT_SECONDS ? SEGMENT_SECONDS : remaining;
}

/** The complete VOD playlist for a session. */
export function buildPlaylist(sessionId, duration) {
  const count = segmentCount(duration);

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    '#EXT-X-MEDIA-SEQUENCE:0'
  ];

  for (let index = 0; index < count; index += 1) {
    lines.push(`#EXTINF:${segmentDuration(index, duration).toFixed(6)},`);
    lines.push(`/api/hls/${sessionId}/${index}.ts`);
  }

  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

export default { SEGMENT_SECONDS, segmentCount, segmentDuration, buildPlaylist };
