'use strict';

/**
 * SRS RTC Player 业务逻辑模块
 * 优化项：点击播放同步搜索录制、连播逆序处理
 */
$(function () {
    let sdk = null;
    let fpsGraph, fpsSeries;
    let timeGraph, timeSeries;
    let networkDelayGraph, networkDelaySeries;

    let maxRenderTime = -1;
    const windowSize = 30;
    const frameInfoRounder = [];

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
        if (fpsGraph) return; 

        fpsSeries = new TimelineDataSeries();
        fpsGraph = new TimelineGraphView('fpsGraph', 'fpsCanvas');
        fpsGraph.setScale(100);

        timeSeries = new TimelineDataSeries();
        timeGraph = new TimelineGraphView('timeGraph', 'timeCanvas');
        timeGraph.setScale(200);

        networkDelaySeries = new TimelineDataSeries();
        networkDelayGraph = new TimelineGraphView('networkDelayGraph', 'networkDelayCanvas');
        networkDelayGraph.setScale(200);
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

            data.streams.forEach(stream => {
                if (!stream.publish.active) return;

                const audiences = stream.clients - 1;
                const coverUrl = `/stream/cover/${stream.name}`;
                
                const btnHtml = `
                    <button class="group relative overflow-hidden bg-slate-800/50 hover:bg-blue-600/20 border border-slate-700 hover:border-blue-500/50 p-3 rounded-2xl transition-all duration-300 text-left">
                        <div class="flex justify-between items-start mb-2">
                            <span class="text-blue-400 font-bold text-sm truncate">${stream.name}</span>
                            <span class="text-[10px] bg-slate-900 px-2 py-0.5 rounded text-slate-400">👥 ${audiences}</span>
                        </div>
                        <img src="${coverUrl}" class="w-full h-20 object-cover rounded-lg bg-slate-900 mb-2 opacity-80 group-hover:opacity-100 transition-opacity" onerror="this.src='https://ossrs.net/gif/v1/sls.gif'">
                        <div class="text-[10px] text-slate-500 group-hover:text-blue-300 transition-colors uppercase font-bold tracking-tighter">点击切换</div>
                    </button>
                `;

                const $btn = $(btnHtml).click(() => {
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

            data.files.forEach(file => {
                const isMp4 = file.file_name.toLowerCase().endsWith(".mp4");
                const fileSize = (file.file_size / 1024 / 1024).toFixed(2);
                
                const itemHtml = `
                    <li class="flex items-center gap-4 p-4 hover:bg-slate-800/30 transition-colors group">
                        <button class="play-btn shrink-0 w-10 h-10 flex items-center justify-center bg-blue-600/10 hover:bg-blue-600 text-blue-400 hover:text-white rounded-full transition-all border border-blue-500/20">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        </button>
                        <div class="flex-grow min-w-0">
                            <div class="text-sm font-medium text-slate-300 truncate">${file.file_name}</div>
                            <div class="flex gap-3 mt-1">
                                <a href="${baseUrl}/stream/record/d/${file.file_name}" target="_blank" class="text-[10px] text-blue-400 hover:underline uppercase font-bold tracking-tighter">下载分片</a>
                                <span class="text-[10px] text-slate-500 uppercase font-bold tracking-tighter">Size: ${fileSize} MB</span>
                            </div>
                        </div>
                        <img src="https://alist.3geeks.top/d/recorder/local/temp/img_thump_kylin.jpg" class="h-10 w-16 object-cover rounded border border-slate-700" onerror="this.style.display='none'">
                    </li>
                `;

                const $item = $(itemHtml);
                $item.find('.play-btn').click(function() {
                    if (!isMp4) return alert("仅支持 MP4 格式预览");
                    
                    if (sdk) { sdk.close(); sdk = null; }
                    const video = document.getElementById("rtc_media_player");
                    video.srcObject = null;
                    video.src = `${baseUrl}/stream/record/p/${file.file_name}`;
                    
                    // 逆序连播逻辑：UI 从上往下是“从新到旧”。
                    // 点击 playlist 连播时，播放完当前项，自动触发其“下一个”兄弟节点（即更早的文件）。
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
                    
                    // 视觉激活状态
                    $("#record_file_list .play-btn").removeClass('bg-emerald-600 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]').addClass('bg-blue-600/10 text-blue-400');
                    $(this).addClass('bg-emerald-600 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]').removeClass('bg-blue-600/10 text-blue-400');
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
        if (rtt > 0) {
            const nowMs = Date.now();
            networkDelaySeries.addPoint(nowMs, rtt * 1000);
            networkDelayGraph.setDataSeries([networkDelaySeries]);
            networkDelayGraph.updateEndDate();
        }
    }

    // --- 视频帧回调 (FPS) ---
    function frameCallback(nowMs, meta) {
        const vid = document.getElementById("rtc_media_player");
        if (meta.receiveTime) {
            maxRenderTime = Math.max(meta.expectedDisplayTime - meta.receiveTime, maxRenderTime);
            if (meta.presentedFrames % windowSize === 0) {
                timeSeries.addPoint(Date.now(), maxRenderTime);
                timeGraph.setDataSeries([timeSeries]);
                timeGraph.updateEndDate();
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
        
        if (fpsGraph && fps > 0) {
            fpsSeries.addPoint(now, fps);
            fpsGraph.setDataSeries([fpsSeries]);
            fpsGraph.updateEndDate();
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
