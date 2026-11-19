'use strict';

// Passive media-element capture only. The caller supplies the selected-video
// and advertisement identity check; this module never requests screen, camera,
// microphone, cookie, or browser-debugger access.
(() => {
  const MAX_BYTES = 512 * 1024 * 1024;
  const active = new Map();
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const failure = (message, code = 'VIDEO_RECORDING_FAILED') => Object.assign(new Error(message), { code });
  const finiteDuration = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86400;
  const sourceOf = video => video.currentSrc || video.getAttribute?.('src') || '';

  function recorderMime() {
    if (typeof globalThis.MediaRecorder !== 'function') return null;
    return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type =>
      globalThis.MediaRecorder.isTypeSupported(type)) || null;
  }

  function cancel(video) {
    if (video) return active.get(video)?.cancel() ?? false;
    let cancelled = false;
    for (const task of active.values()) cancelled = task.cancel() || cancelled;
    return cancelled;
  }

  async function recordVideo(video, options = {}) {
    if (!video || video.tagName !== 'VIDEO' || typeof video.captureStream !== 'function' ||
        typeof video.addEventListener !== 'function' || typeof options.isCurrent !== 'function') {
      throw failure('当前视频不支持浏览器完整录制。', 'VIDEO_RECORDING_UNAVAILABLE');
    }
    if (active.has(video)) throw failure('当前视频正在录制，请等待完成。', 'VIDEO_RECORDING_BUSY');
    const mimeType = recorderMime();
    if (!mimeType) throw failure('当前浏览器不支持带声音的视频录制。', 'VIDEO_RECORDING_UNAVAILABLE');
    const duration = video.duration, source = sourceOf(video);
    const expectedDuration = options.expectedDuration ?? duration;
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? Math.ceil(duration * 1000 + Math.max(30000, duration * 200));
    if (!finiteDuration(duration) || !finiteDuration(expectedDuration) ||
        Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * 0.02) ||
        !source || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 * 86400000) {
      throw failure('视频时长或录制大小限制无效。', 'VIDEO_RECORDING_UNAVAILABLE');
    }
    const original = { paused: video.paused, currentTime: video.currentTime,
      muted: video.muted, playbackRate: video.playbackRate };
    const dimensions = { width: video.videoWidth, height: video.videoHeight };
    const epsilon = Math.min(0.5, Math.max(0.08, duration * 0.01));
    const removers = [], chunks = [];
    let recorder, stream, interval, deadline, totalBytes = 0;
    let settled = false, completed = false, restoring = false, recording = false, internalSeek = false;
    let startedAt = 0, lastTime = 0, startedPlaying = false;
    let finish, rejectResult;
    const result = new Promise((resolve, reject) => { finish = resolve; rejectResult = reject; });
    // A cancellation can arrive while a seek or play promise is pending.
    result.catch(() => {});

    function sameSelection() {
      try {
        return video.isConnected && sourceOf(video) === source && !video.mediaKeys && !video.srcObject &&
          options.isCurrent(video) === true;
      } catch { return false; }
    }
    function stopRecorder() {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
    }
    function fail(error) {
      if (settled) return false;
      settled = true;
      stopRecorder();
      rejectResult(error instanceof Error ? error : failure('录制未完成，未保存视频。'));
      return true;
    }
    const task = { cancel: () => fail(failure('录制已取消，未保存视频。', 'VIDEO_RECORDING_CANCELLED')) };
    active.set(video, task);
    function listen(target, type, listener) {
      target.addEventListener(type, listener);
      removers.push(() => target.removeEventListener(type, listener));
    }
    function guard() {
      if (restoring || settled || completed) return;
      if (!sameSelection()) throw failure('所选视频已切换或受到保护，录制已停止。', 'VIDEO_RECORDING_SELECTION_CHANGED');
      if (!finiteDuration(video.duration) || Math.abs(video.duration - duration) > epsilon ||
          video.playbackRate !== 1 || video.videoWidth !== dimensions.width || video.videoHeight !== dimensions.height) {
        throw failure('视频时长、画质或播放速度发生变化，请重新采集。', 'VIDEO_RECORDING_SELECTION_CHANGED');
      }
      if (!recording) return;
      const tracks = stream.getTracks();
      if (tracks.some(track => track.readyState !== 'live' || !track.enabled || startedPlaying && track.muted === true) ||
          stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1 || !stream.active) {
        throw failure('视频或声音轨道中断，未保存录制。');
      }
      const now = Number(video.currentTime), elapsed = (clock() - startedAt) / 1000;
      if (!Number.isFinite(now) || now + epsilon < lastTime || now > elapsed + 0.75) {
        throw failure('检测到跳转或不连续播放，未保存录制。');
      }
      lastTime = Math.max(lastTime, now);
      try { options.onProgress?.({ currentTime: now, duration, receivedBytes: totalBytes, elapsedMs: elapsed * 1000 }); } catch {}
    }
    const guarded = action => () => { try { guard(); action?.(); } catch (error) { fail(error); } };
    function finishRecording() {
      if (settled || completed) return;
      guard();
      const elapsed = (clock() - startedAt) / 1000;
      if (!video.ended || video.currentTime < duration - epsilon || elapsed < duration - 0.75) {
        throw failure('视频尚未从头完整播放，未保存录制。');
      }
      completed = true;
      stopRecorder();
    }

    try {
      if (!sameSelection() || video.readyState < 2 || dimensions.width < 1 || dimensions.height < 1) {
        throw failure('所选视频尚未就绪或受到保护。', 'VIDEO_RECORDING_UNAVAILABLE');
      }
      if (options.signal?.aborted) throw failure('录制已取消，未保存视频。', 'VIDEO_RECORDING_CANCELLED');
      listen(options.signal || new EventTarget(), 'abort', task.cancel);
      deadline = setTimeout(() => fail(failure('录制超时，未保存不完整视频。', 'VIDEO_RECORDING_TIMEOUT')), timeoutMs);
      for (const type of ['emptied', 'encrypted', 'error', 'abort']) listen(video, type, () => {
        if (!restoring) fail(failure('视频来源或播放状态异常，未保存录制。'));
      });
      listen(video, 'seeking', () => { if (!internalSeek && !restoring) fail(failure('播放位置发生变化，未保存录制。')); });
      listen(video, 'ratechange', guarded());
      listen(video, 'durationchange', guarded());
      listen(video, 'resize', guarded());
      listen(video, 'pause', () => {
        if (recording && !restoring && !completed && !video.ended) fail(failure('播放已暂停，未保存不完整视频。'));
      });
      listen(video, 'waiting', () => {
        if (recording && startedPlaying && !completed) fail(failure('视频缓冲中断，请等待加载后重新采集。'));
      });
      listen(video, 'ended', guarded(finishRecording));

      // Preserve the chosen source and quality. Seeking uses the existing
      // player, not a network request or a second hidden media element.
      video.pause();
      video.muted = true;
      video.playbackRate = 1;
      internalSeek = true;
      if (video.currentTime > 0.001 || video.seeking) {
        const seeked = new Promise((resolve, reject) => {
          let timer;
          const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); };
          listen(video, 'seeked', done);
          timer = setTimeout(() => { video.removeEventListener('seeked', done); reject(failure('无法从视频开头开始录制。')); }, 10000);
          removers.push(() => clearTimeout(timer));
          video.currentTime = 0;
        });
        await Promise.race([seeked, result]);
      }
      internalSeek = false;
      guard();
      if (video.currentTime > epsilon) throw failure('无法定位到视频开头。');

      stream = video.captureStream();
      if (!stream || stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1 ||
          !stream.active || stream.getTracks().some(track => track.readyState !== 'live' || !track.enabled)) {
        throw failure('当前视频未提供完整的画面和声音轨道。', 'VIDEO_RECORDING_UNAVAILABLE');
      }
      for (const track of stream.getTracks()) listen(track, 'ended', () => {
        if (!restoring && !completed) fail(failure('视频或声音轨道提前结束，未保存录制。'));
      });
      for (const track of stream.getTracks()) listen(track, 'mute', () => {
        if (recording && startedPlaying && !restoring && !completed) fail(failure('视频或声音轨道中断，未保存录制。'));
      });
      for (const type of ['addtrack', 'removetrack']) listen(stream, type, () => {
        if (!restoring && !completed) fail(failure('录制轨道发生变化，未保存视频。'));
      });
      recorder = new MediaRecorder(stream, { mimeType });
      listen(recorder, 'dataavailable', event => {
        if (settled || !event.data?.size) return;
        totalBytes += event.data.size;
        if (totalBytes > maxBytes) { fail(failure('视频超过录制大小限制，未保存。', 'VIDEO_RECORDING_TOO_LARGE')); return; }
        chunks.push(event.data);
      });
      listen(recorder, 'error', () => fail(failure('浏览器录制失败，未保存视频。')));
      listen(recorder, 'stop', () => {
        if (settled) return;
        if (!completed || !sameSelection() || totalBytes < 1) { fail(failure('录制未完整结束，未保存视频。')); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        settled = true;
        finish({ blob, mimeType: blob.type, duration, hasAudio: true, elapsedMs: clock() - startedAt });
      });
      recorder.start(1000);
      recording = true;
      startedAt = clock();
      interval = setInterval(guarded(), 100);
      await Promise.race([Promise.resolve(video.play()).then(() => { startedPlaying = true; }), result]);
      return await result;
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      restoring = true;
      clearTimeout(deadline);
      clearInterval(interval);
      for (const remove of removers) { try { remove(); } catch {} }
      stopRecorder();
      try { for (const track of stream?.getTracks?.() || []) track.stop(); } catch {}
      if (sameSelection()) {
        try { video.pause(); } catch {}
        try { video.muted = original.muted; } catch {}
        try { video.playbackRate = original.playbackRate; } catch {}
        try { video.currentTime = Math.min(original.currentTime, video.duration); } catch {}
        if (!original.paused) { try { void Promise.resolve(video.play()).catch(() => {}); } catch {} }
      }
      if (active.get(video) === task) active.delete(video);
    }
  }

  const api = { recordVideo, cancel };
  if (typeof module === 'object' && module?.exports) module.exports = api;
  globalThis.MosaicYouTubeRecording = api;
})();
