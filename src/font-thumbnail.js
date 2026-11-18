'use strict';
window.renderFontThumbnail = async options => {
  if (!options || !/^shitu:\/\/font\/[0-9a-f-]{36}\/preview\.(ttf|otf|woff|woff2)$/.test(options.url)) throw new Error('字体预览地址无效');
  const family = 'ShituThumbnailFont';
  const response = await fetch(options.url);
  if (!response.ok) throw new Error('字体文件暂时无法读取');
  const font = new FontFace(family, await response.arrayBuffer());
  await font.load();
  if (font.status !== 'loaded') throw new Error('此字体暂时无法解码');
  document.fonts.add(font);
  try {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const context = canvas.getContext('2d'); context.fillStyle = '#191a20'; context.fillRect(0, 0, 640, 480);
    context.fillStyle = '#a5a8b5'; context.font = '15px sans-serif'; context.fillText('FONT / ' + String(options.format).toUpperCase(), 40, 44);
    const lines = String(options.sampleText || 'Aa Bb Cc').slice(0, 160).split(/\r?\n/).filter(Boolean).slice(0, 2);
    let size = 80;
    do { context.font = `${size}px "${family}"`; if (lines.every(line => context.measureText(line).width <= 554) || size <= 28) break; size -= 2; } while (size > 28);
    context.fillStyle = '#f4f2ed'; context.textAlign = 'center'; context.textBaseline = 'middle';
    lines.forEach((line, index) => context.fillText(line, 320, 217 + (index - (lines.length - 1) / 2) * size * 1.2, 554));
    context.font = `30px "${family}"`; context.fillStyle = '#c1bfba'; context.fillText('0123456789', 320, 306, 554);
    context.textAlign = 'left'; context.font = '18px sans-serif'; context.fillStyle = '#d7d8de'; context.fillText(String(options.family || '').slice(0, 70), 40, 405, 560);
    context.font = '14px sans-serif'; context.fillStyle = '#9295a1'; context.fillText(String(options.style || 'Regular').slice(0, 70), 40, 436, 560);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.88), fontLoaded: true };
  } finally { document.fonts.delete(font); }
};
