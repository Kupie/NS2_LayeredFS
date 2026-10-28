# Stage 2 — Design: table merge + interval-map storage

Design only. No console code. This describes the data structures Stage 3 will
implement and unit-test on a PC, modeled on Atmosphere's `fs_mitm` romfs builder
(`fsmitm_romfs.cpp`) and layered storage (`fsmitm_layered_romfs_storage.cpp`).

Scope reminder: this is read-only asset overlay — file *data* only. Nothing here
reads or produces exefs, NPDM/ACID/ACI, tickets, keys, or signatures.

---

## 1. The problem

A game's romfs is one contiguous read-only image (one `Read(offset, size)` storage
object — validated in Stage 1). We want some files served from SD-card override
copies instead, with the game none the wiser: it still sees one romfs image, same
kind of object, just with different bytes (and possibly different sizes) for the
files we overrode.

So we build a **new virtual image** whose metadata tables describe the merged tree,
and whose file data comes from two places — the original storage for untouched
files, SD files for overridden ones — without ever copying the whole original. A
read against the virtual image is translated, per byte range, to a read against
whichever real source backs that range.

Two pieces do this:

1. **Table merge** — produce the virtual image's header + dir/file tables.
2. **Interval map** — a sorted list of "this virtual byte range is backed by that
   source at that offset", with a binary-search lookup used on every read.

---

## 2. Inputs

- **Original romfs**: a `read(offset, size)` reader + `size` (Stage 1's reader).
  We parse its four tables (we already do this in `read-logger.traverse`).
- **Override tree**: a set of `{ romfsRelativePath -> { size, read(offset,size) } }`
  entries. On PC these are plain files; on console they are SD files. The module
  does not care which — it only needs size + a byte reader per override, same
  interface as the original. This keeps Stage 3 console-free.

Override precedence: **an override replaces the original file at the same path.**
Overrides may also add files/dirs that do not exist in the original. (Matching
Atmosphere, where SD files are visited first and win ties.)

---

## 3. Merged tree model

Build an in-memory tree, independent of either on-disk layout:

```
DirNode  { name, parent, children: Map<name,DirNode>, files: Map<name,FileNode> }
FileNode { name, parent, size, source }
source = { kind: 'original', offset }      // byte offset in the ORIGINAL image's data region
       | { kind: 'override', reader }      // an override's byte reader (size = reader.size)
```

Construction:

1. Seed root.
2. Walk the **original** romfs tables (offset-walk, as Stage 1 does). For each file,
   add a `FileNode` with `source = { kind:'original', offset }`, where `offset` is
   its absolute data offset in the original image.
3. Walk the **override** tree. For each override file, add/replace the `FileNode` at
   that path with `source = { kind:'override', reader }`. Create intermediate dirs
   as needed. Replacement is by path: an override at `/foo/bar.bntx` overrides the
   original `/foo/bar.bntx` (size may differ); a brand-new override path just adds.

The merged tree is the union of paths; per path, override wins.

Order within a directory (sibling order) and across the whole set determines entry
offsets and therefore hashes, so Stage 3 must pick a **deterministic** order and use
it consistently when sizing, when assigning entry offsets, and when emitting. We use
the same order Atmosphere does (a stable sort of full paths) so output is
reproducible and testable.

---

## 4. Virtual image layout

The rebuilt image uses the standard romfs layout, tables **after** the data
partition (which is what Stage 1 observed on the real title):

```
0x000              header (0x50)
0x050 .. 0x200     reserved / zero
0x200              file data partition         <- FILE_PARTITION_OFFSET
    (each file's data, packed, 0x10-aligned between files)
alignUp(0x200 + partitionSize, 4)
                   dir hash table
                   dir meta table
                   file hash table
                   file meta table
EOF
```

Sizing (all derivable before emitting a single byte):

- **File partition**: iterate files in the chosen order; each file's virtual data
  offset = running partition size aligned up to `0x10`; then add its size. Record
  this offset on the `FileNode` — it becomes the file entry's `dataOffset` (relative
  to `FILE_PARTITION_OFFSET`) and anchors its interval. (Optionally preserve larger
  original inter-file padding for runs of same-source files, as Atmosphere does, so
  consecutive untouched originals stay one contiguous interval — a compaction win,
  see §5. Not required for correctness.)
- **Meta tables**: `dirMetaSize = Σ (0x18 + alignUp(nameLen,4))`,
  `fileMetaSize = Σ (0x20 + alignUp(nameLen,4))`. Entry offsets are assigned in the
  same pass (prefix sums), and stored on each node — needed because hashes key off a
  node's parent's **entry offset**.
- **Hash tables**: `buckets = GetHashTableSize(count)` then `size = 4 * buckets`,
  where `GetHashTableSize(n)` = `3` if `n<3`; `n|1` if `n<19`; else the smallest
  `m ≥ n` divisible by none of {2,3,5,7,11,13,17}. (Already have `pathHash` in
  `romfs-format.cjs`; this adds bucket sizing.)

Then header offsets:

```
fileDataOffset    = 0x200
dirHashTableOffset  = alignUp(0x200 + partitionSize, 4)
dirMetaTableOffset  = dirHashTableOffset  + dirHashSize
fileHashTableOffset = dirMetaTableOffset  + dirMetaSize
fileMetaTableOffset = fileHashTableOffset + fileHashSize
imageSize           = fileMetaTableOffset + fileMetaSize
```

Entry emission: for each node write the fixed struct (parent/sibling/child/file or
parent/sibling/dataOffset/dataSize, plus `hash` chain link and name), using entry
offsets from the sizing pass. Hash chains: bucket = `pathHash(parentEntryOffset,
name) % buckets`; push-front into the bucket (entry's `hash` field = previous bucket
head, bucket head = this entry). This is exactly what `test/synthetic-romfs.cjs`
already does for a single tree; Stage 3 generalizes it to the merged tree and to the
tables-after-data layout.

The header + all four tables are **generated bytes** — they live in memory (or a
small SD scratch file), never read from the original storage.

---

## 5. Interval map (the read router)

A sorted array of sources covering the whole virtual image with no gaps:

```
Source {
  virtualOffset   // start in the virtual image
  size
  kind: 'memory' | 'original' | 'override'
  // memory:   data (the generated header+tables buffer)
  // original: origOffset  (offset in the ORIGINAL image)
  // override: reader       (the override's byte reader)
}
```

Built in virtual-offset order:

1. `{ virtualOffset: 0, size: 0x50, kind:'memory', data: header }`
2. One source per file in the data partition:
   - original file → `{ virtualOffset: 0x200 + dataOffset, size, kind:'original',
     origOffset }`
   - override file → `{ virtualOffset: 0x200 + dataOffset, size, kind:'override',
     reader }`
3. `{ virtualOffset: dirHashTableOffset, size: (all four tables), kind:'memory',
   data: tables }`

**Compaction**: consecutive `original` sources that are contiguous in *both* the
virtual image and the original image collapse into one source. In a mostly-unmodified
romfs this means most of the image is a handful of big `original` intervals with the
few overrides punched out — few entries, cheap lookups.

**Lookup** (`Read(offset, size)`), same shape as Atmosphere's:

```
clamp size to [offset, imageSize)
i = upperBound(sources, offset by virtualOffset) - 1   // last source starting <= offset
while not done:
  s = sources[i]
  if offset < s.virtualOffset + s.size:
     within = offset - s.virtualOffset
     n = min(remaining, s.size - within)
     serve n bytes from s:
       memory   -> copy from s.data[within..]
       original -> originalReader.read(s.origOffset + within, n)
       override -> s.reader.read(within, n)
     advance offset/remaining by n; i++
  else:
     // gap before next source -> zero fill up to sources[i+1].virtualOffset
     i++
```

Because sources tile the whole image, the gap branch only fires for intentional
padding; serving it as zeros matches romfs. A single read may span several sources
(e.g. end of one file's data into the next), which the loop handles.

---

## 6. Stage 3 module surface (PC-testable, no console)

```
src/romfs-merge.cjs
  parseOriginal(reader)            -> merged-tree nodes for the original
  mergeOverrides(tree, overrides)  -> merged tree (override wins by path)
  buildLayout(tree)                -> { header, dirTables, fileTables, sources }
  // uses romfs-format.cjs for structs/hash; generalizes synthetic-romfs.cjs

src/layered-storage.cjs
  LayeredStorage(originalReader, sources)
    .size
    .read(offset, size)            -> Buffer   // the §5 router
  // same { size, read(offset,size) } interface as every other reader, so the
  // Stage 1 logger and the synthetic reader both work against it unchanged.
```

Test harness (`test/stage3.test.cjs`):

- Build a synthetic original with `test/synthetic-romfs.cjs`.
- Provide a few overrides: one replacing a file with a **larger** body, one with a
  **smaller** body, one brand-new path.
- Build the layered image; then, crucially, **parse the layered image back** with
  the Stage 1 `traverse()` (feeding it `LayeredStorage` as the reader) and assert:
  - the listing is original ∪ overrides, override sizes win;
  - reading each file's full range returns the override bytes where overridden and
    the original bytes elsewhere;
  - reads that span file boundaries and table regions return correct bytes;
  - `GetSize` equals the computed image size.

This closes the loop: Stage 1 is the oracle that validates Stage 3's output, all on
PC with no console in the picture.

---

## 7. Confirmed parameters (from Stage 1 on real hardware)

- header size `0x50`; `fileDataOffset = 0x200`.
- file data packed at `0x10` alignment (observed: consecutive files abutting at
  0x10-aligned offsets).
- metadata tables placed **after** the data partition.
- dir entry `0x18` + name, file entry `0x20` + name; `pathHash` as in
  `romfs-format.cjs` (already matches Atmosphere's `CalculatePathHash`).

---

## 8. Explicitly out of scope for Stage 3

- Any console interaction (that is Stage 4, and will be designed before any code).
- Update/DLC romfs layering (a third+ source tier). The source model already
  generalizes to N storage tiers, but Stage 3 implements base + overrides only.
- exefs, NPDM/ACID/ACI, tickets, keys, signatures — not touched here or anywhere.
