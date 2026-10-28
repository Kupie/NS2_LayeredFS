#!/usr/bin/env node
'use strict';
// Stage 3b: end-to-end validation combining the Stage 1 console opener with Stage 3's
// merge + layered storage, entirely read-only. It opens a real title's romfs over
// the console (same as Stage 1), picks one real file path, overlays it with a local
// test file, builds the layered image on the PC, then re-parses that image with the
// Stage 1 traverser and the firmware hash-table resolver and verifies the result.
//
// Nothing live: this only READS from the console (identical access to stage1-probe).
// No writes, no pointer swaps, no injection. All merging/verification is PC-side.
//
//   node tools/stage3b-probe.cjs --ounce <OunceCake> --run <ns2jb-run> \
//        --override <localfile> [--title <16hex>] [--storage 4|5|2] [--path /romfs/path]
//
// If --path is omitted, the smallest file in the title is chosen (cheap to verify)
// and printed so you can see what was picked.

const fs = require('node:fs');
const fmt = require('../src/romfs-format.cjs');
const { fileReader, chunkedReader } = require('../src/reader.cjs');
const { instrument, traverse } = require('../src/read-logger.cjs');
const { buildLayeredStorage } = require('../src/layered-storage.cjs');
const { openRomfsStorage } = require('./openers/ouncecake-romfs.cjs');

function parseArgs(argv) {
  const opts = { spot: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ounce') opts.ounce = argv[++i];
    else if (a === '--run') opts.run = argv[++i];
    else if (a === '--title') opts.title = argv[++i].replace(/^0x/, '').toLowerCase();
    else if (a === '--storage') opts.storage = Number(argv[++i]);
    else if (a === '--override') opts.override = argv[++i];
    else if (a === '--path') opts.path = argv[++i];
    else if (a === '--spot') opts.spot = Number(argv[++i]);
    else throw new Error('unknown option: ' + a);
  }
  if (!opts.ounce || !opts.run) throw new Error('--ounce and --run are required');
  if (!opts.override) throw new Error('--override <localfile> is required');
  if (!fs.existsSync(opts.override)) throw new Error('override file not found: ' + opts.override);
  return opts;
}

const hex = (n) => '0x' + n.toString(16);
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures += 1;
}

// Resolve a romfs path through the hash tables, exactly as the firmware FS does.
// Returns the file entry's dataSize, or null. (Same approach as test/stage3.test.cjs.)
async function resolveViaHash(storage, header, path) {
  const dirHash = await storage.read(header.dirHashTableOffset, header.dirHashTableSize);
  const dirMeta = await storage.read(header.dirMetaTableOffset, header.dirMetaTableSize);
  const fileHash = await storage.read(header.fileHashTableOffset, header.fileHashTableSize);
  const fileMeta = await storage.read(header.fileMetaTableOffset, header.fileMetaTableSize);
  const dirBuckets = header.dirHashTableSize / 4;
  const fileBuckets = header.fileHashTableSize / 4;
  const nameAt = (t, o, f) => t.toString('utf8', o + f, o + f + t.readUInt32LE(o + f - 4));
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dirOff = 0;
  for (const comp of parts) {
    const bucket = fmt.pathHash(dirOff, Buffer.from(comp, 'utf8')) % dirBuckets;
    let e = dirHash.readUInt32LE(bucket * 4);
    let found = -1;
    while (e !== fmt.NONE) {
      if (dirMeta.readUInt32LE(e + fmt.DIR.parent) === dirOff && nameAt(dirMeta, e, fmt.DIR_ENTRY_FIXED) === comp) { found = e; break; }
      e = dirMeta.readUInt32LE(e + fmt.DIR.hash);
    }
    if (found < 0) return null;
    dirOff = found;
  }
  const bucket = fmt.pathHash(dirOff, Buffer.from(fileName, 'utf8')) % fileBuckets;
  let e = fileHash.readUInt32LE(bucket * 4);
  while (e !== fmt.NONE) {
    if (fileMeta.readUInt32LE(e + fmt.FILE.parent) === dirOff && nameAt(fileMeta, e, fmt.FILE_ENTRY_FIXED) === fileName) {
      return Number(fileMeta.readBigUInt64LE(e + fmt.FILE.dataSize));
    }
    e = fileMeta.readUInt32LE(e + fmt.FILE.hash);
  }
  return null;
}

// Compare two readers over [offset,size) / the override's own range, in chunks.
async function bytesEqual(readerA, offA, readerB, offB, size, chunk = 0x40000) {
  for (let at = 0; at < size; at += chunk) {
    const n = Math.min(chunk, size - at);
    const a = await readerA.read(offA + at, n);
    const b = await readerB.read(offB + at, n);
    if (!a.equals(b)) return false;
  }
  return true;
}

// Core verification. `original` is any reader (console-backed in the CLI, synthetic
// in tests). Reads only; all merging/verification is in-process. Returns a summary.
async function verify(original, { override, path, spot = 3 } = {}) {
  failures = 0;
  {
    // Original listing (Stage 1 traverse over the reader).
    const base = await traverse(instrument(original));
    const baseFiles = base.listing.filter((e) => e.type === 'file');
    const baseByPath = new Map(baseFiles.map((e) => [e.path, e]));

    // Pick the target path to override.
    let target = path;
    if (target) {
      if (!baseByPath.has(target)) throw new Error(`path ${target} is not a file in this title`);
    } else {
      const smallest = baseFiles.filter((e) => e.size > 0).sort((a, b) => a.size - b.size)[0];
      if (!smallest) throw new Error('title has no non-empty files to override');
      target = smallest.path;
    }
    const origEntry = baseByPath.get(target);
    console.log(`override target: ${target}  (original size ${origEntry.size} / ${hex(origEntry.size)})`);

    const overrideReader = fileReader(override);
    console.log(`override source: ${override}  (size ${overrideReader.size} / ${hex(overrideReader.size)})\n`);

    // Build the layered image on the PC from the console-backed original + override.
    const { storage: layered } = await buildLayeredStorage(original, { [target]: overrideReader });

    // Re-parse the layered image with the Stage 1 traverser.
    const merged = await traverse(instrument(layered));
    const mergedByPath = new Map(merged.listing.filter((e) => e.type === 'file').map((e) => [e.path, e]));

    console.log('--- verification ---');

    // Counts: overriding an existing path should not change the file/dir count.
    check('merged file count == original', merged.fileCount === base.fileCount, `${merged.fileCount} vs ${base.fileCount}`);
    check('merged dir count == original', merged.dirCount === base.dirCount, `${merged.dirCount} vs ${base.dirCount}`);

    // Overridden file reports the override's size, in both the table listing and the
    // firmware hash-table resolver.
    const mEntry = mergedByPath.get(target);
    check('override present in merged listing', Boolean(mEntry));
    if (mEntry) {
      check('overridden file reports override size', mEntry.size === overrideReader.size, `${mEntry.size} vs ${overrideReader.size}`);
      const hashSize = await resolveViaHash(layered, merged.header, target);
      check('overridden file resolvable via hash tables with override size', hashSize === overrideReader.size, `${hashSize} vs ${overrideReader.size}`);
      // Bytes of the overridden file match the override file exactly.
      const bytesOk = await bytesEqual(layered, mEntry.offset, overrideReader, 0, overrideReader.size);
      check('overridden file bytes == override file', bytesOk);
    }

    // Spot-check: a few OTHER files still read back as their original bytes, through
    // the layered image (original source, re-packed to a new virtual offset).
    const others = baseFiles
      .filter((e) => e.path !== target && e.size > 0)
      .sort((a, b) => a.size - b.size)
      .slice(0, Math.max(0, spot));
    for (const e of others) {
      const m = mergedByPath.get(e.path);
      if (!m) { check(`spot ${e.path} present`, false); continue; }
      const sizeOk = m.size === e.size;
      // Compare layered bytes (new offset) against original bytes (old offset).
      const ok = sizeOk && await bytesEqual(layered, m.offset, original, e.offset, e.size);
      check(`untouched ${e.path} (${e.size}B) matches original`, ok, sizeOk ? '' : `size ${m.size} vs ${e.size}`);
    }

    return { failures, base, merged, target, overrideSize: overrideReader.size, imageSize: layered.size };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const opened = await openRomfsStorage(opts);
  try {
    // Wrap the console reader so large contiguous source reads respect the 0x40000 cap.
    const original = chunkedReader(opened.reader, 0x40000);
    console.log(`title=${opened.info.title} size=${hex(opened.info.size)}  (read-only; no writes, no injection)\n`);

    const r = await verify(original, { override: opts.override, path: opts.path, spot: opts.spot });

    console.log(`\n--- summary ---`);
    console.log(`original: ${r.base.dirCount} dirs, ${r.base.fileCount} files; image ${hex(opened.info.size)}`);
    console.log(`merged:   ${r.merged.dirCount} dirs, ${r.merged.fileCount} files; image ${hex(r.imageSize)}`);
    console.log(r.failures === 0 ? '\nALL CHECKS PASSED' : `\n${r.failures} CHECK(S) FAILED`);
    process.exitCode = r.failures === 0 ? 0 : 1;
  } finally {
    await opened.close();
    console.log('\nstorage handle closed; nothing was modified.');
  }
}

module.exports = { verify };

if (require.main === module) {
  main().catch((e) => { console.error('error:', e.message); process.exitCode = 1; });
}
