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

The console protocol (RPC/session, storage `Read`/`GetSize`, handle location) is
reused from [ns2jb](https://gitlab.com/kurumuz/ns2jb) and
[OunceCake](https://github.com/misshexa66/OunceCake). This repo does not reimplement
the exploit or the handle-location logic; Stage 1 delegates romfs-handle acquisition
to OunceCake's existing read-only dump opener and only *reads* from the handle.

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
src/read-logger.cjs    Stage 1 read logger (console-agnostic; wraps a read(offset,size))
tools/stage1-probe.cjs Stage 1 CLI
tools/openers/ouncecake-romfs.cjs  read-only handle opener delegated to OunceCake
test/synthetic-romfs.cjs  in-memory romfs builder for PC testing
test/stage1.test.cjs      PC validation of the logger (npm test)
```

## Test

```bash
npm test   # builds a synthetic romfs and validates the Stage 1 logger on PC
```
