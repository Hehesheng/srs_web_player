/**
 * Jellyfin source for the host view: sign in, browse the library, pick an item.
 *
 * The access token belongs to the host alone.  It is stored in this browser
 * for a week and handed to the room server, which keeps it in memory; members
 * never see it, and the server proxies every byte they play.
 */

const STORAGE_KEY = "hall_jellyfin_session";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 60;

export function storedJellyfinToken() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
        saved = null;
    }
    if (!saved || !saved.token) return null;
    if (saved.exp && Number(saved.exp) < Date.now()) {
        forgetJellyfinToken();
        return null;
    }
    return saved;
}

export function saveJellyfinToken(token, userName, userId) {
    if (!token) return;
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                token,
                user_name: userName || "",
                user_id: userId || "",
                exp: Date.now() + TOKEN_TTL_MS,
            })
        );
    } catch {
        // private mode or full quota: the token simply is not remembered
    }
}

export function forgetJellyfinToken() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

function fmtDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) return "";
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

function fmtBitrate(bits) {
    const value = Number(bits) || 0;
    if (!value) return "";
    return `${Math.round(value / 100000) / 10} Mbps`;
}

export class JellyfinPicker {
    constructor({ request, getRoom, toast, onPick }) {
        this.request = request;
        this.getRoom = getRoom;
        this.toast = toast;
        this.onPick = onPick || (() => {});
        this.libraries = [];
        this.libraryId = "";
        this.query = "";
        this.items = [];
        this.busy = false;
        this.wired = false;
    }

    // -- server calls --------------------------------------------------
    api(path, options = {}) {
        const room = this.getRoom();
        if (!room) return Promise.reject(new Error("房间还没有准备好"));
        return this.request(`/hall/api/rooms/${encodeURIComponent(room.room_id)}${path}`, {
            ...options,
            headers: { "X-Host-Token": room.host_token, ...(options.headers || {}) },
        });
    }

    status() {
        return this.api("/jellyfin/status");
    }

    async signIn(username, password) {
        const data = await this.api("/jellyfin/session", {
            method: "POST",
            body: { username, password },
        });
        this.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        return data;
    }

    async adopt(token, userId) {
        const data = await this.api("/jellyfin/session", {
            method: "POST",
            body: { token, user_id: userId || undefined },
        });
        this.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        return data;
    }

    // -- login row -----------------------------------------------------
    showLogin(show, message = "") {
        const row = document.getElementById("host-jellyfin-login");
        const hint = document.getElementById("host-jellyfin-hint");
        if (!row) return;
        row.classList.toggle("hidden", !show);
        row.classList.toggle("flex", show);
        if (hint) {
            hint.classList.toggle("hidden", !show);
            hint.classList.remove("text-rose-300");
            hint.classList.add("text-slate-500");
            if (message) {
                hint.textContent = message;
                hint.classList.remove("text-slate-500");
                hint.classList.add("text-rose-300");
            } else {
                hint.textContent =
                    "用你的 Jellyfin 账号登录。密码只用于这一次换取令牌，浏览器只记住 7 天有效的访问令牌。";
            }
        }
        if (show) {
            const user = document.getElementById("host-jellyfin-user");
            if (user && !user.value) user.focus();
        }
    }

    /** Called when the host picks "Jellyfin" from the add-media menu. */
    async begin() {
        const room = this.getRoom();
        if (!room) return;
        this.wire();
        let state;
        try {
            state = await this.status();
        } catch (error) {
            this.toast(error.message || "无法连接媒体厅服务", "error");
            return;
        }
        if (!state.enabled) {
            this.toast("这台服务器的媒体厅没有启用 Jellyfin 源", "error");
            return;
        }
        if (state.authenticated) {
            this.showLogin(false);
            const known = storedJellyfinToken();
            if (known) {
                // Re-reads the library list for the dropdown; a failure here
                // only costs the picker, not the session the room already has.
                try {
                    await this.adopt(known.token, known.user_id);
                } catch {
                    // ignore
                }
            }
            await this.open();
            return;
        }
        const saved = storedJellyfinToken();
        if (saved) {
            try {
                await this.adopt(saved.token, saved.user_id);
                await this.open();
                return;
            } catch (error) {
                // The token expired or was revoked on the Jellyfin side.
                forgetJellyfinToken();
                this.showLogin(true, error.message || "记住的登录已失效，请重新登录");
                return;
            }
        }
        this.showLogin(true);
    }

    async submitLogin() {
        const userInput = document.getElementById("host-jellyfin-user");
        const passInput = document.getElementById("host-jellyfin-pass");
        const button = document.getElementById("btn-jellyfin-login");
        if (!userInput || !passInput || !button || button.disabled) return;
        const username = (userInput.value || "").trim();
        const password = passInput.value || "";
        if (!username || !password) {
            this.showLogin(true, "请填写用户名和密码");
            return;
        }
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "登录中…";
        try {
            const data = await this.signIn(username, password);
            // Only the token is remembered; the password is dropped right here.
            passInput.value = "";
            if (data.token) {
                saveJellyfinToken(
                    data.token,
                    data.jellyfin && data.jellyfin.user_name,
                    data.jellyfin && data.jellyfin.user_id
                );
            }
            this.showLogin(false);
            const name = (data.jellyfin && data.jellyfin.user_name) || username;
            this.toast(`已登录 Jellyfin：${name}`, "success");
            await this.open();
        } catch (error) {
            this.showLogin(true, error.message || "登录失败");
        } finally {
            button.disabled = false;
            button.textContent = label;
        }
    }

    // -- browser overlay -----------------------------------------------
    wire() {
        if (this.wired) return;
        this.wired = true;
        const on = (id, event, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener(event, handler);
        };
        on("btn-jellyfin-login", "click", () => this.submitLogin());
        on("btn-jellyfin-cancel", "click", () => this.showLogin(false));
        on("host-jellyfin-pass", "keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.submitLogin();
            }
        });
        on("jellyfin-close", "click", () => this.close());
        on("jellyfin-library", "change", (event) => {
            this.libraryId = event.target.value || "";
            this.loadItems();
        });
        on("jellyfin-search-btn", "click", () => this.search());
        on("jellyfin-search", "keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.search();
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            const overlay = document.getElementById("jellyfin-browser");
            if (!overlay || overlay.classList.contains("hidden")) return;
            this.close();
        });
    }

    search() {
        const input = document.getElementById("jellyfin-search");
        this.query = input ? (input.value || "").trim() : "";
        this.loadItems(true);
    }

    /** Drop everything tied to the previous room; the token survives. */
    reset() {
        this.libraries = [];
        this.libraryId = "";
        this.query = "";
        this.items = [];
        this.showLogin(false);
        this.close();
        const search = document.getElementById("jellyfin-search");
        if (search) search.value = "";
    }

    async open() {
        const overlay = document.getElementById("jellyfin-browser");
        if (!overlay) return;
        overlay.classList.remove("hidden");
        document.body.classList.add("overflow-hidden");
        this.renderLibraries();
        await this.loadItems(true);
    }

    close() {
        const overlay = document.getElementById("jellyfin-browser");
        if (overlay) overlay.classList.add("hidden");
        document.body.classList.remove("overflow-hidden");
    }

    setStatus(text, tone = "muted") {
        const node = document.getElementById("jellyfin-status");
        if (!node) return;
        node.classList.toggle("hidden", !text);
        node.textContent = text || "";
        node.className = "mb-3 text-xs";
        node.classList.toggle("text-rose-300", tone === "error");
        node.classList.toggle("text-slate-400", tone !== "error");
    }

    renderLibraries() {
        const select = document.getElementById("jellyfin-library");
        const who = document.getElementById("jellyfin-who");
        if (who) {
            const saved = storedJellyfinToken();
            who.textContent = saved && saved.user_name ? `已登录 ${saved.user_name}` : "已登录";
        }
        if (!select) return;
        select.replaceChildren();
        const all = document.createElement("option");
        all.value = "";
        all.textContent = "全部电影";
        select.appendChild(all);
        for (const library of this.libraries) {
            const option = document.createElement("option");
            option.value = library.id;
            option.textContent = library.name || "媒体库";
            select.appendChild(option);
        }
        if (this.libraryId) select.value = this.libraryId;
    }

    async loadItems(reset = false) {
        if (this.busy) return;
        this.busy = true;
        this.setStatus("正在读取片库…");
        if (reset) this.renderItems([]);
        const params = new URLSearchParams({ start: "0", limit: String(PAGE_SIZE) });
        if (this.libraryId) params.set("library", this.libraryId);
        if (this.query) params.set("q", this.query);
        try {
            const data = await this.api(`/jellyfin/items?${params.toString()}`);
            this.items = Array.isArray(data.items) ? data.items : [];
            this.renderItems(this.items);
            const total = Number(data.total) || this.items.length;
            this.setStatus(
                this.items.length
                    ? `共 ${total} 项${this.items.length < total ? `，先显示前 ${this.items.length} 项` : ""}`
                    : "没有找到匹配的影片"
            );
        } catch (error) {
            this.setStatus(error.message || "读取片库失败", "error");
            if (error.code === "JELLYFIN_AUTH_REQUIRED" || error.code === "JELLYFIN_AUTH_FAILED") {
                forgetJellyfinToken();
                this.showLogin(true, "登录已失效，请重新登录");
            }
        } finally {
            this.busy = false;
        }
    }

    renderItems(items) {
        const list = document.getElementById("jellyfin-items");
        if (!list) return;
        list.replaceChildren();
        if (!items.length) {
            const empty = document.createElement("li");
            empty.className = "text-xs italic text-slate-600";
            empty.textContent = "点上面的搜索按钮试试";
            list.appendChild(empty);
            return;
        }
        for (const item of items) {
            const row = document.createElement("li");
            row.className =
                "flex items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-2";

            const left = document.createElement("div");
            left.className = "min-w-0";
            const title = document.createElement("div");
            title.className = "truncate text-xs font-semibold text-slate-200";
            title.textContent = item.name || "未命名";
            const meta = document.createElement("div");
            meta.className = "mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500";
            const bits = [fmtDuration(item.duration), fmtBitrate(item.bitrate), (item.container || "").toUpperCase()]
                .filter(Boolean);
            for (const text of bits) {
                const span = document.createElement("span");
                span.textContent = text;
                meta.appendChild(span);
            }
            if (item.mode === "hls") {
                const tag = document.createElement("span");
                tag.className = "rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300";
                tag.textContent = "转码";
                meta.appendChild(tag);
            }
            left.append(title, meta);

            const add = document.createElement("button");
            add.type = "button";
            add.className =
                "shrink-0 rounded-lg border border-slate-700/60 bg-slate-900/60 px-2 py-1 text-[10px] font-bold text-slate-300 transition hover:border-sky-500/50 hover:text-sky-300";
            add.textContent = "加入";
            add.addEventListener("click", () => {
                add.disabled = true;
                add.textContent = "…";
                Promise.resolve(this.onPick(item))
                    .catch(() => {
                        // the caller reports its own errors
                    })
                    .finally(() => {
                        add.disabled = false;
                        add.textContent = "加入";
                    });
            });

            row.append(left, add);
            list.appendChild(row);
        }
    }
}
