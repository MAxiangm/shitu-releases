'use strict';
window.renderFontExport = async ({ font, text, settings }) => {
  const source = new URL(font.url);
  if (source.protocol !== 'shitu:' || source.hostname !== 'font' || source.username || source.password || source.port || source.search || source.hash ||
      !/^\/[0-9a-f-]{36}\/preview\.(ttf|otf|woff|woff2)$/.test(source.pathname)) throw new Error('字体预览地址无效');
  const family = 'mosaic-font-export';
  const face = new FontFace(family, `url(${JSON.stringify(source.href)})`);
  let timeout;
  try {
    await Promise.race([face.load(), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('字体加载超时')), 15000); })]);
    document.fonts.add(face);
    const canvas = document.getElementById('fontExportCanvas');
    const result = window.ShituFontLayout.renderCanvas(canvas, text, settings, `"${family}", sans-serif`);
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, overflow: Boolean(result.overflow) };
  } finally {
    clearTimeout(timeout);
    document.fonts.delete(face);
  }
};
