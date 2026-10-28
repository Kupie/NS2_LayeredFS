'use strict';
// Stage 3 validation on PC: build a synthetic original romfs, overlay SD overrides
// (one larger, one smaller, one brand-new), build the layered image, then re-parse
// it with the Stage 1 traverser (feeding LayeredStorage as the reader) and assert
// the merged listing, sizes, and bytes. Stage 1 is the oracle. No console involved.

const assert = require('node:assert');
const { build } = require('./synthetic-romfs.cjs');
const { bufferReader } = require('../src/reader.cjs');
const fmt = require('../src/romfs-format.cjs');
const { instrument, traverse } = require('../src/read-logger.cjs');
const { buildLayeredStorage } = require('../src/layered-storage.cjs');

async function readWhole(reader) {
  return reader.read(0, reader.size);
}

// Resolve a romfs path using ONLY the hash tables, exactly as the firmware FS does:
// per component, compute bucket = pathHash(parentEntryOffset, name) % buckets, then
// walk the entry's hash-link chain checking parent + name. Proves the hash tables
// (which traverse's offset-walk never touches) are correct and the game can find
// override files. Returns the file entry's dataSize, or null if not found.
async function resolveViaHash(storage, header, path) {
  const dirHash = await storage.read(header.dirHashTableOffset, header.dirHashTableSize);
  const dirMeta = await storage.read(header.dirMetaTableOffset, header.dirMetaTableSize);
  const fileHash = await storage.read(header.fileHashTableOffset, header.fileHashTableSize);
  const fileMeta = await storage.read(header.fileMetaTableOffset, header.fileMetaTableSize);
  const dirBuckets = header.dirHashTableSize / 4;
  const fileBuckets = header.fileHashTableSize / 4;
  const nameAt = (tbl, off, fixed) => tbl.toString('utf8', off + fixed, off + fixed + tbl.readUInt32LE(off + fixed - 4));

  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dirOff = 0; // root

  for (const comp of parts) {
    const nameB = Buffer.from(comp, 'utf8');
    const bucket = fmt.pathHash(dirOff, nameB) % dirBuckets;
    let e = dirHash.readUInt32LE(bucket * 4);
    let found = -1;
    while (e !== fmt.NONE) {
      if (dirMeta.readUInt32LE(e + fmt.DIR.parent) === dirOff && nameAt(dirMeta, e, fmt.DIR_ENTRY_FIXED) === comp) { found = e; break; }
      e = dirMeta.readUInt32LE(e + fmt.DIR.hash);
    }
    if (found < 0) return null;
    dirOff = found;
  }

  const nameB = Buffer.from(fileName, 'utf8');
  const bucket = fmt.pathHash(dirOff, nameB) % fileBuckets;
  let e = fileHash.readUInt32LE(bucket * 4);
  while (e !== fmt.NONE) {
    if (fileMeta.readUInt32LE(e + fmt.FILE.parent) === dirOff && nameAt(fileMeta, e, fmt.FILE_ENTRY_FIXED) === fileName) {
      return Number(fileMeta.readBigUInt64LE(e + fmt.FILE.dataSize));
    }
    e = fileMeta.readUInt32LE(e + fmt.FILE.hash);
  }
  return null;
}

// No-overrides round trip: the layered image must be a faithful re-pack of the
// original (same listing + bytes), with the Stage 1 traverser as oracle.
async function testIdentityRepack() {
  const original = {
    'a.txt': Buffer.from('hello world'),
    'sub/b.bin': Buffer.alloc(5000, 0xab),
    'sub/deep/c.dat': Buffer.from([1, 2, 3, 4]),
  };
  const { image } = build(original);
  const { storage } = await buildLayeredStorage(bufferReader(image), {});
  const io = instrument(storage);
  const result = await traverse(io);
  const got = new Map(result.listing.filter((e) => e.type === 'file').map((e) => [e.path, e]));
  for (const [p, data] of Object.entries(original)) {
    const key = '/' + p;
    assert.ok(got.has(key), `repack missing ${key}`);
    const bytes = await storage.read(got.get(key).offset, got.get(key).size);
    assert.ok(bytes.equals(data), `repack bytes differ for ${key}`);
  }
  console.log('ok - no-override identity re-pack correct');
}

async function run() {
  // Original romfs.
  const original = {
    'a.txt': Buffer.from('hello world'),               // -> overridden, larger
    'sub/b.bin': Buffer.alloc(5000, 0xab),             // -> overridden, smaller
    'sub/deep/c.dat': Buffer.from([1, 2, 3, 4]),       // -> untouched
    'readme': Buffer.from('ORIGINAL readme contents'), // -> untouched
  };
  const { image: origImage } = build(original);
  const originalReader = bufferReader(origImage);

  // Overrides: larger replacement, smaller replacement, brand-new path.
  const overrides = {
    'a.txt': Buffer.from('A'.repeat(100000)),          // larger than 11
    '/sub/b.bin': Buffer.from([9, 8, 7]),              // smaller than 5000 (leading slash ok)
    'sub/deep/new.bin': Buffer.alloc(777, 0x5a),       // new file in existing dir
    'brand/new/dir/hello.txt': Buffer.from('fresh'),   // new dirs
  };

  const { storage, layout } = await buildLayeredStorage(originalReader, overrides);

  // 1) GetSize matches the computed image size.
  assert.strictEqual(storage.size, layout.imageSize);

  // 2) Re-parse the layered image with the Stage 1 traverser as oracle.
  const io = instrument(storage);
  const result = await traverse(io);
  const listing = new Map(result.listing.map((e) => [e.path, e]));

  // Expected merged tree: original union overrides, override sizes win.
  const expected = {
    '/a.txt': 100000,
    '/sub/b.bin': 3,
    '/sub/deep/c.dat': 4,
    '/readme': 24,
    '/sub/deep/new.bin': 777,
    '/brand/new/dir/hello.txt': 5,
  };
  for (const [p, size] of Object.entries(expected)) {
    assert.ok(listing.has(p), `missing ${p}`);
    assert.strictEqual(listing.get(p).type, 'file', `${p} not a file`);
    assert.strictEqual(listing.get(p).size, size, `${p} size`);
  }
  // New dirs exist; no stray files.
  for (const d of ['/sub', '/sub/deep', '/brand', '/brand/new', '/brand/new/dir']) {
    assert.ok(listing.has(d) && listing.get(d).type === 'directory', `missing dir ${d}`);
  }
  assert.strictEqual(result.fileCount, Object.keys(expected).length, 'file count');

  // 3) Bytes: read each file's full range through the layered storage and compare.
  const expectBytes = {
    '/a.txt': overrides['a.txt'],
    '/sub/b.bin': overrides['/sub/b.bin'],
    '/sub/deep/c.dat': original['sub/deep/c.dat'],   // untouched -> original bytes
    '/readme': original['readme'],                    // untouched -> original bytes
    '/sub/deep/new.bin': overrides['sub/deep/new.bin'],
    '/brand/new/dir/hello.txt': overrides['brand/new/dir/hello.txt'],
  };
  for (const [p, want] of Object.entries(expectBytes)) {
    const e = listing.get(p);
    const got = await storage.read(e.offset, e.size);
    assert.ok(got.equals(want), `bytes differ for ${p}`);
  }

  // 4) A read spanning a file boundary into the next source returns correct bytes.
  //    Re-read the whole image two ways and compare: chunked vs. one shot.
  const whole = await readWhole(storage);
  const piecewise = Buffer.alloc(storage.size);
  for (let at = 0; at < storage.size; at += 1000) {
    const n = Math.min(1000, storage.size - at);
    (await storage.read(at, n)).copy(piecewise, at);
  }
  assert.ok(whole.equals(piecewise), 'chunked reads disagree with whole-image read');

  // 5) The re-parsed header equals the built layout.
  assert.strictEqual(result.header.fileDataOffset, layout.layout.fileDataOffset);
  assert.strictEqual(result.header.dirHashTableOffset, layout.layout.dirHashTableOffset);
  assert.strictEqual(result.header.fileMetaTableOffset, layout.layout.fileMetaTableOffset);

  // 6) Hash-table resolution: every file must be findable the way the firmware
  //    resolves paths (via the hash tables), not just by offset-walk.
  for (const [p, size] of Object.entries(expected)) {
    assert.strictEqual(await resolveViaHash(storage, result.header, p), size, `hash lookup ${p}`);
  }
  assert.strictEqual(await resolveViaHash(storage, result.header, '/does/not/exist'), null, 'phantom path resolved');
  console.log('ok - all files resolvable via hash tables (firmware lookup path)');

  await testIdentityRepack();

  console.log(`ok - merged ${result.dirCount} dirs, ${result.fileCount} files`);
  console.log(`ok - image size ${storage.size} (0x${storage.size.toString(16)}), ${layout.sources.length} sources`);
  console.log('ok - override bytes, untouched bytes, spanning reads all correct');
  console.log('stage3 test passed');
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
