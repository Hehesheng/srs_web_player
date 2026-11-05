/**
 * Pull embedded subtitle tracks out of an MP4 so they can be offered as normal
 * WebVTT subtitles.
 *
 * Chrome never exposes samples from the container's subtitle track through
 * `video.textTracks`, so the only way to show them is to read them ourselves:
 * find the `moov`, let mp4box.js parse the sample tables, read the sample
 * bytes, and turn each cue into WebVTT.  Only tx3g (mov_text) and WebVTT-in-MP4
 * tracks can be decoded; bitmap and ASS tracks are skipped.
 */
(function () {
    "use strict";

    // The moov is normally a few hundred KB; anything far beyond that is not a
    // file we should pull into memory just to look for subtitles.
    var MAX_MOOV_BYTES = 32 * 1024 * 1024;
    var MAX_SAMPLES_PER_TRACK = 20000;
    var MAX_TRACKS = 4;
    var MAX_READ_BYTES = 64 * 1024 * 1024;
    // Reading nearby samples in one go keeps remote playback to a few requests.
    var RANGE_MERGE_GAP = 256 * 1024;
    var PARSE_TIMEOUT_MS = 20000;

    var LANG_ALIASES = {
        eng: "en",
        en: "en",
        chi: "zh",
        zho: "zh",
        cmn: "zh",
        zh: "zh",
        jpn: "ja",
        ja: "ja",
        kor: "ko",
        ko: "ko",
        fra: "fr",
        fre: "fr",
        fr: "fr",
        deu: "de",
        ger: "de",
        de: "de",
        spa: "es",
        es: "es",
        rus: "ru",
        ru: "ru",
        por: "pt",
        pt: "pt",
        ita: "it",
        it: "it",
        ara: "ar",
        ar: "ar",
        hin: "hi",
        hi: "hi",
        tha: "th",
        th: "th",
        vie: "vi",
        vi: "vi",
        ind: "id",
        id: "id",
        tur: "tr",
        tr: "tr",
        nld: "nl",
        dut: "nl",
        pol: "pl",
        pl: "pl",
        swe: "sv",
        sv: "sv",
        ces: "cs",
        cze: "cs",
        ell: "el",
        gre: "el",
        heb: "he",
        ukr: "uk",
        ms: "ms",
        may: "ms",
    };

    var LANG_LABELS = {
        en: "英语",
        zh: "中文",
        ja: "日语",
        ko: "韩语",
        fr: "法语",
        de: "德语",
        es: "西班牙语",
        ru: "俄语",
        pt: "葡萄牙语",
        it: "意大利语",
        ar: "阿拉伯语",
        hi: "印地语",
        th: "泰语",
        vi: "越南语",
        id: "印尼语",
        tr: "土耳其语",
        nl: "荷兰语",
        pl: "波兰语",
        sv: "瑞典语",
        cs: "捷克语",
        el: "希腊语",
        he: "希伯来语",
        uk: "乌克兰语",
        ms: "马来语",
    };

    var decoder = new TextDecoder("utf-8");

    function normalizeLang(raw) {
        var code = String(raw || "").trim().toLowerCase();
        if (!code || code === "und") return "und";
        var short = LANG_ALIASES[code] || code;
        return /^[a-z]{2,3}$/.test(short) ? short : "und";
    }

    function languageLabel(lang) {
        if (!lang || lang === "und") return "未知语言";
        return LANG_LABELS[lang] || lang.toUpperCase();
    }

    function isMp4Media(media) {
        if (!media) return false;
        var name = String(media.name || "");
        var mime = String(media.mime || "");
        if (/^video\/(mp4|quicktime|x-m4v)$/i.test(mime)) return true;
        return /\.(mp4|m4v|mov)$/i.test(name);
    }

    function readU32(bytes, pos) {
        return (
            ((bytes[pos] << 24) >>> 0) +
            (bytes[pos + 1] << 16) +
            (bytes[pos + 2] << 8) +
            bytes[pos + 3]
        );
    }

    function ascii(bytes, pos, length) {
        var text = "";
        for (var i = 0; i < length && pos + i < bytes.length; i += 1) {
            text += String.fromCharCode(bytes[pos + i]);
        }
        return text;
    }

    // -- byte sources ---------------------------------------------------
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

    function urlReader(url, size) {
        return {
            size: size,
            read: async function (start, end) {
                var response = await fetch(url, {
                    headers: { Range: "bytes=" + start + "-" + (end - 1) },
                });
                if (!response.ok && response.status !== 206) {
                    throw new Error("HTTP " + response.status);
                }
                var buffer = await response.arrayBuffer();
                var bytes = new Uint8Array(buffer);
                // A server that ignores Range hands back the whole file.
                if (response.status === 200 && bytes.length >= end) {
                    return bytes.subarray(start, end);
                }
                return bytes;
            },
        };
    }

    // -- box walking ----------------------------------------------------
    async function readBoxAt(reader, pos) {
        if (pos + 8 > reader.size) return null;
        var head = await reader.read(pos, Math.min(pos + 16, reader.size));
        if (head.length < 8) return null;
        var size = readU32(head, 0);
        var type = ascii(head, 4, 4);
        var headerSize = 8;
        if (size === 1) {
            if (head.length < 16) return null;
            var high = readU32(head, 8);
            var low = readU32(head, 12);
            size = high * 4294967296 + low;
            headerSize = 16;
        } else if (size === 0) {
            size = reader.size - pos;
        }
        if (!size || size < headerSize) return null;
        return { type: type, size: size, headerSize: headerSize, start: pos, end: pos + size };
    }

    // Walk the top level until the movie header shows up, remembering ftyp
    // along the way: mp4box wants a brand before it will report track info.
    async function readMovieHeader(reader) {
        var pos = 0;
        var ftyp = null;
        for (var guard = 0; guard < 64; guard += 1) {
            var box = await readBoxAt(reader, pos);
            if (!box) break;
            if (box.type === "ftyp" && !ftyp) ftyp = box;
            if (box.type === "moov") return { moov: box, ftyp: ftyp };
            if (box.end <= pos) break;
            pos = box.end;
        }
        return null;
    }

    function syntheticFtyp() {
        var bytes = new Uint8Array(16);
        bytes[3] = 16;
        bytes.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
        bytes.set([0x69, 0x73, 0x6f, 0x6d], 8); // isom
        return bytes;
    }

    function concatBytes(parts) {
        var total = 0;
        var i;
        for (i = 0; i < parts.length; i += 1) total += parts[i].length;
        var merged = new Uint8Array(total);
        var offset = 0;
        for (i = 0; i < parts.length; i += 1) {
            merged.set(parts[i], offset);
            offset += parts[i].length;
        }
        return merged;
    }

    // mp4box only parses a stream that starts at byte 0, so the header boxes are
    // replayed from the start.  Sample offsets inside the movie header are
    // absolute file offsets, so they stay valid.
    function parseMovieHeader(ftypBytes, moovBytes) {
        if (typeof MP4Box === "undefined" || !MP4Box || !MP4Box.createFile) {
            return Promise.reject(new Error("mp4box.js 未加载"));
        }
        return new Promise(function (resolve, reject) {
            var file = MP4Box.createFile();
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error("解析超时"));
            }, PARSE_TIMEOUT_MS);
            function done(callback, value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback(value);
            }
            file.onReady = function (info) {
                done(resolve, { file: file, info: info });
            };
            file.onError = function (error) {
                done(reject, new Error(String(error)));
            };
            try {
                var merged = concatBytes([ftypBytes || syntheticFtyp(), moovBytes]);
                var buffer = merged.buffer;
                buffer.fileStart = 0;
                file.appendBuffer(buffer);
                file.flush();
            } catch (error) {
                done(reject, error);
            }
        });
    }

    // -- sample decoding ------------------------------------------------
    function decodeTx3g(bytes) {
        if (bytes.length < 2) return "";
        var length = (bytes[0] << 8) | bytes[1];
        var end = Math.min(bytes.length, 2 + length);
        return decoder.decode(bytes.subarray(2, end)).trim();
    }

    function collectPayl(bytes, start, end) {
        var parts = [];
        var pos = start;
        while (pos + 8 <= end) {
            var size = readU32(bytes, pos);
            var type = ascii(bytes, pos + 4, 4);
            if (size < 8 || pos + size > end) break;
            if (type === "payl") {
                parts.push(decoder.decode(bytes.subarray(pos + 8, pos + size)));
            }
            pos += size;
        }
        return parts.join("\n");
    }

    function decodeWvtt(bytes) {
        var parts = [];
        var pos = 0;
        while (pos + 8 <= bytes.length) {
            var size = readU32(bytes, pos);
            var type = ascii(bytes, pos + 4, 4);
            if (size < 8 || pos + size > bytes.length) break;
            if (type === "vttc") parts.push(collectPayl(bytes, pos + 8, pos + size));
            pos += size;
        }
        return parts.join("\n").trim();
    }

    function decodeSample(codec, bytes) {
        if (codec.indexOf("wvtt") === 0) return decodeWvtt(bytes);
        return decodeTx3g(bytes);
    }

    function isTextTrack(track) {
        var codec = String(track.codec || "").toLowerCase();
        if (codec === "tx3g" || codec === "text" || codec.indexOf("wvtt") === 0) return true;
        return track.type === "subtitles" || track.type === "text";
    }

    async function readSamples(reader, samples) {
        var runs = [];
        var total = 0;
        for (var i = 0; i < samples.length; i += 1) {
            var sample = samples[i];
            var start = sample.offset;
            var end = sample.offset + sample.size;
            if (start < 0 || end > reader.size || end <= start) continue;
            total += end - start;
            if (total > MAX_READ_BYTES) return null;
            var last = runs[runs.length - 1];
            if (last && start >= last.start && start <= last.end + RANGE_MERGE_GAP) {
                last.end = Math.max(last.end, end);
                last.items.push({ sample: sample, start: start, end: end });
            } else {
                runs.push({ start: start, end: end, items: [{ sample: sample, start: start, end: end }] });
            }
        }
        var out = new Map();
        for (var r = 0; r < runs.length; r += 1) {
            var run = runs[r];
            var buffer = await reader.read(run.start, run.end);
            for (var j = 0; j < run.items.length; j += 1) {
                var item = run.items[j];
                var rel = item.start - run.start;
                var size = item.end - item.start;
                if (rel < 0 || rel + size > buffer.length) continue;
                out.set(item.sample, buffer.subarray(rel, rel + size));
            }
        }
        return out;
    }

    function pad(value) {
        return value < 10 ? "0" + value : String(value);
    }

    function formatTime(seconds) {
        var total = Math.max(0, Math.round(seconds * 1000));
        var ms = total % 1000;
        var s = Math.floor(total / 1000) % 60;
        var m = Math.floor(total / 60000) % 60;
        var h = Math.floor(total / 3600000);
        return pad(h) + ":" + pad(m) + ":" + pad(s) + "." + String(ms).padStart(3, "0");
    }

    function buildVtt(track, trackInfo, codec, sampleBytes) {
        // The track object from ISOFile has no timescale; the parsed track info
        // from onReady carries it.
        var timescale = Number(trackInfo.timescale) || 0;
        if (!timescale || !track.samples) return "";
        var lines = ["WEBVTT", ""];
        var cues = 0;
        for (var i = 0; i < track.samples.length; i += 1) {
            var sample = track.samples[i];
            var bytes = sampleBytes.get(sample);
            if (!bytes || !bytes.length) continue;
            var text = decodeSample(codec, bytes);
            if (!text) continue;
            var start = (Number(sample.cts) || 0) / timescale;
            var seconds = (Number(sample.duration) || 0) / timescale;
            if (seconds <= 0) {
                // The final sample often has no duration; run it until the next
                // cue, or keep a readable default.
                var next = track.samples[i + 1];
                seconds = next ? (Number(next.cts) - Number(sample.cts)) / timescale : 0;
            }
            if (!(seconds > 0)) seconds = 2;
            lines.push(formatTime(start) + " --> " + formatTime(start + seconds));
            lines.push(text);
            lines.push("");
            cues += 1;
        }
        return cues ? lines.join("\n") : "";
    }

    /**
     * @param {{file?: File, url?: string, size?: number}} source
     * @returns {Promise<Array<{lang: string, label: string, name: string, vtt: string}>>}
     */
    async function extractSubtitles(source) {
        if (!source) return [];
        if (typeof MP4Box === "undefined") return [];
        var reader = null;
        if (source.file) {
            if (!source.file.size) return [];
            reader = fileReader(source.file);
        } else if (source.url && source.size > 0) {
            reader = urlReader(source.url, source.size);
        }
        if (!reader) return [];

        var header = await readMovieHeader(reader);
        if (!header || !header.moov || header.moov.size > MAX_MOOV_BYTES) return [];
        var moovBytes = await reader.read(header.moov.start, header.moov.end);
        if (!moovBytes.length) return [];
        var ftypBytes = null;
        if (header.ftyp && header.ftyp.size <= 4096) {
            try {
                ftypBytes = await reader.read(header.ftyp.start, header.ftyp.end);
            } catch (error) {
                ftypBytes = null;
            }
        }

        var parsed = await parseMovieHeader(ftypBytes, moovBytes);
        var tracks = (parsed.info.tracks || []).filter(isTextTrack);
        var results = [];
        for (var i = 0; i < tracks.length && results.length < MAX_TRACKS; i += 1) {
            var trackInfo = tracks[i];
            var track = parsed.file.getTrackById(trackInfo.id);
            if (!track || !track.samples || !track.samples.length) continue;
            if (track.samples.length > MAX_SAMPLES_PER_TRACK) continue;
            var codec = String(trackInfo.codec || "").toLowerCase();
            var sampleBytes;
            try {
                sampleBytes = await readSamples(reader, track.samples);
            } catch (error) {
                continue;
            }
            if (!sampleBytes) continue;
            var vtt = buildVtt(track, trackInfo, codec, sampleBytes);
            if (!vtt) continue;
            var lang = normalizeLang(trackInfo.language);
            results.push({
                lang: lang,
                label: languageLabel(lang),
                name: "内嵌 · " + languageLabel(lang) + ".vtt",
                vtt: vtt,
            });
        }
        return results;
    }

    window.HallEmbeddedSubs = {
        isMp4Media: isMp4Media,
        extractSubtitles: extractSubtitles,
        languageLabel: languageLabel,
    };
})();
