/** Small DOM helpers shared by the host and member views. */

export const $ = (id) => document.getElementById(id);

let toastTimer = 0;

export function toast(message, kind = "info") {
    const el = $("toast");
    if (!el) return;
    el.textContent = String(message || "");
    const palette = {
        error: "border-rose-500/40 bg-rose-950/95 text-rose-100",
        success: "border-emerald-500/40 bg-emerald-950/95 text-emerald-100",
        info: "border-slate-600/80 bg-slate-900/95 text-slate-100",
    };
    el.className = `pointer-events-none fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-xl border px-5 py-3 text-xs font-semibold shadow-2xl ${palette[kind] || palette.info}`;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.add("hidden"), 3200);
}

export function showView(name) {
    for (const view of ["landing", "host", "member"]) {
        const el = $(`view-${view}`);
        if (el) el.classList.toggle("hidden", view !== name);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
}

export function setStatusBadge(id, label, tone = "muted") {
    const el = $(id);
    if (!el) return;
    const tones = {
        muted: "bg-slate-800/80 text-slate-400",
        good: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/25",
        warn: "bg-amber-500/10 text-amber-300 border border-amber-500/25",
        bad: "bg-rose-500/10 text-rose-300 border border-rose-500/25",
    };
    el.className = `rounded-full px-3 py-1 text-[10px] font-bold ${tones[tone] || tones.muted}`;
    el.textContent = label;
}

export function showError(id, message) {
    const el = $(id);
    if (!el) return;
    if (!message) {
        el.textContent = "";
        el.classList.add("hidden");
        return;
    }
    el.textContent = message;
    el.classList.remove("hidden");
}

export function fmtTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function fmtBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${value} B`;
}

function memberRow(name, { host = false, self = false } = {}) {
    const row = document.createElement("li");
    row.className = "flex items-center justify-between gap-3 rounded-lg bg-slate-900/40 px-3 py-2";

    const left = document.createElement("span");
    left.className = "flex min-w-0 items-center gap-2";

    const dot = document.createElement("span");
    dot.className = host
        ? "h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400"
        : "h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400";
    left.appendChild(dot);

    const label = document.createElement("span");
    label.className = "truncate text-xs text-slate-300";
    label.textContent = name;
    left.appendChild(label);
    row.appendChild(left);

    if (host || self) {
        const badge = document.createElement("span");
        badge.className = host
            ? "shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-bold text-sky-300"
            : "shrink-0 rounded bg-slate-700/40 px-1.5 py-0.5 text-[9px] font-bold text-slate-400";
        badge.textContent = host ? "房主" : "我";
        row.appendChild(badge);
    }
    return row;
}

export function renderMembers(listEl, members, options = {}) {
    if (!listEl) return;
    listEl.replaceChildren();
    const hostName = options.hostName;
    const selfId = options.selfId;
    if (hostName) listEl.appendChild(memberRow(hostName, { host: true }));

    const list = Array.isArray(members) ? members : [];
    for (const member of list) {
        if (!member || !member.name) continue;
        if (options.hideSelf && selfId && member.id === selfId) continue;
        listEl.appendChild(memberRow(member.name, { self: member.id === selfId }));
    }
    if (!listEl.children.length) {
        const empty = document.createElement("li");
        empty.className = "text-xs italic text-slate-600";
        empty.textContent = options.emptyText || "暂无成员";
        listEl.appendChild(empty);
    }
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {
            ok = false;
        }
        area.remove();
        return ok;
    }
}
