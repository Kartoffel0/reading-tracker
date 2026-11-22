// Reading the facts an .m4b already carries.
//
// An audiobook file is its own metadata store: `mvhd` holds the runtime, `chpl`
// holds the chapter names and offsets, `ilst` holds the iTunes tags, and `covr`
// holds the cover art. Chromium's <audio> ignores all of it — it only reports
// `duration` once the file is loaded — so the library shelf reads the atoms
// once at import time instead of opening every file to know how long it is.
//
// Everything here is read-only and offset-based: a 474 MB book is never read
// whole. The top-level walk skips `mdat` by its header alone, so only `moov`
// (a few MB, at either end of the file) is ever loaded.

const fs = require('fs');

// A box: [4-byte size][4-byte type][payload]. A size of 1 means a 64-bit size
// follows the type; a size of 0 means the box runs to the end of its parent.
function readBoxHeader(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > buffer.length) return null;
    size = Number(buffer.readBigUInt64BE(offset + 8));
    header = 16;
  }
  if (size === 0) size = buffer.length - offset;
  if (size < header) return null;
  return { type, size, header, start: offset, data: offset + header, end: offset + size };
}

function childBoxes(buffer, box) {
  const out = [];
  if (!box) return out;
  let offset = box.data;
  const end = Math.min(box.end, buffer.length);
  while (offset < end - 7) {
    const child = readBoxHeader(buffer, offset);
    if (!child) break;
    out.push(child);
    offset = child.end;
  }
  return out;
}

function findBox(buffer, boxes, type) {
  return boxes.find((box) => box.type === type) || null;
}

// `meta` is a full box: its children start four bytes in, after version/flags.
function metaChildren(buffer, meta) {
  return childBoxes(buffer, { ...meta, data: meta.data + 4 });
}

// mvhd: version 0 keeps timescale at 12 and duration at 16; version 1 widens
// both to 64 bits at 20 and 24.
function readMovieDuration(buffer, mvhd) {
  const version = buffer[mvhd.data];
  const timescale =
    version === 1 ? buffer.readUInt32BE(mvhd.data + 20) : buffer.readUInt32BE(mvhd.data + 12);
  const duration =
    version === 1
      ? Number(buffer.readBigUInt64BE(mvhd.data + 24))
      : buffer.readUInt32BE(mvhd.data + 16);
  if (!timescale || !Number.isFinite(duration)) return 0;
  return duration / timescale;
}

// chpl (the Nike chapter list): [version/flags:4][reserved:4][count:1] then one
// entry per chapter, each [start:8, in 100-nanosecond units][name-length:1][name].
function readChapters(buffer, chpl) {
  const chapters = [];
  if (!chpl || chpl.data + 9 > buffer.length) return chapters;
  const count = buffer[chpl.data + 8];
  let offset = chpl.data + 9;
  for (let i = 0; i < count && offset < chpl.end; i += 1) {
    if (offset + 9 > buffer.length) break;
    const start = Number(buffer.readBigUInt64BE(offset));
    const length = buffer[offset + 8];
    offset += 9;
    if (offset + length > buffer.length) break;
    const title = buffer.toString('utf8', offset, offset + length).trim();
    offset += length;
    if (Number.isFinite(start)) chapters.push({ t: start / 1e7, title });
  }
  return chapters;
}

function readTextTag(buffer, ilst, type) {
  const entry = childBoxes(buffer, ilst).find((box) => box.type === type);
  if (!entry) return null;
  const data = childBoxes(buffer, entry).find((box) => box.type === 'data');
  if (!data) return null;
  const text = buffer.toString('utf8', data.data + 8, data.end).trim();
  return text || null;
}

// covr: one or more `data` boxes whose first byte after the type is the image
// format (13 = JPEG, 14 = PNG).
function readCoverArt(buffer, ilst) {
  const covr = childBoxes(buffer, ilst).find((box) => box.type === 'covr');
  if (!covr) return null;
  const data = childBoxes(buffer, covr).find((box) => box.type === 'data');
  if (!data) return null;
  const format = buffer.readUInt32BE(data.data) & 0x00ffffff;
  const bytes = buffer.subarray(data.data + 8, data.end);
  if (!bytes.length) return null;
  return { bytes, ext: format === 14 ? '.png' : '.jpg' };
}

/**
 * Read the runtime, chapters, tags and cover art of an .m4b.
 * Returns `{ duration, chapters, title, artist, album, cover }`; any field the
 * file does not carry comes back as `0`, `[]` or `null`.
 */
function readAudiobookMeta(filePath) {
  const meta = { duration: 0, chapters: [], title: null, artist: null, album: null, cover: null };
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const fileSize = fs.fstatSync(fd).size;

    // Walk top-level boxes by header alone; only `moov` gets loaded.
    let moov = null;
    let offset = 0;
    while (offset < fileSize - 7) {
      const head = Buffer.alloc(16);
      const read = fs.readSync(fd, head, 0, 16, offset);
      if (read < 8) break;
      const box = readBoxHeader(head, 0);
      if (!box) break;
      if (box.type === 'moov') {
        const size = Math.min(box.size, 128 * 1024 * 1024);
        const buffer = Buffer.alloc(size);
        const got = fs.readSync(fd, buffer, 0, size, offset);
        moov = { buffer: buffer.subarray(0, got), box: readBoxHeader(buffer, 0) };
        break;
      }
      offset += box.size;
    }

    if (!moov) return meta;
    const buffer = moov.buffer;
    const moovChildren = childBoxes(buffer, moov.box);

    const mvhd = findBox(buffer, moovChildren, 'mvhd');
    if (mvhd) meta.duration = readMovieDuration(buffer, mvhd);

    const udta = findBox(buffer, moovChildren, 'udta');
    if (udta) {
      const udtaChildren = childBoxes(buffer, udta);
      const chpl = findBox(buffer, udtaChildren, 'chpl');
      if (chpl) meta.chapters = readChapters(buffer, chpl);

      const metaBox = findBox(buffer, udtaChildren, 'meta');
      const ilst = metaBox ? findBox(buffer, metaChildren(buffer, metaBox), 'ilst') : null;
      if (ilst) {
        meta.title = readTextTag(buffer, ilst, '\u00a9nam');
        meta.artist = readTextTag(buffer, ilst, '\u00a9ART');
        meta.album = readTextTag(buffer, ilst, '\u00a9alb');
        meta.cover = readCoverArt(buffer, ilst);
      }
    }
  } catch (err) {
    console.error(`[m4b] could not read ${filePath}: ${err.message}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
  return meta;
}

/** Every .m4b under `dir`, recursively, in a stable order. */
function findAudiobooks(dir, depth = 0) {
  const found = [];
  if (depth > 6) return found;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = require('path').join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findAudiobooks(full, depth + 1));
    else if (/\.m4b$/i.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * The subtitle file that belongs to an audiobook: the sidecar with the same
 * name, or else the only .srt sitting beside it. Returns the path or null.
 */
function findSubtitles(audioPath) {
  const path = require('path');
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  const sameName = path.join(dir, `${base}.srt`);
  if (fs.existsSync(sameName)) return sameName;
  const candidates = fs.readdirSync(dir).filter((name) => /\.srt$/i.test(name));
  if (candidates.length === 1) return path.join(dir, candidates[0]);
  // Several subtitle files and none named after the book: match on the first
  // significant word so "[author] title [asin].srt" still pairs up.
  const marker = base.split(/[\s([\]]+/).filter(Boolean).pop() || '';
  const hit = candidates.find((name) => marker && name.includes(marker));
  return hit ? path.join(dir, hit) : null;
}

module.exports = { readAudiobookMeta, findAudiobooks, findSubtitles };
