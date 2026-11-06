/**
 * Matroska (MKV) reader.
 *
 * Two jobs:
 *  - say which codecs a file holds, so a playback failure can name the reason
 *    instead of showing a blank player;
 *  - pull out text subtitle tracks, which Chrome never exposes through
 *    `video.textTracks`.
 *
 * MKV interleaves everything into clusters, so unlike MP4 there is no index to
 * jump to and a full scan is the only way to find the subtitle cue blocks.  The
 * scan only runs for local files, and only after the header shows that there is
 * something worth scanning for.
 */
(function () {
    "use strict";

    var CHUNK_BYTES = 4 * 1024 * 1024;
    var MAX_CUES_PER_TRACK = 20000;
    var MAX_CUE_BYTES = 4096;
    var MAX_TRACKS = 8;

    var ID = {
        EBML: 0x1a45dfa3,
        SEGMENT: 0x18538067,
        SEEKHEAD: 0x114d9b74,
        INFO: 0x1549a966,
        TRACKS: 0x1654ae6b,
        TRACKENTRY: 0xae,
        TRACKNUMBER: 0xd7,
        TRACKTYPE: 0x83,
        CODECID: 0x86,
        LANGUAGE: 0x22b59c,
        LANGUAGEIETF: 0x22b59d,
        NAME: 0x536e,
        FLAGDEFAULT: 0x88,
        CLUSTER: 0x1f43b675,
        TIMESTAMP: 0xe7,
        SIMPLEBLOCK: 0xa3,
        BLOCKGROUP: 0xa0,
        BLOCK: 0xa1,
        BLOCKDURATION: 0x9b,
        CUES: 0x1c53bb6b,
        TAGS: 0x1254c367,
        CHAPTERS: 0x1043a770,
        ATTACHMENTS: 0x1941a469,
        VOID: 0xec,
    };

    // Elements that can only appear directly under Segment.  A cluster with an
    // unknown size ends where one of these starts again.
    var SEGMENT_CHILDREN = new Set([
        ID.CLUSTER,
        ID.CUES,
        ID.TAGS,
        ID.CHAPTERS,
        ID.ATTACHMENTS,
        ID.SEEKHEAD,
        ID.INFO,
        ID.TRACKS,
    ]);

    var VIDEO_CODECS = {
        "V_MPEG4/ISO/AVC": { name: "H.264", playable: true },
        "V_MPEG4/ISO/AVC/ES": { name: "H.264", playable: true },
        "V_MPEGH/ISO/HEVC": { name: "HEVC/H.265", playable: false },
        "V_VP8": { name: "VP8", playable: true },
        "V_VP9": { name: "VP9", playable: true },
        "V_AV1": { name: "AV1", playable: true },
        "V_THEORA": { name: "Theora", playable: false },
        "V_MPEG4/ISO/ASP": { name: "MPEG-4 Part 2", playable: false },
        "V_MPEG2": { name: "MPEG-2", playable: false },
        "V_MPEG1": { name: "MPEG-1", playable: false },
        "V_PRORES": { name: "ProRes", playable: false },
        "V_FFV1": { name: "FFV1", playable: false },
    };

    var AUDIO_CODECS = {
        "A_AAC": { name: "AAC", playable: true },
        "A_OPUS": { name: "Opus", playable: true },
        "A_VORBIS": { name: "Vorbis", playable: true },
        "A_FLAC": { name: "FLAC", playable: true },
        "A_MPEG/L3": { name: "MP3", playable: true },
        "A_AC3": { name: "AC3", playable: false },
        "A_EAC3": { name: "E-AC3", playable: false },
        "A_DTS": { name: "DTS", playable: false },
        "A_TRUEHD": { name: "TrueHD", playable: false },
        "A_MLP": { name: "MLP", playable: false },
        "A_MS/ACM": { name: "ACM 音频", playable: false },
    };

    var SUBTITLE_CODECS = {
        "S_TEXT/UTF8": "srt",
        "S_TEXT/ASCII": "srt",
        "S_TEXT/ASS": "ass",
        "S_TEXT/SSA": "ass",
        "S_ASS": "ass",
        "S_SSA": "ass",
        "D_WEBVTT/SUBTITLES": "webvtt",
        "D_WEBVTT/CAPTIONS": "webvtt",
        "D_WEBVTT/DESCRIPTIONS": "webvtt",
        "D_WEBVTT/METADATA": "webvtt",
    };

    var shared = window.HallEmbeddedSubs || {};
    var normalizeLang = shared.normalizeLang || function (code) {
        return code || "und";
    };
    var languageLabel = shared.languageLabel || function (lang) {
        return lang && lang !== "und" ? String(lang).toUpperCase() : "未知语言";
    };
    var formatTime = shared.formatTime || function (seconds) {
        var total = Math.max(0, Math.round(seconds * 1000));
        var ms = total % 1000;
        var s = Math.floor(total / 1000) % 60;
        var m = Math.floor(total / 60000) % 60;
        var h = Math.floor(total / 3600000);
        var pad = function (v) {
            return v < 10 ? "0" + v : String(v);
        };
        return pad(h) + ":" + pad(m) + ":" + pad(s) + "." + String(ms).padStart(3, "0");
    };

    var decoder = new TextDecoder("utf-8");

    function isMkvMedia(media) {
        if (!media) return false;
        var name = String(media.name || "");
        var mime = String(media.mime || "");
        if (/matroska/i.test(mime)) return true;
        return /\.(mkv|mk3d|mka)$/i.test(name);
    }

    // -- byte access ----------------------------------------------------
    function readWindow(reader) {
        var start = 0;
        var buffer = new Uint8Array(0);
        return {
            size: reader.size,
            get: async function (pos, length) {
                if (length <= 0) return new Uint8Array(0);
                var end = Math.min(reader.size, pos + length);
                if (pos >= start && end <= start + buffer.length) {
                    return buffer.subarray(pos - start, end - start);
                }
                var readEnd = Math.min(reader.size, pos + Math.max(CHUNK_BYTES, length));
                buffer = await reader.read(pos, readEnd);
                start = pos;
                return buffer.subarray(0, Math.min(length, buffer.length));
            },
        };
    }

    function fileReader(file) {
        return {
            size: file.size,
            read: function (start, end) {
                return file
                    .slice(start, end)
                    .arrayBuffer()
                    .then(function (buffer) {
                        return new Uint8Array(buffer);
                    });
            },
        };
    }

    // -- EBML primitives ------------------------------------------------
    function idLength(byte) {
        if (byte & 0x80) return 1;
        if (byte & 0x40) return 2;
        if (byte & 0x20) return 3;
        if (byte & 0x10) return 4;
        return 0;
    }

    function sizeLength(byte) {
        for (var length = 1; length <= 8; length += 1) {
            if (byte & (0x80 >> (length - 1))) return length;
        }
        return 0;
    }

    async function readElement(win, pos, limit) {
        var head = await win.get(pos, Math.min(16, limit - pos));
        if (head.length < 2) return null;
        var length = idLength(head[0]);
        if (!length || head.length < length + 1) return null;
        var id = 0;
        for (var i = 0; i < length; i += 1) id = id * 256 + head[i];

        var sizeLen = sizeLength(head[length]);
        if (!sizeLen || head.length < length + sizeLen) return null;
        var value = head[length] & (0xff >> sizeLen);
        var unknown = value === (0xff >> sizeLen);
        for (var s = 1; s < sizeLen; s += 1) {
            value = value * 256 + head[length + s];
            if (head[length + s] !== 0xff) unknown = false;
        }
        var dataStart = pos + length + sizeLen;
        var end = unknown ? limit : dataStart + value;
        if (end > limit) end = limit;
        return { id: id, dataStart: dataStart, end: end, unknown: unknown };
    }

    function readVint(bytes, offset) {
        var length = sizeLength(bytes[offset]);
        if (!length || offset + length > bytes.length) return null;
        var value = bytes[offset] & (0xff >> length);
        for (var i = 1; i < length; i += 1) value = value * 256 + bytes[offset + i];
        return { value: value, length: length };
    }

    async function readUint(win, start, end) {
        var bytes = await win.get(start, end - start);
        var value = 0;
        for (var i = 0; i < bytes.length; i += 1) value = value * 256 + bytes[i];
        return value;
    }

    async function readString(win, start, end) {
        var bytes = await win.get(start, end - start);
        return decoder.decode(bytes).replace(/\u0000+$/, "").trim();
    }

    // -- structure ------------------------------------------------------
    async function findSegment(win) {
        var pos = 0;
        for (var guard = 0; guard < 16 && pos < win.size; guard += 1) {
            var element = await readElement(win, pos, win.size);
            if (!element) return null;
            if (element.id === ID.SEGMENT) return element;
            if (element.end <= pos) return null;
            pos = element.end;
        }
        return null;
    }

    async function parseTrackEntry(win, element) {
        var track = { number: 0, type: 0, codec: "", language: "", languageIetf: "", name: "" };
        var pos = element.dataStart;
        while (pos < element.end) {
            var child = await readElement(win, pos, element.end);
            if (!child) break;
            if (child.id === ID.TRACKNUMBER) {
                track.number = await readUint(win, child.dataStart, child.end);
            } else if (child.id === ID.TRACKTYPE) {
                track.type = await readUint(win, child.dataStart, child.end);
            } else if (child.id === ID.CODECID) {
                track.codec = await readString(win, child.dataStart, child.end);
            } else if (child.id === ID.LANGUAGE) {
                track.language = await readString(win, child.dataStart, child.end);
            } else if (child.id === ID.LANGUAGEIETF) {
                track.languageIetf = await readString(win, child.dataStart, child.end);
            } else if (child.id === ID.NAME) {
                track.name = await readString(win, child.dataStart, child.end);
            }
            if (child.end <= pos) break;
            pos = child.end;
        }
        return track;
    }

    async function parseTracks(win, element) {
        var tracks = [];
        var pos = element.dataStart;
        while (pos < element.end) {
            var child = await readElement(win, pos, element.end);
            if (!child) break;
            if (child.id === ID.TRACKENTRY) tracks.push(await parseTrackEntry(win, child));
            if (child.end <= pos) break;
            pos = child.end;
        }
        return tracks;
    }

    function describe(track) {
        if (track.type === 1) {
            var video = VIDEO_CODECS[track.codec] || { name: track.codec || "未知视频", playable: null };
            return { kind: "video", codec: track.codec, name: video.name, playable: video.playable };
        }
        if (track.type === 2) {
            var audio = AUDIO_CODECS[track.codec] || { name: track.codec || "未知音频", playable: null };
            return { kind: "audio", codec: track.codec, name: audio.name, playable: audio.playable };
        }
        if (track.type === 0x11) {
            var format = SUBTITLE_CODECS[track.codec] || null;
            return {
                kind: "subtitle",
                codec: track.codec,
                name: track.codec,
                format: format,
                playable: null,
            };
        }
        return null;
    }

    function buildInfo(tracks) {
        var info = { video: [], audio: [], subtitles: [] };
        for (var i = 0; i < tracks.length; i += 1) {
            var described = describe(tracks[i]);
            if (!described) continue;
            if (described.kind === "video") info.video.push(described);
            else if (described.kind === "audio") info.audio.push(described);
            else {
                described.number = tracks[i].number;
                described.language = normalizeLang(tracks[i].languageIetf || tracks[i].language);
                described.title = tracks[i].name || "";
                info.subtitles.push(described);
            }
        }
        return info;
    }

    /** Header-only read: what is inside the file, without scanning cues. */
    async function analyze(file) {
        var win = readWindow(fileReader(file));
        var segment = await findSegment(win);
        if (!segment) return null;
        var pos = segment.dataStart;
        while (pos < segment.end) {
            var element = await readElement(win, pos, segment.end);
            if (!element) break;
            if (element.id === ID.TRACKS) {
                var tracks = await parseTracks(win, element);
                return { info: buildInfo(tracks), tracks: tracks };
            }
            if (element.end <= pos) break;
            pos = element.end;
        }
        return null;
    }

    // -- cue scan -------------------------------------------------------
    function decodeAssText(payload) {
        // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
        var parts = payload.split(",");
        var text = parts.length > 8 ? parts.slice(8).join(",") : payload;
        text = text.replace(/\{[^}]*\}/g, "");
        text = text.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ");
        text = text.replace(/\\[a-zA-Z]+[^\\\s]*/g, "");
        return text.trim();
    }

    function decodeWebvtt(payload) {
        // Blocks normally carry the cue text only; some muxers leave the cue
        // header or a WEBVTT line in, and those would nest inside our cue.
        return payload
            .split(/\r?\n/)
            .filter(function (line) {
                var text = line.trim();
                if (!text) return false;
                if (text.toUpperCase() === "WEBVTT") return false;
                return text.indexOf("-->") === -1;
            })
            .join("\n")
            .trim();
    }

    function decodeCue(format, payload) {
        if (format === "ass") return decodeAssText(payload);
        if (format === "webvtt") return decodeWebvtt(payload);
        return payload.replace(/\\[Nn]/g, "\n").trim();
    }

    function escapeCue(text) {
        return text.replace(/&/g, "&amp;").replace(/-->/g, "--&gt;");
    }

    async function collectBlock(win, element, clusterTime, state) {
        var head = await win.get(element.dataStart, Math.min(16, element.end - element.dataStart));
        var track = readVint(head, 0);
        if (!track) return null;
        var offset = track.length;
        if (offset + 3 > head.length) return null;
        var relative = (head[offset] << 8) | head[offset + 1];
        if (relative & 0x8000) relative -= 0x10000;
        var flags = head[offset + 2];
        var lacing = (flags >> 1) & 0x03;
        if (lacing !== 0) return null; // subtitle blocks are never laced in practice
        return {
            number: track.value,
            start: clusterTime + relative,
            textStart: element.dataStart + offset + 3,
            textEnd: element.end,
        };
    }

    async function readCue(win, block, format) {
        var length = block.textEnd - block.textStart;
        if (length <= 0 || length > MAX_CUE_BYTES) return "";
        var bytes = await win.get(block.textStart, length);
        return decodeCue(format, decoder.decode(bytes));
    }

    async function parseBlockGroup(win, element, clusterTime, state) {
        var block = null;
        var duration = null;
        var pos = element.dataStart;
        while (pos < element.end) {
            var child = await readElement(win, pos, element.end);
            if (!child) break;
            if (child.id === ID.BLOCK) {
                block = await collectBlock(win, child, clusterTime, state);
            } else if (child.id === ID.BLOCKDURATION) {
                duration = await readUint(win, child.dataStart, child.end);
            }
            if (child.end <= pos) break;
            pos = child.end;
        }
        if (!block) return;
        await addCue(win, block, duration, state);
    }

    async function addCue(win, block, duration, state) {
        var track = state.byNumber.get(block.number);
        if (!track) return;
        if (track.cues.length >= MAX_CUES_PER_TRACK) return;
        var text = await readCue(win, block, track.format);
        if (!text) return;
        track.cues.push({
            start: Math.max(0, block.start),
            end: duration && duration > 0 ? Math.max(0, block.start) + duration : null,
            text: text,
        });
    }

    async function parseCluster(win, element, limit, state) {
        var pos = element.dataStart;
        var clusterTime = 0;
        var end = element.unknown ? limit : element.end;
        while (pos < end) {
            var child = await readElement(win, pos, end);
            if (!child) break;
            // Only an unknown-size cluster can run into the next one; stop
            // before swallowing an element that belongs to the segment.
            if (SEGMENT_CHILDREN.has(child.id)) return pos;
            if (child.id === ID.TIMESTAMP) {
                clusterTime = await readUint(win, child.dataStart, child.end);
            } else if (child.id === ID.SIMPLEBLOCK) {
                var block = await collectBlock(win, child, clusterTime, state);
                if (block) await addCue(win, block, null, state);
            } else if (child.id === ID.BLOCKGROUP) {
                await parseBlockGroup(win, child, clusterTime, state);
            }
            if (child.end <= pos) break;
            pos = child.end;
        }
        return pos;
    }

    function buildVtt(cues) {
        if (!cues.length) return "";
        cues.sort(function (a, b) {
            return a.start - b.start;
        });
        for (var i = 0; i < cues.length; i += 1) {
            if (cues[i].end === null) {
                var next = cues[i + 1];
                cues[i].end = next && next.start > cues[i].start ? next.start : cues[i].start + 3;
            }
        }
        var lines = ["WEBVTT", ""];
        for (var j = 0; j < cues.length; j += 1) {
            var cue = cues[j];
            if (!(cue.end > cue.start)) continue;
            lines.push(formatTime(cue.start / 1000) + " --> " + formatTime(cue.end / 1000));
            lines.push(escapeCue(cue.text));
            lines.push("");
        }
        return cues.length ? lines.join("\n") : "";
    }

    /**
     * Full scan: read every cluster for the text subtitle tracks in the file.
     * @param {File} file
     * @param {{onProgress?: function(number): void}} [options]
     */
    async function scan(file, options) {
        var settings = options || {};
        var win = readWindow(fileReader(file));
        var segment = await findSegment(win);
        if (!segment) return { info: null, tracks: [] };
        var info = null;
        var trackList = [];
        var state = { byNumber: new Map() };
        var pos = segment.dataStart;
        var limit = segment.end;
        var started = false;

        while (pos < limit) {
            var element = await readElement(win, pos, limit);
            if (!element) break;
            if (element.id === ID.TRACKS) {
                trackList = await parseTracks(win, element);
                info = buildInfo(trackList);
                var usable = info.subtitles.filter(function (item) {
                    return Boolean(item.format);
                });
                for (var i = 0; i < usable.length && i < MAX_TRACKS; i += 1) {
                    state.byNumber.set(usable[i].number, { format: usable[i].format, cues: [] });
                }
                if (!state.byNumber.size) return { info: info, tracks: [] };
            } else if (element.id === ID.CLUSTER && state.byNumber.size) {
                if (!started) {
                    started = true;
                    if (settings.onProgress) settings.onProgress(0);
                }
                pos = await parseCluster(win, element, limit, state);
                if (settings.onProgress) {
                    settings.onProgress(Math.min(1, pos / Math.max(1, limit)));
                }
                continue;
            }
            if (element.end <= pos) break;
            pos = element.end;
        }

        if (!info) return { info: null, tracks: [] };
        var tracks = [];
        for (var t = 0; t < trackList.length; t += 1) {
            var described = info.subtitles.find(function (item) {
                return item.number === trackList[t].number;
            });
            if (!described || !described.format) continue;
            var collected = state.byNumber.get(trackList[t].number);
            if (!collected) continue;
            var vtt = buildVtt(collected.cues);
            if (!vtt) continue;
            var lang = normalizeLang(trackList[t].languageIetf || trackList[t].language);
            var custom = (trackList[t].name || "").trim();
            var label = custom || languageLabel(lang);
            tracks.push({
                lang: lang,
                label: label,
                name: "内嵌 · " + label + ".vtt",
                vtt: vtt,
            });
        }
        return { info: info, tracks: tracks };
    }

    /** Turn codec facts into a sentence for the player UI, or null. */
    function describeUnsupported(info) {
        if (!info) return null;
        var names = function (items) {
            return items
                .map(function (item) {
                    return item.name;
                })
                .join("/");
        };
        var badAudio = (info.audio || []).filter(function (item) {
            return item.playable === false;
        });
        var badVideo = (info.video || []).filter(function (item) {
            return item.playable === false;
        });
        if (!badAudio.length && !badVideo.length) return null;
        var parts = [];
        if (badVideo.length) parts.push("视频是 " + names(badVideo));
        if (badAudio.length) parts.push("音轨是 " + names(badAudio));
        var okVideo = (info.video || []).filter(function (item) {
            return item.playable === true;
        });
        var lead = okVideo.length && !badVideo.length ? "视频（" + names(okVideo) + "）本身没问题，" : "";
        return (
            "这个文件 Chrome 无法解码：" +
            parts.join("，") +
            "。" +
            lead +
            "转成 MP4（H.264 视频 + AAC 音轨）即可播放。"
        );
    }

    window.HallMkv = {
        isMkvMedia: isMkvMedia,
        analyze: analyze,
        scan: scan,
        describeUnsupported: describeUnsupported,
    };
})();
