#!/usr/bin/env node
'use strict';
// Remote title-launch tool. Launches an already-installed, UNMODIFIED title through
// the normal OS application-launch path (the same one Home Menu uses when you tap an
// icon): appletAE -> OpenSystemAppletProxy -> GetApplicationCreator ->
// CreateApplication(titleId) -> IApplicationAccessor::Start.
//
// No exefs read/write, no code injection, no persistence. CreateApplication takes
// only the target ApplicationId (a u64) — there is no NCA path or code reference.
//
// If this process lacks the applet-manager privilege (appletAE / ISystemAppletProxy)
// the tool STOPS and reports plainly. It does NOT attempt any workaround — no
// hooking, no privilege escalation, no alternate injection path.
//
//   node tools/launch-title.cjs --ounce <OunceCake> --run <ns2jb-run> --title <16hex>
//
// Tip: run `npdm-permissions.cjs --title <smile4basic-id>` first and look at ACI0
// Services for "appletAE"/applet-manager access to know if this path is reachable.

const path = require('node:path');

// Applet command IDs (nn::am). These are the documented Switch values; a failure at
// one of these steps may indicate a Switch-2 command-id difference — which we report,
// not work around.
const CMD_OPEN_SYSTEM_APPLET_PROXY = 100; // IAllSystemAppletProxiesService
const CMD_GET_APPLICATION_CREATOR = 22;   // ISystemAppletProxy
const CMD_CREATE_APPLICATION = 0;         // IApplicationCreator
const CMD_START = 10;                      // IApplicationAccessor
const CURRENT_PROCESS_HANDLE = 0xffff8001; // pseudo-handle for own process

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ounce') opts.ounce = argv[++i];
    else if (a === '--run') opts.run = argv[++i];
    else if (a === '--title') opts.title = argv[++i].replace(/^0x/, '').toLowerCase();
    else throw new Error('unknown option: ' + a);
  }
  if (!opts.ounce || !opts.run) throw new Error('--ounce and --run are required');
  if (!opts.title || !/^[0-9a-f]{16}$/.test(opts.title)) throw new Error('--title <16 hex digits> is required');
  return opts;
}

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const engine = path.join(opts.ounce, 'engine');
  const { attachGame } = require(path.join(engine, 'session.cjs'));

  const attachment = await attachGame(opts.run);
  const { s } = attachment;

  // Extract a single moved sub-interface handle from an IPC reply.
  const expectHandle = (reply, label) => {
    if (reply.result) throw new Error(`${label} failed: result 0x${reply.result.toString(16)}`);
    if (!reply.moves || reply.moves.length !== 1) throw new Error(`${label}: expected one moved interface handle`);
    return reply.moves[0];
  };

  try {
    // Step 1 — reachability: can this process even open the applet-manager service?
    let appletAE;
    try {
      appletAE = await attachment.service('appletAE');
    } catch (e) {
      console.error('appletAE is not reachable from this process: ' + e.message);
      console.error('This process lacks applet-manager service access, so the normal');
      console.error('application-launch path is NOT available at this privilege level.');
      console.error('Stopping. (No workaround: no hooking, no privilege escalation.)');
      process.exitCode = 2;
      return;
    }
    console.log('appletAE opened.');

    // Step 2 — ISystemAppletProxy (needs our process handle + pid, like Home Menu).
    const proxy = expectHandle(
      await s.ipc('OpenSystemAppletProxy', appletAE, CMD_OPEN_SYSTEM_APPLET_PROXY, u64(0), { pid: true, copies: [CURRENT_PROCESS_HANDLE] }),
      'OpenSystemAppletProxy (cmd 100)',
    );
    console.log('ISystemAppletProxy obtained.');

    // Step 3 — IApplicationCreator.
    const creator = expectHandle(
      await s.ipc('GetApplicationCreator', proxy, CMD_GET_APPLICATION_CREATOR),
      'GetApplicationCreator (cmd 22)',
    );
    console.log('IApplicationCreator obtained.');

    // Step 4 — CreateApplication(titleId) -> IApplicationAccessor. Only the title ID
    // is passed; no exefs/NCA path is involved.
    const accessor = expectHandle(
      await s.ipc('CreateApplication', creator, CMD_CREATE_APPLICATION, u64('0x' + opts.title)),
      'CreateApplication (cmd 0)',
    );
    console.log(`IApplicationAccessor obtained for ${opts.title}.`);

    // Step 5 — Start. Heads-up: once the target goes foreground, THIS process (the
    // exploit host) exits, so the RPC session ending right after Start is EXPECTED —
    // not a hang or a bug.
    console.log('\nAbout to call Start. The target title will come to the foreground and');
    console.log('this launching process will exit, so the RPC session WILL end here.');
    console.log('That is expected behavior, not a crash.\n');

    const started = await s.ipc('Start', accessor, CMD_START);
    if (started.result) throw new Error(`Start (cmd 10) failed: result 0x${started.result.toString(16)}`);
    console.log('Start issued. Launching ' + opts.title + '. Session will now end.');
  } catch (e) {
    console.error('error: ' + e.message);
    console.error('Stopping without any workaround (no hooking / escalation / injection).');
    process.exitCode = 1;
  } finally {
    try { await attachment.close(); } catch { /* session may already be gone after Start */ }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('error:', e.message); process.exitCode = 1; });
}
