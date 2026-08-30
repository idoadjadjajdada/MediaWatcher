/**
 * Release-title quality scoring.
 *
 * The formula is the one from the spec, with one deliberate change: the CAM /
 * telesync patterns are anchored to token boundaries. A bare /ts|tc|cam/i test
 * matches inside ordinary words — "Ghosts", "Watchmen", "Camelot" — and would
 * hand a -2.0 penalty to legitimate releases. Anchoring keeps the intent
 * (punish cams) without the false positives. Every other term is tested
 * exactly as written.
 */

/** Matches only when the token stands alone: "Movie.2023.TS.x264" but not "Ghosts". */
const CAM_PATTERN = /(?:^|[^a-z0-9])(?:cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|hdtc)(?:[^a-z0-9]|$)/i;

const RESOLUTION_4K = /2160p|4k|remux/i;
const RESOLUTION_1080 = /1080p/i;
const RESOLUTION_720 = /720p/i;
const RESOLUTION_SD = /480p|sd/i;

const SOURCE_BLURAY = /bluray|bdrip|bdremux/i;
const SOURCE_WEBDL = /web-dl|webdl/i;
const SOURCE_WEBRIP = /webrip/i;
const SOURCE_HDTV = /hdtv/i;

const CODEC_HEVC = /x265|hevc|h\.?265/i;
const CODEC_AVC = /x264|h\.?264|av1/i;

const AI_UPSCALE = /ai.?upscale|ai.?enhanced|ai.?remaster/i;
const ANY_UPSCALE = /upscale/i;
const NATIVE_HINT = /native|real/i;
const REMUX = /remux/i;

const UNDERSIZED_REMUX_BYTES = 5_000_000_000;

/** "4.2 GB" — 1024-based, which is how trackers report sizes. */
export function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 'Unknown';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

/** Quality signals for a release title, independent of scoring. */
export function parseQuality(title, sizeBytes = 0) {
  const text = String(title || '');

  let resolutionRank = 0;
  if (RESOLUTION_4K.test(text)) resolutionRank = 5;
  else if (RESOLUTION_1080.test(text)) resolutionRank = 4;
  else if (RESOLUTION_720.test(text)) resolutionRank = 3;
  else if (RESOLUTION_SD.test(text)) resolutionRank = 2;

  let sourceBonus = 0;
  let sourceLabel = null;
  if (SOURCE_BLURAY.test(text)) { sourceBonus = 0.5; sourceLabel = 'BluRay'; }
  else if (SOURCE_WEBDL.test(text)) { sourceBonus = 0.3; sourceLabel = 'WEB-DL'; }
  else if (SOURCE_WEBRIP.test(text)) { sourceBonus = 0.2; sourceLabel = 'WEBRip'; }
  else if (SOURCE_HDTV.test(text)) { sourceBonus = 0; sourceLabel = 'HDTV'; }
  else if (CAM_PATTERN.test(text)) { sourceBonus = -2.0; sourceLabel = 'CAM'; }

  let codecBonus = 0;
  if (CODEC_HEVC.test(text)) codecBonus = 0.1;
  else if (CODEC_AVC.test(text)) codecBonus = 0;

  const isAiUpscale = AI_UPSCALE.test(text);
  const isPlainUpscale = !isAiUpscale && ANY_UPSCALE.test(text) && !NATIVE_HINT.test(text);

  let upscalePenalty = 0;
  if (isAiUpscale) upscalePenalty = -1.5;
  else if (isPlainUpscale) upscalePenalty = -1.0;

  // A "remux" far below remux size is almost always a mislabelled re-encode.
  const undersizedRemux = REMUX.test(text) && Number(sizeBytes) > 0 && Number(sizeBytes) < UNDERSIZED_REMUX_BYTES;
  if (undersizedRemux) upscalePenalty -= 0.5;

  return {
    resolutionRank,
    sourceBonus,
    sourceLabel,
    codecBonus,
    upscalePenalty,
    isAiUpscale,
    isPlainUpscale,
    undersizedRemux,
    is_4k: resolutionRank === 5,
    is_1080p: resolutionRank === 4,
    is_720p: resolutionRank === 3,
    is_bluray: SOURCE_BLURAY.test(text),
    is_webdl: SOURCE_WEBDL.test(text),
    is_cam: CAM_PATTERN.test(text)
  };
}

/** Enrich one unified search result with score and display badges. */
export function scoreResult(result) {
  const sizeBytes = Number(result.size_bytes) || 0;
  const seeders = Number(result.seeders) || 0;
  const quality = parseQuality(result.title, sizeBytes);

  const seederBonus = Math.log10(seeders + 1);
  const finalScore = quality.resolutionRank
    + quality.sourceBonus
    + quality.codecBonus
    + quality.upscalePenalty
    + seederBonus;

  const warnings = [];
  if (quality.isAiUpscale) warnings.push('AI Upscale');
  else if (quality.isPlainUpscale) warnings.push('Upscaled');
  if (quality.undersizedRemux) warnings.push('Undersized REMUX');

  const qualityBadge = quality.is_4k ? '4K'
    : quality.is_1080p ? '1080p'
      : quality.is_720p ? '720p'
        : 'SD';

  return {
    ...result,
    size_bytes: sizeBytes,
    size_human: formatSize(sizeBytes),
    seeders,
    final_score: Number(finalScore.toFixed(4)),
    is_4k: quality.is_4k,
    is_1080p: quality.is_1080p,
    is_720p: quality.is_720p,
    is_bluray: quality.is_bluray,
    is_webdl: quality.is_webdl,
    is_upscaled: quality.upscalePenalty < 0,
    is_cam: quality.is_cam,
    badges: {
      quality: qualityBadge,
      source: quality.sourceLabel,
      warnings
    }
  };
}

/** Score every result and sort best-first. */
export function rankResults(results) {
  return results
    .map(scoreResult)
    .sort((a, b) => b.final_score - a.final_score || b.seeders - a.seeders);
}

export default { rankResults, scoreResult, parseQuality, formatSize };
