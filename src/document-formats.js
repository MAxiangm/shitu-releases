(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MosaicDocumentFormats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const extensions = Object.freeze(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'odt', 'ods', 'odp']);
  const mimeTypes = Object.freeze({
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', rtf: 'application/rtf',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation'
  });
  const labels = Object.freeze({ pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', ppt: 'PowerPoint', pptx: 'PowerPoint', txt: '文本', md: 'Markdown', csv: 'CSV', rtf: 'RTF', odt: 'OpenDocument 文本', ods: 'OpenDocument 表格', odp: 'OpenDocument 演示' });
  const normalize = extension => typeof extension === 'string' ? extension.replace(/^\./, '').toLowerCase() : '';
  const has = extension => Object.hasOwn(mimeTypes, normalize(extension));
  const label = extension => labels[normalize(extension)] || '文档';
  return Object.freeze({ extensions, mimeTypes, labels, has, label });
});
