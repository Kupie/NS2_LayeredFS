#!/usr/bin/env node
'use strict';
// Read-only NPDM permission printer. Reads a title's main.npdm from its code/exefs
// partition (via OunceCake's exported openCode / openUpdate, same way the romfs tools
// open romfs) and decodes it per the public NPDM layout. It ONLY reads the main.npdm
// metadata file and prints it: no code segment is read, no signature is verified or
// forged, nothing is written.
//
//   node tools/npdm-permissions.cjs --ounce <OunceCake> --run <ns2jb-run> \
//        [--title <16hex>] [--storage 4|5|2] [--update] [--json]
//
// --update decodes the composed/updated program's main.npdm instead of the base.

const path = require('node:path');
const npdm = require('../src/npdm.cjs');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ounce') opts.ounce = argv[++i];
    else if (a === '--run') opts.run = argv[++i];
    else if (a === '--title') opts.title = argv[++i].replace(/^0x/, '').toLowerCase();
    else if (a === '--storage') opts.storage = Number(argv[++i]);
    else if (a === '--update') opts.update = true;
    else if (a === '--json') opts.json = true;
    else throw new Error('unknown option: ' + a);
  }
  if (!opts.ounce || !opts.run) throw new Error('--ounce and --run are required');
  return opts;
}

// Fetch main.npdm bytes for the base or composed-update program, read-only.
async function openMainNpdm(engine, attachment, { title, storage, update }) {
  const { s, root, domain, service, filesystem } = attachment;
  const { resolveProgramContent, discoverUpdates } = require(path.join(engine, 'content.cjs'));
  const { createProgramMounts } = require(path.join(engine, 'program.cjs'));
  const { pathRequest, success } = require(path.join(engine, 'protocol.cjs'));
  const mounts = createProgramMounts(attachment);

  // Resolve a Program content record and stamp source.runtimeProgramId (GetProgramId,
  // cmd 618) — exactly what createGameFiles.open() does before opening code/exefs.
  async function resolve(extra) {
    const source = await resolveProgramContent({ s, domain, service, title, ...extra });
    const fn = Buffer.alloc(0x301);
    fn.write(source.contentPath);
    await s.write(s.base + 0x2000, fn);
    const id = success(
      await domain.send(s, 'Read selected NCA ProgramId', root, pathRequest(618, Buffer.from([source.attributes]), s.base + 0x2000)),
      'Read selected NCA ProgramId',
    );
    source.runtimeProgramId = id.data.readBigUInt64LE().toString(16).padStart(16, '0');
    return source;
  }

  let codeHandle;
  let used;
  if (update) {
    const updates = await discoverUpdates({ ...attachment, title });
    if (!updates.length) throw new Error('no update is installed for ' + title + ' (omit --update for base)');
    const newest = Math.max(...updates.map((u) => u.version));
    let picks = updates.filter((u) => u.version === newest);
    if (storage != null) picks = [...picks].sort((a, b) => (a.storage === storage ? -1 : 0));
    let lastError;
    for (const u of picks) {
      try {
        const source = await resolve({ storage: u.storage, update: { contentTitle: u.contentTitle, version: u.version } });
        codeHandle = await mounts.openUpdate({ title, storage: u.storage, attributes: source.attributes, source, section: 'exefs' });
        used = { storage: u.storage, version: u.version, runtimeProgramId: source.runtimeProgramId };
        break;
      } catch (e) { lastError = e; }
    }
    if (codeHandle == null) throw lastError || new Error('could not open update exefs');
  } else {
    const candidates = storage != null ? [storage] : [4, 5, 2];
    let lastError;
    for (const medium of candidates) {
      try {
        const source = await resolve({ storage: medium });
        codeHandle = await mounts.openCode({ title: source.runtimeProgramId, storage: source.storage, attributes: source.attributes, source });
        used = { storage: source.storage, runtimeProgramId: source.runtimeProgramId };
        break;
      } catch (e) { lastError = e; }
    }
    if (codeHandle == null) throw lastError || new Error('could not open exefs');
  }

  const opened = await filesystem.openFile(s, codeHandle, '/main.npdm');
  if (opened.result) { await s.close(codeHandle); throw new Error('open /main.npdm failed: 0x' + opened.result.toString(16)); }
  try {
    const size = Number(await filesystem.fileSize(s, opened.handle));
    const bytes = await filesystem.readFile(s, opened.handle, 0, size);
    return { bytes, used };
  } finally {
    await s.close(opened.handle);
    await s.close(codeHandle);
  }
}

function printReport(d, used, kind) {
  const m = d.meta;
  console.log(`=== Meta (${kind}) ===`);
  console.log(`  Name                 ${m.name}`);
  console.log(`  ProductCode          ${m.productCode}`);
  console.log(`  Is64BitInstruction   ${m.flags0.is64BitInstruction}`);
  console.log(`  ProcessAddressSpace  ${m.flags0.processAddressSpace}`);
  console.log(`  MainThreadPriority   ${m.mainThreadPriority}`);
  console.log(`  MainThreadCoreNumber ${m.mainThreadCoreNumber}`);
  console.log(`  SystemResourceSize   0x${m.systemResourceSize.toString(16)}`);
  console.log(`  Version              ${m.version}`);
  console.log(`  MainThreadStackSize  0x${m.mainThreadStackSize.toString(16)}`);
  if (used?.runtimeProgramId) console.log(`  runtimeProgramId     ${used.runtimeProgramId}`);

  const a = d.aci0;
  console.log(`\n=== ACI0 (actual granted permissions) ===  ProgramId ${a.programId}`);

  console.log(`\n-- ACI0 Services --`);
  for (const s of a.services) console.log(`  ${s.isServer ? 'host  ' : 'client'}  ${s.name}`);
  if (!a.services.length) console.log('  (none)');

  console.log(`\n-- ACI0 FS Permissions --  FsAccessFlag ${a.fs.fsAccessFlagRaw}`);
  for (const f of a.fs.granted) console.log(`  ${f}`);
  if (!a.fs.granted.length) console.log('  (none)');
  if (a.fs.contentOwnerIds) console.log(`  ContentOwnerIds: ${a.fs.contentOwnerIds.join(', ')}`);

  console.log(`\n-- ACI0 Syscalls (enabled SVC numbers) --`);
  console.log('  ' + (a.kernel.enabledSvcs.length ? a.kernel.enabledSvcs.map((n) => '0x' + n.toString(16)).join(' ') : '(none)'));

  console.log(`\n-- ACI0 Kernel Capabilities --`);
  for (const c of a.kernel.caps) {
    if (c.type === 'EnableSystemCalls') continue; // shown above as a flat list
    console.log('  ' + JSON.stringify(c));
  }

  console.log(`\n=== ACID summary (DECLARED MAX permissions, NOT what's granted) ===`);
  if (d.acid?.error) { console.log('  (could not parse ACID: ' + d.acid.error + ')'); return; }
  console.log(`  SignatureBlock   ${d.acid.signatureBlock}`);
  console.log(`  Flags            raw=0x${d.acid.flags.raw.toString(16)} production=${d.acid.flags.production} unqualifiedApproval=${d.acid.flags.unqualifiedApproval} deprecatedUseSecureMemory=${d.acid.flags.deprecatedUseSecureMemory}`);
  console.log(`  ProgramIdMin/Max ${d.acid.programIdMin} .. ${d.acid.programIdMax}`);
  console.log(`  FS (max)         ${d.acid.fs.granted.join(', ') || '(none)'}`);
  console.log(`  Services (max)   ${d.acid.services.map((s) => (s.isServer ? '+' : '') + s.name).join(' ') || '(none)'}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const engine = path.join(opts.ounce, 'engine');
  const { attachGame } = require(path.join(engine, 'session.cjs'));
  const { discoverGames } = require(path.join(engine, 'content.cjs'));

  const attachment = await attachGame(opts.run);
  try {
    let title = opts.title;
    if (!title) {
      const games = await discoverGames({ ...attachment, shouldStop: () => false });
      if (!games.length) throw new Error('no titles found; pass --title');
      title = games[0].title;
    }
    const { bytes, used } = await openMainNpdm(engine, attachment, { title, storage: opts.storage, update: opts.update });
    const decoded = npdm.decodeNpdm(bytes);
    const kind = opts.update ? 'update' : 'base';
    if (opts.json) {
      console.log(JSON.stringify({ title, kind, used, npdm: decoded }, null, 2));
    } else {
      console.log(`title=${title}  main.npdm=${bytes.length} bytes  (read-only; nothing modified)\n`);
      printReport(decoded, used, kind);
    }
  } finally {
    await attachment.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('error:', e.message); process.exitCode = 1; });
}

module.exports = { openMainNpdm };
