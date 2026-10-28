'use strict';
// Build a small, valid RomFS image in memory from a plain {path: Buffer} map.
// Produces hash-correct tables (so it is reusable by later stages, not just the
// Stage 1 offset-walk). Pure PC code -- no console involved.

const fmt = require('../src/romfs-format.cjs');

const align = (n, a) => Math.ceil(n / a) * a;

function build(fileMap, { dataAlign = 16 } = {}) {
  // 1) Materialize the directory tree from the flat path map.
  const root = { name: '', path: '/', dirs: new Map(), files: [], parent: null };
  const ensureDir = (parts) => {
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, dirs: new Map(), files: [], parent: node });
      }
      node = node.dirs.get(part);
    }
    return node;
  };
  for (const [p, data] of Object.entries(fileMap)) {
    const parts = p.split('/').filter(Boolean);
    const name = parts.pop();
    ensureDir(parts).files.push({ name, data: Buffer.from(data) });
  }

  // 2) Assign metadata-table offsets (dirs and files), recording name bytes.
  const dirEntries = [];
  const fileEntries = [];
  let dirOff = 0;
  let fileOff = 0;
  const layoutDir = (node) => {
    const nameB = Buffer.from(node.name, 'utf8');
    node._off = dirOff;
    node._nameB = nameB;
    dirEntries.push(node);
    dirOff += align(fmt.DIR_ENTRY_FIXED + nameB.length, 4);
  };
  layoutDir(root);
  // Breadth-first so parents precede children (not required, but tidy).
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    for (const child of node.dirs.values()) { layoutDir(child); queue.push(child); }
    for (const f of node.files) {
      const nameB = Buffer.from(f.name, 'utf8');
      f._off = fileOff;
      f._nameB = nameB;
      fileEntries.push(f);
      fileOff += align(fmt.FILE_ENTRY_FIXED + nameB.length, 4);
    }
  }

  // 3) File data offsets (relative to fileDataOffset).
  let dataRel = 0;
  for (const f of fileEntries) { f._dataRel = dataRel; dataRel += align(f.data.length, dataAlign); }
  const dataSize = dataRel;

  // 4) Hash tables.
  const bucketCount = (n) => Math.max(3, n | 0);
  const dirBuckets = bucketCount(dirEntries.length);
  const fileBuckets = bucketCount(fileEntries.length);
  const dirHash = Buffer.alloc(dirBuckets * 4); dirHash.fill(0xff);
  const fileHash = Buffer.alloc(fileBuckets * 4); fileHash.fill(0xff);

  // 5) Emit metadata tables, linking siblings/children and hash chains.
  const dirMeta = Buffer.alloc(dirOff); dirMeta.fill(0);
  const fileMeta = Buffer.alloc(fileOff); fileMeta.fill(0);

  for (const node of dirEntries) {
    const off = node._off;
    const children = [...node.dirs.values()];
    dirMeta.writeUInt32LE(node.parent ? node.parent._off : 0, off + fmt.DIR.parent);
    dirMeta.writeUInt32LE(node._sibling != null ? node._sibling : fmt.NONE, off + fmt.DIR.sibling);
    dirMeta.writeUInt32LE(children.length ? children[0]._off : fmt.NONE, off + fmt.DIR.child);
    dirMeta.writeUInt32LE(node.files.length ? node.files[0]._off : fmt.NONE, off + fmt.DIR.file);
    dirMeta.writeUInt32LE(node._nameB.length, off + fmt.DIR.nameLen);
    node._nameB.copy(dirMeta, off + fmt.DIR_ENTRY_FIXED);
    // sibling links for this node's children
    children.forEach((c, i) => { c._sibling = children[i + 1] ? children[i + 1]._off : fmt.NONE; });
    // hash chain (bucket by parent offset + name)
    const bucket = fmt.pathHash(node.parent ? node.parent._off : 0, node._nameB) % dirBuckets;
    dirMeta.writeUInt32LE(dirHash.readUInt32LE(bucket * 4), off + fmt.DIR.hash);
    dirHash.writeUInt32LE(off, bucket * 4);
  }

  for (const node of dirEntries) {
    node.files.forEach((f, i) => { f._sibling = node.files[i + 1] ? node.files[i + 1]._off : fmt.NONE; f._parentOff = node._off; });
  }
  for (const f of fileEntries) {
    const off = f._off;
    fileMeta.writeUInt32LE(f._parentOff, off + fmt.FILE.parent);
    fileMeta.writeUInt32LE(f._sibling, off + fmt.FILE.sibling);
    fileMeta.writeBigUInt64LE(BigInt(f._dataRel), off + fmt.FILE.dataOffset);
    fileMeta.writeBigUInt64LE(BigInt(f.data.length), off + fmt.FILE.dataSize);
    fileMeta.writeUInt32LE(f._nameB.length, off + fmt.FILE.nameLen);
    f._nameB.copy(fileMeta, off + fmt.FILE_ENTRY_FIXED);
    const bucket = fmt.pathHash(f._parentOff, f._nameB) % fileBuckets;
    fileMeta.writeUInt32LE(fileHash.readUInt32LE(bucket * 4), off + fmt.FILE.hash);
    fileHash.writeUInt32LE(off, bucket * 4);
  }

  // 6) Assemble the image: header | dirHash | dirMeta | fileHash | fileMeta | data.
  let cur = fmt.HEADER_SIZE;
  const place = (len) => { const at = cur; cur += align(len, 8); return at; };
  const dirHashOff = place(dirHash.length);
  const dirMetaOff = place(dirMeta.length);
  const fileHashOff = place(fileHash.length);
  const fileMetaOff = place(fileMeta.length);
  const fileDataOff = align(cur, dataAlign);

  const header = {
    headerSize: fmt.HEADER_SIZE,
    dirHashTableOffset: dirHashOff, dirHashTableSize: dirHash.length,
    dirMetaTableOffset: dirMetaOff, dirMetaTableSize: dirMeta.length,
    fileHashTableOffset: fileHashOff, fileHashTableSize: fileHash.length,
    fileMetaTableOffset: fileMetaOff, fileMetaTableSize: fileMeta.length,
    fileDataOffset: fileDataOff,
  };

  const image = Buffer.alloc(fileDataOff + dataSize);
  fmt.writeHeader(header).copy(image, 0);
  dirHash.copy(image, dirHashOff);
  dirMeta.copy(image, dirMetaOff);
  fileHash.copy(image, fileHashOff);
  fileMeta.copy(image, fileMetaOff);
  for (const f of fileEntries) f.data.copy(image, fileDataOff + f._dataRel);

  return { image, header };
}

// bufferReader now lives in src/reader.cjs (one interface for the whole project);
// re-exported here so existing tests that import it from this module keep working.
const { bufferReader } = require('../src/reader.cjs');

module.exports = { build, bufferReader };
