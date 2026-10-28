'use strict';
// Stage 1 validation on PC: build a synthetic romfs, run the read logger against a
// Buffer-backed reader, and assert the reconstructed listing + read annotations.
// No console involved.

const assert = require('node:assert');
const { instrument, traverse } = require('../src/read-logger.cjs');
const fmt = require('../src/romfs-format.cjs');
const { build, bufferReader } = require('./synthetic-romfs.cjs');

// Regression: on real Switch images the metadata tables sit AFTER the file-data
// blob. The file-data region must end at the first table, not at imageSize, or
// every table read is mis-tagged as also hitting fileData. Numbers below are from
// a real title (probe output): fileDataOffset=0x200, tables contiguous at the end.
function testTablesAfterData() {
  const header = {
    headerSize: 0x50,
    dirHashTableOffset: 0x4dae37bf8, dirHashTableSize: 0x224,
    dirMetaTableOffset: 0x4dae37e1c, dirMetaTableSize: 0x1574,
    fileHashTableOffset: 0x4dae39390, fileHashTableSize: 0x254,
    fileMetaTableOffset: 0x4dae395e4, fileMetaTableSize: 0x1ef8,
    fileDataOffset: 0x200,
  };
  const imageSize = 0x4dae3b4dc;
  const regionList = fmt.regions(header, imageSize);

  const fileData = regionList.find((r) => r.name === 'fileData');
  assert.strictEqual(fileData.end, 0x4dae37bf8, 'fileData must end at the first trailing table');

  // A read fully inside the dir meta table is tagged ONLY dirMetaTable.
  assert.deepStrictEqual(fmt.classifyRange(regionList, 0x4dae37e1c, 0x1574), ['dirMetaTable']);
  // A read inside the data blob is tagged ONLY fileData.
  assert.deepStrictEqual(fmt.classifyRange(regionList, 0x200, 0x1000), ['fileData']);
  console.log('ok - tables-after-data layout classified correctly');
}

async function run() {
  const files = {
    'a.txt': Buffer.from('hello world'),
    'sub/b.bin': Buffer.alloc(5000, 0xab),
    'sub/deep/c.dat': Buffer.from([1, 2, 3, 4]),
  };
  const { image, header } = build(files);
  const io = instrument(bufferReader(image));

  const result = await traverse(io, { dataSamples: 2 });

  // Listing round-trips the input tree.
  const paths = result.listing.map((e) => e.type[0] + ' ' + e.path).sort();
  assert.deepStrictEqual(paths, [
    'd /sub',
    'd /sub/deep',
    'f /a.txt',
    'f /sub/b.bin',
    'f /sub/deep/c.dat',
  ]);
  assert.strictEqual(result.fileCount, 3);

  // Header matches what the builder emitted.
  assert.deepStrictEqual(result.header, header);

  // Every logged read is classified to a known region, and the header read is first.
  assert.strictEqual(io.log[0].offset, 0);
  assert.strictEqual(io.log[0].size, fmt_header_size());
  for (const e of io.log) {
    assert.ok(e.regions && e.regions.length, `read #${e.seq} unclassified`);
    assert.ok(!e.regions.includes('unmapped'), `read #${e.seq} hit unmapped region`);
  }

  // We touched every metadata region plus fileData (from dataSamples).
  const regionsSeen = new Set(Object.keys(io.stats.byRegion));
  for (const r of ['header', 'dirMetaTable', 'fileMetaTable', 'dirHashTable', 'fileHashTable', 'fileData']) {
    assert.ok(regionsSeen.has(r), `expected to observe reads in ${r}`);
  }

  console.log(`ok - ${io.stats.reads} reads, ${io.stats.bytes} bytes`);
  console.log('ok - regions observed:', [...regionsSeen].join(', '));

  testTablesAfterData();
  console.log('stage1 test passed');
}

function fmt_header_size() { return require('../src/romfs-format.cjs').HEADER_SIZE; }

run().catch((e) => { console.error(e); process.exitCode = 1; });
