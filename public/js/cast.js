/**
 * Chromecast.
 *
 * AirPlay is a button the browser draws once Safari sees a receiver; this is
 * not that. A Chromecast is told a URL and fetches it itself, so the whole
 * feature is: load Google's sender SDK, ask the server for a link the receiver
 * can actually reach, and hand it over.
 *
 * Everything here is defensive about the SDK not being there. It is a script
 * from gstatic that only loads when casting is switched on, only in Chromium,
 * and only over a secure context or plain http on the LAN — so "not available"
 * is the ordinary case rather than an error, and nothing in the player may
 * depend on it having worked.
 */
import * as api from './api.js';

const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

/** The one receiver worth defaulting to: it plays what a browser plays. */
const DEFAULT_RECEIVER = 'CC1AD845';

let loading = null;
let available = false;

/**
 * Load the SDK once, and resolve false rather than throwing when it will not.
 *
 * The SDK announces itself through a global callback rather than a promise, so
 * this waits for that and gives up after a few seconds — a script that never
 * calls back is indistinguishable from one that is simply blocked.
 */
function loadSdk() {
  if (loading) return loading;

  loading = new Promise((resolve) => {
    if (window.cast?.framework) return resolve(true);

    const timer = setTimeout(() => resolve(false), 6000);

    window.__onGCastApiAvailable = (isAvailable) => {
      clearTimeout(timer);
      resolve(Boolean(isAvailable));
    };

    const script = document.createElement('script');
    script.src = SDK_URL;
    script.onerror = () => { clearTimeout(timer); resolve(false); };
    document.head.appendChild(script);
    return undefined;
  });

  return loading;
}

/**
 * Is casting possible here?
 *
 * Both halves have to be true and they fail for unrelated reasons: the server
 * has to be listening somewhere a Chromecast can reach, and this browser has
 * to be able to talk to one.
 */
export async function isAvailable() {
  const status = await api.getCastStatus().catch(() => null);
  if (!status?.enabled) return false;

  available = await loadSdk();
  if (!available) return false;

  try {
    window.cast.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: DEFAULT_RECEIVER,
      // Ending the session when the page goes away would stop playback the
      // moment someone locks their phone, which is the opposite of casting.
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    return true;
  } catch {
    return false;
  }
}

/** What the receiver can decode, which is not what this browser can. */
function receiverCapabilities(session) {
  try {
    const device = session?.getCastDevice?.();
    const model = String(device?.friendlyName || '');
    // Deliberately coarse. The SDK does not report codec support, and the one
    // distinction that matters is old device or not — everything since the
    // Ultra decodes HEVC, everything before it does not.
    const modern = /Ultra|Google TV|Chromecast HD|Nest Hub/i.test(model);
    return { hevc: modern, ac3: modern };
  } catch {
    return { hevc: false, ac3: false };
  }
}

/**
 * Cast one file, from a position.
 *
 * Throws with something worth reading: every failure here happens on a device
 * across the room, so the message is the only diagnostic anyone gets.
 */
export async function cast(filePath, { title = '', subtitle = '', poster = '', currentTime = 0 } = {}) {
  if (!available && !(await isAvailable())) {
    throw new Error('Casting is not available here.');
  }

  const context = window.cast.framework.CastContext.getInstance();
  await context.requestSession();

  const session = context.getCurrentSession();
  if (!session) throw new Error('No Chromecast was chosen.');

  const media = await api.getCastMedia(filePath, receiverCapabilities(session));

  const info = new window.chrome.cast.media.MediaInfo(media.url, media.contentType);
  info.streamType = window.chrome.cast.media.StreamType.BUFFERED;
  if (media.duration) info.duration = media.duration;

  const metadata = new window.chrome.cast.media.GenericMediaMetadata();
  metadata.title = title;
  metadata.subtitle = subtitle;
  if (poster) metadata.images = [new window.chrome.cast.Image(poster)];
  info.metadata = metadata;

  if (media.subtitles?.length > 0) {
    info.tracks = media.subtitles.map((entry) => {
      const track = new window.chrome.cast.media.Track(entry.id, window.chrome.cast.media.TrackType.TEXT);
      track.trackContentId = entry.url;
      track.trackContentType = 'text/vtt';
      track.subtype = window.chrome.cast.media.TextTrackType.SUBTITLES;
      track.language = entry.lang;
      track.name = entry.lang.toUpperCase();
      return track;
    });
  }

  const request = new window.chrome.cast.media.LoadRequest(info);
  // Picking up where the viewer is, rather than at the beginning: casting
  // mid-film is the common case, not the exception.
  request.currentTime = Math.max(0, Math.floor(currentTime));
  request.autoplay = true;

  await session.loadMedia(request);
  return { mode: media.mode, device: session.getCastDevice?.()?.friendlyName || 'Chromecast' };
}

/** Stop casting and leave the receiver idle. */
export async function stop() {
  try {
    const context = window.cast?.framework?.CastContext.getInstance();
    await context?.endCurrentSession(true);
  } catch {
    // Already gone, or never started.
  }
}

/** Is something casting right now? */
export function isCasting() {
  try {
    const state = window.cast?.framework?.CastContext.getInstance().getCastState();
    return state === window.cast.framework.CastState.CONNECTED;
  } catch {
    return false;
  }
}

export default { isAvailable, cast, stop, isCasting };
