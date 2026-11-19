'use strict';

const AUTH_REQUIRED = new Set(['AUTH_REQUIRED', 'VIDEO_AUTH_REQUIRED', 'VIDEO_AUTH_EXPIRED']);
const CURRENT_BROWSER_SITES = new Set(['youtube', 'bilibili']);

function failure(code, message) { return Object.assign(new Error(message), { code }); }

function createAuthenticatedVideoDownload({ auth, downloadYouTube, downloadSiteVideo }) {
  if (!auth || typeof auth.withBrowserSession !== 'function' ||
      typeof downloadYouTube !== 'function' || typeof downloadSiteVideo !== 'function') {
    throw new TypeError('Current-browser video session dependencies are missing');
  }

  async function run(site, download, options) {
    options.signal?.throwIfAborted();
    const { browserSession, cookieFile: _ignoredCookieFile, ...downloadOptions } = options;
    if (!CURRENT_BROWSER_SITES.has(site)) {
      if (browserSession !== undefined) throw failure('VIDEO_BROWSER_SESSION_INVALID', '当前浏览器登录暂只支持 YouTube 和 Bilibili 视频。');
      return download(downloadOptions);
    }
    try {
      // Only the extension's current, explicitly granted session is used.
      // Never substitute an older saved account or open a login browser.
      if (browserSession !== undefined) {
        return await auth.withBrowserSession(browserSession, (cookieFile, context = {}) => {
          const signal = context.signal || options.signal;
          signal?.throwIfAborted();
          return download({ ...downloadOptions, ...(signal ? { signal } : {}), cookieFile });
        }, { signal: options.signal, site });
      }
      return await download(downloadOptions);
    } catch (error) {
      if (!AUTH_REQUIRED.has(error?.code) && error?.code !== `${site.toUpperCase()}_AUTH_REQUIRED`) throw error;
      const label = site === 'bilibili' ? 'Bilibili（B站）' : 'YouTube';
      if (browserSession !== undefined) {
        throw failure('VIDEO_BROWSER_LOGIN_REQUIRED', `${label} 未接受当前 Chrome 的登录，请在原来的 ${label} 标签页检查登录或验证后重试。`);
      }
      throw failure('VIDEO_BROWSER_PERMISSION_REQUIRED', `请在 Chrome 的 Mosaic 采集助手中开启“使用当前 ${site === 'bilibili' ? 'Bilibili' : 'YouTube'} 登录”，然后在原标签页重试。`);
    }
  }

  return {
    downloadYouTube: options => run('youtube', downloadYouTube, options),
    downloadSiteVideo: options => run(options.site, downloadSiteVideo, options)
  };
}

module.exports = { createAuthenticatedVideoDownload };
