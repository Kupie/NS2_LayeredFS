'use strict';
// Pure, read-only NPDM decoder (Meta / ACI0 / ACID).
//
// Decodes the public NPDM layout for inspection only. It NEVER verifies or forges a
// signature, never writes, and does not touch executable code — main.npdm is a
// metadata/permissions descriptor, not a code segment. Field layouts and bit tables
// are taken verbatim from Atmosphere (which matches switchbrew.org/wiki/NPDM):
//   - ldr_types.hpp            (Npdm/Aci/Acid structs, MetaFlag0, ProcessAddressSpace)
//   - kern_k_capabilities.hpp  (kernel-capability type tags + field layouts)
//   - fssrv_access_control_bits.hpp (FsAccessFlag bit -> name)

const META_SIZE = 0x80;

// Meta.flags0 ProcessAddressSpace enum (ldr_types.hpp).
const PROCESS_ADDRESS_SPACE = {
  0: '32Bit', 1: '64Bit(36)', 2: '32BitNoReserved', 3: '64Bit(39)', 4: '64Bit(42)',
};

// FsAccessFlag (u64) bit -> name (fssrv_access_control_bits.hpp, AccessControlBits::Bits).
const FS_ACCESS_FLAGS = [
  [0, 'ApplicationInfo'], [1, 'BootModeControl'], [2, 'Calibration'], [3, 'SystemSaveData'],
  [4, 'GameCard'], [5, 'SaveDataBackUp'], [6, 'SaveDataManagement'], [7, 'BisAllRaw'],
  [8, 'GameCardRaw'], [9, 'GameCardPrivate'], [10, 'SetTime'], [11, 'ContentManager'],
  [12, 'ImageManager'], [13, 'CreateSaveData'], [14, 'SystemSaveDataManagement'], [15, 'BisFileSystem'],
  [16, 'SystemUpdate'], [17, 'SaveDataMeta'], [18, 'DeviceSaveData'], [19, 'SettingsControl'],
  [20, 'SystemData'], [21, 'SdCard'], [22, 'Host'], [23, 'FillBis'],
  [24, 'CorruptSaveData'], [25, 'SaveDataForDebug'], [26, 'FormatSdCard'], [27, 'GetRightsId'],
  [28, 'RegisterExternalKey'], [29, 'RegisterUpdatePartition'], [30, 'SaveDataTransfer'], [31, 'DeviceDetection'],
  [32, 'AccessFailureResolution'], [33, 'SaveDataTransferVersion2'], [34, 'RegisterProgramIndexMapInfo'],
  [35, 'CreateOwnSaveData'], [36, 'MoveCacheStorage'], [62, 'Debug'], [63, 'FullPermission'],
];

// Kernel-capability type tags: value (1<<n)-1 -> name (kern_k_capabilities.hpp).
const KC_TYPES = {
  7: 'ThreadInfo',          // CorePriority
  15: 'EnableSystemCalls',  // SyscallMask
  63: 'MemoryMap',          // MapRange (pair: range + size)
  127: 'IoMemoryMap',       // MapIoPage
  1023: 'MemoryRegionMap',  // MapRegion
  2047: 'EnableInterrupts', // InterruptPair
  8191: 'MiscParams',       // ProgramType
  16383: 'KernelVersion',
  32767: 'HandleTableSize', // HandleTable
  65535: 'MiscFlags',       // DebugFlags
};
const KC_REGION = { 0: 'NoMapping', 1: 'KernelTraceBuffer', 2: 'OnMemoryBootImage', 3: 'DTB' };

const bits = (v, start, count) => (v >>> start) & (2 ** count - 1);

function ascii(buf, start, len) {
  let end = start;
  while (end < start + len && buf[end] !== 0) end++;
  return buf.toString('utf8', start, end);
}

function decodeFsAccessFlag(flags /* BigInt */) {
  const granted = [];
  for (const [bit, name] of FS_ACCESS_FLAGS) {
    if (flags & (1n << BigInt(bit))) granted.push(name);
  }
  return granted;
}

// FS Access Control data (ACI0 FAC / ACID FAC share this embedded-descriptor form).
function decodeFac(buf, base, size) {
  if (size < 0x0c) return { version: null, fsAccessFlagRaw: '0x0', granted: [] };
  const version = buf.readUInt32LE(base + 0x00);
  const flags = buf.readBigUInt64LE(base + 0x04);
  const out = {
    version,
    fsAccessFlagRaw: '0x' + flags.toString(16).padStart(16, '0'),
    granted: decodeFsAccessFlag(flags),
  };
  // Owner-info arrays (best-effort; offsets relative to FAC base).
  try {
    const coOff = buf.readUInt32LE(base + 0x0c);
    const coSize = buf.readUInt32LE(base + 0x10);
    const sdOff = buf.readUInt32LE(base + 0x14);
    const sdSize = buf.readUInt32LE(base + 0x18);
    if (coSize >= 4 && base + coOff + 4 <= base + size) {
      const n = buf.readUInt32LE(base + coOff);
      const ids = [];
      for (let i = 0; i < n && base + coOff + 4 + (i + 1) * 8 <= base + size; i++) {
        ids.push(buf.readBigUInt64LE(base + coOff + 4 + i * 8).toString(16).padStart(16, '0'));
      }
      if (ids.length) out.contentOwnerIds = ids;
    }
    if (sdSize >= 4 && base + sdOff + 4 <= base + size) {
      out.saveDataOwnerIdCount = buf.readUInt32LE(base + sdOff);
    }
  } catch { /* leave owner info off on any bounds issue */ }
  return out;
}

// Service Access Control: control byte (bit7 = IsServer, low 3 bits = nameLen-1).
function decodeSac(buf, base, size) {
  const services = [];
  let off = 0;
  while (off < size) {
    const ctrl = buf[base + off];
    off += 1;
    if (ctrl === 0) break; // terminator / padding
    const isServer = (ctrl & 0x80) !== 0;
    const nameLen = (ctrl & 0x07) + 1;
    if (off + nameLen > size) break;
    services.push({ name: buf.toString('utf8', base + off, base + off + nameLen), isServer });
    off += nameLen;
  }
  return services;
}

// Kernel Capabilities: 32-bit descriptors, type by lowest clear bit.
function decodeKc(buf, base, size) {
  const caps = [];
  const svc = new Set();
  const n = Math.floor(size / 4);
  for (let i = 0; i < n; i++) {
    const v = buf.readUInt32LE(base + i * 4);
    if (v === 0xffffffff) continue; // padding
    const lowZero = (~v & (v + 1)) >>> 0; // = type + 1 = (1<<idBits)
    const typeVal = (lowZero - 1) >>> 0;
    const type = KC_TYPES[typeVal];
    if (!type) { caps.push({ type: 'Unknown', raw: '0x' + v.toString(16) }); continue; }
    switch (type) {
      case 'ThreadInfo':
        caps.push({ type, lowestThreadPriority: bits(v, 4, 6), highestThreadPriority: bits(v, 10, 6), minCoreId: bits(v, 16, 8), maxCoreId: bits(v, 24, 8) });
        break;
      case 'EnableSystemCalls': {
        const mask = bits(v, 5, 24);
        const index = bits(v, 29, 3);
        const ids = [];
        for (let b = 0; b < 24; b++) if (mask & (1 << b)) { const id = index * 24 + b; ids.push(id); svc.add(id); }
        caps.push({ type, index, svcs: ids });
        break;
      }
      case 'MemoryMap': {
        const address = bits(v, 7, 24);
        const readOnly = bits(v, 31, 1) === 1;
        let pages = null; let normal = null;
        if (i + 1 < n) { const s = buf.readUInt32LE(base + (i + 1) * 4); pages = bits(s, 7, 20); normal = bits(s, 31, 1) === 1; i += 1; }
        caps.push({ type, pageAddress: '0x' + address.toString(16), byteAddress: '0x' + (address * 0x1000).toString(16), pages, isRam: normal, readOnly });
        break;
      }
      case 'IoMemoryMap':
        caps.push({ type, pageAddress: '0x' + bits(v, 8, 24).toString(16), byteAddress: '0x' + (bits(v, 8, 24) * 0x1000).toString(16) });
        break;
      case 'MemoryRegionMap':
        caps.push({ type, regions: [
          { region: KC_REGION[bits(v, 11, 6)] ?? bits(v, 11, 6), readOnly: bits(v, 17, 1) === 1 },
          { region: KC_REGION[bits(v, 18, 6)] ?? bits(v, 18, 6), readOnly: bits(v, 24, 1) === 1 },
          { region: KC_REGION[bits(v, 25, 6)] ?? bits(v, 25, 6), readOnly: bits(v, 31, 1) === 1 },
        ] });
        break;
      case 'EnableInterrupts':
        caps.push({ type, irq0: bits(v, 12, 10), irq1: bits(v, 22, 10) });
        break;
      case 'MiscParams':
        caps.push({ type, programType: bits(v, 14, 3) });
        break;
      case 'KernelVersion':
        caps.push({ type, major: bits(v, 19, 13), minor: bits(v, 15, 4) });
        break;
      case 'HandleTableSize':
        caps.push({ type, size: bits(v, 16, 10) });
        break;
      case 'MiscFlags':
        caps.push({ type, allowDebug: bits(v, 17, 1) === 1, forceDebugProd: bits(v, 18, 1) === 1, forceDebug: bits(v, 19, 1) === 1 });
        break;
      default:
        caps.push({ type, raw: '0x' + v.toString(16) });
    }
  }
  return { caps, enabledSvcs: [...svc].sort((a, b) => a - b) };
}

function decodeMeta(buf) {
  if (buf.length < META_SIZE || buf.toString('ascii', 0, 4) !== 'META') {
    throw new Error('not an NPDM: missing META magic');
  }
  const flags0 = buf[0x0c];
  const flags1 = buf[0x0d];
  return {
    magic: 'META',
    signatureKeyGeneration: buf.readUInt32LE(0x04),
    flags0: {
      raw: flags0,
      is64BitInstruction: (flags0 & 1) !== 0,
      processAddressSpace: PROCESS_ADDRESS_SPACE[(flags0 >> 1) & 7] ?? ((flags0 >> 1) & 7),
      optimizeMemoryAllocation: (flags0 & (1 << 4)) !== 0,
      disableDeviceAddressSpaceMerge: (flags0 & (1 << 5)) !== 0,
      enableAddressSanitizer: (flags0 & (1 << 6)) !== 0,
      preventCodeReads: (flags0 & (1 << 7)) !== 0,
    },
    flags1: { raw: flags1, enableShadowStack: (flags1 & 1) !== 0 },
    mainThreadPriority: buf[0x0e],
    mainThreadCoreNumber: buf[0x0f],
    systemResourceSize: buf.readUInt32LE(0x14),
    version: buf.readUInt32LE(0x18),
    mainThreadStackSize: buf.readUInt32LE(0x1c),
    name: ascii(buf, 0x20, 0x10),
    productCode: ascii(buf, 0x30, 0x10),
    aciOffset: buf.readUInt32LE(0x70), aciSize: buf.readUInt32LE(0x74),
    acidOffset: buf.readUInt32LE(0x78), acidSize: buf.readUInt32LE(0x7c),
  };
}

// ACI0: actual granted permissions. Offsets within ACI0 are relative to its start.
function decodeAci0(buf, aciBase) {
  if (buf.toString('ascii', aciBase, aciBase + 4) !== 'ACI0') throw new Error('ACI0 magic missing');
  const programId = buf.readBigUInt64LE(aciBase + 0x10).toString(16).padStart(16, '0');
  const facOff = buf.readUInt32LE(aciBase + 0x20); const facSize = buf.readUInt32LE(aciBase + 0x24);
  const sacOff = buf.readUInt32LE(aciBase + 0x28); const sacSize = buf.readUInt32LE(aciBase + 0x2c);
  const kacOff = buf.readUInt32LE(aciBase + 0x30); const kacSize = buf.readUInt32LE(aciBase + 0x34);
  return {
    programId,
    services: decodeSac(buf, aciBase + sacOff, sacSize),
    fs: decodeFac(buf, aciBase + facOff, facSize),
    kernel: decodeKc(buf, aciBase + kacOff, kacSize),
  };
}

// ACID: declared MAX permissions (not what's granted). Body magic sits after the
// signature+pubkey block: 0x200 (RSA-2048) or 0x300 (RSA-3072, Switch 2).
function decodeAcid(buf, acidBase, acidSize) {
  let body = -1;
  if (buf.toString('ascii', acidBase + 0x200, acidBase + 0x204) === 'ACID') body = acidBase + 0x200;
  else if (acidSize >= 0x340 && buf.toString('ascii', acidBase + 0x300, acidBase + 0x304) === 'ACID') body = acidBase + 0x300;
  if (body < 0) throw new Error('ACID body magic not found at +0x200 or +0x300');

  const flags = buf.readUInt32LE(body + 0x0c);
  const facOff = buf.readUInt32LE(body + 0x20); const facSize = buf.readUInt32LE(body + 0x24);
  const sacOff = buf.readUInt32LE(body + 0x28); const sacSize = buf.readUInt32LE(body + 0x2c);
  const kacOff = buf.readUInt32LE(body + 0x30); const kacSize = buf.readUInt32LE(body + 0x34);
  return {
    signatureBlock: body - acidBase === 0x300 ? 'RSA-3072 (0x300)' : 'RSA-2048 (0x200)',
    flags: {
      raw: flags,
      production: (flags & 1) !== 0,
      unqualifiedApproval: (flags & 2) !== 0,
      deprecatedUseSecureMemory: (flags & (1 << 2)) !== 0,
    },
    programIdMin: buf.readBigUInt64LE(body + 0x10).toString(16).padStart(16, '0'),
    programIdMax: buf.readBigUInt64LE(body + 0x18).toString(16).padStart(16, '0'),
    services: decodeSac(buf, body + sacOff, sacSize),
    fs: decodeFac(buf, body + facOff, facSize),
    kernel: decodeKc(buf, body + kacOff, kacSize),
  };
}

function decodeNpdm(buf) {
  const meta = decodeMeta(buf);
  const aci0 = decodeAci0(buf, meta.aciOffset);
  let acid = null;
  try { acid = decodeAcid(buf, meta.acidOffset, meta.acidSize); } catch (e) { acid = { error: e.message }; }
  return { meta, aci0, acid };
}

module.exports = {
  decodeNpdm, decodeMeta, decodeAci0, decodeAcid, decodeFac, decodeSac, decodeKc, decodeFsAccessFlag,
  FS_ACCESS_FLAGS, KC_TYPES, META_SIZE,
};
