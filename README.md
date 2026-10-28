# NS2 LayeredFS

A **read-only** romfs asset-override layer for personal Switch 2 game modding, on a
console you have jailbroken yourself. It follows Atmosphere's `fs_mitm` LayeredFS
model: SD-card files (models, textures, text, audio) are served transparently in
place of a game's own romfs assets, overlay reads only.

## Scope and boundaries

This project is **data reads only**. It does not, and will not:

- touch exefs or program code,
- read, parse, modify, or generate NPDM / ACID / ACI access-control or capability data,
- handle signatures, ticket/keys, or any DRM / content-decryption step,
- change permissions or escalate privileges,
- modify original storage (SD or internal) — overrides live on the SD card and
  originals are never written.

If any stage turns out to require any of the above, that stage stops and is flagged
rather than implemented. You still need your own legally-obtained copy of a game for
any of this to do anything; nothing here enables piracy or signature bypass.

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
tools/stage1-probe.cjs Stage 1 CLI
tools/stage3b-probe.cjs Stage 3b CLI: console open (read-only) + PC-side merge/verify
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

## Test

```bash
npm test   # Stage 1 logger + Stage 3 merge/layered-storage, all on PC
```

Stage 3's test builds a synthetic original, overlays a larger replacement, a smaller
replacement, and brand-new files/dirs, then re-parses the layered image with the
Stage 1 traverser (the oracle) and checks: merged listing + sizes, override vs.
untouched bytes, boundary-spanning reads, `GetSize`, and that every file resolves
through the hash tables the way the firmware looks paths up.
