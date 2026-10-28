# NS2 LayeredFS

A **read-only** romfs asset-override layer for personal Switch 2 game modding, on a
console you have jailbroken yourself. It follows Atmosphere's `fs_mitm` LayeredFS
model: SD-card files (models, textures, text, audio) are served transparently in
place of a game's own romfs assets, overlay reads only.

## Scope and boundaries

This project overlays **asset file data only**, read-only, for games you own on a
console you jailbroke yourself.

**Permanently out of scope — never, in any stage:**

- forging, extracting, bypassing, or modifying any **signature, key, or
  ticket/license** data — or anything that would grant access to content not
  legitimately owned. No keys or tickets are ever acquired, extracted, persisted, or
  altered by this project;
- touching **exefs / `main` / `subsdk*` / any executable code**;
- **writing** `main.npdm` or any ACI0 / ACID / ACI access-control data;
- any **persistent** console state change, or any write to original storage (SD or
  internal) — overrides live on the SD card; originals are never written.

**In scope (read-only, non-persistent):**

- reading a title's romfs and serving SD-card overrides in place of its own assets
  (the LayeredFS model);
- to read a title's **composed/patched update romfs** (not just base), two extra
  read-only, self-restoring console operations, performed via OunceCake's existing,
  unmodified code:
  - reading the title's own `main.npdm` and **temporarily registering, then
    restoring**, its `fah`/`fac` access-control blobs so FS hands back the composed
    romfs (`fs-context.cjs` `openProgramRomfs` / `openCurrentProgramRomfs`);
  - triggering the **same legitimate license-presence check the system performs
    automatically during normal play** — if, and only if, FS does not already have
    the title's key cached (`program.cjs` `withUpdateLicenses` / `prepareInstalledLicense`
    via the `es`/eticket service). This asks FS to confirm legitimate entitlement for
    content you own; **no key or ticket is returned, extracted, persisted, or
    modified — FS alone evaluates and holds them, exactly as during gameplay.** For a
    title launched normally with its update installed, this fallback is not even
    reached (the live program context already has the key).

Everything remains **read-only and non-persistent**: every registration/pointer
change is undone by the time the handle closes. See the restore-on-close audit note
below. You still need your own legally-obtained copy of a game; nothing here enables
piracy, signature bypass, or access to content you do not own.

### Restore-on-close audit (update path)

`memory.write` is a guarded compare-and-write (asserts current == expected before
writing), and every swap/registration in the update path runs under `withCleanup`,
whose cleanup runs on success and on error: the temporary program context and patch
location are removed, pointer swaps are CAS-restored (idempotent; skipped if already
original), and the program-index map is restored. Nothing is written to NAND/SD.
**Known limit:** if the RPC session or console dies *mid-operation*, cleanup cannot
run and those temporary FS registrations / in-RAM pointer swaps persist until the
next reboot, which clears them fully (nothing persistent is left behind).

## Build stages

| Stage | What | Console? |
|-------|------|----------|
| 1 | Locate a launched title's romfs storage and **log every `Read(offset,size)`** it would receive, read-only. Validates the access pattern. | yes (passive) |
| 2 | *(design only)* table-merge data structure + interval-map lookup. | no |
| 3 | Standalone layered-storage module + table merge, with a PC-only test harness. | no |
| 4 | *(design first)* minimal pointer/handle swap to route a running game's romfs through the layered storage, acquire-swap-operate-restore, restored on exit/crash. | yes |

Stages are implemented one at a time with confirmation between each.

## Relationship to OunceCake / ns2jb

The console protocol (RPC/session, storage `Read`/`GetSize`) is reused from
[ns2jb](https://gitlab.com/kurumuz/ns2jb) and
[OunceCake](https://github.com/misshexa66/OunceCake). This repo does not reimplement
the exploit. The Stage 1 opener uses **only OunceCake's published exports**
(`attachGame`, `discoverGames`/`resolveProgramContent`, `pathRequest`/`success`) and
reimplements just the read-only base-romfs open (`OpenDataStorageByPath` + `GetSize`
+ `readStorage`) that OunceCake's internal `createGameFiles.open()` performs — so a
cloned, unmodified OunceCake works as-is, with no patching. It does **not** use
`openProgramRomfs`/`copyProgramRegistry` (the access-control / pointer-swap path).

## Stage 1 — usage

```bash
# Start ns2jb's RPC (node run.cjs --rpc), note its "Run folder:".
node tools/stage1-probe.cjs \
  --ounce /path/to/OunceCake \
  --run   /path/to/ns2jb/runs/switch2-XXXXXX \
  [--title 0123456789abcdef] [--storage 4|5|2] [--data-samples 8] [--json reads.jsonl]
```

It prints each `Read(offset, size)` annotated with the romfs region it lands in
(`header`, `dirHashTable`, `dirMetaTable`, `fileHashTable`, `fileMetaTable`,
`fileData`), then a summary and the parsed header layout. It modifies nothing and
closes the handle on exit.

## Layout

```
src/romfs-format.cjs   RomFS on-disk format: struct offsets, path hash, region map (pure data)
src/reader.cjs         byte-reader interface {size, read(offset,size)}: buffer- and file-backed
src/read-logger.cjs    Stage 1 read logger (console-agnostic; wraps a read(offset,size))
src/romfs-merge.cjs    Stage 3 table merge: original romfs union SD overrides -> layout + sources
src/layered-storage.cjs Stage 3 layered storage: interval-map read router over the sources
src/npdm.cjs           pure read-only NPDM decoder (Meta/ACI0/ACID), bit tables from Atmosphere
tools/stage1-probe.cjs Stage 1 CLI
tools/stage3b-probe.cjs Stage 3b CLI: console open (read-only) + PC-side merge/verify
tools/npdm-permissions.cjs read-only NPDM permission printer (reads main.npdm, decodes, prints)
tools/launch-title.cjs remote title launch via the official applet API (no injection/persistence)
tools/openers/ouncecake-romfs.cjs  read-only handle opener (OunceCake published exports only)
test/synthetic-romfs.cjs  in-memory romfs builder for PC testing
test/stage1.test.cjs      PC validation of the logger
test/stage3.test.cjs      PC validation of merge + layered storage
```

## Stage 3 — layered storage (PC, no console)

`buildLayeredStorage(originalReader, overrides)` parses the original romfs, overlays
the overrides (a map of romfs path -> reader or Buffer; override wins by path), and
returns a `LayeredStorage` with the standard `{ size, read(offset, size) }`
interface. Reads are routed per byte-range to generated metadata, the original
storage, or an override. Because it is just another reader, the Stage 1 traverser
parses its output — which is how the tests validate it.

## Stage 3b — end-to-end loop closer (console read-only, verify on PC)

Combines the Stage 1 console opener with Stage 3's merge/layered-storage, to prove
the whole data path against a *real* title before Stage 4 exists. It opens a title's
romfs read-only (identical access to Stage 1 — no writes, no pointer swaps, nothing
live), picks one real file, overlays it with a local test file, builds the layered
image on the PC, re-parses it with the Stage 1 traverser + firmware hash resolver,
and reports whether the overridden file now has the override's size/bytes and every
spot-checked file still matches the original.

```bash
node tools/stage3b-probe.cjs \
  --ounce /path/to/OunceCake --run /path/to/ns2jb/runs/switch2-XXXXXX \
  --override ./my-test-asset.bin \
  [--title 0123456789abcdef] [--storage 4|5|2] [--path /some/real/file] [--spot 3]
```

Without `--path` it picks the smallest file (cheap to verify) and prints it. All
merging and verification happen PC-side; the console is only read.

## Utility tools (NPDM inspection + official launch)

Two standalone tools, same CLI pattern (`--ounce`, `--run`, `--title`, `--update`, `--json`):

- **`tools/npdm-permissions.cjs`** — reads a title's `main.npdm` (the metadata/permission
  descriptor in the code partition, *not* a code segment), decodes it per the public
  NPDM layout, and prints Meta / ACI0 Services / ACI0 Syscalls / ACI0 FS Permissions /
  ACI0 Kernel Capabilities / ACID summary. Read-only: it never verifies or forges a
  signature and never writes. ACI0 is the actual granted set; ACID is labeled as the
  declared *maximum*, not what's granted. `--update` decodes the composed update's npdm.

  ```bash
  node tools/npdm-permissions.cjs --ounce <OunceCake> --run <ns2jb-run> --title <16hex> [--update] [--json]
  ```

- **`tools/launch-title.cjs`** — launches an already-installed, unmodified title through
  the **official** OS launch path (the Home Menu path): `appletAE` →
  `OpenSystemAppletProxy` → `GetApplicationCreator` → `CreateApplication(titleId)` →
  `IApplicationAccessor::Start`. No exefs read/write, no injection, no persistence;
  `CreateApplication` takes only the title ID. If the process lacks applet-manager
  privilege it **stops and reports** — no workaround. `Start` ends the current RPC
  session (the launcher exits once the target foregrounds); the tool prints this first
  so it reads as expected, not a hang.

  ```bash
  node tools/launch-title.cjs --ounce <OunceCake> --run <ns2jb-run> --title <16hex>
  ```

## Test

```bash
npm test   # Stage 1 logger + Stage 3 merge/layered-storage + NPDM decoder, all on PC
```

Stage 3's test builds a synthetic original, overlays a larger replacement, a smaller
replacement, and brand-new files/dirs, then re-parses the layered image with the
Stage 1 traverser (the oracle) and checks: merged listing + sizes, override vs.
untouched bytes, boundary-spanning reads, `GetSize`, and that every file resolves
through the hash tables the way the firmware looks paths up.
