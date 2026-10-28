'use strict';
// Stage 3: merge an original romfs's tables with an SD override tree, and lay out a
// new virtual romfs image + the interval map that routes reads to the right source.
//
// Pure PC code. Consumes readers ({size, read(offset,size)}); produces buffers and a
// plain source array. No console, no RPC. See docs/stage2-design.md.

const fmt = require('./romfs-format.cjs');
const { bufferReader } = require('./reader.cjs');

const FILE_PARTITION_OFFSET = 0x200;
const alignUp = (n, a) => Math.ceil(n / a) * a;

// --- merged tree -----------------------------------------------------------

const makeDir = (name, parent) => ({ type: 'dir', name, parent, dirs: new Map(), files: new Map() });
const makeFile = (name, parent, size, source) => ({ type: 'file', name, parent, size, source });

async function readAll(reader, offset, length, chunk = 0x40000) {
  if (!length) return Buffer.alloc(0);
  const parts = [];
  for (let at = 0; at < length; at += chunk) {
    parts.push(await reader.read(offset + at, Math.min(chunk, length - at)));
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

const readName = (table, off, fixed) => {
  const n = table.readUInt32LE(off + fixed - 4);
  return table.toString('utf8', off + fixed, off + fixed + n);
};

// Build a merged tree seeded from the original romfs. Each original file's source is
// its absolute byte offset in the original image's data region.
async function parseOriginal(reader) {
  const header = fmt.readHeader(await reader.read(0, fmt.HEADER_SIZE));
  const dirMeta = await readAll(reader, header.dirMetaTableOffset, header.dirMetaTableSize);
  const fileMeta = await readAll(reader, header.fileMetaTableOffset, header.fileMetaTableSize);

  const root = makeDir('', null);
  const stack = [{ off: 0, node: root }];
  const seenDirs = new Set([0]);
  const seenFiles = new Set();

  while (stack.length) {
    const { off, node } = stack.pop();
    let c = dirMeta.readUInt32LE(off + fmt.DIR.child);
    while (c !== fmt.NONE) {
      if (seenDirs.has(c)) throw new Error('directory cycle in original');
      seenDirs.add(c);
      const name = readName(dirMeta, c, fmt.DIR_ENTRY_FIXED);
      const d = makeDir(name, node);
      node.dirs.set(name, d);
      stack.push({ off: c, node: d });
      c = dirMeta.readUInt32LE(c + fmt.DIR.sibling);
    }
    let f = dirMeta.readUInt32LE(off + fmt.DIR.file);
    while (f !== fmt.NONE) {
      if (seenFiles.has(f)) throw new Error('file cycle in original');
      seenFiles.add(f);
      const name = readName(fileMeta, f, fmt.FILE_ENTRY_FIXED);
      const rel = Number(fileMeta.readBigUInt64LE(f + fmt.FILE.dataOffset));
      const size = Number(fileMeta.readBigUInt64LE(f + fmt.FILE.dataSize));
      node.files.set(name, makeFile(name, node, size, { kind: 'original', offset: header.fileDataOffset + rel }));
      f = fileMeta.readUInt32LE(f + fmt.FILE.sibling);
    }
  }
  return root;
}

// Overlay overrides onto the merged tree. `overrides` maps a romfs-relative path
// ('/a/b.bin' or 'a/b.bin') to a reader or a Buffer. Override wins by path; new
// paths are added, creating intermediate dirs.
function mergeOverrides(root, overrides) {
  const entries = overrides instanceof Map ? [...overrides] : Object.entries(overrides);
  for (const [p, value] of entries) {
    const reader = Buffer.isBuffer(value) ? bufferReader(value) : value;
    const parts = p.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error('override path has no filename: ' + p);
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, makeDir(part, node));
      node = node.dirs.get(part);
      if (node.type !== 'dir') throw new Error('override path crosses a file: ' + p);
    }
    node.files.set(name, makeFile(name, node, reader.size, { kind: 'override', reader }));
  }
  return root;
}

// --- layout ----------------------------------------------------------------

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Produce the virtual image's header + metadata tables + the interval map.
function buildLayout(root) {
  // Deterministic order: BFS of dirs, name-sorted children; name-sorted files per dir.
  const dirs = [root];
  const files = [];
  for (let i = 0; i < dirs.length; i++) {
    const node = dirs[i];
    node._childDirs = [...node.dirs.values()].sort(byName);
    node._files = [...node.files.values()].sort(byName);
    dirs.push(...node._childDirs);
    files.push(...node._files);
  }

  // Entry offsets (prefix sums over variable-length entries), and name bytes.
  let dOff = 0;
  for (const d of dirs) {
    d._nameB = Buffer.from(d.name, 'utf8');
    d._entryOffset = dOff;
    dOff += fmt.DIR_ENTRY_FIXED + alignUp(d._nameB.length, 4);
  }
  const dirMetaSize = dOff;
  let fOff = 0;
  for (const f of files) {
    f._nameB = Buffer.from(f.name, 'utf8');
    f._entryOffset = fOff;
    fOff += fmt.FILE_ENTRY_FIXED + alignUp(f._nameB.length, 4);
  }
  const fileMetaSize = fOff;

  // Sibling/child/file links (need entry offsets first).
  root._siblingOffset = fmt.NONE;
  for (const d of dirs) {
    d._childDirs.forEach((c, i) => { c._siblingOffset = i + 1 < d._childDirs.length ? d._childDirs[i + 1]._entryOffset : fmt.NONE; });
    d._files.forEach((f, i) => { f._siblingOffset = i + 1 < d._files.length ? d._files[i + 1]._entryOffset : fmt.NONE; });
  }

  // File data partition: pack files, 0x10-aligned between them.
  let part = 0;
  for (const f of files) {
    part = alignUp(part, 0x10);
    f._dataOffset = part;
    part += f.size;
  }
  const partitionSize = part;

  // Hash tables.
  const dirBuckets = fmt.hashTableBuckets(dirs.length);
  const fileBuckets = fmt.hashTableBuckets(files.length);
  const dirHashSize = dirBuckets * 4;
  const fileHashSize = fileBuckets * 4;

  // Header offsets (tables after the data partition).
  const fileDataOffset = FILE_PARTITION_OFFSET;
  const dirHashTableOffset = alignUp(fileDataOffset + partitionSize, 4);
  const dirMetaTableOffset = dirHashTableOffset + dirHashSize;
  const fileHashTableOffset = dirMetaTableOffset + dirMetaSize;
  const fileMetaTableOffset = fileHashTableOffset + fileHashSize;
  const imageSize = fileMetaTableOffset + fileMetaSize;

  // Emit directory meta + hash.
  const dirMeta = Buffer.alloc(dirMetaSize);
  const dirHash = Buffer.alloc(dirHashSize); dirHash.fill(0xff);
  for (const d of dirs) {
    const off = d._entryOffset;
    dirMeta.writeUInt32LE(d.parent ? d.parent._entryOffset : 0, off + fmt.DIR.parent);
    dirMeta.writeUInt32LE(d._siblingOffset, off + fmt.DIR.sibling);
    dirMeta.writeUInt32LE(d._childDirs.length ? d._childDirs[0]._entryOffset : fmt.NONE, off + fmt.DIR.child);
    dirMeta.writeUInt32LE(d._files.length ? d._files[0]._entryOffset : fmt.NONE, off + fmt.DIR.file);
    dirMeta.writeUInt32LE(d._nameB.length, off + fmt.DIR.nameLen);
    d._nameB.copy(dirMeta, off + fmt.DIR_ENTRY_FIXED);
    const bucket = fmt.pathHash(d.parent ? d.parent._entryOffset : 0, d._nameB) % dirBuckets;
    dirMeta.writeUInt32LE(dirHash.readUInt32LE(bucket * 4), off + fmt.DIR.hash);
    dirHash.writeUInt32LE(off, bucket * 4);
  }

  // Emit file meta + hash.
  const fileMeta = Buffer.alloc(fileMetaSize);
  const fileHash = Buffer.alloc(fileHashSize); fileHash.fill(0xff);
  for (const f of files) {
    const off = f._entryOffset;
    fileMeta.writeUInt32LE(f.parent._entryOffset, off + fmt.FILE.parent);
    fileMeta.writeUInt32LE(f._siblingOffset, off + fmt.FILE.sibling);
    fileMeta.writeBigUInt64LE(BigInt(f._dataOffset), off + fmt.FILE.dataOffset);
    fileMeta.writeBigUInt64LE(BigInt(f.size), off + fmt.FILE.dataSize);
    fileMeta.writeUInt32LE(f._nameB.length, off + fmt.FILE.nameLen);
    f._nameB.copy(fileMeta, off + fmt.FILE_ENTRY_FIXED);
    const bucket = fmt.pathHash(f.parent._entryOffset, f._nameB) % fileBuckets;
    fileMeta.writeUInt32LE(fileHash.readUInt32LE(bucket * 4), off + fmt.FILE.hash);
    fileHash.writeUInt32LE(off, bucket * 4);
  }

  const header = fmt.writeHeader({
    headerSize: fmt.HEADER_SIZE,
    dirHashTableOffset, dirHashTableSize: dirHashSize,
    dirMetaTableOffset, dirMetaTableSize: dirMetaSize,
    fileHashTableOffset, fileHashTableSize: fileHashSize,
    fileMetaTableOffset, fileMetaTableSize: fileMetaSize,
    fileDataOffset,
  });
  // Tables block, in on-disk order, served as one memory source at dirHashTableOffset.
  const tables = Buffer.concat([dirHash, dirMeta, fileHash, fileMeta]);

  // Interval map.
  const sources = [{ virtualOffset: 0, size: fmt.HEADER_SIZE, kind: 'memory', data: header }];
  for (const f of files) {
    if (f.size === 0) continue;
    const vo = fileDataOffset + f._dataOffset;
    if (f.source.kind === 'original') {
      sources.push({ virtualOffset: vo, size: f.size, kind: 'original', origOffset: f.source.offset });
    } else {
      sources.push({ virtualOffset: vo, size: f.size, kind: 'override', reader: f.source.reader });
    }
  }
  sources.push({ virtualOffset: dirHashTableOffset, size: tables.length, kind: 'memory', data: tables });
  sources.sort((a, b) => a.virtualOffset - b.virtualOffset);

  // Compact adjacent original sources contiguous in BOTH virtual and original space.
  const compacted = [];
  for (const s of sources) {
    const last = compacted[compacted.length - 1];
    if (last && last.kind === 'original' && s.kind === 'original' &&
        last.virtualOffset + last.size === s.virtualOffset &&
        last.origOffset + last.size === s.origOffset) {
      last.size += s.size;
    } else {
      compacted.push({ ...s });
    }
  }

  return {
    header, tables, sources: compacted, imageSize,
    counts: { dirs: dirs.length, files: files.length },
    layout: {
      fileDataOffset, dirHashTableOffset, dirMetaTableOffset,
      fileHashTableOffset, fileMetaTableOffset, partitionSize,
    },
  };
}

module.exports = { parseOriginal, mergeOverrides, buildLayout, FILE_PARTITION_OFFSET };
