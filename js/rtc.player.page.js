'use strict';

/**
 * SRS RTC Player 业务逻辑模块
 * 优化项：点击播放同步搜索录制、连播逆序处理
 */
$(function () {
    let sdk = null;
    let fpsChart, timeChart, networkDelayChart;

    let maxRenderTime = -1;
    const windowSize = 30;
    const frameInfoRounder = [];

    // Chart.js 配置常量
    const MAX_DATA_POINTS = 60; // 保留最近60个数据点
    const CHART_COMMON_CONFIG = {
        type: 'line',
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 200 },
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false }
            },
            scales: {
                x: {
                    display: false
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(148, 163, 184, 0.1)',
                        drawBorder: false
                    },
                    ticks: {
                        color: 'rgba(148, 163, 184, 0.6)',
                        font: { size: 10 },
                        maxTicksLimit: 5
                    }
                }
            },
            elements: {
                line: {
                    tension: 0.4,
                    borderWidth: 2
                },
                point: {
                    radius: 0,
                    hitRadius: 10,
                    hoverRadius: 4
                }
            }
        }
    };

    // --- 工具函数 ---
    const utils = {
        setCookie: (name, value) => { document.cookie = `${name}=${value};path=/`; },
        getCookie: (name, def) => {
            const parts = `; ${document.cookie}`.split(`; ${name}=`);
            return parts.length === 2 ? parts.pop().split(';').shift() : def;
        },
        parseQuery: () => parse_query_string() // 依赖外部 srs.page.js
    };

    // --- 初始化监控图表 ---
    function initStatusGraphs() {
        if (fpsChart) return;

        // FPS 图表 - 紫色主题
        const fpsCtx = document.getElementById('fpsCanvas').getContext('2d');
        fpsChart = new Chart(fpsCtx, {
            ...CHART_COMMON_CONFIG,
            data: {
                labels: [],
                datasets: [{
                    label: 'FPS',
                    data: [],
                    borderColor: '#a78bfa',
                    backgroundColor: 'rgba(167, 139, 250, 0.1)',
                    fill: true
                }]
            }
        });

        // 渲染延迟图表 - 绿色主题
        const timeCtx = document.getElementById('timeCanvas').getContext('2d');
        timeChart = new Chart(timeCtx, {
            ...CHART_COMMON_CONFIG,
            data: {
                labels: [],
                datasets: [{
                    label: 'Render Delay',
                    data: [],
                    borderColor: '#34d399',
                    backgroundColor: 'rgba(52, 211, 153, 0.1)',
                    fill: true
                }]
            }
        });

        // 网络延迟图表 - 蓝色主题
        const networkCtx = document.getElementById('networkDelayCanvas').getContext('2d');
        networkDelayChart = new Chart(networkCtx, {
            ...CHART_COMMON_CONFIG,
            data: {
                labels: [],
                datasets: [{
                    label: 'Network Latency',
                    data: [],
                    borderColor: '#60a5fa',
                    backgroundColor: 'rgba(96, 165, 250, 0.1)',
                    fill: true
                }]
            }
        });
    }

    // 更新图表数据的辅助函数
    function updateChartData(chart, value) {
        const data = chart.data.datasets[0].data;
        const labels = chart.data.labels;

        data.push(value);
        labels.push('');

        // 限制数据点数量
        if (data.length > MAX_DATA_POINTS) {
            data.shift();
            labels.shift();
        }

        chart.update('none'); // 'none' 模式跳过动画，提升性能
    }

    // --- 播放器延迟设置 ---
    function applyPlayoutDelay() {
        const delayMs = $("#max_delay_value").val();
        utils.setCookie("delayMs", delayMs);
        if (sdk && sdk.pc) {
            sdk.pc.getReceivers().forEach(rec => {
                if ('playoutDelayHint' in rec) {
                    rec.playoutDelayHint = delayMs / 1000;
                }
            });
        }
    }

    // --- 核心播放逻辑 ---
    async function startPlay(urlOverride) {
        const url = urlOverride || $("#txt_url").val();
        if (!url) return;

        // 1. 同步搜索录制文件
        // 优先从下拉框获取流名，若无则尝试从 URL 解析
        let streamName = $("#user_name").val();
        if (!streamName || streamName === 'livestream') {
            const match = url.match(/\/([^\/\?]+)(\?|$)/);
            streamName = match ? match[1] : 'livestream';
        }
        
        $("#record_stream_name").val(streamName);
        fetchRecordings(); // 异步触发搜索

        // 2. 执行 WebRTC 播放
        if (sdk) {
            sdk.close();
            sdk = null;
        }

        $('#rtc_media_player').show();
        initStatusGraphs();
        
        sdk = new SrsRtcPlayerAsync();
        const videoElement = document.getElementById("rtc_media_player");
        $(videoElement).prop('srcObject', sdk.stream);
        videoElement.src = ""; // 确保不是在播放录制文件

        try {
            const session = await sdk.play(url);
            $('#sessionid').text(`ID: ${session.sessionid}`);
            $('#simulator-drop').attr('href', `${session.simulator}?drop=1&username=${session.sessionid}`);
            applyPlayoutDelay();
        } catch (e) {
            sdk.close();
            sdk = null;
            $('#rtc_media_player').hide();
            console.error("SRS Play Error:", e);
        }
    }

    // --- 流列表发现 ---
    async function fetchActiveStreams() {
        const query = utils.parseQuery();
        const protocol = window.location.protocol;
        const apiPort = protocol === "http:" ? ":1985" : "";
        const apiUrl = `${protocol}//${query.hostname}${apiPort}/api/v1/streams/`;

        const $grid = $("#streams_grid");
        const $selector = $("#user_name");

        try {
            const response = await fetch(apiUrl);
            const data = await response.json();
            
            $grid.empty();
            $selector.html('<option value="livestream">Default</option>');

            if (!data.streams || data.streams.length === 0) {
                $grid.append('<div class="col-span-full text-center py-4 text-slate-500 italic text-sm">暂无在线活跃流</div>');
                return;
            }

            const template = document.getElementById("stream_card_template");
            if (!template || !template.content.firstElementChild) {
                console.warn("stream_card_template not found, skip rendering.");
                return;
            }

            data.streams.forEach(stream => {
                if (!stream.publish.active) return;

                const audiences = stream.clients - 1;
                const coverUrl = `/stream/cover/${stream.name}`;

                const node = template.content.firstElementChild.cloneNode(true);
                const $btn = $(node);

                $btn.find(".stream-name").text(stream.name);
                $btn.find(".audience-count").text(`👥 ${audiences}`);
                $btn.find(".cover-img").attr("src", coverUrl);

                $btn.click(() => {
                    $("#txt_url").val(stream.name);
                    srs_init_rtc("#txt_url", { ...query, stream: stream.name });
                    $selector.val(stream.name);
                    startPlay();
                });

                $grid.append($btn);
                $selector.append(`<option value="${stream.name}">${stream.name}</option>`);
            });
        } catch (e) {
            console.warn("Fetch streams failed:", e);
        }
    }

    // --- 录制文件管理 ---
    async function fetchRecordings() {
        const streamName = $("#record_stream_name").val();
        if (!streamName) return;

        const query = utils.parseQuery();
        const protocol = window.location.protocol;
        const apiPort = protocol === "http:" ? ":11985" : "";
        const apiUrl = `${protocol}//${query.hostname}${apiPort}/stream/query_record/${streamName}`;
        const baseUrl = `${protocol}//${query.hostname}${apiPort}`;

        const $status = $("#record_file_request_status").show();
        const $list = $("#record_file_list").empty();

        try {
            const response = await fetch(apiUrl);
            const data = await response.json();
            $status.hide();

            if (!data.files || data.files.length === 0) {
                $list.append('<li class="p-6 text-slate-500 text-center italic text-xs">未找到该流的录制分片</li>');
                return;
            }

            const template = document.getElementById("record_file_item_template");
            if (!template || !template.content.firstElementChild) {
                console.warn("record_file_item_template not found, skip rendering.");
                return;
            }

            data.files.forEach(file => {
                const isMp4 = file.file_name.toLowerCase().endsWith(".mp4");
                const fileSize = (file.file_size / 1024 / 1024).toFixed(2);

                const node = template.content.firstElementChild.cloneNode(true);
                const $item = $(node);

                $item.find(".file-name").text(file.file_name);
                $item.find(".file-size").text(`Size: ${fileSize} MB`);
                $item.find(".download-link").attr("href", `${baseUrl}/stream/record/d/${file.file_name}`);

                const $playBtn = $item.find(".play-btn");
                $playBtn.click(function () {
                    if (!isMp4) return alert("仅支持 MP4 格式预览");

                    if (sdk) { sdk.close(); sdk = null; }
                    const video = document.getElementById("rtc_media_player");
                    video.srcObject = null;
                    video.src = `${baseUrl}/stream/record/p/${file.file_name}`;

                    video.onended = () => {
                        if ($("#playback_check_box").is(":checked")) {
                            const $nextItem = $item.next();
                            if ($nextItem.length > 0) {
                                console.info("Playlist: Playing next older segment...");
                                $nextItem.find('.play-btn').click();
                            } else {
                                console.info("Playlist: Reached end of recorded segments.");
                            }
                        }
                    };

                    $("#record_file_list .play-btn")
                        .removeClass('bg-emerald-600 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]')
                        .addClass('bg-blue-600/10 text-blue-400');
                    $(this)
                        .addClass('bg-emerald-600 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]')
                        .removeClass('bg-blue-600/10 text-blue-400');
                });

                $list.append($item);
            });
        } catch (e) {
            $status.hide();
            console.error("Fetch records failed:", e);
        }
    }

    // --- WebRTC 统计处理 ---
    let lastStats = { audio: { ts: 0, bytes: 0 }, video: { ts: 0, bytes: 0 }, rtt: { rcv: 0, total: 0 } };

    function processStats(results) {
        let vBps = 0, aBps = 0, rtt = 0;

        results.forEach(report => {
            const now = report.timestamp;
            if (report.type === 'inbound-rtp') {
                const type = report.mediaType; 
                const bytes = report.bytesReceived;
                const last = lastStats[type];

                if (last.ts && now > last.ts) {
                    const bps = Math.floor((8 * (bytes - last.bytes)) / (now - last.ts));
                    if (type === 'video') vBps = bps; else aBps = bps;
                }
                lastStats[type] = { ts: now, bytes: bytes };
            } else if (report.type === 'candidate-pair' && report.responsesReceived > 0) {
                const lastRtt = lastStats.rtt;
                if (lastRtt.rcv && report.responsesReceived > lastRtt.rcv) {
                    rtt = (report.totalRoundTripTime - lastRtt.total) / (report.responsesReceived - lastRtt.rcv);
                }
                lastStats.rtt = { rcv: report.responsesReceived, total: report.totalRoundTripTime };
            }
        });

        $("#bitrate_info").text(`V: ${vBps}kbps | A: ${aBps}kbps`);
        if (rtt > 0 && networkDelayChart) {
            updateChartData(networkDelayChart, Math.round(rtt * 1000));
        }
    }

    // --- 视频帧回调 (FPS) ---
    function frameCallback(nowMs, meta) {
        const vid = document.getElementById("rtc_media_player");
        if (meta.receiveTime) {
            maxRenderTime = Math.max(meta.expectedDisplayTime - meta.receiveTime, maxRenderTime);
            if (meta.presentedFrames % windowSize === 0 && timeChart) {
                updateChartData(timeChart, Math.round(maxRenderTime));
                maxRenderTime = -1;
            }
        }
        frameInfoRounder.push({ time: Date.now() });
        vid.requestVideoFrameCallback(frameCallback);
    }

    // --- 事件绑定 ---
    $("#btn_play").click(() => startPlay());
    $("#refresh_streams_btn").click(() => fetchActiveStreams());
    $("#btn_set_max_delay").click(() => applyPlayoutDelay());
    $("#refresh_record_file_button").click(() => fetchRecordings());
    
    $("#user_name").change(function() {
        const name = $(this).val();
        $("#record_stream_name").val(name);
        srs_init_rtc("#txt_url", { ...utils.parseQuery(), stream: name });
        fetchRecordings(); // 切换用户下拉框也同步刷新录制
    });

    // 定时刷新器
    setInterval(() => {
        if (sdk && sdk.pc) {
            sdk.pc.getStats(null).then(processStats).catch(console.error);
        }
    }, 500);

    setInterval(() => {
        const now = Date.now();
        while (frameInfoRounder.length > 0 && now - frameInfoRounder[0].time > 1000) {
            frameInfoRounder.shift();
        }
        const fps = frameInfoRounder.length;
        const video = document.getElementById("rtc_media_player");
        $("#frame_info").text(`${video.videoWidth || 0}x${video.videoHeight || 0} @ ${fps}FPS`);
        
        if (fpsChart && fps > 0) {
            updateChartData(fpsChart, fps);
        }
    }, 1000);

    // --- 初始加载 ---
    const query = utils.parseQuery();
    srs_init_rtc("#txt_url", query);
    initStatusGraphs();
    fetchActiveStreams();

    if (query.autostart === 'true') {
        $('#rtc_media_player').prop('muted', true);
        startPlay();
    }

    document.getElementById("rtc_media_player").requestVideoFrameCallback(frameCallback);
});
