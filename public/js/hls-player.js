/**
 * HLS attachment.
 *
 * Safari and iOS play HLS natively through AVFoundation and must be given the
 * playlist directly — handing those a Media Source instead is slower and, on
 * iPhone, unsupported. Everything else goes through hls.js.
 *
 * The library is fetched only when a stream actually needs it, so direct and
 * cached playback never pays for 400KB it will not use.
 */
let libraryPromise = null;

function loadHlsLibrary() {
  if (libraryPromise) return libraryPromise;

  libraryPromise = new Promise((resolve, reject) => {
    // Already present from a previous attach in this page.
    if (window.Hls) return resolve(window.Hls);

    const script = document.createElement('script');
    script.src = '/js/vendor/hls.min.js';
    script.onload = () => (window.Hls
      ? resolve(window.Hls)
      : reject(new Error('the HLS player loaded but did not register')));
    script.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever.
      libraryPromise = null;
      reject(new Error('could not load the HLS player'));
    };
    document.head.appendChild(script);
  });

  return libraryPromise;
}

/** Does this browser play HLS without help? */
export const nativeHls = (video) =>
  Boolean(video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl'));

/**
 * Point a <video> at an HLS playlist.
 * Resolves a detach function that MUST be called before the element is reused,
 * or the previous stream keeps loading segments in the background.
 */
export async function attachHls(video, url, { startPosition = 0 } = {}) {
  /*
   * hls.js is tried first and native is the fallback, which is the opposite of
   * what the naming suggests. Chromium answers canPlayType('...mpegurl') with
   * "maybe" and then fails with MEDIA_ERR_SRC_NOT_SUPPORTED when actually given
   * a playlist, so trusting that check hands Chrome a source it cannot play.
   *
   * Ordering it this way is still correct for iOS: there is no MSE there, so
   * Hls.isSupported() is false and it falls through to the native path, which
   * is the one Apple wants used anyway.
   */
  const Hls = await loadHlsLibrary().catch(() => null);

  if (!Hls?.isSupported()) {
    if (nativeHls(video)) {
      /*
       * Registered before the source is assigned. Metadata can arrive in the
       * same turn, and a listener added afterwards misses it - which is how a
       * resumed episode silently started from the beginning.
       */
      if (startPosition > 0) {
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = startPosition;
        }, { once: true });
      }
      video.src = url;
      return () => { video.removeAttribute('src'); };
    }
    throw new Error('This browser cannot play the converted stream.');
  }

  const instance = new Hls({
    /*
     * Where to begin, handed to the library rather than seeked afterwards.
     * Seeking on loadedmetadata raced the event and lost, and even when it
     * won it made the player fetch the opening segments before jumping.
     */
    startPosition: startPosition > 0 ? startPosition : -1,
    // The playlist is complete from the first request and segments are made on
    // demand, so none of the live-edge machinery applies.
    lowLatencyMode: false,
    /*
     * A segment can take several seconds when the encoder has just restarted
     * after a seek — it has to seek the source and refill before writing
     * anything. The defaults give up long before that and surface as a stall.
     */
    fragLoadingMaxRetry: 8,
    fragLoadingRetryDelay: 1000,
    fragLoadingMaxRetryTimeout: 20000
  });

  instance.loadSource(url);
  instance.attachMedia(video);

  return () => {
    try { instance.destroy(); } catch { /* already torn down */ }
  };
}

export default { attachHls, nativeHls };
