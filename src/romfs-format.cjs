'use strict';
// RomFS on-disk format (Nintendo level-6 image, as used by Switch/Switch 2 titles).
//
// This module is pure data: struct offsets, the path-hash function, and helpers
// to classify which region of the image a given byte range belongs to. No console,
// no RPC, no I/O. It is shared by:
//   - Stage 1 (read logger)   : region classification for annotating Read(offset,size)
//   - Stage 3 (layered module) : table parsing / rebuilding
//
// Field offsets match OunceCake's known-good reader (engine/mounts.cjs readRomfs).

const HEADER_SIZE = 0x50; // 10 x u64
const NONE = 0xffffffff; // sentinel for "no entry"

// Fixed (pre-name) size of each metadata entry.
const DIR_ENTRY_FIXED = 0x18; // parent,sibling,child,file,hash,nameLen
const FILE_ENTRY_FIXED = 0x20; // parent,sibling,dataOff(u64),dataSize(u64),hash,nameLen

// Directory metadata entry field offsets.
const DIR = {
  parent: 0x00, // offset of parent directory entry
  sibling: 0x04, // offset of next sibling directory (NONE = end)
  child: 0x08, // offset of first child directory (NONE = none)
  file: 0x0c, // offset of first child file (NONE = none)
  hash: 0x10, // offset of next entry in the same hash bucket (NONE = end)
  nameLen: 0x14, // length of the name that follows the fixed block
};

// File metadata entry field offsets.
const FILE = {
  parent: 0x00, // offset of containing directory entry
  sibling: 0x04, // offset of next file in the same directory (NONE = end)
  dataOffset: 0x08, // u64, relative to header.fileDataOffset
  dataSize: 0x10, // u64
  hash: 0x18, // offset of next entry in the same hash bucket (NONE = end)
  nameLen: 0x1c, // length of the name that follows the fixed block
};

// Parse the 0x50-byte superblock into named u64 fields.
function readHeader(buf) {
  if (buf.length < HEADER_SIZE) throw new Error('RomFS header: need 0x50 bytes');
  const u64 = (i) => {
    const v = buf.readBigUInt64LE(i * 8);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('RomFS field exceeds numeric precision');
    return Number(v);
  };
  const header = {
    headerSize: u64(0),
    dirHashTableOffset: u64(1),
    dirHashTableSize: u64(2),
    dirMetaTableOffset: u64(3),
    dirMetaTableSize: u64(4),
    fileHashTableOffset: u64(5),
    fileHashTableSize: u64(6),
    fileMetaTableOffset: u64(7),
    fileMetaTableSize: u64(8),
    fileDataOffset: u64(9),
  };
  if (header.headerSize !== HEADER_SIZE) throw new Error('RomFS header size is not 0x50');
  return header;
}

// Serialize a header object back into a 0x50-byte buffer (used by Stage 3).
function writeHeader(header) {
  const buf = Buffer.alloc(HEADER_SIZE);
  const fields = [
    header.headerSize, header.dirHashTableOffset, header.dirHashTableSize,
    header.dirMetaTableOffset, header.dirMetaTableSize, header.fileHashTableOffset,
    header.fileHashTableSize, header.fileMetaTableOffset, header.fileMetaTableSize,
    header.fileDataOffset,
  ];
  fields.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), i * 8));
  return buf;
}

// Nintendo RomFS path hash: seed from the parent entry offset, rotate-right-5 and
// xor each UTF-8 byte of the name. Bucket index is hash % bucketCount, where
// bucketCount = hashTableSize / 4. Needed by Stage 3 to rebuild hash tables.
function pathHash(parentOffset, nameBytes) {
  let hash = (parentOffset ^ 123456789) >>> 0;
  for (let i = 0; i < nameBytes.length; i++) {
    hash = ((hash >>> 5) | (hash << 27)) >>> 0;
    hash = (hash ^ nameBytes[i]) >>> 0;
  }
  return hash >>> 0;
}

function hashBucketCount(hashTableSize) {
  return Math.floor(hashTableSize / 4);
}

// The five regions of a RomFS image, as [start, end) byte ranges, sorted.
// `header` is the parsed superblock; `imageSize` bounds the final data region.
function regions(header, imageSize) {
  const list = [
    { name: 'header', start: 0, end: HEADER_SIZE },
    { name: 'dirHashTable', start: header.dirHashTableOffset, end: header.dirHashTableOffset + header.dirHashTableSize },
    { name: 'dirMetaTable', start: header.dirMetaTableOffset, end: header.dirMetaTableOffset + header.dirMetaTableSize },
    { name: 'fileHashTable', start: header.fileHashTableOffset, end: header.fileHashTableOffset + header.fileHashTableSize },
    { name: 'fileMetaTable', start: header.fileMetaTableOffset, end: header.fileMetaTableOffset + header.fileMetaTableSize },
    { name: 'fileData', start: header.fileDataOffset, end: imageSize },
  ];
  return list.sort((a, b) => a.start - b.start);
}

// Classify a [offset, offset+size) read against the region map. Returns the list of
// region names the range touches (usually one; a range can straddle a boundary).
function classifyRange(regionList, offset, size) {
  const end = offset + size;
  const hits = [];
  for (const r of regionList) {
    if (offset < r.end && end > r.start) hits.push(r.name);
  }
  return hits.length ? hits : ['unmapped'];
}

module.exports = {
  HEADER_SIZE, NONE, DIR_ENTRY_FIXED, FILE_ENTRY_FIXED, DIR, FILE,
  readHeader, writeHeader, pathHash, hashBucketCount, regions, classifyRange,
};
