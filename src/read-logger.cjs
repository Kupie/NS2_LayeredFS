'use strict';
// Stage 1: read-only romfs access-pattern logger.
//
// Purpose: validate that we can locate a title's romfs storage and understand the
// exact Read(offset, size) calls a romfs consumer issues against it -- WITHOUT
// modifying anything. This records every read, annotates it with the romfs region
// it lands in, and reconstructs the dir/file tables purely from those reads.
//
// It never writes to storage, never patches memory, never swaps a pointer. It is a
// passive observer sitting in front of a read-only storage reader. The same
// `read(offset, size)` interface is satisfied by a real console storage handle
// (Stage 1 live) or a synthetic Buffer (Stage 3 PC test), so this module has no
// console dependency.

const fmt = require('./romfs-format.cjs');

// Wrap a reader so every Read(offset, size) is recorded before being served.
// `reader` must provide: size (number) and async read(offset, size) -> Buffer.
function instrument(reader, { onRead } = {}) {
  const log = [];
  let regionList = null; // populated once the header is known, for annotation
  const stats = { reads: 0, bytes: 0, byRegion: Object.create(null) };

  async function read(offset, size) {
    const entry = { seq: log.length, offset, size };
    if (regionList) entry.regions = fmt.classifyRange(regionList, offset, size);
    log.push(entry);
    stats.reads += 1;
    stats.bytes += size;
    // Count into the region histogram now if we can classify; otherwise setRegions
    // backfills this entry once the header is parsed.
    if (entry.regions) {
      for (const name of entry.regions) stats.byRegion[name] = (stats.byRegion[name] || 0) + 1;
    }
    if (onRead) onRead(entry);
    const bytes = await reader.read(offset, size);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
      throw new Error(`reader returned ${bytes && bytes.length} bytes for a ${size}-byte read at ${offset}`);
    }
    return bytes;
  }

  return {
    get size() { return reader.size; },
    setRegions(header) {
      regionList = fmt.regions(header, reader.size);
      // Backfill region annotations + the histogram for reads made before the
      // header was parsed (the header read itself).
      for (const e of log) {
        if (e.regions) continue;
        e.regions = fmt.classifyRange(regionList, e.offset, e.size);
        for (const name of e.regions) stats.byRegion[name] = (stats.byRegion[name] || 0) + 1;
      }
    },
    read,
    log,
    stats,
  };
}

// Chunked read that respects the console's per-call transfer ceiling (0x40000),
// so a large table/file is logged as the sequence of reads a real consumer issues.
async function readChunked(io, offset, length, chunk = 0x40000) {
  const parts = [];
  for (let at = 0; at < length; at += chunk) {
    const n = Math.min(chunk, length - at);
    parts.push(await io.read(offset + at, n));
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

// Walk the romfs tables read-only, driving `io.read` exactly as a consumer that
// enumerates the tree and opens files would. Returns the reconstructed listing.
// `dataSamples` optionally issues real file-data reads for the first N files, so the
// log also shows the fileData-region access pattern (head + tail of each file).
async function traverse(io, { dataSamples = 0, sampleBytes = 0x1000 } = {}) {
  if (io.size < fmt.HEADER_SIZE) throw new Error('storage too small to hold a romfs header');

  // 1) Superblock.
  const header = fmt.readHeader(await io.read(0, fmt.HEADER_SIZE));
  io.setRegions(header);

  // 2) Metadata tables (the four regions a consumer loads up front).
  const dirMeta = await readChunked(io, header.dirMetaTableOffset, header.dirMetaTableSize);
  const fileMeta = await readChunked(io, header.fileMetaTableOffset, header.fileMetaTableSize);
  // Hash tables are what a consumer reads to resolve a path by name; load them too.
  await readChunked(io, header.dirHashTableOffset, header.dirHashTableSize);
  await readChunked(io, header.fileHashTableOffset, header.fileHashTableSize);

  // 3) Reconstruct the tree from the tables (offset-walk, matches OunceCake's reader).
  const listing = [];
  const files = [];
  const stack = [{ offset: 0, path: '/' }];
  const seenDirs = new Set([0]);
  const seenFiles = new Set();

  const readName = (table, off, fixed) => {
    const n = table.readUInt32LE(off + fixed - 4);
    return table.toString('utf8', off + fixed, off + fixed + n);
  };

  while (stack.length) {
    const dir = stack.pop();
    let child = dirMeta.readUInt32LE(dir.offset + fmt.DIR.child);
    let file = dirMeta.readUInt32LE(dir.offset + fmt.DIR.file);

    while (child !== fmt.NONE) {
      if (seenDirs.has(child)) throw new Error('directory cycle');
      seenDirs.add(child);
      const name = readName(dirMeta, child, fmt.DIR_ENTRY_FIXED);
      const p = dir.path.replace(/\/$/, '') + '/' + name;
      listing.push({ path: p, type: 'directory' });
      stack.push({ offset: child, path: p });
      child = dirMeta.readUInt32LE(child + fmt.DIR.sibling);
    }

    while (file !== fmt.NONE) {
      if (seenFiles.has(file)) throw new Error('file cycle');
      seenFiles.add(file);
      const name = readName(fileMeta, file, fmt.FILE_ENTRY_FIXED);
      const rel = Number(fileMeta.readBigUInt64LE(file + fmt.FILE.dataOffset));
      const size = Number(fileMeta.readBigUInt64LE(file + fmt.FILE.dataSize));
      const p = dir.path.replace(/\/$/, '') + '/' + name;
      const record = { path: p, type: 'file', size, offset: header.fileDataOffset + rel };
      listing.push(record);
      files.push(record);
      file = fileMeta.readUInt32LE(file + fmt.FILE.sibling);
    }
  }

  // 4) Optionally sample real data reads to exercise the fileData region.
  files.sort((a, b) => a.offset - b.offset);
  for (const f of files.slice(0, dataSamples)) {
    if (f.size === 0) continue;
    const headN = Math.min(sampleBytes, f.size);
    await io.read(f.offset, headN);
    if (f.size > sampleBytes * 2) {
      const tailN = Math.min(sampleBytes, f.size);
      await io.read(f.offset + f.size - tailN, tailN);
    }
  }

  return { header, listing, fileCount: files.length, dirCount: seenDirs.size - 1 };
}

module.exports = { instrument, traverse, readChunked };
