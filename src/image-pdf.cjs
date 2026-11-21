'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const sharp = require('sharp');

const deflate = promisify(zlib.deflate);
const MAX_PIXELS = 100_000_000;
const MAX_PAGES = 256;
const MAX_PAGE_POINTS = 14_400;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const IMAGES_PER_PAGE = Object.freeze([1, 2, 3, 4, 6, 8, 9]);
const abortError = () => Object.assign(new Error('任务已取消'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const decimal = number => Number(number.toFixed(4)).toString();

function pdfOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PDF 参数无效');
  const imagesPerPage = value.imagesPerPage ?? 1;
  if (!IMAGES_PER_PAGE.includes(imagesPerPage)) throw new Error('每页图片数只能为 1、2、3、4、6、8 或 9');
  const pageSize = value.pageSize ?? (imagesPerPage > 1 ? 'a4' : 'image');
  const orientation = value.orientation ?? 'auto';
  const margin = value.margin ?? (pageSize === 'a4' ? 18 : 0);
  const gap = value.gap ?? 10;
  if (!['image', 'a4'].includes(pageSize)) throw new Error('不支持的 PDF 页面尺寸');
  if (imagesPerPage > 1 && pageSize !== 'a4') throw new Error('多图排版请选择 A4 页面');
  if (!['auto', 'portrait', 'landscape'].includes(orientation)) throw new Error('PDF 页面方向无效');
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 100) throw new Error('PDF 页边距必须是 0 至 100 的数值');
  if (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0 || gap > 100) throw new Error('PDF 图片间距必须是 0 至 100 的数值');
  return { pageSize, orientation, margin, imagesPerPage, gap };
}

function pageLayout(imageWidth, imageHeight, options = {}) {
  const { pageSize, orientation, margin } = pdfOptions(options);
  let width, height;
  if (pageSize === 'a4') {
    width = 210 / 25.4 * 72;
    height = 297 / 25.4 * 72;
    if (orientation === 'landscape' || (orientation === 'auto' && imageWidth > imageHeight)) [width, height] = [height, width];
  } else {
    // Treat pixels as CSS pixels (96 dpi); cap pages to the PDF 1.4 limit.
    const scale = Math.min(0.75, (MAX_PAGE_POINTS - margin * 2) / Math.max(imageWidth, imageHeight));
    width = imageWidth * scale + margin * 2;
    height = imageHeight * scale + margin * 2;
    if ((orientation === 'portrait' && width > height) || (orientation === 'landscape' && height > width)) [width, height] = [height, width];
  }
  const scale = Math.min((width - margin * 2) / imageWidth, (height - margin * 2) / imageHeight);
  const drawWidth = imageWidth * scale, drawHeight = imageHeight * scale;
  return { width, height, drawWidth, drawHeight, x: (width - drawWidth) / 2, y: (height - drawHeight) / 2 };
}

function gridLayout(options = {}) {
  const { imagesPerPage, orientation, margin, gap } = pdfOptions(options);
  const grids = { 1: [1, 1], 2: [1, 2], 3: [1, 3], 4: [2, 2], 6: [2, 3], 8: [2, 4], 9: [3, 3] };
  let [columns, rows] = grids[imagesPerPage];
  let width = 210 / 25.4 * 72, height = 297 / 25.4 * 72;
  if (orientation === 'landscape') {
    [width, height] = [height, width];
    [columns, rows] = [rows, columns];
  }
  const cellWidth = (width - margin * 2 - gap * (columns - 1)) / columns;
  const cellHeight = (height - margin * 2 - gap * (rows - 1)) / rows;
  return { width, height, columns, rows, cellWidth, cellHeight, gap, margin };
}

function fitGridImage(imageWidth, imageHeight, slot, grid) {
  const scale = Math.min(grid.cellWidth / imageWidth, grid.cellHeight / imageHeight);
  const drawWidth = imageWidth * scale, drawHeight = imageHeight * scale;
  const column = slot % grid.columns, row = Math.floor(slot / grid.columns);
  return { width: grid.width, height: grid.height, drawWidth, drawHeight,
    x: grid.margin + column * (grid.cellWidth + grid.gap) + (grid.cellWidth - drawWidth) / 2,
    // PDF starts at the bottom; ordered input fills cells from the top left.
    y: grid.height - grid.margin - row * (grid.cellHeight + grid.gap) - (grid.cellHeight + drawHeight) / 2 };
}

// Small dependency-free PDF 1.4 writer. Images are embedded losslessly, with
// only one image's decoded pixels held in memory at a time, even in a grid.
async function writeImagePdf({ inputPaths, outputPath, options = {}, signal, onProgress = () => {} } = {}) {
  if (!Array.isArray(inputPaths) || !inputPaths.length || inputPaths.length > MAX_PAGES || inputPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) throw new Error(`请选择 1 至 ${MAX_PAGES} 张有效图片`);
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw new Error('PDF 保存路径无效');
  const settings = pdfOptions(options);
  const grid = settings.imagesPerPage > 1 ? gridLayout(settings) : null;
  const pages = [];
  let nextObjectId = 3;
  for (let start = 0; start < inputPaths.length; start += settings.imagesPerPage) {
    const count = Math.min(settings.imagesPerPage, inputPaths.length - start);
    const imageIds = Array.from({ length: count }, () => nextObjectId++);
    pages.push({ start, imageIds, contentId: nextObjectId++, pageId: nextObjectId++ });
  }
  checkAbort(signal);
  let handle, created = false, offset = 0;
  const offsets = [0];
  const pageSizes = [];
  const write = async value => {
    checkAbort(signal);
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii');
    if (offset + buffer.length > MAX_OUTPUT_BYTES) throw new Error('PDF 超过 2 GB，请分批导出');
    let written = 0;
    while (written < buffer.length) {
      checkAbort(signal);
      const result = await handle.write(buffer, written, buffer.length - written, null);
      if (!result.bytesWritten) throw new Error('无法写入 PDF 文件');
      written += result.bytesWritten;
      offset += result.bytesWritten;
    }
  };
  const object = async (id, body, bytes) => {
    offsets[id] = offset;
    await write(`${id} 0 obj\n${body}`);
    if (bytes) {
      await write('\nstream\n');
      await write(bytes);
      await write('\nendstream');
    }
    await write('\nendobj\n');
  };
  try {
    handle = await fs.open(outputPath, 'wx');
    created = true;
    await write(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
    await object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    await object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(page => `${page.pageId} 0 R`).join(' ')}] >>`);
    for (const page of pages) {
      const contentParts = [];
      let dimensions;
      for (let slot = 0; slot < page.imageIds.length; slot++) {
        const index = page.start + slot;
        checkAbort(signal);
        onProgress({ progress: index / inputPaths.length, current: index + 1, total: inputPaths.length });
        const input = inputPaths[index];
        const metadata = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
        if ((metadata.pages || 1) > 1) throw new Error('PDF 暂不处理动图或多页图片，请先转为静态图片');
        if (!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸');
        checkAbort(signal);
        const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
          .rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
        checkAbort(signal);
        const compressed = await deflate(data);
        checkAbort(signal);
        const layout = grid ? fitGridImage(info.width, info.height, slot, grid) : pageLayout(info.width, info.height, settings);
        dimensions = { width: layout.width, height: layout.height };
        await object(page.imageIds[slot], `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>`, compressed);
        contentParts.push(`q\n${decimal(layout.drawWidth)} 0 0 ${decimal(layout.drawHeight)} ${decimal(layout.x)} ${decimal(layout.y)} cm\n/Im${slot} Do\nQ\n`);
        onProgress({ progress: (index + 1) / inputPaths.length, current: index + 1, total: inputPaths.length });
      }
      pageSizes.push(dimensions);
      const content = Buffer.from(contentParts.join(''), 'ascii');
      await object(page.contentId, `<< /Length ${content.length} >>`, content);
      const resources = page.imageIds.map((id, slot) => `/Im${slot} ${id} 0 R`).join(' ');
      await object(page.pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${decimal(dimensions.width)} ${decimal(dimensions.height)}] /Resources << /XObject << ${resources} >> >> /Contents ${page.contentId} 0 R >>`);
    }
    checkAbort(signal);
    const xref = offset;
    await write(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    for (let id = 1; id < offsets.length; id++) await write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    await write(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    await handle.close();
    handle = null;
    checkAbort(signal);
    return { pages: pages.length, inputCount: inputPaths.length, imagesPerPage: settings.imagesPerPage, pageSizes,
      layout: { columns: grid?.columns || 1, rows: grid?.rows || 1, margin: settings.margin, gap: grid ? settings.gap : 0 },
      size: offset, engine: '本地 PDF' };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { writeImagePdf, pageLayout, gridLayout, pdfOptions, MAX_PAGES, MAX_PIXELS, IMAGES_PER_PAGE };
