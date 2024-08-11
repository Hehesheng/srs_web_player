'use strict';
$(function () {
    var sdk = null; // Global handler to do cleanup when replaying.
    // graph value
    let fpsGraph;
    let fpsSeries;

    let timeGraph;
    let timeSeries;

    let networkDelayGraph;
    let networkDelaySeries;

    let maxRenderTime = -1;
    const windowSize = 30;
    function setCookie(name, value) {
        document.cookie = `${name}=${value}`;
    }
    function getCookie(name, if_null) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) { 
            return parts.pop().split(';').shift();
        }
        return if_null;
    }
    function init_status_graph() {
        fpsSeries = new TimelineDataSeries();
        fpsGraph = new TimelineGraphView('fpsGraph', 'fpsCanvas');
        fpsGraph.setScale(200);
        fpsGraph.updateEndDate();

        timeSeries = new TimelineDataSeries();
        timeGraph = new TimelineGraphView('timeGraph', 'timeCanvas');
        timeGraph.setScale(200);
        timeGraph.updateEndDate();

        networkDelaySeries = new TimelineDataSeries();
        networkDelayGraph = new TimelineGraphView('networkDelayGraph', 'networkDelayCanvas');
        networkDelayGraph.setScale(200);
        networkDelayGraph.updateEndDate();
    }
    let max_delay_value_input = document.getElementById("max_delay_value");
    function set_max_delay() {
        let max_delay_ms = max_delay_value_input.value;
        setCookie("delayMs", max_delay_ms);
        if (sdk) {
            // console.info(max_delay_ms);
            sdk.pc.getReceivers().forEach(function(rec, index, arr) {
                rec.playoutDelayHint = max_delay_ms / 1000;
            });
        }
    }
    max_delay_value_input.value = Number(getCookie("delayMs", 0));
    max_delay_value_input.onkeydown = function (e) {
        if (e.key == "Enter") {
            set_max_delay();
        }
    };
    init_status_graph();
    var startPlay = function () {
        $('#rtc_media_player').show();
        init_status_graph();
        // Close PC when user replay.
        if (sdk) {
            sdk.close();
            sdk = null;
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
            sdk = null;
            $('#rtc_media_player').hide();
            console.error(reason);
        });
        // console.info(sdk.pc);
        set_max_delay();
    };

    let set_max_delay_button = document.getElementById("btn_set_max_delay");
    set_max_delay_button.onclick = set_max_delay;

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

    function query_record_stream_by_name() {
        get_record_list(query, $("#record_stream_name").val());
    }
    document.getElementById("record_stream_name").onkeydown = function (e) {
        if (e.key == "Enter") {
            query_record_stream_by_name();
        }
    };
    document.getElementById("refresh_record_file_button").onclick = query_record_stream_by_name;

    let playback_check_box = document.getElementById("playback_check_box");
    playback_check_box.checked = getCookie("playback", "false") === "true";
    playback_check_box.onchange = function (e) {
        setCookie("playback", playback_check_box.checked);
    };

    function get_record_list(query, stream_name) {
        let web_protocal = window.location.protocol;
        let base_url = web_protocal + "//" + query.hostname + (web_protocal == "http:" ? ":11985" : "");
        let query_url = base_url + "/stream/query_record/" + stream_name;
        const record_file_list_query = new XMLHttpRequest();
        record_file_list_query.open("GET", query_url);
        record_file_list_query.send();

        let record_request_status = document.getElementById("record_file_request_status");
        record_request_status.style.display = "";
        record_file_list_query.onreadystatechange = (e) => {
            if (record_file_list_query.readyState === 4 && record_file_list_query.status === 200) {
                record_request_status.style.display = "none";
                let record_file_list_infos = JSON.parse(record_file_list_query.responseText);
                let record_file_list_obj = document.getElementById("record_file_list");
                record_file_list_obj.innerHTML = '';
                if (record_file_list_infos.stream_name != stream_name) {
                    return;
                }
                record_file_list_infos.files.reverse().forEach((file_info, index, arr) => {
                    // single file item parent
                    let file_item = document.createElement("div");
                    file_item.className = "form-inline";
                    file_item.style = "text-align: left; border: 1px solid black;";
                    // preview button
                    let preview_record_file_button = document.createElement("button");
                    preview_record_file_button.className = "btn btn-primary previewBtn";
                    preview_record_file_button.style.width = "10%";
                    preview_record_file_button.innerHTML = "preview";
                    preview_record_file_button.id = file_info.file_name + "_preview_btn";
                    function play_next_call(e, pre_info) {
                        let enable_countine_play = playback_check_box.checked;
                        if (!enable_countine_play) { return; }
                        let next_ele = document.getElementById(pre_info.file_name + "_preview_btn").parentElement.previousElementSibling;
                        // console.info(e, " info:", pre_info, " next:", next_ele);
                        if (next_ele == null) { return; }
                        let btn_list = next_ele.getElementsByClassName("btn");
                        if (btn_list.length == 0) { return; }
                        let b = btn_list[0];
                        b.click();
                    }
                    function play_record_file(record_info, btn) {
                        if (record_info.file_name.split(".").slice(-1) != "mp4") {
                            alert("仅支持mp4文件预览！");
                            return;
                        }
                        if (sdk) {
                            sdk.close();
                            sdk = null;
                        }
                        // reset btn
                        let preview_btn_list = document.getElementsByClassName("previewBtn");
                        for (let i = 0; i < preview_btn_list.length; i++) {
                            preview_btn_list[i].innerHTML = "preview";
                        }
                        // preview_url = file_url;
                        let media_player = document.getElementById("rtc_media_player");
                        // media_player.innerHTML = "";
                        media_player.style.display = "";
                        $('#rtc_media_player').prop('srcObject', null);
                        media_player.src = base_url + "/stream/record/p/" + record_info.file_name;
                        media_player.onended = function (e) {
                            play_next_call(e, record_info);
                        };
                        btn.innerHTML = "on playing";
                    }
                    preview_record_file_button.addEventListener("click", function () {
                        play_record_file(file_info, preview_record_file_button);
                    });
                    file_item.appendChild(preview_record_file_button);
                    file_item.appendChild(document.createTextNode('\n'));
                    // download link
                    let download_link = document.createElement("a");
                    download_link.href = base_url + "/stream/record/d/" + file_info.file_name;
                    download_link.download = file_info.file_name;
                    download_link.innerHTML = file_info.file_name;
                    download_link.target = "_blank";
                    download_link.rel = "noopener noreferrer";
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
        let streams_list = document.getElementById("streams_grid");
        let user_name_selector = document.getElementById("user_name");
        let refresh_button = document.createElement("button");
        streams_list.style.gap = "1vh";
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
                let streams_list = document.getElementById("streams_grid");
                let user_name_selector = document.getElementById("user_name");
                let server_streams_status = JSON.parse(Http.responseText);
                console.log(server_streams_status);
                server_streams_status.streams.forEach((stream, index, arr) => {
                    if (!stream.publish.active) {
                        return;
                    }
                    let audiences = stream.clients - 1;
                    let new_button = document.createElement("button");
                    new_button.className = "btn btn-primary";
                    new_button.innerHTML = stream.name + "<br>👥 " + audiences;
                    console.info(stream.name + '\'s audiences: ', audiences);
                    new_button.onclick = function () {
                        console.info("button click");
                        // update_stream_url(query, $(this).text());
                        update_stream_url(query, stream.name);
                        // console.info("stream name:", stream.name);
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
    let web_protocal = window.location.protocol;
    find_streams_page(web_protocal + "//" + query.hostname + (web_protocal == "http:" ? ":1985" : "") + "/api/v1/streams/");

    if (query.autostart === 'true') {
        $('#rtc_media_player').prop('muted', true);
        console.warn('For autostart, we should mute it, see https://www.jianshu.com/p/c3c6944eed5a ' +
            'or https://developers.google.com/web/updates/2017/09/autoplay-policy-changes#audiovideo_elements');
        window.addEventListener("load", function () { startPlay(); });
    }
    // Part 1:
    var vid = document.getElementById("rtc_media_player");
    var last_media_time, last_frame_num;
    var last_metadata = null;
    let frame_info_rounder = [];
    class FrameInfo {
        constructor(diff, time) {
            this.diff = diff;
            this.time = time;
        }
    }
    // Part 2 (with some modifications):
    function frameBeginCallback(nowMs, metaData) {
        let media_time_diff = Math.abs(metaData.mediaTime - last_media_time);
        let frame_num_diff = Math.abs(metaData.presentedFrames - last_frame_num);
        let diff = 0;
        if (frame_num_diff !== 0) {
            diff = media_time_diff / frame_num_diff;
        }
        if (diff) {
            frame_info_rounder.push(new FrameInfo(frame_num_diff, Date.now()));
        }
        last_media_time = metaData.mediaTime;
        last_frame_num = metaData.presentedFrames;
        last_metadata = metaData;
        // console.info(nowMs);
        // console.info(metaData);
        // For graph purposes, take the maximum over a window.
        if (metaData.receiveTime != null) {
            maxRenderTime = Math.max(metaData.expectedDisplayTime - metaData.receiveTime, maxRenderTime);
            if (metaData.presentedFrames % windowSize === 0) {
                timeSeries.addPoint(Date.now(), maxRenderTime);
                timeGraph.setDataSeries([timeSeries]);
                timeGraph.updateEndDate();

                maxRenderTime = -1;
            }
        }
        vid.requestVideoFrameCallback(frameBeginCallback);
    }
    vid.requestVideoFrameCallback(frameBeginCallback);
    // Part 3:
    vid.addEventListener("seeked", function () {
        frame_info_rounder.pop();
    });
    // Part 4:
    function update_frame_info(fps, width, height) {
        document.getElementById("frame_info").textContent = "Video Info: " + width + "x" + height + ", " + fps + "FPS";
    }
    let audio_bytes_pre;
    let video_bytes_pre;
    let audio_ts_pre;
    let video_ts_pre;
    let total_rtt_pre;
    let responses_rev_pre;
    function showRemoteStats(results) {
        // calculate video bitrate
        let audio_bps = "0";
        let video_bps = "0";
        let rtt = NaN;
        results.forEach(report => {
            const now = report.timestamp;
            if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
                const bytes = report.bytesReceived;
                if (video_ts_pre && (now !== video_ts_pre)) {
                    video_bps = 8 * (bytes - video_bytes_pre) / (now - video_ts_pre);
                    video_bps = Math.floor(video_bps);
                }
                video_bytes_pre = bytes;
                video_ts_pre = now;
                // console.info(report);
            } else if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
                const bytes = report.bytesReceived;
                if (audio_ts_pre && (now !== audio_ts_pre)) {
                    audio_bps = 8 * (bytes - audio_bytes_pre) / (now - audio_ts_pre);
                    audio_bps = Math.floor(audio_bps);
                }
                audio_bytes_pre = bytes;
                audio_ts_pre = now;
                // console.info(report);
            } else if (report.type === 'candidate-pair' && report.responsesReceived !== 0) {
                if (total_rtt_pre && (report.responsesReceived !== responses_rev_pre)) {
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
        document.getElementById("bitrate_info").textContent = `video:${video_bps} audio:${audio_bps}`;
        let date_now = Date.now();
        // rtt
        if (rtt !== NaN) {
            networkDelaySeries.addPoint(date_now, rtt * 1000);
            networkDelayGraph.setDataSeries([networkDelaySeries]);
            networkDelayGraph.updateEndDate();
        }
    }
    setInterval(function () {
        if (sdk) {
            sdk.pc.getStats(null)
                .then(showRemoteStats, err => console.log(err));
        }
    }, 500);
    setInterval(function () {
        if (vid.played.length === 0) {
            return;
        }
        let now_ms = Date.now();
        while (frame_info_rounder.length > 0 && now_ms - frame_info_rounder[0].time > 1000) {
            frame_info_rounder.shift();
        }
        let fps = frame_info_rounder.length;
        let width = last_metadata == null ? 0 : last_metadata.width;
        let height = last_metadata == null ? 0 : last_metadata.height;
        update_frame_info(fps, width, height);
        fpsSeries.addPoint(Date.now(), Math.round(fps));
        fpsGraph.setDataSeries([fpsSeries]);
        fpsGraph.updateEndDate();
    }, 200);
});
