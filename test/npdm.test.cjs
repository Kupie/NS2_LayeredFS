'use strict';
// Validates the NPDM decoder against a hand-built synthetic NPDM with known fields.
// Proves the kernel-capability decoding (esp. SyscallMask 24-id group indexing) and
// the FsAccessFlag bit decode, before the tool ever runs against real console bytes.

const assert = require('node:assert');
const npdm = require('../src/npdm.cjs');

const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

// --- shared FAC / SAC / KC bodies ---------------------------------------------
function buildFac() {
  const fac = Buffer.alloc(0x1c);
  fac.writeUInt32LE(1, 0x00); // version
  // ApplicationInfo(0) | SdCard(21) | GetRightsId(27) | Debug(62)
  const flags = (1n << 0n) | (1n << 21n) | (1n << 27n) | (1n << 62n);
  fac.writeBigUInt64LE(flags, 0x04);
  // content/savedata owner info offsets+sizes all zero -> skipped
  return fac;
}
function buildSac() {
  // "fsp-srv" client (len7 -> ctrl 0x06), "apt" client (len3 -> 0x02), "bsd" server (0x82)
  return Buffer.concat([
    Buffer.from([0x06]), Buffer.from('fsp-srv'),
    Buffer.from([0x02]), Buffer.from('apt'),
    Buffer.from([0x82]), Buffer.from('bsd'),
  ]);
}
function buildKc() {
  // ThreadInfo(lowest=63,maxCore=3); SyscallMask(index1, svc 24,25,27); HandleTable(512); padding
  return Buffer.concat([u32(0x030003f7), u32(0x2000016f), u32(0x02007fff), u32(0xffffffff)]);
}

function buildNpdm() {
  const fac = buildFac();
  const sac = buildSac();
  const kac = buildKc();

  // ACI0 block: 0x40 header, then fac, sac, kac.
  const aciHeader = Buffer.alloc(0x40);
  aciHeader.write('ACI0', 0);
  u64('0x0100aabbccdd0000').copy(aciHeader, 0x10); // ProgramId
  const facOff = 0x40;
  const sacOff = facOff + fac.length;
  const kacOff = (sacOff + sac.length + 3) & ~3;
  aciHeader.writeUInt32LE(facOff, 0x20); aciHeader.writeUInt32LE(fac.length, 0x24);
  aciHeader.writeUInt32LE(sacOff, 0x28); aciHeader.writeUInt32LE(sac.length, 0x2c);
  aciHeader.writeUInt32LE(kacOff, 0x30); aciHeader.writeUInt32LE(kac.length, 0x34);
  const aci = Buffer.alloc(kacOff + kac.length);
  aciHeader.copy(aci); fac.copy(aci, facOff); sac.copy(aci, sacOff); kac.copy(aci, kacOff);

  // ACID block: 0x300 signature+pubkey (zeros) then body (Switch 2 style).
  const bodyHeader = Buffer.alloc(0x40);
  bodyHeader.write('ACID', 0);
  bodyHeader.writeUInt32LE(0b101, 0x0c); // flags: production + deprecatedUseSecureMemory
  u64('0x0100000000000000').copy(bodyHeader, 0x10); // programIdMin
  u64('0x01000000ffffffff').copy(bodyHeader, 0x18); // programIdMax
  const aFacOff = 0x40;
  const aSacOff = aFacOff + fac.length;
  const aKacOff = (aSacOff + sac.length + 3) & ~3;
  bodyHeader.writeUInt32LE(aFacOff, 0x20); bodyHeader.writeUInt32LE(fac.length, 0x24);
  bodyHeader.writeUInt32LE(aSacOff, 0x28); bodyHeader.writeUInt32LE(sac.length, 0x2c);
  bodyHeader.writeUInt32LE(aKacOff, 0x30); bodyHeader.writeUInt32LE(kac.length, 0x34);
  const body = Buffer.alloc(aKacOff + kac.length);
  bodyHeader.copy(body); fac.copy(body, aFacOff); sac.copy(body, aSacOff); kac.copy(body, aKacOff);
  const acid = Buffer.concat([Buffer.alloc(0x300), body]);

  // Meta (0x80).
  const meta = Buffer.alloc(0x80);
  meta.write('META', 0);
  meta[0x0c] = 0x01 | (3 << 1) | (1 << 4); // Is64Bit, ProcessAddressSpace=3 (64Bit(39)), OptimizeMemoryAllocation
  meta[0x0e] = 44;   // main thread priority
  meta[0x0f] = 3;    // core
  meta.writeUInt32LE(0, 0x14); meta.writeUInt32LE(0x11, 0x18); meta.writeUInt32LE(0x4000, 0x1c);
  meta.write('TestApp', 0x20);
  meta.write('ABCDE-000', 0x30);

  const aciOffset = 0x80;
  const acidOffset = (aciOffset + aci.length + 0xf) & ~0xf;
  meta.writeUInt32LE(aciOffset, 0x70); meta.writeUInt32LE(aci.length, 0x74);
  meta.writeUInt32LE(acidOffset, 0x78); meta.writeUInt32LE(acid.length, 0x7c);

  const out = Buffer.alloc(acidOffset + acid.length);
  meta.copy(out, 0); aci.copy(out, aciOffset); acid.copy(out, acidOffset);
  return out;
}

function run() {
  const decoded = npdm.decodeNpdm(buildNpdm());

  // Meta
  assert.strictEqual(decoded.meta.magic, 'META');
  assert.strictEqual(decoded.meta.flags0.is64BitInstruction, true);
  assert.strictEqual(decoded.meta.flags0.processAddressSpace, '64Bit(39)');
  assert.strictEqual(decoded.meta.flags0.optimizeMemoryAllocation, true);
  assert.strictEqual(decoded.meta.name, 'TestApp');
  assert.strictEqual(decoded.meta.mainThreadPriority, 44);

  // ACI0 services
  const svcs = decoded.aci0.services;
  assert.deepStrictEqual(svcs.find((s) => s.name === 'fsp-srv'), { name: 'fsp-srv', isServer: false });
  assert.deepStrictEqual(svcs.find((s) => s.name === 'apt'), { name: 'apt', isServer: false });
  assert.deepStrictEqual(svcs.find((s) => s.name === 'bsd'), { name: 'bsd', isServer: true });

  // ACI0 FS permissions
  assert.deepStrictEqual(decoded.aci0.fs.granted.sort(), ['ApplicationInfo', 'Debug', 'GetRightsId', 'SdCard'].sort());

  // ACI0 kernel: syscalls decoded via 24-id groups; HandleTable size; ThreadInfo
  assert.deepStrictEqual(decoded.aci0.kernel.enabledSvcs, [24, 25, 27]);
  const ht = decoded.aci0.kernel.caps.find((c) => c.type === 'HandleTableSize');
  assert.strictEqual(ht.size, 512);
  const ti = decoded.aci0.kernel.caps.find((c) => c.type === 'ThreadInfo');
  assert.strictEqual(ti.lowestThreadPriority, 63);
  assert.strictEqual(ti.maxCoreId, 3);

  // ACID
  assert.strictEqual(decoded.acid.signatureBlock, 'RSA-3072 (0x300)');
  assert.strictEqual(decoded.acid.flags.production, true);
  assert.strictEqual(decoded.acid.flags.deprecatedUseSecureMemory, true);
  assert.strictEqual(decoded.acid.flags.unqualifiedApproval, false);
  assert.strictEqual(decoded.acid.programIdMin, '0100000000000000');
  assert.strictEqual(decoded.acid.programIdMax, '01000000ffffffff');
  assert.ok(decoded.acid.fs.granted.includes('SdCard'));

  console.log('ok - meta flags, services (client/server), fs flags, syscall groups, handle table, acid');
  console.log('npdm test passed');
}

run();
