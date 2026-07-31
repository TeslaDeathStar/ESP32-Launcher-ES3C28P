#!/usr/bin/env node
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const ROOT_DIR  = path.resolve(process.argv[2] || '.');
const PORT      = parseInt(process.env.PORT || '8080', 10);
const WEBUI_DIR = path.resolve(__dirname, '..');
const USERNAME  = process.env.WUI_USR || 'admin';
const PASSWORD  = process.env.WUI_PWD || 'admin';
const NVS_FILE  = path.join(__dirname, 'nvs_mock.json');

// ── State ─────────────────────────────────────────────────────────────────────
const sessions = new Map();  // token → timestamp

let otaContext = null;

let nvs = {};
try { nvs = JSON.parse(fs.readFileSync(NVS_FILE, 'utf8')); } catch {}
if (!Object.keys(nvs).length) {
  nvs = {
    launcher: [
      { k: 'brightness', t: 'u8',  v: 128 },
      { k: 'rotation',   t: 'u8',  v: 1   },
      { k: 'wifi_ssid',  t: 'str', v: 'MyNetwork' },
      { k: 'wifi_pwd',   t: 'str', v: 'secret'    },
    ]
  };
  fs.writeFileSync(NVS_FILE, JSON.stringify(nvs, null, 2));
}
function saveNvs() { fs.writeFileSync(NVS_FILE, JSON.stringify(nvs, null, 2)); }

// ── Partition Manager (PMan) mock ───────────────────────────────────────────────
// Mirrors the model in src/partition_table_model.cpp / src/partitioner.cpp closely
// enough to drive the WebUI: edits accumulate in `workingTable` (nothing is
// "written to flash") until an `apply` action persists them to PARTITIONS_FILE and
// clears the pending state, exactly like the on-device dirty-flag flow.
const PART_TABLE_OFFSET = 0x8000;
const PART_TABLE_SIZE = 0x1000;
const SECTOR_SIZE = 0x1000;
const APP_ALIGNMENT = 0x10000;
const PARTITIONS_FILE = path.join(__dirname, 'partitions_mock.json');

function defaultPartitionsMock() {
  return {
    flashSize: 0x1000000, // 16MB
    runningOffset: 0x110000, // pretend "app1" is the currently booted OTA slot
    entries: [
      { type: 0x01, subtype: 0x02, label: 'nvs', offset: 0x009000, size: 0x005000, flags: 0 },
      { type: 0x01, subtype: 0x00, label: 'otadata', offset: 0x00e000, size: 0x002000, flags: 0 },
      { type: 0x00, subtype: 0x00, label: 'factory', offset: 0x010000, size: 0x100000, flags: 0 },
      {
        type: 0x00, subtype: 0x10, label: 'app1', offset: 0x110000, size: 0x200000, flags: 0,
        appName: 'Bruce', dataLabels: ['spiffs'],
      },
      {
        type: 0x01, subtype: 0x82, label: 'spiffs', offset: 0x310000, size: 0x100000, flags: 0,
        appName: 'Bruce',
      },
      {
        type: 0x00, subtype: 0x11, label: 'app2', offset: 0x410000, size: 0x200000, flags: 0,
        appName: 'Marauder', dataLabels: ['vfs'],
      },
      {
        type: 0x01, subtype: 0x81, label: 'vfs', offset: 0x610000, size: 0x200000, flags: 0,
        appName: 'Marauder',
      },
    ],
  };
}

function loadPartitionsMock() {
  try { return JSON.parse(fs.readFileSync(PARTITIONS_FILE, 'utf8')); } catch {}
  const seed = defaultPartitionsMock();
  fs.writeFileSync(PARTITIONS_FILE, JSON.stringify(seed, null, 2));
  return seed;
}
function savePartitionsMock() { fs.writeFileSync(PARTITIONS_FILE, JSON.stringify(flashTable, null, 2)); }

let flashTable = loadPartitionsMock();     // last "written" table (ground truth)
let workingTable = null;                   // staged edits, or null when nothing is pending
let workingDirty = false;
const backupsByLabel = {};                 // label -> [{path, type}]  (in-memory, simulated)

function cloneTable(t) { return JSON.parse(JSON.stringify(t)); }
function sourceTable() { return workingDirty && workingTable ? workingTable : flashTable; }
function commitEdit(edited) { workingTable = edited; workingDirty = true; }
function fail(error, msg) { error.msg = msg; return false; }

function partAlignment(type, subtype) {
  if (type === 0x00) return APP_ALIGNMENT;
  if (type === 0x01 && [0x81, 0x82, 0x83].includes(subtype)) return APP_ALIGNMENT;
  return SECTOR_SIZE;
}
function alignUp(v, a) { return a ? Math.ceil(v / a) * a : v; }
function alignDown(v, a) { return a ? Math.floor(v / a) * a : v; }

function partTypeName(e) { return ({ 0: 'APP', 1: 'DATA', 2: 'BOOT', 3: 'PTBL' })[e.type] || 'UNK'; }
function partSubtypeName(e) {
  if (e.type === 0x00) {
    if (e.subtype === 0x00) return 'factory';
    if (e.subtype >= 0x10 && e.subtype <= 0x1f) return 'ota_' + (e.subtype - 0x10);
    if (e.subtype === 0x20) return 'test';
  }
  if (e.type === 0x01) {
    if (e.subtype === 0x00) return 'ota';
    if (e.subtype === 0x01) return 'phy';
    if (e.subtype === 0x02) return 'nvs';
    if (e.subtype === 0x03) return 'coredump';
    if (e.subtype === 0x81) return 'fat';
    if (e.subtype === 0x82) return 'spiffs';
    if (e.subtype === 0x83) return 'littlefs';
  }
  return e.subtype.toString(16).padStart(2, '0').toUpperCase();
}
function isFactoryOrTest(e) { return e.type === 0x00 && (e.subtype === 0x00 || e.subtype === 0x20); }
function isProtectedEntry(table, e) {
  if (table.runningOffset === e.offset) return true;
  if (isFactoryOrTest(e)) return true;
  if (e.type === 0x01 && e.subtype <= 0x05) return true;
  return false;
}

function freeRanges(table) {
  const sorted = [...table.entries].sort((a, b) => a.offset - b.offset);
  const ranges = [];
  let cursor = PART_TABLE_OFFSET + PART_TABLE_SIZE;
  for (const e of sorted) {
    if (e.offset > cursor) ranges.push({ offset: cursor, size: e.offset - cursor });
    cursor = Math.max(cursor, e.offset + e.size);
  }
  if (cursor < table.flashSize) ranges.push({ offset: cursor, size: table.flashSize - cursor });
  return ranges.filter((r) => r.size > 0);
}

function validatePartitions(table, error) {
  if (!table.entries.length) return fail(error, 'Empty table');
  const sorted = [...table.entries].sort((a, b) => a.offset - b.offset);
  for (const e of sorted) {
    if (!e.label) return fail(error, "Partition needs a label");
    if (!e.size) return fail(error, `${e.label}: size can't be zero`);
    if (e.offset % SECTOR_SIZE !== 0 || e.size % SECTOR_SIZE !== 0)
      return fail(error, `${e.label}: not sector-aligned`);
    if (e.offset < PART_TABLE_OFFSET + PART_TABLE_SIZE)
      return fail(error, `${e.label}: overlaps the partition table`);
    if (e.offset + e.size > table.flashSize) return fail(error, `${e.label}: exceeds flash size`);
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].size)
      return fail(error, `${sorted[i].label} overlaps ${sorted[i - 1].label}`);
  }
  return true;
}

// Re-packs every entry contiguously (sector/64KB aligned per its own type) right after
// the partition-table area, same intent as launcherPartitionCompact(): free space always
// ends up as a single trailing range instead of scattered gaps.
function compactPartitions(table) {
  const sorted = [...table.entries].sort((a, b) => a.offset - b.offset);
  let cursor = PART_TABLE_OFFSET + PART_TABLE_SIZE;
  for (const e of sorted) {
    e.offset = alignUp(cursor, partAlignment(e.type, e.subtype));
    cursor = e.offset + e.size;
  }
  table.entries = sorted;
}

function findIndexByOffset(table, offset) { return table.entries.findIndex((e) => e.offset === offset); }

function buildPartitionsView(table) {
  const entries = table.entries
    .filter((e) => e.offset >= 0x10000)
    .map((e) => {
      const protectedEntry = isProtectedEntry(table, e);
      const view = {
        type: e.type,
        subtype: e.subtype,
        typeName: partTypeName(e),
        subtypeName: partSubtypeName(e),
        label: e.label,
        offset: e.offset,
        size: e.size,
        flags: e.flags || 0,
        protected: protectedEntry,
        running: table.runningOffset === e.offset,
      };
      if (e.type === 0x00) {
        if (e.appName) view.appName = e.appName;
        if (e.dataLabels && e.dataLabels.length) view.dataLabels = e.dataLabels;
      } else if (e.type === 0x01 && e.appName) {
        view.appName = e.appName;
      }
      if (!protectedEntry) {
        let minOffset = PART_TABLE_OFFSET + PART_TABLE_SIZE;
        let maxOffset = table.flashSize;
        for (const other of table.entries) {
          if (other === e) continue;
          const otherEnd = other.offset + other.size;
          if (otherEnd <= e.offset && otherEnd > minOffset) minOffset = otherEnd;
          if (other.offset >= e.offset + e.size && other.offset < maxOffset) maxOffset = other.offset;
        }
        view.minOffset = minOffset;
        view.maxOffset = maxOffset;
        view.alignment = partAlignment(e.type, e.subtype);
      }
      return view;
    });
  return { flashSize: table.flashSize, dirty: workingDirty, entries, freeRanges: freeRanges(table) };
}

function actionResize(params, error) {
  const offset = Number(params.offset);
  const newSize = Number(params.size);
  const newOffset = params.newOffset !== undefined ? Number(params.newOffset) : offset;
  const source = sourceTable();
  const idx = findIndexByOffset(source, offset);
  if (idx < 0) return fail(error, 'Partition not found');
  if (isProtectedEntry(source, source.entries[idx])) return fail(error, 'Protected partition');
  if (!newSize) return fail(error, 'Invalid size');

  const edited = cloneTable(source);
  edited.entries[idx].offset = newOffset;
  edited.entries[idx].size = newSize;
  if (!validatePartitions(edited, error)) return false;
  compactPartitions(edited);
  commitEdit(edited);
  return true;
}

function actionCreate(params, error) {
  const type = Number(params.type);
  let subtype = Number(params.subtype);
  const label = String(params.label || '').trim();
  if (!label) return fail(error, 'Label required');
  const alignment = partAlignment(type, subtype);
  const size = alignUp(Number(params.size) || 0, alignment);
  if (!size) return fail(error, 'Invalid size');

  const edited = cloneTable(sourceTable());
  let offset;
  if (params.offset !== undefined) {
    offset = Number(params.offset);
  } else {
    const free = freeRanges(edited).find((r) => {
      const alignedOffset = alignUp(r.offset, alignment);
      const alignedEnd = alignDown(r.offset + r.size, alignment);
      return alignedEnd - alignedOffset >= size;
    });
    if (!free) return fail(error, 'No free range large enough');
    offset = alignUp(free.offset, alignment);
  }

  if (type === 0x00) {
    const used = new Set(
      edited.entries.filter((e) => e.type === 0x00 && e.subtype >= 0x10 && e.subtype <= 0x1f).map((e) => e.subtype)
    );
    let nextSubtype = -1;
    for (let s = 0x10; s <= 0x1f; s++) if (!used.has(s)) { nextSubtype = s; break; }
    if (nextSubtype < 0) return fail(error, 'No OTA slot available');
    subtype = nextSubtype;
  }

  edited.entries.push({ type, subtype, label, offset, size, flags: 0 });
  if (!validatePartitions(edited, error)) return false;
  compactPartitions(edited);
  commitEdit(edited);
  return true;
}

function actionDelete(params, error) {
  const offset = Number(params.offset);
  const source = sourceTable();
  const idx = findIndexByOffset(source, offset);
  if (idx < 0) return fail(error, 'Partition not found');
  if (isProtectedEntry(source, source.entries[idx])) return fail(error, 'Protected partition');

  const edited = cloneTable(source);
  edited.entries.splice(idx, 1);
  if (!validatePartitions(edited, error)) return false;
  compactPartitions(edited);
  commitEdit(edited);
  return true;
}

function actionFormat(params, error) {
  if (workingDirty) return fail(error, 'Apply or discard pending changes first');
  const offset = Number(params.offset);
  const source = sourceTable();
  const idx = findIndexByOffset(source, offset);
  if (idx < 0) return fail(error, 'Partition not found');
  const entry = source.entries[idx];
  if (isProtectedEntry(source, entry) || entry.type !== 0x01) return fail(error, 'Cannot format');
  console.log(`[PMAN] format (simulated) label=${entry.label}`);
  return true;
}

function actionApply(error) {
  const target = cloneTable(sourceTable());
  compactPartitions(target);
  if (!validatePartitions(target, error)) return false;
  flashTable = target;
  savePartitionsMock();
  workingTable = null;
  workingDirty = false;
  console.log('[PMAN] partition table written (simulated) — device would reboot now');
  return true;
}

function actionDiscard() {
  workingTable = null;
  workingDirty = false;
  return true;
}

function actionBackup(params, error) {
  const label = params.label;
  if (!label) { fail(error, 'Missing label'); return null; }
  const entry = sourceTable().entries.find((e) => e.label === label);
  if (!entry) { fail(error, 'Partition not found'); return null; }
  const dir = entry.appName ? `/bkp/mock-${entry.appName}` : '/bkp';
  const idx = (backupsByLabel[label] || []).length;
  const typeLabel = partSubtypeName(entry).toUpperCase();
  const outPath = `${dir}/${typeLabel}.${label}.${idx}.bin`;
  backupsByLabel[label] = backupsByLabel[label] || [];
  backupsByLabel[label].push({ path: outPath, type: typeLabel });
  console.log(`[PMAN] backup (simulated) label=${label} -> ${outPath}`);
  return outPath;
}

function actionRestore(params, error) {
  const { label, path: backupPath } = params;
  if (!label || !backupPath) return fail(error, 'Missing label or path');
  console.log(`[PMAN] restore (simulated) label=${label} <- ${backupPath}`);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function humanReadableSize(bytes) {
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(2)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function generateToken() {
  return crypto.randomBytes(18).toString('base64url').slice(0, 24);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}

function isAuthenticated(req) {
  const token = parseCookies(req)['ESP32SESSION'];
  return !!(token && sessions.has(token));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clearOtaContext() {
  otaContext = null;
}

// Safe path resolution — never escape ROOT_DIR
function toAbsPath(relPath) {
  const abs = path.normalize(path.join(ROOT_DIR, relPath));
  if (abs !== ROOT_DIR && !abs.startsWith(ROOT_DIR + path.sep)) return null;
  return abs;
}

// ── Binary multipart parser ───────────────────────────────────────────────────
function bufferIndexOf(buf, needle, offset = 0) {
  for (let i = offset; i <= buf.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

function parseMultipart(body, boundary) {
  // Returns { fieldName: string|Buffer, ... }
  // Binary files → Buffer; text fields → string
  const result   = {};
  const CRLF     = Buffer.from('\r\n');
  const DBLCRLF  = Buffer.from('\r\n\r\n');
  const delim    = Buffer.from('--' + boundary);
  const endDelim = Buffer.from('--' + boundary + '--');

  let pos = 0;
  while (pos < body.length) {
    const start = bufferIndexOf(body, delim, pos);
    if (start === -1) break;
    pos = start + delim.length;

    // End of multipart
    if (body.slice(pos, pos + 2).toString() === '--') break;
    // Skip CRLF after boundary
    if (body.slice(pos, pos + 2).toString() === '\r\n') pos += 2;

    // Find end of headers
    const headerEnd = bufferIndexOf(body, DBLCRLF, pos);
    if (headerEnd === -1) break;
    const headers = body.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;

    // Find next boundary to know content extent
    const nextBoundary = bufferIndexOf(body, Buffer.from('\r\n--' + boundary), pos);
    const contentEnd   = nextBoundary === -1 ? body.length : nextBoundary;
    const content      = body.slice(pos, contentEnd);
    pos = contentEnd;

    // Parse name and filename from Content-Disposition
    const dispLine = headers.split('\r\n').find(h => /content-disposition/i.test(h)) || '';
    const nameM    = dispLine.match(/\bname="([^"]+)"/i);
    const fileM    = dispLine.match(/\bfilename="([^"]*)"/i);
    if (!nameM) continue;
    const name     = nameM[1];
    const filename = fileM ? fileM[1] : null;

    result[name] = filename !== null
      ? { filename, data: content }
      : content.toString();
  }
  return result;
}

function parseParams(body, contentType) {
  if ((contentType || '').includes('multipart/form-data')) {
    const bm = contentType.match(/boundary=([^\s;]+)/);
    if (!bm) return {};
    const parsed = parseMultipart(body, bm[1]);
    const params = {};
    for (const [key, value] of Object.entries(parsed)) {
      params[key] = typeof value === 'string' ? value : value.toString();
    }
    return params;
  }

  const params = {};
  new URLSearchParams(body.toString()).forEach((v, k) => { params[k] = v; });
  return params;
}

function normalizeOtaPart(part, fileSize) {
  if (!part || typeof part !== 'object') throw new Error('Invalid manifest part');

  const normalized = {
    kind: typeof part.kind === 'string' ? part.kind : '',
    label: typeof part.label === 'string' ? part.label : '',
    subtype: Number(part.subtype),
    sourceOffset: Number(part.sourceOffset),
    copySize: Number(part.copySize),
    declaredSize: Number(part.declaredSize ?? part.copySize),
  };

  if (!['app', 'data'].includes(normalized.kind)) throw new Error('Invalid manifest part kind');
  if (!Number.isInteger(normalized.subtype) || normalized.subtype < 0 || normalized.subtype > 0xFF) {
    throw new Error('Invalid manifest subtype');
  }
  if (!Number.isInteger(normalized.sourceOffset) || normalized.sourceOffset < 0) {
    throw new Error('Invalid manifest sourceOffset');
  }
  if (!Number.isInteger(normalized.copySize) || normalized.copySize <= 0) {
    throw new Error('Invalid manifest copySize');
  }
  if (!Number.isInteger(normalized.declaredSize) || normalized.declaredSize <= 0) {
    throw new Error('Invalid manifest declaredSize');
  }
  if (normalized.sourceOffset > fileSize || normalized.copySize > fileSize - normalized.sourceOffset) {
    throw new Error('Manifest range exceeds file');
  }

  return normalized;
}

function prepareOtaContext(params) {
  const fileSize = Number(params.size);
  if (!Number.isInteger(fileSize) || fileSize <= 0) throw new Error('Invalid OTA size');

  if (!params.manifest) {
    clearOtaContext();
    return { active: false, legacy: true, fileSize, command: Number(params.command) || 0 };
  }

  let manifest;
  try {
    manifest = JSON.parse(params.manifest);
  } catch {
    throw new Error('Bad manifest');
  }

  if (!manifest || !Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    throw new Error('Missing parts');
  }

  const parts = manifest.parts.map((part) => normalizeOtaPart(part, fileSize));
  const appParts = parts.filter((part) => part.kind === 'app');
  if (appParts.length !== 1) throw new Error('Missing app part');

  parts.sort((a, b) => a.sourceOffset - b.sourceOffset);
  otaContext = {
    active: true,
    sourceName: typeof manifest.sourceName === 'string' ? manifest.sourceName : '',
    fileSize,
    parts,
    totalCopySize: parts.reduce((sum, part) => sum + part.copySize, 0),
    totalWritten: 0,
    receivedFileSize: 0,
  };
  return otaContext;
}

function logPreparedOtaContext(ctx) {
  if (!ctx.active) return;
  console.log(`[OTA] prepared source=${ctx.sourceName || 'unknown'} fileSize=${ctx.fileSize} totalCopySize=${ctx.totalCopySize}`);
  for (const part of ctx.parts) {
    const label = part.label ? ` label=${part.label}` : '';
    console.log(
      `[OTA] part kind=${part.kind} subtype=0x${part.subtype.toString(16)} offset=0x${part.sourceOffset.toString(16)} copy=0x${part.copySize.toString(16)} declared=0x${part.declaredSize.toString(16)}${label}`
    );
  }
}

// ── Directory listing (matches listFiles() in webInterface.cpp) ───────────────
function listFilesResponse(folder) {
  const normFolder = folder.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const abs = toAbsPath(normFolder === '/' ? '' : normFolder);
  let text = `pa:${normFolder}:0\n`;
  if (!abs) return text;
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        text += `Fo:${e.name}:0\n`;
      } else {
        const size = fs.statSync(path.join(abs, e.name)).size;
        text += `Fi:${e.name}:${humanReadableSize(size)}\n`;
      }
    }
  } catch (err) {
    console.error(`listfiles error: ${err.message}`);
  }
  return text;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname, query: queryStr } = url.parse(req.url || '/', false);
  const query  = Object.fromEntries(new URLSearchParams(queryStr || ''));
  const method = req.method || 'GET';

  function send(status, type, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  }
  const ok        = (body)     => send(200, 'text/plain', body);
  const sendJson  = (body)     => send(200, 'application/json', body);
  const err       = (code, m)  => send(code, 'text/plain', m);
  const redirect  = (loc, code = 302) => {
    res.writeHead(code, { 'Location': loc, 'Access-Control-Allow-Origin': '*' });
    res.end();
  };
  function serveFile(filePath, contentType) {
    try {
      send(200, contentType, fs.readFileSync(filePath));
    } catch {
      err(404, 'Not found');
    }
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST',
      'Access-Control-Allow-Headers': 'Content-Type,Cookie',
    });
    return res.end();
  }

  // ── Public endpoints ────────────────────────────────────────────────────────

  // GET /ping
  if (pathname === '/ping' && method === 'GET') return ok('launcher-pong');

  // GET /scripts.js
  if (pathname === '/scripts.js') return serveFile(path.join(WEBUI_DIR, 'scripts.js'), 'application/javascript');

  // GET /style.css
  if (pathname === '/style.css') return serveFile(path.join(WEBUI_DIR, 'style.css'), 'text/css');

  // GET /logged-out
  if (pathname === '/logged-out') return serveFile(path.join(WEBUI_DIR, 'logout.html'), 'text/html');

  // GET /systeminfo  (no auth required — scripts.js calls it on page load)
  if (pathname === '/systeminfo' && method === 'GET') {
    const totalBytes = 10 * 1024 * 1024 * 1024;
    const usedBytes = 2 * 1024 * 1024 * 1024;
    const freeBytes = totalBytes - usedBytes;
    const body = JSON.stringify({
      VERSION: '1.0.0-mock',
      SD: {
        free: humanReadableSize(freeBytes), used: humanReadableSize(usedBytes), total: humanReadableSize(totalBytes),
        freeBytes, usedBytes, totalBytes,
      }
    });
    return sendJson(body);
  }

  // GET / — serve login page or main UI
  if (pathname === '/' && method === 'GET') {
    if (isAuthenticated(req)) {
      return serveFile(path.join(WEBUI_DIR, 'index.html'), 'text/html');
    }
    return serveFile(path.join(WEBUI_DIR, 'login.html'), 'text/html');
  }

  // POST /login
  if (pathname === '/login' && method === 'POST') {
    const body = await readBody(req);
    const ct   = req.headers['content-type'] || '';
    let params = {};
    if (ct.includes('multipart/form-data')) {
      const bm = ct.match(/boundary=([^\s;]+)/);
      if (bm) { const p = parseMultipart(body, bm[1]); for (const k in p) params[k] = typeof p[k] === 'string' ? p[k] : p[k].toString(); }
    } else {
      new URLSearchParams(body.toString()).forEach((v, k) => { params[k] = v; });
    }
    if (params['username'] === USERNAME && params['password'] === PASSWORD) {
      const token = generateToken();
      sessions.clear();
      sessions.set(token, Date.now());
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': `ESP32SESSION=${token}; Path=/; HttpOnly`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end();
    }
    return redirect('/?failed');
  }

  // GET /logout
  if (pathname === '/logout') {
    sessions.delete(parseCookies(req)['ESP32SESSION']);
    res.writeHead(302, {
      'Location': '/?loggedout',
      'Set-Cookie': 'ESP32SESSION=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end();
  }

  // ── Auth wall ────────────────────────────────────────────────────────────────
  if (!isAuthenticated(req)) return err(401, 'Unauthorized');

  // GET /reboot
  if (pathname === '/reboot') {
    console.log('[REBOOT] simulated');
    return ok('Rebooting (simulated)');
  }

  if (pathname === '/OTA' && method === 'GET' && Object.prototype.hasOwnProperty.call(query, 'update')) {
    clearOtaContext();
    console.log('[OTA] update mode enabled (simulated)');
    return ok('Update');
  }

  // GET /listfiles?folder=X
  if (pathname === '/listfiles' && method === 'GET') {
    return ok(listFilesResponse(query.folder || '/'));
  }

  // GET /file?name=X&action=download|delete|create
  if (pathname === '/file' && method === 'GET') {
    const { name, action } = query;
    if (!name || !action) return err(400, 'ERROR: name and action params required');
    const abs = toAbsPath(name);
    if (!abs) return err(400, 'ERROR: invalid path');

    if (action === 'download') {
      try {
        const content = fs.readFileSync(abs);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': content.length,
          'Content-Disposition': `attachment; filename="${path.basename(abs)}"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(content);
      } catch { return err(404, 'File not found'); }
    }
    if (action === 'delete') {
      try { fs.rmSync(abs, { recursive: true, force: true }); return ok(`Deleted : ${name}`); }
      catch { return ok(`FAIL deleting: ${name}`); }
    }
    if (action === 'create') {
      try { fs.mkdirSync(abs, { recursive: true }); return ok(`Created new folder: ${name}`); }
      catch { return ok(`FAIL creating folder: ${name}`); }
    }
    return err(400, 'ERROR: invalid action param supplied');
  }

  // GET /editfile?name=X   POST /editfile?name=X
  if (pathname === '/editfile') {
    const { name } = query;
    if (!name) return err(400, 'Missing name');
    const abs = toAbsPath(name);
    if (!abs) return err(400, 'Invalid path');
    if (method === 'GET') {
      try { return send(200, 'text/plain', fs.readFileSync(abs)); }
      catch { return err(404, 'Not found'); }
    }
    if (method === 'POST') {
      const body = await readBody(req);
      try { fs.writeFileSync(abs, body); return ok('OK'); }
      catch { return ok('FAIL'); }
    }
  }

  // POST / — file upload
  if (pathname === '/' && method === 'POST') {
    const body = await readBody(req);
    const ct   = req.headers['content-type'] || '';
    const bm   = ct.match(/boundary=([^\s;]+)/);
    if (bm) {
      const parts = parseMultipart(body, bm[1]);
      // folder comes from the "folder" field in the XHR FormData
      const folder = typeof parts['folder'] === 'string' ? parts['folder'] : '/';
      for (const [k, v] of Object.entries(parts)) {
        if (typeof v === 'object' && v.data && v.filename) {
          // webkitRelativePath may contain subdirs in the filename
          const relName = v.filename.replace(/\\/g, '/');
          const dest = toAbsPath(path.posix.join(folder === '/' ? '' : folder, relName));
          if (!dest) continue;
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, v.data);
          console.log(`[UPLOAD] ${dest} (${humanReadableSize(v.data.length)})`);
        }
      }
    }
    return ok('OK');
  }

  // GET/POST /nvs
  if (pathname === '/nvs') {
    if (method === 'GET') return sendJson(JSON.stringify(nvs));
    if (method === 'POST') {
      const body = await readBody(req);
      try {
        const update = JSON.parse(body.toString());
        for (const [ns, fields] of Object.entries(update)) {
          if (!nvs[ns]) nvs[ns] = [];
          for (const field of (fields || [])) {
            if (ns === 'launcher' && field.k === 'token') continue;  // never expose
            const existing = nvs[ns].find(f => f.k === field.k);
            if (existing) Object.assign(existing, field);
            else nvs[ns].push(field);
          }
        }
        saveNvs();
        return ok('OK');
      } catch { return err(400, 'Bad JSON'); }
    }
  }

  // GET /partitions[?list=backups&label=X]   POST /partitions (action=...)
  if (pathname === '/partitions') {
    if (method === 'GET') {
      if (query.list === 'backups') {
        return sendJson(JSON.stringify({ backups: backupsByLabel[query.label || ''] || [] }));
      }
      return sendJson(JSON.stringify(buildPartitionsView(sourceTable())));
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const params = parseParams(body, req.headers['content-type'] || '');
      const action = params.action;
      const error = {};
      let success = false;
      let resultPath = null;
      switch (action) {
        case 'resize': success = actionResize(params, error); break;
        case 'create': success = actionCreate(params, error); break;
        case 'delete': success = actionDelete(params, error); break;
        case 'format': success = actionFormat(params, error); break;
        case 'apply': success = actionApply(error); break;
        case 'discard': success = actionDiscard(); break;
        case 'backup': resultPath = actionBackup(params, error); success = !!resultPath; break;
        case 'restore': success = actionRestore(params, error); break;
        default: error.msg = 'Unknown action';
      }
      if (!success) return err(400, error.msg || 'Failed');
      if (action === 'backup') return sendJson(JSON.stringify({ path: resultPath }));
      if (action === 'apply') return ok('OK');
      return sendJson(JSON.stringify(buildPartitionsView(sourceTable())));
    }
  }

  // POST /rename
  if (pathname === '/rename' && method === 'POST') {
    const body = await readBody(req);
    const ct   = req.headers['content-type'] || '';
    let params = {};
    if (ct.includes('multipart/form-data')) {
      const bm = ct.match(/boundary=([^\s;]+)/);
      if (bm) { const p = parseMultipart(body, bm[1]); for (const k in p) params[k] = typeof p[k] === 'string' ? p[k] : p[k].toString(); }
    } else {
      new URLSearchParams(body.toString()).forEach((v, k) => { params[k] = v; });
    }
    const { filePath, fileName } = params;
    if (!filePath || !fileName) return err(400, 'Missing fileName or filePath');
    const absOld = toAbsPath(filePath);
    if (!absOld) return err(400, 'Invalid path');
    const absNew = path.join(path.dirname(absOld), fileName);
    try { fs.renameSync(absOld, absNew); return ok(`${filePath} renamed to ${fileName}`); }
    catch { return ok('Fail renaming file.'); }
  }

  // POST /UPDATE (SD update simulation)
  if (pathname === '/UPDATE' && method === 'POST') {
    const body = await readBody(req);
    const ct   = req.headers['content-type'] || '';
    let fileName = '';
    if (ct.includes('multipart/form-data')) {
      const bm = ct.match(/boundary=([^\s;]+)/);
      if (bm) { const p = parseMultipart(body, bm[1]); fileName = typeof p['fileName'] === 'string' ? p['fileName'] : ''; }
    }
    if (fileName) { console.log(`[UPDATE] SD update simulated for: ${fileName}`); return ok('Starting Update'); }
    return err(400, 'Missing fileName');
  }

  // POST /OTA
  if (pathname === '/OTA' && method === 'POST') {
    const body = await readBody(req);
    const params = parseParams(body, req.headers['content-type'] || '');
    if (!Object.prototype.hasOwnProperty.call(params, 'command')) return err(400, 'Invalid OTA request');

    try {
      const ctx = prepareOtaContext(params);
      if (ctx.active) logPreparedOtaContext(ctx);
      else console.log(`[OTA] legacy request received command=${ctx.command} size=${ctx.fileSize} (simulated)`);
      return ok('OK');
    } catch (error) {
      clearOtaContext();
      return err(400, error.message || 'Install prep failed');
    }
  }

  // POST /OTAFILE
  if (pathname === '/OTAFILE' && method === 'POST') {
    const body = await readBody(req);
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) return err(400, 'Missing multipart boundary');

    const parts = parseMultipart(body, bm[1]);
    const upload = parts['file1'];
    if (!upload || typeof upload !== 'object' || !upload.data) return ok('No file');

    const fileBuffer = upload.data;
    if (otaContext && otaContext.active) {
      if (fileBuffer.length !== otaContext.fileSize) {
        clearOtaContext();
        return err(400, 'Uploaded file size does not match prepared OTA size');
      }

      for (const part of otaContext.parts) {
        const chunk = fileBuffer.subarray(part.sourceOffset, part.sourceOffset + part.copySize);
        if (chunk.length !== part.copySize) {
          clearOtaContext();
          return err(400, 'Manifest range exceeds uploaded file');
        }
        otaContext.totalWritten += chunk.length;
        console.log(
          `[OTAFILE] wrote kind=${part.kind} subtype=0x${part.subtype.toString(16)} offset=0x${part.sourceOffset.toString(16)} bytes=${chunk.length}` +
          (part.label ? ` label=${part.label}` : '')
        );
      }

      const completed = otaContext.totalWritten === otaContext.totalCopySize;
      console.log(
        `[OTAFILE] completed source=${otaContext.sourceName || upload.filename || 'unknown'} totalWritten=${otaContext.totalWritten}/${otaContext.totalCopySize}`
      );
      clearOtaContext();
      return completed ? ok('OK') : err(400, 'Incomplete OTA write');
    }

    console.log(`[OTAFILE] legacy upload received bytes=${fileBuffer.length} (simulated)`);
    return ok('OK');
  }

  // GET /sdpins
  if (pathname === '/sdpins' && method === 'GET') {
    return ok('Functionality exclusive for Headless environment');
  }

  // GET /wifi
  if (pathname === '/wifi' && method === 'GET') {
    const { usr, pwd, ssid } = query;
    if (usr && pwd) {
      console.log(`[WIFI] credentials updated  user=${usr}`);
      return ok(`User: ${usr} configured with password: ${pwd}`);
    }
    if (ssid && pwd) {
      console.log(`[WIFI] ssid=${ssid}`);
    }
    return ok('OK');
  }

  // Fallback
  redirect('/');
});

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   Launcher WebUI — Dev Server        ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  URL  : http://localhost:${PORT}`);
  console.log(`  Root : ${ROOT_DIR}`);
  console.log(`  Login: ${USERNAME} / ${PASSWORD}`);
  console.log('  Ctrl+C to stop\n');
});
