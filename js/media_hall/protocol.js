/**
 * Wire protocol shared by the hall page, host worker and member client.
 *
 * Control messages are JSON strings.  Media blocks travel as binary frames:
 *
 *   0   4  req_id  uint32 BE
 *   4   4  gen     uint32 BE
 *   8   2  seq     uint16 BE
 *   10  2  flags   uint16 BE   bit0 = final, bit1 = error
 *   12  N  payload
 */

export const MSG = Object.freeze({
    AUTH: "auth",
    AUTH_OK: "auth_ok",
    STATE: "state",
    SEEK: "seek",
    END: "end",
    STATUS: "status",
    PING: "ping",
    PONG: "pong",
    FLOW: "flow",
    READ: "read",
    CANCEL: "cancel",
    ROOM_STATE: "room_state",
    RESYNC: "resync",
    ERROR: "error",
});

export const FLAG_FINAL = 0x0001;
export const FLAG_ERROR = 0x0002;
export const HEADER_SIZE = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeControl(payload) {
    return JSON.stringify(payload);
}

export function decodeControl(text) {
    try {
        const value = JSON.parse(text);
        return value && typeof value === "object" ? value : null;
    } catch {
        return null;
    }
}

export function encodeFrame(reqId, gen, seq, flags, payload = new Uint8Array(0)) {
    const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const buffer = new ArrayBuffer(HEADER_SIZE + body.byteLength);
    const view = new DataView(buffer);
    view.setUint32(0, reqId >>> 0);
    view.setUint32(4, gen >>> 0);
    view.setUint16(8, seq & 0xffff);
    view.setUint16(10, flags & 0xffff);
    new Uint8Array(buffer, HEADER_SIZE).set(body);
    return buffer;
}

export function decodeFrame(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_SIZE) return null;
    const view = new DataView(data);
    return {
        reqId: view.getUint32(0),
        gen: view.getUint32(4),
        seq: view.getUint16(8),
        flags: view.getUint16(10),
        payload: new Uint8Array(data, HEADER_SIZE),
    };
}

/** Build a ws:// or wss:// URL for a same-origin path. */
export function websocketUrl(path) {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${window.location.host}${path}`;
}

/** Accept either a bare room code or a full share link. */
export function parseRoomRef(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    try {
        const url = new URL(value, window.location.href);
        const fromQuery = url.searchParams.get("room");
        if (fromQuery) return fromQuery.trim().toUpperCase();
    } catch {
        // not a URL; fall through
    }
    return value.toUpperCase();
}
