$(function () {
    var sdk = null; // Global handler to do cleanup when replaying.
    // graph value
    let frameIntervalGraph;
    let frameIntervalSeries;

    let timeGraph;
    let timeSeries;

    let networkDelayGraph;
    let networkDelaySeries;

    let maxRenderTime = -1;
    let maxNetworkDelay = -1;
    const windowSize = 30;
    var startPlay = function () {
        $('#rtc_media_player').show();

        frameIntervalSeries = new TimelineDataSeries();
        frameIntervalGraph = new TimelineGraphView('frameIntervalGraph', 'frameIntervalCanvas');
        frameIntervalGraph.setScale(200);
        frameIntervalGraph.updateEndDate();

        timeSeries = new TimelineDataSeries();
        timeGraph = new TimelineGraphView('timeGraph', 'timeCanvas');
        timeGraph.setScale(200);
        timeGraph.updateEndDate();

        networkDelaySeries = new TimelineDataSeries();
        networkDelayGraph = new TimelineGraphView('networkDelayGraph', 'networkDelayCanvas');
        networkDelayGraph.setScale(200);
        networkDelayGraph.updateEndDate();

        // Close PC when user replay.
        if (sdk) {
            sdk.close();
        }
        sdk = new SrsRtcPlayerAsync();

        // https://webrtc.org/getting-started/remote-streams
        $('#rtc_media_player').prop('srcObject', sdk.stream);
        // Optional callback, SDK will add track to stream.
        // sdk.ontrack = function (event) { console.log('Got track', event); sdk.stream.addTrack(event.track); };

        // For example: webrtc://r.ossrs.net/live/livestream
        var url = $("#txt_url").val();
        sdk.play(url).then(function (session) {
            $('#sessionid').html(session.sessionid);
            $('#simulator-drop').attr('href', session.simulator + '?drop=1&username=' + session.sessionid);
        }).catch(function (reason) {
            sdk.close();
            $('#rtc_media_player').hide();
            console.error(reason);
        });
    };

    function update_stream_url(query, stream_name) {
        query.stream = stream_name;
        $("#record_stream_name").val(stream_name);
        srs_init_rtc("#txt_url", query);
    }

    $('#rtc_media_player').hide();
    var query = parse_query_string();
    // srs_init_rtc("#txt_url", query);
    update_stream_url(query, $("#user_name").val());

    function on_click_start_play() {
        $('#rtc_media_player').prop('muted', false);
        startPlay();
        $('#navbar_id').hide();
        get_record_list(query, $("#record_stream_name").val());
    }

    document.querySelector("#refresh_record_file_button").onclick = function () {
        get_record_list(query, $("#record_stream_name").val());
    };

    function get_record_list(query, stream_name) {
        base_url = "http://" + query.hostname + ":11985"
        query_url = base_url + "/stream/query_record/" + stream_name;
        const record_file_list_query = new XMLHttpRequest();
        record_file_list_query.open("GET", query_url);
        record_file_list_query.send();

        let record_request_status = document.getElementById("record_file_request_status");
        record_request_status.style.display = "";
        record_file_list_query.onreadystatechange = (e) => {
            if (record_file_list_query.readyState === 4 && record_file_list_query.status === 200) {
                record_request_status.style.display = "none";
                let record_file_list_infos = JSON.parse(record_file_list_query.responseText);
                let record_file_list_obj = document.querySelector("#record_file_list");
                record_file_list_obj.innerHTML = '';
                if (record_file_list_infos.stream_name != stream_name) {
                    return;
                }
                record_file_list_infos.files.forEach((file_info, index, arr) => {
                    // single file item parent
                    let file_item = document.createElement("div");
                    file_item.className = "form-inline";
                    file_item.style = "text-align: left; border: 1px solid black;";
                    // preview button
                    let preview_record_file_button = document.createElement("button");
                    preview_record_file_button.className = "btn btn-primary";
                    preview_record_file_button.innerHTML = "preview";
                    preview_record_file_button.onclick = function () {
                        if (file_info.file_name.split(".").slice(-1) != "mp4") {
                            alert("仅支持mp4录制文件！");
                            return;
                        }
                        if (sdk) {
                            sdk.close();
                            sdk = null;
                        }
                        // preview_url = file_url;
                        let media_player = document.getElementById("rtc_media_player");
                        // media_player.innerHTML = "";
                        media_player.style.display = "";
                        $('#rtc_media_player').prop('srcObject', null);
                        media_player.src = base_url + "/stream/record/p/" + file_info.file_name;
                    };
                    file_item.appendChild(preview_record_file_button);
                    file_item.appendChild(document.createTextNode('\n'));
                    // download link
                    let download_link = document.createElement("a");
                    download_link.href = base_url + "/stream/record/d/" + file_info.file_name;
                    download_link.download = file_info.file_name;
                    download_link.innerHTML = file_info.file_name;
                    file_item.appendChild(download_link);
                    file_item.appendChild(document.createTextNode('\n'));
                    // file size info
                    let file_size_text = document.createElement("text");
                    file_size_text.style = "text-align: right";
                    file_size_text.innerHTML = "file size: " + (file_info.file_size / 1024 / 1024).toFixed(2) + "MB";
                    file_item.appendChild(file_size_text);
                    record_file_list_obj.appendChild(file_item);
                });
            } else if (record_file_list_query.readyState === 4) {
                record_request_status.style.display = "none";
                alert(record_file_list_query.responseText);
            }
        }
    }

    $("#btn_play").click(function () {
        on_click_start_play();
    });
    $("#user_name").change(function () {
        update_stream_url(query, $("#user_name").val());
    });

    function add_refresh_stream_list_button(url) {
        // add refresh button
        let streams_list = document.querySelector("#streams_grid");
        let user_name_selector = document.querySelector("#user_name");
        let refresh_button = document.createElement("button");
        refresh_button.className = "btn btn-primary";
        refresh_button.innerHTML = "刷新";
        refresh_button.onclick = function () {
            // clear list
            streams_list.innerHTML = "";
            user_name_selector.innerHTML = "";
            // <option value="livestream">default</option>
            let default_option = document.createElement("option");
            default_option.value = "livestream";
            default_option.innerHTML = "default";
            user_name_selector.appendChild(default_option);
            find_streams_page(url);
        };
        streams_list.appendChild(refresh_button);
    };

    function find_streams_page(url) {
        const Http = new XMLHttpRequest();
        Http.open("GET", url);
        Http.send();

        Http.onreadystatechange = (e) => {
            if (Http.readyState === 4 && Http.status === 200) {
                // add_refresh_stream_list_button(url);
                // console.log(Http.responseText);
                let streams_list = document.querySelector("#streams_grid");
                let user_name_selector = document.querySelector("#user_name");
                let server_streams_status = JSON.parse(Http.responseText);
                console.log(server_streams_status);
                server_streams_status.streams.forEach((stream, index, arr) => {
                    let new_button = document.createElement("button");
                    new_button.className = "btn btn-primary";
                    new_button.innerHTML = stream.name;
                    new_button.onclick = function () {
                        console.info("button click");
                        update_stream_url(query, $(this).text());
                        on_click_start_play();
                    };
                    streams_list.appendChild(new_button);
                    // add to user option
                    let new_option = document.createElement("option");
                    new_option.value = stream.name;
                    new_option.innerHTML = stream.name;
                    user_name_selector.appendChild(new_option);
                });
            }
        }
        add_refresh_stream_list_button(url);
    };

    console.info(query);
    find_streams_page("http://" + query.hostname + ":1985/api/v1/streams/");

    if (query.autostart === 'true') {
        $('#rtc_media_player').prop('muted', true);
        console.warn('For autostart, we should mute it, see https://www.jianshu.com/p/c3c6944eed5a ' +
            'or https://developers.google.com/web/updates/2017/09/autoplay-policy-changes#audiovideo_elements');
        window.addEventListener("load", function () { startPlay(); });
    }
    // Part 1:
    var vid = document.querySelector("#rtc_media_player");
    var last_media_time, last_frame_num, fps;
    var fps_rounder = [];
    var fps_time_rounder = [];
    var last_metadata = null;
    var last_update_tick;
    var last_max_frame_interval, last_min_frame_interval;
    var max_frame_interval_tick = 0, min_frame_interval_tick = 0;
    // Part 2 (with some modifications):
    function ticker(nowMs, metaData) {
        var media_time_diff = Math.abs(metaData.mediaTime - last_media_time);
        var frame_num_diff = Math.abs(metaData.presentedFrames - last_frame_num);
        var diff = media_time_diff / frame_num_diff;
        if (diff) {
            fps_rounder.push(diff);
            fps_time_rounder.push(metaData.mediaTime);
            // The graph library does not like the performance.now() style `now`.
            const UPDATE_INTERVAL = 0.2;
            if (!last_update_tick) {
                last_update_tick = nowMs;
            }
            if (last_max_frame_interval === 0 || last_max_frame_interval < diff) {
                last_max_frame_interval = diff;
                max_frame_interval_tick = Date.now();
            }
            if (last_min_frame_interval === UPDATE_INTERVAL || last_min_frame_interval > diff) {
                last_min_frame_interval = diff;
                min_frame_interval_tick = Date.now();
            }
            if (nowMs - last_update_tick > UPDATE_INTERVAL * 1000) {
                if (max_frame_interval_tick !== 0) {
                    frameIntervalSeries.addPoint(max_frame_interval_tick, last_max_frame_interval * 1000);
                }
                if (min_frame_interval_tick !== 0) {
                    frameIntervalSeries.addPoint(min_frame_interval_tick, last_min_frame_interval * 1000);
                }
                frameIntervalGraph.setDataSeries([frameIntervalSeries]);
                frameIntervalGraph.updateEndDate();
                last_update_tick = nowMs;
                last_max_frame_interval = 0;
                last_min_frame_interval = UPDATE_INTERVAL;
                max_frame_interval_tick = 0;
                min_frame_interval_tick = 0;
            }
        }
        last_media_time = metaData.mediaTime;
        last_frame_num = metaData.presentedFrames;
        last_metadata = metaData;
        // console.info(metaData);
        // For graph purposes, take the maximum over a window.
        maxRenderTime = Math.max(metaData.expectedDisplayTime - metaData.receiveTime, maxRenderTime);

        if (metaData.presentedFrames % windowSize !== 0) {
            vid.requestVideoFrameCallback(ticker);
            return;
        }

        timeSeries.addPoint(Date.now(), maxRenderTime);
        timeGraph.setDataSeries([timeSeries]);
        timeGraph.updateEndDate();

        maxRenderTime = -1;
        vid.requestVideoFrameCallback(ticker);
    }
    vid.requestVideoFrameCallback(ticker);
    // Part 3:
    vid.addEventListener("seeked", function () {
        fps_rounder.pop();
    });
    // Part 4:
    function get_fps_average() {
        if (fps_rounder.length == 0) return 0;
        return fps_rounder.reduce((a, b) => a + b) / fps_rounder.length;
    }
    function update_frame_info(fps, width, height) {
        document.querySelector("#frame_info").textContent = "Video Info: " + width + "x" + height + ", " + fps + "FPS";
    }
    let audio_bytes_pre;
    let video_bytes_pre;
    let audio_ts_pre;
    let video_ts_pre;
    let total_rtt_pre;
    let responses_rev_pre;
    let jitter_buffer_delay_pre;
    let jitter_buffer_emitted_count_pre;
    function showRemoteStats(results) {
        // calculate video bitrate
        let audio_bps = "0";
        let video_bps = "0";
        let jitter_delay = 0;
        var rtt = 0;
        results.forEach(report => {
            const now = report.timestamp;
            if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
                const bytes = report.bytesReceived;
                if (video_ts_pre) {
                    video_bps = 8 * (bytes - video_bytes_pre) / (now - video_ts_pre);
                    video_bps = Math.floor(video_bps);
                }
                video_bytes_pre = bytes;
                video_ts_pre = now;
                if (jitter_buffer_emitted_count_pre) {
                    jitter_delay = (report.jitterBufferDelay - jitter_buffer_delay_pre) /
                        (report.jitterBufferEmittedCount - jitter_buffer_emitted_count_pre);
                }
                jitter_buffer_delay_pre = report.jitterBufferDelay;
                jitter_buffer_emitted_count_pre = report.jitterBufferEmittedCount;
                // console.info(report);
            } else if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
                const bytes = report.bytesReceived;
                if (audio_ts_pre) {
                    audio_bps = 8 * (bytes - audio_bytes_pre) / (now - audio_ts_pre);
                    audio_bps = Math.floor(audio_bps);
                }
                audio_bytes_pre = bytes;
                audio_ts_pre = now;
                // console.info(report);
            } else if (report.type === 'candidate-pair' && report.responsesReceived !== 0) {
                if (total_rtt_pre) {
                    rtt = (report.totalRoundTripTime - total_rtt_pre) / (report.responsesReceived - responses_rev_pre);
                }
                total_rtt_pre = report.totalRoundTripTime;
                responses_rev_pre = report.responsesReceived;
                // console.info(report);
            }
        });
        audio_bps += 'kbps';
        video_bps += 'kbps';
        // console.info(results);
        document.querySelector("#bitrate_info").textContent = `video:${video_bps} audio:${audio_bps}`;
        let date_now = Date.now();
        // jitter
        // timeSeries.addPoint(date_now, jitter_delay * 1000);
        // timeGraph.setDataSeries([timeSeries]);
        // timeGraph.updateEndDate();
        // rtt
        networkDelaySeries.addPoint(date_now, rtt * 1000);
        networkDelayGraph.setDataSeries([networkDelaySeries]);
        networkDelayGraph.updateEndDate();
    }
    setInterval(function () {
        if (sdk) {
            sdk.pc.getStats(null)
                .then(showRemoteStats, err => console.log(err));
        }
    }, 500);
    setInterval(function () {
        if (fps_rounder.length == 0) {
            update_frame_info(0, 0, 0);
            return;
        }
        var has_shift = false;
        while (fps_time_rounder.length > 0 &&
            Math.abs(fps_time_rounder[fps_time_rounder.length - 1] - fps_time_rounder[0]) > 0.3) {
            fps_rounder.shift();
            fps_time_rounder.shift();
            has_shift = true;
        }
        if (!has_shift) {
            fps_rounder.shift();
            fps_time_rounder.shift();
        }
        fps = Math.round(1 / get_fps_average());
        update_frame_info(fps, last_metadata.width, last_metadata.height);
    }, 200);
});