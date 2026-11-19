'use strict';

function videoExpectations(input = {}) {
  const expected = {};
  if (input.expectedDuration !== undefined) {
    if (typeof input.expectedDuration !== 'number' || !Number.isFinite(input.expectedDuration) || input.expectedDuration <= 0 || input.expectedDuration > 86400) {
      throw new Error('视频原始时长无效，请重新采集');
    }
    expected.expectedDuration = input.expectedDuration;
  }
  if (input.expectedAudio !== undefined) {
    if (input.expectedAudio !== true) throw new Error('视频声音信息无效，请重新采集');
    expected.expectedAudio = true;
  }
  return expected;
}

function checkCapturedVideo(metadata, expected = {}) {
  const incomplete = message => Object.assign(new Error(message), { code: 'VIDEO_INCOMPLETE' });
  if (!metadata || !(metadata.width > 0) || !(metadata.height > 0) || !metadata.codec) {
    throw incomplete('下载结果没有可读取的视频画面，未保存');
  }
  if (expected.expectedAudio && !metadata.hasAudio) throw incomplete('下载结果缺少原视频的声音，未保存');
  if (expected.expectedDuration) {
    const duration = Number(metadata.duration);
    const tolerance = Math.max(2, expected.expectedDuration * 0.03);
    if (!(duration > 0) || Math.abs(duration - expected.expectedDuration) > tolerance) {
      throw incomplete('下载结果的时长与原视频不符，未保存');
    }
  }
  return metadata;
}

module.exports = { videoExpectations, checkCapturedVideo };
