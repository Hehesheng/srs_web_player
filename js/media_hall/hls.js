/**
 * HLS glue for the transcoded path.
 *
 * Jellyfin hands us an event playlist that grows while the movie is encoded,
 * so this is live playback, not a fixed duration media element.  Everything
 * keeps the video's own clock (relative to the start of the transcode); the
 * caller adds `media_start` when it needs a wall-clock position.
 *
 * Media Source does the demuxing wherever it exists -- including iOS 17.1+,
 * which exposes ManagedMediaSource for exactly this.  That matters more than it
 * looks: with Media Source the same code path plays everywhere, while the
 * element's own HLS support hands the viewer to the system player, whose
 * pipeline behaves differently (it downloads a VOD playlist the way a
 * progressive file is fetched, ignores `playbackRate`, and hitches on its own
 * schedule).  Phones whose Media Source misbehaves still fall back to the
 * element, which is why nothing here gives up on the stream for good.
 */

const attached = new WeakMap();
// Elements whose Media Source session died: they keep playing the playlist
// natively for the rest of the page's life, because flipping back and forth
// would stall the picture on every retry.  A reload starts fresh.
const nativeOnly = new WeakSet();
// A Media Source session gets one repair attempt; a second fatal media error
// means the engine is not going to survive on this device.
const mediaRepaired = new WeakSet();

export function hlsSupported() {
    return Boolean(window.Hls && window.Hls.isSupported());
}

export function hlsAttached(video) {
    return Boolean(video && attached.has(video));
}

/** Tear the current stream down and leave the element with no source. */
export function detachHls(video) {
    if (!video) return;
    const entry = attached.get(video);
    attached.delete(video);
    if (entry) {
        try {
            entry.instance.destroy();
        } catch {
            // already destroyed
        }
    }
    try {
        video.pause();
    } catch {
        // ignore
    }
    video.removeAttribute("src");
    try {
        video.load();
    } catch {
        // ignore
    }
}

/** Devices whose only Media Source is the managed one (iOS Safari). */
function managedOnly() {
    return Boolean(window.ManagedMediaSource) && !window.MediaSource;
}

/**
 * Hand the playlist to the element's own HLS pipeline.
 *
 * The safety net rather than the default: the system player fetches a growing
 * VOD playlist the way it fetches a file, ignores `playbackRate`, and paces
 * itself on its own schedule.  A phone that cannot hold a Media Source session
 * open still gets a picture this way, which beats an error card.
 */
function playNative(video, url) {
    nativeOnly.add(video);
    video.src = url;
    video.load();
    return null;
}

/**
 * Play `url` on `video`, using hls.js when the browser needs it.
 *
 * Returns the hls.js instance, or null when playback falls back to the
 * element's own HLS support (old Safari, a phone that lost its session).
 */
export function attachHls(video, url, { onError } = {}) {
    detachHls(video);
    if (!video || !url) return null;

    if (!hlsSupported() || nativeOnly.has(video)) {
        // No Media Source here, or this element already lost its session once.
        return playNative(video, url);
    }

    const Hls = window.Hls;
    const instance = new Hls({
        // Stay close to the encoder: the host is the timing authority and the
        // playlist only holds a handful of segments.
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 8,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 6,
        fragLoadingTimeOut: 45000,
        fragLoadingMaxRetry: 6,
        startPosition: -1,
        enableWorker: true,
    });
    attached.set(video, { instance });

    instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal) return;
        // A restarted transcode briefly 404s a segment; recovering is cheaper
        // than tearing the whole stream down and rebuilding it.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try {
                instance.startLoad();
                return;
            } catch {
                // fall through to giving up
            }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // One repair, once.  A second fatal media error on a phone whose
            // only Media Source is the managed one means this engine is not
            // going to survive there; drop to the element rather than the
            // error card the caller would show.
            if (mediaRepaired.has(video)) {
                if (managedOnly()) {
                    detachHls(video);
                    return playNative(video, url);
                }
            } else {
                try {
                    mediaRepaired.add(video);
                    instance.recoverMediaError();
                    return;
                } catch {
                    // fall through to giving up
                }
            }
        }
        detachHls(video);
        if (onError) onError(data);
    });

    instance.loadSource(url);
    instance.attachMedia(video);
    return instance;
}
