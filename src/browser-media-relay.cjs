'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { vimeoPlaybackUrl } = require('./vimeo-playback-source.cjs');

const CHUNK_LIMIT = 256 * 1024;
const MESSAGE_LIMIT = 384 * 1024;

function invalid(message = '浏览器视频传输数据无效') { return new Error(message); }
function abortError() { return new Error('浏览器视频读取已结束'); }

// The extension only supplies bytes for a read already selected by the source
// parser. It never supplies a local filename, a new source URL, or a budget.
function createBrowserMediaRelay() {
  const sessions = new Map();

  function createSession(requestId, { signal, validateUrl = vimeoPlaybackUrl, sourceType, label = 'Vimeo' } = {}) {
    if (sessions.has(requestId)) throw invalid('浏览器视频读取任务已存在');
    signal?.throwIfAborted();
    const session = { requestId, signal, sourceType, current: null, closed: false };
    sessions.set(requestId, session);

    async function finish(entry, error) {
      if (entry.finishing) return entry.finishing;
      entry.finishing = (async () => {
        try { await entry.writing; } catch (writeError) { error ||= writeError; }
        try { await entry.file?.close(); } catch (closeError) { error ||= closeError; }
        if (session.current === entry) session.current = null;
        if (error) entry.reject(error);
        else entry.resolve(entry.file ? undefined : { body: Buffer.concat(entry.chunks, entry.bytes), url: entry.url });
      })();
      return entry.finishing;
    }

    async function close(error = abortError()) {
      if (session.closed) return session.closing;
      session.closed = true;
      signal?.removeEventListener('abort', onAbort);
      if (sessions.get(requestId) === session) sessions.delete(requestId);
      session.closing = session.current ? finish(session.current, error) : Promise.resolve();
      return session.closing;
    }
    const onAbort = () => { void close(signal.reason || abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    session.close = close;

    async function read(source, { destination, limit, range, contentType, onBytes = () => {}, onHead = () => {} } = {}) {
      if (session.closed) throw abortError();
      signal?.throwIfAborted();
      if (session.current || session.opening) throw invalid('浏览器视频读取任务尚未完成');
      const url = validateUrl(source);
      if (!Number.isSafeInteger(limit) || limit < 1) throw invalid('浏览器视频读取大小无效');
      if (contentType !== undefined && !/^[a-z]+\/[a-z0-9.+-]+$/.test(contentType)) throw invalid('浏览器视频读取格式无效');
      if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          range.start < 0 || range.end < range.start || range.end - range.start + 1 > limit)) throw invalid('浏览器视频读取区间无效');
      session.opening = true;
      let file;
      try { file = destination ? await fs.open(destination, 'wx') : null; }
      finally { session.opening = false; }
      if (session.closed || signal?.aborted) {
        await file?.close();
        throw signal?.reason || abortError();
      }
      let resolve, reject;
      const result = new Promise((yes, no) => { resolve = yes; reject = no; });
      const entry = { readId: crypto.randomUUID(), url, range, limit, contentType, onBytes, onHead,
        file, chunks: [], bytes: 0, sequence: 0, head: false, processing: false, resolve, reject };
      session.current = entry;
      return result;
    }

    session.accept = async body => {
      const entry = session.current;
      if (!entry || body.readId !== entry.readId || entry.finishing) throw invalid('浏览器视频读取请求已失效');
      try {
        if (entry.processing) throw invalid('浏览器视频数据必须按顺序发送');
        entry.processing = true;
        if (!Number.isSafeInteger(body.sequence) || body.sequence !== entry.sequence) throw invalid('浏览器视频数据顺序不符');
        entry.sequence++;
        if (body.error !== undefined) {
          if (typeof body.error !== 'string' || !body.error || body.error.length > 1500) throw invalid();
          throw invalid(`浏览器未能读取 ${label} 播放源，请刷新视频页面后重试`);
        }
        if (body.head !== undefined) {
          if (entry.head || body.sequence !== 0 || !body.head || typeof body.head !== 'object') throw invalid();
          const head = body.head;
          if (head.status !== (entry.range ? 206 : 200)) throw invalid(`浏览器读取 ${label} 返回 HTTP ${Number.isInteger(head.status) ? head.status : '无效'}，未保存视频`);
          const finalUrl = validateUrl(head.url);
          if (finalUrl.href !== entry.url.href) throw invalid('浏览器视频读取来源不符');
          if (typeof head.contentType !== 'string' || head.contentType.length > 256 || /(?:text\/html|application\/xhtml)/i.test(head.contentType)) throw invalid(`${label} 返回的数据不是可读取的媒体文件`);
          if (entry.contentType && head.contentType.split(';')[0].trim().toLowerCase() !== entry.contentType) throw invalid(`${label} 返回的媒体格式与请求不符`);
          if (head.contentLength !== undefined && (!Number.isSafeInteger(head.contentLength) || head.contentLength < 0 || head.contentLength > entry.limit)) throw invalid(`${label} 播放源超出采集大小上限`);
          entry.contentLength = head.contentLength;
          if (entry.range) {
            const match = typeof head.contentRange === 'string' && /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(head.contentRange);
            const total = match?.[3] === '*' ? null : Number(match?.[3]);
            if (!match || Number(match[1]) !== entry.range.start || Number(match[2]) !== entry.range.end ||
                (total !== null && (!Number.isSafeInteger(total) || total <= entry.range.end))) throw invalid(`${label} 返回的分段区间与播放清单不符`);
          }
          entry.head = true;
          entry.onHead(head);
        }
        if (!entry.head) throw invalid('浏览器视频缺少响应信息');
        if (body.dataBase64 !== undefined) {
          const text = body.dataBase64;
          if (typeof text !== 'string' || !text || text.length > Math.ceil(CHUNK_LIMIT / 3) * 4 || text.length % 4 ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw invalid();
          const bytes = Buffer.from(text, 'base64');
          if (!bytes.length || bytes.length > CHUNK_LIMIT || bytes.toString('base64') !== text) throw invalid();
          if (entry.bytes + bytes.length > entry.limit || (entry.range && entry.bytes + bytes.length > entry.range.end - entry.range.start + 1)) throw invalid(`${label} 播放源超出采集大小上限`);
          if (entry.file) {
            entry.writing = entry.file.writeFile(bytes);
            await entry.writing;
            entry.writing = null;
          } else entry.chunks.push(bytes);
          if (entry.finishing) throw abortError();
          entry.bytes += bytes.length;
          entry.onBytes(bytes.length);
        }
        if (body.done !== undefined && body.done !== true) throw invalid();
        if (body.done) {
          if (!entry.bytes || (entry.range && entry.bytes !== entry.range.end - entry.range.start + 1) ||
              (entry.contentLength !== undefined && entry.bytes !== entry.contentLength)) throw invalid(`${label} 播放分段不完整，未保存视频`);
          await finish(entry);
        } else if (body.head === undefined && body.dataBase64 === undefined) throw invalid();
        return { ok: true };
      } catch (error) {
        await finish(entry, error);
        throw error;
      } finally { entry.processing = false; }
    };
    return { read, close };
  }

  return {
    createSession,
    poll(requestId) {
      const session = sessions.get(requestId);
      const entry = session?.current;
      return entry && !entry.finishing ? { readId: entry.readId, url: entry.url.href, limit: entry.limit,
        ...(session.sourceType ? { sourceType: session.sourceType } : {}),
        ...(entry.range ? { range: entry.range } : {}) } : null;
    },
    async accept(body) {
      const session = sessions.get(body?.requestId);
      if (!session || session.closed) throw invalid('浏览器视频读取任务已失效');
      return session.accept(body);
    },
    async close() {
      await Promise.all([...sessions.values()].map(session => session.close()));
    }
  };
}

module.exports = { createBrowserMediaRelay, CHUNK_LIMIT, MESSAGE_LIMIT };
