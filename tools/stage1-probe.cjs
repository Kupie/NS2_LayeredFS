#!/usr/bin/env node
'use strict';
// Stage 1 CLI: locate a launched title's romfs storage and log every
// Read(offset, size) a consumer issues against it, read-only. Modifies nothing.
//
//   node tools/stage1-probe.cjs --ounce <OunceCake-dir> --run <ns2jb-run-dir> \
//        [--title <16hex>] [--storage 4|5|2] [--data-samples N] [--json out.jsonl]
//
// --ounce / --run are the same paths OunceCake uses. Without --title the first
// discovered title is probed. --data-samples issues real head/tail reads for the
// first N files so the fileData access pattern shows up in the log too.

const fs = require('node:fs');
const { instrument, traverse } = require('../src/read-logger.cjs');
const { openRomfsStorage } = require('./openers/ouncecake-romfs.cjs');

function parseArgs(argv) {
  const opts = { dataSamples: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ounce') opts.ounce = argv[++i];
    else if (a === '--run') opts.run = argv[++i];
    else if (a === '--title') opts.title = argv[++i].replace(/^0x/, '').toLowerCase();
    else if (a === '--storage') opts.storage = Number(argv[++i]);
    else if (a === '--data-samples') opts.dataSamples = Number(argv[++i]);
    else if (a === '--json') opts.json = argv[++i];
    else throw new Error('unknown option: ' + a);
  }
  if (!opts.ounce || !opts.run) throw new Error('--ounce and --run are required');
  return opts;
}

const hex = (n) => '0x' + n.toString(16);

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const opened = await openRomfsStorage(opts);

  try {
    console.log(`romfs storage located: title=${opened.info.title} size=${hex(opened.info.size)} (${opened.info.size} bytes)`);
    console.log('logging reads (read-only; storage is not modified)\n');

    const io = instrument(opened.reader, {
      onRead(e) {
        // regions on read #0 (the header) aren't known yet; they are backfilled by
        // setRegions and shown in the summary / JSONL below.
        const regions = (e.regions || ['(pending)']).join('+');
        console.log(`#${String(e.seq).padStart(4)}  Read(off=${hex(e.offset).padStart(10)}, size=${hex(e.size).padStart(8)})  [${regions}]`);
      },
    });

    const result = await traverse(io, { dataSamples: opts.dataSamples });

    // Write the JSONL from the final log so every entry (incl. read #0) is annotated.
    if (opts.json) {
      fs.writeFileSync(opts.json, io.log.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }

    console.log('\n--- summary ---');
    console.log(`entries: ${result.dirCount} dirs, ${result.fileCount} files`);
    console.log(`total reads: ${io.stats.reads}, total bytes: ${io.stats.bytes} (${hex(io.stats.bytes)})`);
    console.log('reads by region:');
    for (const [name, count] of Object.entries(io.stats.byRegion).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name.padEnd(14)} ${count}`);
    }
    console.log('\nlayout (from header):');
    const h = result.header;
    for (const [k, v] of Object.entries(h)) console.log(`  ${k.padEnd(20)} ${hex(v)}`);
  } finally {
    await opened.close();
    console.log('\nstorage handle closed; nothing was modified.');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('error:', e.message); process.exitCode = 1; });
}
