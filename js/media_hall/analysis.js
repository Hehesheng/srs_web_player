/**
 * 实时分析：把「会不会卡」变成可读的数字和曲线。
 *
 * 参照 rtc_player 的 Real-time Analysis —— 每个指标一张小卡，左上角一个会呼吸
 * 的圆点，下面是画布。大厅是零依赖页面（只有 hls.js 和 Tailwind CDN），所以曲线
 * 是自己用 canvas 画的：固定 60 个点、一秒一个点，也就是最近一分钟。纵轴按窗口
 * 自适应，漂移和推进各有一条参考线（0 和 1.00）—— 漂移在参考线上面是「跑在房主
 * 前面」，下面是「落后」，这两件事的修法完全相反，所以它必须一眼看得出来。
 *
 * 这张卡片现在默认就开着，还常常开在手机上，所以有两处克制：
 *   - 看不见的时候不碰画布（宽屏模式、?debug=0、页面切到后台），采样照常进环形
 *     缓冲，因此退出来时曲线是连续的，不会空一段；
 *   - 数字格的 DOM 只在文字真的变了才重建 —— 统计每 400ms 来一次，不该每 400ms
 *     重建十一个节点。
 */

// 和 rtc_player 一样是 60 个点；这里一秒一个，所以窗口是一分钟。
const CHART_POINTS = 60;
const SAMPLE_MS = 1000;

/** "#38bdf8" + 0.3 → "rgba(56,189,248,0.3)"，用来给面积做渐变。 */
function withAlpha(hex, alpha) {
    const raw = hex.replace("#", "");
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    const value = parseInt(full, 16);
    if (!Number.isFinite(value)) return `rgba(148,163,184,${alpha})`;
    return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

/** 一条一分钟的曲线：进点、自适应纵轴、画网格 + 面积 + 线 + 末点。 */
class Sparkline {
    constructor(canvas, { color, kind }) {
        this.canvas = canvas;
        this.color = color || "#38bdf8";
        this.kind = kind;
        this.values = [];
    }

    /** 只收真实读数：缺数据的那一拍就让它空着，不要补 0（0 是一个读数）。 */
    push(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) return false;
        this.values.push(value);
        if (this.values.length > CHART_POINTS) this.values.shift();
        return true;
    }

    /**
     * 纵轴范围。漂移和推进都绕着参考值对称取，这样参考线永远在正中，曲线的高低
     * 就是领先/落后本身；前向缓存和 RTT 从 0 起，它们的下限本来就是 0。
     */
    range() {
        const values = this.values;
        if (!values.length) return [0, 1];
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        if (this.kind === "drift") {
            const span = Math.max(0.5, Math.abs(lo), Math.abs(hi));
            return [-span, span];
        }
        if (this.kind === "advance") {
            const span = Math.max(0.02, Math.abs(1 - lo), Math.abs(hi - 1));
            return [1 - span, 1 + span];
        }
        if (this.kind === "rtt") return [0, Math.max(40, hi)];
        return [0, Math.max(2, hi)];
    }

    baseline() {
        if (this.kind === "drift") return 0;
        if (this.kind === "advance") return 1;
        return null;
    }

    draw() {
        const canvas = this.canvas;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pxWidth = Math.round(width * dpr);
        const pxHeight = Math.round(height * dpr);
        if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
            canvas.width = pxWidth;
            canvas.height = pxHeight;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const top = 6;
        const bottom = height - 6;
        const [lo, hi] = this.range();
        const span = hi - lo || 1;
        const y = (value) => bottom - ((value - lo) / span) * (bottom - top);

        ctx.strokeStyle = "rgba(148,163,184,0.12)";
        ctx.lineWidth = 1;
        for (const frac of [0, 0.5, 1]) {
            const at = Math.round(top + (bottom - top) * frac) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, at);
            ctx.lineTo(width, at);
            ctx.stroke();
        }

        const base = this.baseline();
        if (base !== null && base >= lo && base <= hi) {
            ctx.strokeStyle = "rgba(148,163,184,0.35)";
            ctx.setLineDash([3, 4]);
            const at = Math.round(y(base)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, at);
            ctx.lineTo(width, at);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const values = this.values;
        if (values.length < 2) return;
        // 最右边永远是"现在"，曲线从右边往左长满 —— 看着像仪表，不像进度条。
        const x = (index) => (index / (CHART_POINTS - 1)) * width;
        // 面积填到参考线，不是填到画布底：漂移和推进的面积就是"离参考值有多远"，
        // 填到底会变成一大块实心色，看着像负载而不是偏差。
        const areaBase = base !== null && base >= lo && base <= hi ? y(base) : bottom;
        const gradient = ctx.createLinearGradient(0, top, 0, bottom);
        gradient.addColorStop(0, withAlpha(this.color, 0.3));
        gradient.addColorStop(1, withAlpha(this.color, 0.02));
        ctx.beginPath();
        ctx.moveTo(x(0), areaBase);
        values.forEach((value, index) => ctx.lineTo(x(index), y(value)));
        ctx.lineTo(x(values.length - 1), areaBase);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        values.forEach((value, index) => (index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value))));
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x(values.length - 1), y(values[values.length - 1]), 3, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
    }
}

/** 图标只用一条常量路径，文字一律 textContent —— 拼字符串进 innerHTML 没必要。 */
const ICONS = {
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="m10 8 5 3-5 3z"/><path d="M8 21h8"/>',
    buffer: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2.5"/><path d="M7 2v20M17 2v20M2 12h20"/>',
    alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4M12 17h.01"/>',
    pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    skip: '<path d="M5 4l10 8-10 8z"/><path d="M19 5v14"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9 2h6"/>',
    pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
};

// 只有真出问题时才染色：这张卡片是常开的，满屏都是颜色就没人看了。
const TONES = {
    ok: "text-slate-200",
    muted: "text-slate-400",
    warn: "text-amber-300",
    bad: "text-rose-300",
};

function iconNode(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("class", "h-4 w-4 shrink-0 text-slate-500");
    svg.innerHTML = ICONS[name] || ICONS.pulse;
    return svg;
}

/** 一格：图标 + 名称 + 读数（+ 一行小字补充）。 */
function tileNode(tile) {
    const box = document.createElement("div");
    box.className = "flex items-center gap-2 rounded-xl border border-white/5 bg-slate-900/40 px-3 py-2";
    box.append(iconNode(tile.icon));
    const body = document.createElement("div");
    body.className = "min-w-0";
    const label = document.createElement("div");
    label.className = "truncate text-[10px] uppercase tracking-wider text-slate-500";
    label.textContent = tile.label;
    const value = document.createElement("div");
    value.className = `truncate font-mono text-sm ${TONES[tile.tone] || TONES.ok}`;
    value.textContent = tile.value;
    body.append(label, value);
    if (tile.note) {
        const note = document.createElement("div");
        note.className = "truncate font-mono text-[10px] text-slate-500";
        note.textContent = tile.note;
        body.append(note);
    }
    box.append(body);
    return box;
}

export class AnalysisPanel {
    constructor(root) {
        this.root = root;
        this.tileHost = root.querySelector("[data-tiles]");
        this.tileKey = "";
        this.charts = {};
        for (const node of root.querySelectorAll("[data-chart]")) {
            this.charts[node.dataset.chart] = {
                spark: new Sparkline(node.querySelector("canvas"), {
                    color: node.dataset.color,
                    kind: node.dataset.chart,
                }),
                now: node.querySelector("[data-now]"),
                range: node.querySelector("[data-range]"),
            };
        }
        this.lastSampleAt = 0;
    }

    /**
     * `tiles` 是 [{icon, label, value, note, tone}]，`samples` 是各条曲线的当前
     * 读数（drift / buffer / advance / rtt，缺的就是这一拍没读到）。
     */
    update({ tiles, samples } = {}) {
        if (tiles) this.renderTiles(tiles);
        this.sample(samples);
    }

    renderTiles(tiles) {
        if (!this.tileHost) return;
        const key = tiles.map((tile) => `${tile.icon}|${tile.label}|${tile.value}|${tile.note || ""}|${tile.tone || ""}`).join("~");
        if (key === this.tileKey) return;
        this.tileKey = key;
        this.tileHost.replaceChildren(...tiles.map(tileNode));
    }

    sample(samples) {
        if (!samples) return;
        const now = performance.now();
        // 一秒一个点：统计 400ms 来一次，曲线不该跟着 400ms 抖一次。四条曲线
        // 同一拍进点（某一拍没读到的那个就不进，不补 0）。
        if (now - this.lastSampleAt < SAMPLE_MS) return;
        this.lastSampleAt = now;
        for (const [key, chart] of Object.entries(this.charts)) chart.spark.push(samples[key]);
        // 窗口里已经攒了多少个点：不看画布也能知道采样有没有断（收起时采样照常，
        // 所以再打开时曲线是连续的，不会空一段）。
        const drift = this.charts.drift;
        this.root.dataset.samples = String(drift ? drift.spark.values.length : 0);
        if (!this.visible()) return;
        for (const chart of Object.values(this.charts)) {
            chart.spark.draw();
            const values = chart.spark.values;
            if (chart.now) {
                chart.now.textContent = values.length ? this.format(chart.spark.kind, values[values.length - 1]) : "--";
            }
            if (chart.range) {
                chart.range.textContent = values.length
                    ? `${this.format(chart.spark.kind, Math.min(...values))} ~ ${this.format(chart.spark.kind, Math.max(...values))}`
                    : "";
            }
        }
    }

    format(kind, value) {
        if (kind === "drift") return `${value >= 0 ? "+" : ""}${value.toFixed(2)}s`;
        if (kind === "buffer") return `${value.toFixed(1)}s`;
        if (kind === "advance") return `${value.toFixed(3)}x`;
        return `${Math.round(value)}ms`;
    }

    /**
     * 画布只在看得见的时候动：宽屏模式把下方卡片藏了、`?debug=0` 把整块关了、
     * 页面切到后台 —— 这三种情况都不该有人在给手机画曲线。
     */
    visible() {
        return Boolean(this.root.offsetParent) && !document.hidden;
    }
}
