'use strict';

const JSZip = require('jszip');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2);
const INLINE_TABLE_ROW_LIMIT = 60;
const BLUE = rgb(0.08, 0.4, 0.72);
const DARK = rgb(0.08, 0.15, 0.23);
const MUTED = rgb(0.35, 0.42, 0.5);

function pdfText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/[\\()]/g, '\\$&')
    .replace(/[\r\n\t]/g, ' ');
}

function wrap(value, width) {
  const words = String(value || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!word) continue;
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function pageContent(lines) {
  const commands = ['BT', '/F1 18 Tf', '54 742 Td', `(${pdfText(lines[0])}) Tj`, '/F1 10 Tf', '0 -28 Td'];
  lines.slice(1).forEach((line, index) => {
    if (index) commands.push('0 -17 Td');
    commands.push(`(${pdfText(line)}) Tj`);
  });
  commands.push('ET');
  return commands.join('\n');
}

function fmtDate(value) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return isNaN(date) ? pdfText(value) : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtSize(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function drawLines(page, lines, x, y, font, size, color, lineHeight) {
  let cursor = y;
  for (const line of lines) {
    page.drawText(pdfText(line), { x, y: cursor, size, font, color });
    cursor -= lineHeight;
  }
  return cursor;
}

function addTextPage(pdf, title, lines, fonts, options = {}) {
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const heading = options.heading || title;
  page.drawText(pdfText(heading), { x: MARGIN, y: PAGE_HEIGHT - MARGIN, size: options.headingSize || 16, font: fonts.bold, color: options.headingColor || DARK });
  let y = PAGE_HEIGHT - MARGIN - (options.headingSize || 16) - 20;
  const size = options.size || 10;
  const lineHeight = options.lineHeight || 15;
  for (const raw of lines) {
    y = drawLines(page, wrap(raw, options.wrapWidth || 94), MARGIN, y, fonts.regular, size, options.color || DARK, lineHeight) - (options.paragraphGap || 2);
  }
  return page;
}

function parseCsv(value) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const source = String(value || '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); if (row.some(value => value.trim())) rows.push(row); }
  return rows;
}

function tableWidths(rows) {
  const count = Math.max(1, ...rows.map(row => row.length));
  const widths = Array.from({ length: count }, (_, index) => {
    const longest = Math.max(8, ...rows.map(row => String(row[index] || '').length));
    return Math.max(54, Math.min(180, longest * 3.4 + 24));
  });
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map(width => width * CONTENT_WIDTH / total);
}

function tableCellLines(value, width, size) {
  return wrap(value || '', Math.max(7, Math.floor((width - 10) / (size * 0.52)))).slice(0, 3);
}

function drawTableRow(page, row, widths, top, fonts, header) {
  const size = header ? 8 : 7.5;
  const cellLines = widths.map((width, index) => tableCellLines(row[index], width, size));
  const rowHeight = Math.max(header ? 25 : 21, ...cellLines.map(lines => lines.length * 9 + 10));
  let x = MARGIN;
  widths.forEach((width, index) => {
    page.drawRectangle({ x, y: top - rowHeight, width, height: rowHeight, color: header ? BLUE : (index % 2 ? rgb(0.98, 0.99, 1) : rgb(0.94, 0.97, 0.99)), borderColor: rgb(0.78, 0.84, 0.9), borderWidth: 0.45 });
    drawLines(page, cellLines[index], x + 5, top - 13, header ? fonts.bold : fonts.regular, size, header ? rgb(1, 1, 1) : DARK, 9);
    x += width;
  });
  return rowHeight;
}

function addTablePages(pdf, heading, tables, fonts) {
  for (const table of tables) {
    const rows = Array.isArray(table.rows) ? table.rows.filter(row => row.some(value => String(value || '').trim())) : [];
    if (!rows.length) { addTextPage(pdf, heading, ['The file contained no printable rows.'], fonts, { heading: `${heading} / ${table.title}` }); continue; }
    const widths = tableWidths(rows);
    let index = 0;
    while (index < rows.length) {
      const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      page.drawText(pdfText(heading), { x: MARGIN, y: PAGE_HEIGHT - MARGIN, size: 15, font: fonts.bold, color: DARK });
      page.drawText(pdfText(table.title), { x: MARGIN, y: PAGE_HEIGHT - MARGIN - 20, size: 9, font: fonts.regular, color: MUTED });
      let top = PAGE_HEIGHT - MARGIN - 54;
      const header = rows[0];
      top -= drawTableRow(page, header, widths, top, fonts, true);
      if (index === 0) index = 1;
      while (index < rows.length) {
        const rowHeight = Math.max(21, ...widths.map((width, column) => tableCellLines(rows[index][column], width, 7.5).length * 9 + 10));
        if (top - rowHeight < MARGIN) break;
        top -= drawTableRow(page, rows[index], widths, top, fonts, false);
        index++;
      }
    }
  }
}

function itemStatus(fileList, field) {
  if (fileList.length) return fileList.some(file => file.status === 'approved') ? 'Approved' : (fileList.some(file => file.status === 'attention') ? 'Needs attention' : 'Pending review');
  if (field && Object.keys(field.values || {}).length) return 'Information provided';
  return 'Not provided';
}

function xmlText(xml) {
  return pdfText(xml.replace(/<w:tab\s*\/?>(?:<\/w:tab>)?/g, '\t').replace(/<\/w:p>|<\/a:p>/g, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').trim());
}

async function officeTables(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = sharedFile ? (await sharedFile.async('string')).split(/<si[ >]/).slice(1).map(xmlText) : [];
  const targets = {};
  for (const match of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) targets[match[1]] = `xl/${match[2].replace(/^\/+/, '')}`;
  const tables = [];
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const sheetFile = zip.file(targets[sheet[2]] || '');
    if (!sheetFile) continue;
    const rows = [];
    const xml = await sheetFile.async('string');
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1], ref = /\br="([A-Z]+)\d+"/.exec(attrs), value = /<v>([\s\S]*?)<\/v>/.exec(cell[2]);
        if (!ref) continue;
        let column = 0; for (const letter of ref[1]) column = column * 26 + letter.charCodeAt(0) - 64;
        let cellValue = value ? xmlText(value[1]) : xmlText((/<is>([\s\S]*?)<\/is>/.exec(cell[2]) || [])[1] || '');
        if (/\bt="s"/.test(attrs)) cellValue = shared[Number(cellValue)] || '';
        cells[column - 1] = cellValue;
      }
      if (cells.length) rows.push(cells);
    }
    tables.push({ title: sheet[1], rows });
  }
  return tables;
}

async function officeText(buffer, ext) {
  if (ext === '.xlsx') {
    const tables = await officeTables(buffer);
    return tables.flatMap(table => [`Sheet: ${table.title}`, ...table.rows.map(row => row.join(', ')), '']);
  }
  if (ext === '.xlsx') {
    const zip = await JSZip.loadAsync(buffer);
    const workbook = await zip.file('xl/workbook.xml').async('string');
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const sharedFile = zip.file('xl/sharedStrings.xml');
    const shared = sharedFile ? (await sharedFile.async('string')).split(/<si[ >]/).slice(1).map(xmlText) : [];
    const targets = {};
    for (const match of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) targets[match[1]] = `xl/${match[2].replace(/^\/+/, '')}`;
    const lines = [];
    for (const sheet of workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
      const sheetFile = zip.file(targets[sheet[2]] || '');
      if (!sheetFile) continue;
      const xml = await sheetFile.async('string');
      lines.push(`Sheet: ${sheet[1]}`);
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cell[1], ref = /\br="([A-Z]+)\d+"/.exec(attrs), value = /<v>([\s\S]*?)<\/v>/.exec(cell[2]);
          if (!ref || !value) continue;
          let column = 0; for (const letter of ref[1]) column = column * 26 + letter.charCodeAt(0) - 64;
          let cellValue = xmlText(value[1]);
          if (/\bt="s"/.test(attrs)) cellValue = shared[Number(cellValue)] || '';
          cells[column - 1] = cellValue;
        }
        if (cells.length) lines.push(cells.map(value => `"${String(value || '').replace(/"/g, '""')}"`).join(','));
      }
      lines.push('');
    }
    return lines;
  }
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter(name => ext === '.docx' ? /^word\/document.*\.xml$/i.test(name) : /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort();
  return (await Promise.all(names.map(name => zip.file(name).async('string')))).map(xmlText).filter(Boolean);
}

async function renderFile(pdf, file, sectionTitle, itemName, readBuffer, fonts) {
  const buffer = readBuffer(file.id);
  if (!buffer) return addTextPage(pdf, itemName, [`${file.name}: the original file could not be read from storage.`], fonts, { heading: sectionTitle });
  const ext = String(file.ext || '').toLowerCase();
  if (['.xlsx', '.xls', '.csv', '.docx', '.doc', '.pptx', '.ppt'].includes(ext)) {
    await pdf.attach(buffer, file.name, { mimeType: file.mime || 'application/octet-stream', description: `Original file for ${sectionTitle} / ${itemName}` });
  }
  if (['.docx', '.doc'].includes(ext)) {
    addTextPage(pdf, itemName, [`Original file attached: ${file.name}`, 'The Word document is preserved in its original format and can be downloaded from this packet.'], fonts, { heading: sectionTitle });
    return;
  }
  if (ext === '.pdf') {
    try {
      const source = await PDFDocument.load(buffer);
      const pages = await pdf.copyPages(source, source.getPageIndices());
      pages.forEach(page => pdf.addPage(page));
      return;
    } catch (_) { /* use fallback page */ }
  }
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
    try {
      const image = ext === '.png' ? await pdf.embedPng(buffer) : await pdf.embedJpg(buffer);
      const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      page.drawText(pdfText(`${sectionTitle} / ${itemName} / ${file.name}`), { x: MARGIN, y: PAGE_HEIGHT - MARGIN, size: 9, font: fonts.bold, color: BLUE });
      const scale = Math.min(CONTENT_WIDTH / image.width, (PAGE_HEIGHT - 120) / image.height);
      const width = image.width * scale, height = image.height * scale;
      page.drawImage(image, { x: (PAGE_WIDTH - width) / 2, y: Math.max(MARGIN, (PAGE_HEIGHT - height) / 2 - 10), width, height });
      return;
    } catch (_) { /* use fallback page */ }
  }
  if (['.xlsx', '.csv'].includes(ext)) {
    try {
      const tables = ext === '.csv' ? [{ title: file.name, rows: parseCsv(buffer.toString('utf8')) }] : await officeTables(buffer);
      const rowCount = tables.reduce((count, table) => count + table.rows.length, 0);
      if (rowCount > INLINE_TABLE_ROW_LIMIT) {
        addTextPage(pdf, itemName, [`Original file attached: ${file.name}`, `This ${ext === '.csv' ? 'CSV' : 'spreadsheet'} contains ${rowCount} rows, so it is available as the original file instead of being expanded across many packet pages.`], fonts, { heading: sectionTitle });
        return;
      }
      addTablePages(pdf, `${sectionTitle} / ${itemName} / ${file.name}`, tables, fonts);
      return;
    } catch (_) { /* use fallback page */ }
  }
  if (['.txt', '.xls', '.docx', '.pptx'].includes(ext)) {
    try {
      const lines = ext === '.txt' || ext === '.csv' ? buffer.toString('utf8').split(/\r?\n/) : await officeText(buffer, ext);
      addTextPage(pdf, itemName, lines.length ? lines : ['The file contained no printable text.'], fonts, { heading: `${sectionTitle} / ${itemName} / ${file.name}`, size: 8, lineHeight: 11, wrapWidth: 115 });
      return;
    } catch (_) { /* use fallback page */ }
  }
  addTextPage(pdf, itemName, [`${file.name} is attached to this requirement.`, `Format: ${file.ext || file.mime || 'unknown'}; size: ${fmtSize(file.size)}.`, 'This file format could not be rendered inline on the server. Open the original file from the portal.'], fonts, { heading: sectionTitle });
}

async function createPacketPdf({ provider, sections, files, fields, readBuffer }) {
  const pdf = await PDFDocument.create();
  const fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const fileList = Array.isArray(files) ? files : [];
  const fieldList = Array.isArray(fields) ? fields : [];
  const fileByKey = {};
  fileList.forEach(file => { if (file.docKey) (fileByKey[file.docKey] ||= []).push(file); });
  const fieldByKey = Object.fromEntries(fieldList.map(field => [field.docKey, field]));
  const catalogSections = Array.isArray(sections) ? sections : [];
  const cover = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cover.drawText(pdfText(`Credentialing packet for ${provider.displayName || provider.email || 'Provider'}`), { x: MARGIN, y: PAGE_HEIGHT - 72, size: 22, font: fonts.bold, color: DARK });
  cover.drawText('Profile and submitted credentialing documents', { x: MARGIN, y: PAGE_HEIGHT - 98, size: 11, font: fonts.regular, color: MUTED });
  cover.drawText('PROFILE', { x: MARGIN, y: PAGE_HEIGHT - 150, size: 10, font: fonts.bold, color: BLUE });
  const deal = provider.deal || {};
  drawLines(cover, [`Name: ${provider.displayName || 'Not provided'}`, `Email: ${provider.email || 'Not provided'}`, `Account: ${provider.active === false ? 'Inactive' : 'Active'}`, `Pipeline status: ${deal.status || 'pending'}`, `Active date: ${fmtDate(deal.activeDate)}`, `Packet generated: ${fmtDate(new Date().toISOString())}`], MARGIN, PAGE_HEIGHT - 174, fonts.regular, 11, DARK, 20);
  let coverY = PAGE_HEIGHT - 340;
  cover.drawText('SECTIONS', { x: MARGIN, y: coverY, size: 10, font: fonts.bold, color: BLUE });
  coverY -= 22;
  catalogSections.forEach((section, index) => { if (coverY >= MARGIN + 20) { cover.drawText(pdfText(`${index + 1}. ${section.title}`), { x: MARGIN, y: coverY, size: 10, font: fonts.regular, color: DARK }); coverY -= 16; } });
  for (const [sectionIndex, section] of catalogSections.entries()) {
    const sectionItems = Array.isArray(section.items) ? section.items : [];
    const overview = [`Section ${sectionIndex + 1} of ${catalogSections.length}`, ''];
    sectionItems.forEach(item => {
      const itemFiles = fileByKey[item.key] || [], field = fieldByKey[item.key];
      overview.push(`${item.name} — ${itemStatus(itemFiles, field)}`);
      itemFiles.forEach(file => overview.push(`  ${file.name} · ${file.status || 'pending'} · ${fmtSize(file.size)} · uploaded ${fmtDate(file.createdAt)}`));
      if (field && field.values) Object.entries(field.values).forEach(([key, value]) => overview.push(`  ${key}: ${value || 'Not provided'}`));
      overview.push('');
    });
    addTextPage(pdf, section.title, overview, fonts, { heading: `${sectionIndex + 1}. ${section.title}`, size: 10, lineHeight: 15, wrapWidth: 92 });
    for (const item of sectionItems) for (const file of fileByKey[item.key] || []) await renderFile(pdf, file, section.title, item.name, readBuffer, fonts);
  }
  return Buffer.from(await pdf.save());
}

function archiveFileName(name, used) {
  const clean = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  let candidate = clean;
  let index = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem} (${index++})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

async function createPacketBundle({ pdf, files, readBuffer }) {
  const zip = new JSZip();
  zip.file('credentialing-packet.pdf', pdf);
  const used = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const buffer = readBuffer(file.id);
    if (buffer) zip.file(`files/${archiveFileName(file.name, used)}`, buffer);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { createPacketPdf, createPacketBundle };