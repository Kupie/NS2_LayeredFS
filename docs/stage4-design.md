# Stage 4 — Design: live interception of a running title's romfs reads

**Design only. No code. Stop for review before any implementation, injection, or
live testing.** This is the first stage that touches live, running console state.

Goal: route a currently-running title's own romfs reads through the Stage 3 layered
image, so the game transparently sees SD overrides in place of its assets — the
fs_mitm LayeredFS effect, but applied to an already-running process over RPC instead
of from a resident sysmodule.

Citations are to the reference repos as read: `OunceCake/engine/*` and
`ns2jb/engine/switch2/*`.

---

## 0. What stays permanently out of scope (reaffirmed, binding on this design)

This design does **not**, anywhere, and no later implementation of it may:

- modify **exefs / `main` / `subsdk*` / any executable code** — not the game's, not
  fs's. Stage 4 maps our **own new** router code and builds our **own new** vtable
  page; it never rewrites an existing instruction. The interception is a single
  **data-pointer** swap (§1), explicitly *not* inline instruction patching;
- **write** `main.npdm` or any ACI0 / ACID / ACI data;
- forge, extract, bypass, or modify any **signature, key, or ticket/license**. The
  only license interaction remains the already-approved, read-only composed-romfs
  **license-presence check** from the Stage 3 `--update` work (`program.cjs`
  `withUpdateLicenses`), unchanged and not extended here;
- make any **persistent** (NAND/SD) state change.

If any step below turns out to require crossing one of these lines, that step stops
and is flagged rather than worked around. One such line is examined head-on in §1.3
(swapping a vtable *pointer* is data, not code) and §3 (crash hazards).

---

## 1. Interception: locate the live romfs storage object and swap one pointer

### 1.1 Where the game's romfs reads actually resolve

A running title reads its romfs as a chain inside fs:

```
game  --fsp-srv IPC-->  RomFsFileSystem (parses header/tables)
                              |  reads image bytes via
                              v
                        IStorage  (the romfs image storage)   <-- interception point
                              |  IStorage::Read(offset, buf, size)
                              v
                        NCA / section storage
```

The **byte-level** reads — `Read(offset, buffer, size)` over the romfs image — happen
at the `IStorage` layer, and offsets there are romfs-image offsets. That is exactly
the contract Stage 3's `LayeredStorage.read(offset, size)` implements. So the
interception point is the **romfs image `IStorage` object**, and our router stands in
for its `Read`.

### 1.2 The swap, modeled on `copyProgramRegistry`

`fs-context.cjs` already proves the acquire/swap/operate/restore pattern we reuse:

- **Locate by vtable signature.** `candidates()` (`fs-context.cjs:10-29`) scans an
  object/handle table for entries whose object vtable equals a known value
  (`layout.rootVptr + 0x5888`). We locate the romfs `IStorage` the same way — by its
  class vtable signature and/or by walking the live program's FS context the way
  `openCurrentProgramRomfs` already navigates (registry → program root → nca → …).
- **Swap a pointer with a guarded CAS.** `copyProgramRegistry` swaps an object
  pointer in a table entry: `memory.write(entry + 0x20, b.subarray(0x20),
  Buffer.from(source.pair, 'hex'))` (`fs-context.cjs:83`), operates, then
  `restoreRegistrySlot` writes it back (`fs-context.cjs:45-55`, invoked at `:95`).
  `memory.write(at, expected, replacement)` is a **guarded compare-and-write**
  (`ns2jb/.../tools/fs-memory.cjs:108-115`: it asserts current == expected before
  writing), so every swap and restore is verified.

Two swap targets, in order of robustness for an already-running game:

1. **Per-object vtable-pointer swap (primary).** Read the romfs `IStorage` object's
   vtable pointer at `object+0x00`; record it as `original`. Build a **private copy**
   of that vtable in our mapped memory, identical except the `Read` slot (and, as
   needed, `GetSize`/`OperateRange`) points at our router (§2). CAS-write
   `object+0x00` from `original` → `&ourVtable`. Because a C++ object dereferences
   *its own* vtable pointer on every virtual call, this reroutes **only this object's**
   reads, regardless of how the game references it (even a cached C++ pointer), and
   leaves every other `IStorage` instance untouched (we copied the vtable rather than
   editing the shared one). Restore = one reverse CAS.
2. **Table-entry object-pointer swap (the direct `copyProgramRegistry` analogue).**
   If the romfs storage is reached through a domain/handle-table entry, construct a
   whole stand-in `IStorage` (our vtable pointer + our fields) and CAS-swap the
   entry's object pointer to it, exactly as `copyProgramRegistry` swaps `entry+0x20`.
   Cleaner, but only intercepts reads that re-resolve through that entry — a game
   holding a direct object pointer would bypass it. Hence (1) is primary.

Either way the toggle is **one 8-byte aligned store**, which is atomic on aarch64 —
so interception is all-or-nothing, never half-applied (important for §3).

### 1.3 Why this is a pointer swap, not code modification

The vtable is a table of function pointers in read-only data; an object's vtable
*pointer* is a data field in a heap object. We change **one data pointer** to a table
**we allocated**, whose non-`Read` slots copy fs's existing function pointers
unchanged (referenced, never rewritten). No existing instruction anywhere is
modified. This is the "pointer-table swap, not inline instruction patching" the stage
requires, and it keeps §0's "no code modification" line intact.

### 1.4 The timing hazard that must be settled before implementation (FLAG)

`fs_mitm` on Atmosphere intercepts **before** the game mounts romfs, so the game
parses the *merged* tables from the start. We are intercepting a game that is
**already running** and may have **already parsed and cached** the original romfs
tree at launch. That gives two models, and which one is correct depends on behavior
we must verify empirically (do not assume):

- **Model A — present the rebuilt image (matches Stage 3 `buildLayout`).** The router
  serves the whole Stage 3 layered image (new header, relocated tables, re-packed
  data) via the interval map. Correct **iff** the game re-reads header/tables after
  the swap (or never cached them). If the game cached the original tree, its file
  offsets won't match our relocated layout → wrong bytes. Best when overrides change
  file sizes or add/remove files.
- **Model B — in-place byte redirect (robust for a running, cached game).** The
  interval map is built over the **original** image geometry; header, tables, and all
  untouched file offsets are byte-identical to the original, and only the overridden
  files' data ranges redirect to override bytes. Safe against a game that cached the
  original tree, because nothing it cached moved. **Limitation:** an override must fit
  the original file's extent (equal size, or smaller with zero/pad); larger overrides
  and added/removed files are not possible in-place.

Recommendation: implement **Model B first** (it is the only one guaranteed correct
for the already-running case and needs only a trivial change to how `buildLayout`
assigns offsets — reuse originals), and treat **Model A** as a follow-up gated on
empirically confirming, per target title, that the game re-reads tables after the
swap. The probe to decide this is read-only and can be designed separately. This is
flagged, not resolved, pending your review.

---

## 2. PC-vs-native split, and what the native read-router needs

**On the PC (one-time, per mod-set):** the table merge / layout
(`romfs-merge.cjs buildLayout`) runs exactly as Stage 3 already does, producing the
generated metadata bytes (header + four tables) and the **source list** (the interval
map). Node then writes those into fs-mapped memory and opens the handles the router
needs. Nothing in the merge runs during gameplay.

**In fs (hot path, per read):** per-read routing must be resident native code — Node
cannot be in the path of a live `IStorage::Read`. It is built and injected the same
way as the FTP payload: freestanding aarch64 C, no libc, its own `memcpy`/`memset`,
raw IPC via an `svcSendSyncRequest` thunk, mapped via `ro:dmnt`
(`ftp.cjs:305/317/258`) and started as context for our vtable's `Read` slot (no new
thread needed — the game's own threads call into it).

### 2.1 Router inputs (a config block, like `FtpConfig`)

Written into our mapped region by Node before the swap:

- `armed` / flags (volatile), an `original_read` function pointer (the real
  `IStorage::Read`, for passthrough — see §3), and an `io_lock` word;
- pointer + length of the **generated metadata** bytes (header + tables), already in
  our mapped memory;
- pointer + count of the **source list**: each entry
  `{ u64 virtualOffset; u64 size; u32 kind; u32 pad; u64 arg; }` where `kind` ∈
  {`memory`, `original`, `override`} and `arg` is a metadata offset, an original-image
  offset, or an override-handle index + file offset;
- the **original romfs storage handle** (to forward `original` ranges);
- the **override handles** (see §2.3);
- a per-call IPC scratch buffer (or the lock serializes one shared buffer).

### 2.2 The router's `Read(this, offset, buffer, size)`

ABI: `nn`'s `Result IStorage::Read(s64 offset, void *buffer, size_t size)` →
`x0=this, x1=offset, x2=buffer, x3=size`, `Result` in `w0`. `buffer` is addressable
in fs (fs maps the client's output buffer for the request), so the router both
`memcpy`s into it and uses it as the receive target for sub-reads — exactly how
`native.c read_storage` reads into `c->data` (`native.c`). Logic is the Stage 3
`LayeredStorage.read` loop, ported to C:

1. bounds-check against virtual size; binary-search the source list for `offset`
   (the Stage 3 `lowerSourceIndex`), then walk sources covering `[offset, offset+size)`:
   - `memory`  → `memcpy` from the generated-metadata region (already in fs memory);
   - `original`→ build a `Read` IPC (cmd 0) against the original storage handle into
     `buffer+written` (`native.c packet`/`response`/`read_storage`, storage form);
   - `override`→ a file `Read` IPC (cmd 0, file semantics — `native.c`'s `file=1`
     path) against the override file handle at the in-file offset;
   - gap → `memset(0)` (intentional romfs padding).
2. return `0` on success, or the FS `Result` on a failed sub-read (never abort).

### 2.3 Serving SD override files (the investigated answer — not assumed)

`native.c` has **no** file API; it serves everything by raw FS IPC against handles the
Node side opened and passed in (`FtpFunctions` has only socket calls + a generic
`ipc`/`close_handle`; file data comes from `OpenDataStorageByPath` cmd 206 / `OpenFile`
cmd 8 / `Read` cmd 0 built by hand). fs itself is the filesystem server and already
has SD access. So override files are served the same proven way, **no new syscalls**:

- **Primary — Node pre-opens, router reads.** At deploy time Node (over RPC) opens the
  SD-card filesystem (`fsp-srv` OpenSdCardFileSystem) and `OpenFile`s each override,
  passing the **file handles + sizes** into the router config (mirroring how
  `deployFtp` passes romfs storage handles via the Source table, `ftp.cjs:183-191`).
  The hot path is then a single cmd-0 file read per override range — minimal work in
  `Read`, and `ns2jb`'s `filesystem.cjs` already has the Node-side open helpers.
- **Alternative — router opens on demand.** Node passes one SD-filesystem handle +
  the override path strings; the router does `OpenFile`/`Read`/`Close` per read
  (`native.c open_source` already shows the cmd-8 path-descriptor form). Scales to
  many overrides without holding handles, at the cost of per-read open/close.

Either way: pure FS IPC against legitimately-opened handles, read-only, no libc file
I/O, no new capability. Pre-opened handles opened by Node stay valid for the session
and are closed on teardown (§3).

### 2.4 Concurrency

A game reads romfs from multiple threads; our `Read` can be entered concurrently.
`native.c` already serializes FS IPC with `io_enter`/`io_leave` around a shared buffer
— the router adopts the same lock (or a per-call scratch) so concurrent reads don't
corrupt the shared IPC buffer. The `memory`/`memcpy` path needs no lock.

---

## 3. Restore-on-close and crash safety (this is live state — no glossing)

The swap itself is the same guarded-CAS pattern audited for Stage 3b, but the stakes
are higher: a stale pointer here is dereferenced by the running game on its next read.

**Clean teardown (RPC alive), strictly ordered:**
1. **Disarm** the router (clear `armed`); from then its `Read` shim calls
   `original_read(this, …)` — pure passthrough to the real storage. Reads stay correct
   even before the pointer is restored.
2. **Restore** the swapped pointer with a reverse guarded CAS (expect `&ourVtable`,
   write `original`); verify it took.
3. **Only then unmap** our code/data pages (`ro:dmnt 0x524f0013`, as `ftp.cjs:258`)
   and close the override/SD handles and the work session.

Order is the invariant: **never free a page the object's pointer might still
reference.** (The FTP `close()` stops the thread before unmapping, `ftp.cjs:236-262`;
ours additionally restores the pointer before unmapping.)

**Atomicity:** the swap/restore is a single 8-byte aligned store → atomic on aarch64,
so the pointer is never torn/half-written. Interception is strictly on or off.

**Crash / RPC-death accounting (honest):**
- **No persistent state is ever written** (no NAND/SD writes), so every failure mode
  below clears completely on reboot.
- If the session dies **after** the swap but **before** restore, the object's vtable
  pointer still points at our vtable/router, and our pages are **still mapped**
  (nobody unmapped them — we can't, and on a clean we restore *before* unmapping). The
  game keeps reading through the resident router until reboot. If the router was left
  `armed`, overrides keep applying; design choice to flag: whether to default the
  router to **passthrough-until-explicitly-armed** so a death leaves the game reading
  original bytes rather than a half-torn-down override. Recommended: yes.
- The one genuinely dangerous ordering — **freed pages + live pointer = dangling
  vtable = fs/system crash** — is excluded by the teardown order (restore before
  unmap) and by the fact that a dead RPC session cannot unmap anything, so it cannot
  produce the dangling case on its own. The only way to hit it is a buggy teardown
  that unmaps first; the implementation must make that ordering impossible (unmap is
  gated on a verified restore).
- A removal/restore IPC can itself fail; like Stage 3b we aggregate such errors and,
  critically, **do not unmap** if restore is unconfirmed — leaving interception
  resident-until-reboot (safe) rather than dangling (unsafe).
- Residual on crash, in full: one swapped data pointer in a heap object, our mapped
  code/data pages, and the open override/SD + original handles — all volatile, all
  gone on reboot, none persistent. Same "lives until reboot" character as the Stage 3b
  registrations, with the added, explicitly-managed rule that teardown order prevents
  the dangling-pointer crash.

**Pre-swap safety gate:** before arming, the router can be exercised read-only (Node
calls our `Read` via the same `rpc.call*` path used to start threads, against known
offsets, and compares to the Stage 3b PC result) so we validate the resident router
returns identical bytes to the PC `LayeredStorage` *before* any pointer is swapped
into the live object.

---

## 4. Open items to resolve during review (not decided here)

1. **Model A vs B (§1.4)** — settle via a read-only probe of whether the target title
   re-reads tables after a swap. Recommend shipping Model B first.
2. **Exact object + vtable geometry** — the romfs `IStorage` vtable signature, the
   `Read` slot index, and the reliable way to locate the live object for the attached
   title. Empirical, read-only to determine; must be pinned before any swap.
3. **Override handle strategy (§2.3)** — pre-opened vs on-demand.
4. **Passthrough-until-armed default (§3)** — recommended on.

Nothing in this document is implemented. Awaiting review before any code, injection,
or live test.
