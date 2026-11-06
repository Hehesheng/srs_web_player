/**
 * HLS glue for the transcoded path.
 *
 * Jellyfin hands us an event playlist that grows while the movie is encoded,
 * so this is live playback, not a fixed duration media element.  Everything
 * keeps the video's own clock (relative to the start of the transcode); the
 * caller adds `media_start` when it needs a wall-clock position.
 */

const attached = new WeakMap();

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

/**
 * Play `url` on `video`, using hls.js when the browser needs it.
 *
 * Returns the hls.js instance, or null when playback falls back to the
 * element's own HLS support (Safari, iOS).
 */
export function attachHls(video, url, { onError } = {}) {
    detachHls(video);
    if (!video || !url) return null;

    if (!hlsSupported()) {
        // Safari plays the playlist itself; there is nothing to drive.
        video.src = url;
        video.load();
        return null;
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
            try {
                instance.recoverMediaError();
                return;
            } catch {
                // fall through to giving up
            }
        }
        detachHls(video);
        if (onError) onError(data);
    });

    instance.loadSource(url);
    instance.attachMedia(video);
    return instance;
}
