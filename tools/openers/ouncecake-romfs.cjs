'use strict';
// Read-only romfs storage opener. Uses ONLY OunceCake's published exports, so
// NS2_LayeredFS never requires a patched copy of OunceCake:
//
//   session.cjs : attachGame                                        (exported)
//   content.cjs : discoverGames, resolveProgramContent, discoverUpdates (exported)
//   protocol.cjs: pathRequest, success                              (exported)
//   program.cjs : createProgramMounts                               (exported)
//
// BASE (default): resolve the installed Program content's path, then
// OpenDataStorageByPath (cmd 206, type 1) on the FS root, GetSize (cmd 4), reads via
// readStorage. Plain read path; does NOT touch NPDM/access-control, does not mount
// exefs, modifies nothing.
//
// UPDATE (--update): obtain the title's COMPOSED/patched romfs (base + installed
// update, as the console serves it during play) by calling OunceCake's own,
// UNMODIFIED createProgramMounts(attachment).openUpdate({section:'romfs'}). Per the
// scope decision documented in README.md, that path is read-only and self-restoring
// but does temporarily read main.npdm + register/restore fah/fac access-control
// blobs, and may trigger the same legitimate license-presence check the system runs
// during normal play. No key/ticket is extracted, persisted, or modified. We only
// read from the handle it returns, then close it.

const path = require('node:path');

async function openRomfsStorage({ ounce, run, title, storage, update = false, shouldStop = () => false }) {
  const engine = path.join(ounce, 'engine');
  const { attachGame } = require(path.join(engine, 'session.cjs'));
  const { discoverGames, resolveProgramContent, discoverUpdates } = require(path.join(engine, 'content.cjs'));
  const { pathRequest, success } = require(path.join(engine, 'protocol.cjs'));

  const attachment = await attachGame(run);
  const { s, root, domain, filesystem, service } = attachment;
  let handle;

  // Open the title's COMPOSED update romfs via OunceCake's unmodified openUpdate.
  // Returns { handle, storage, version }. The thin glue here (resolve the update's
  // Program content + set runtimeProgramId via GetProgramId, cmd 618) mirrors what
  // OunceCake's internal createGameFiles.open() does before calling openUpdate;
  // the heavy lifting (patch compose, licenses, composed-romfs open) is all inside
  // openUpdate, called as-is.
  async function openUpdateRomfs(resolvedTitle, candidates) {
    const { createProgramMounts } = require(path.join(engine, 'program.cjs'));
    const updates = await discoverUpdates({ ...attachment, title: resolvedTitle });
    if (!updates.length) {
      throw new Error('no update is installed for ' + resolvedTitle + ' (nothing to compose; use base romfs)');
    }
    const newest = Math.max(...updates.map((u) => u.version));
    let picks = updates.filter((u) => u.version === newest);
    if (candidates) picks = [...picks].sort((a, b) => candidates.indexOf(a.storage) - candidates.indexOf(b.storage));

    const mounts = createProgramMounts(attachment);
    let lastError;
    for (const u of picks) {
      try {
        const source = await resolveProgramContent({
          s, domain, service, title: resolvedTitle, storage: u.storage,
          update: { contentTitle: u.contentTitle, version: u.version },
        });
        // GetProgramId of the selected NCA -> runtimeProgramId (openUpdate needs it).
        const filename = Buffer.alloc(0x301);
        filename.write(source.contentPath);
        await s.write(s.base + 0x2000, filename);
        const identity = success(
          await domain.send(s, 'Read selected NCA ProgramId', root, pathRequest(618, Buffer.from([source.attributes]), s.base + 0x2000)),
          'Read selected NCA ProgramId',
        );
        source.runtimeProgramId = identity.data.readBigUInt64LE().toString(16).padStart(16, '0');

        const h = await mounts.openUpdate({ title: resolvedTitle, storage: u.storage, attributes: source.attributes, source, section: 'romfs' });
        return { handle: h, storage: u.storage, version: u.version };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('could not open composed update romfs for ' + resolvedTitle);
  }

  try {
    // Resolve title + candidate storage media from the library if not pinned.
    let candidates = storage != null ? [storage] : null;
    let resolvedTitle = title;
    if (!candidates || !resolvedTitle) {
      const games = await discoverGames({ ...attachment, shouldStop });
      const game = resolvedTitle ? games.find((g) => g.title === resolvedTitle) : games[0];
      if (!game) throw new Error('title not found in library: ' + (resolvedTitle || '(none given)'));
      resolvedTitle = game.title;
      candidates = candidates || game.storages || [4, 5, 2];
    }

    let sourceStorage;
    let kind;

    if (update) {
      const opened = await openUpdateRomfs(resolvedTitle, candidates);
      handle = opened.handle;
      sourceStorage = opened.storage;
      kind = 'update';
    } else {
      // Resolve the base Program content on the first medium that has it.
      let source;
      let lastError;
      for (const medium of candidates) {
        try {
          source = await resolveProgramContent({ s, domain, service, title: resolvedTitle, storage: medium });
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!source) throw lastError || new Error('could not resolve program content for ' + resolvedTitle);

      // OpenDataStorageByPath(root, path=contentPath, {attributes, type:1}) -> storage.
      const filename = Buffer.alloc(0x301);
      filename.write(source.contentPath);
      await s.write(s.base + 0x2000, filename);
      const input = Buffer.alloc(8);
      input[0] = source.attributes;
      input.writeUInt32LE(1, 4); // content type 1 = base romfs
      let reply;
      try {
        reply = success(
          await domain.send(s, 'OpenDataStorageByPath', root, pathRequest(206, input, s.base + 0x2000)),
          'OpenDataStorageByPath',
        );
      } catch (error) {
        if (error.nativeResult?.canonical === 0x7d802) {
          error.message +=
            '\nThe title key is not registered with FS. Run OunceCake normally once for this ' +
            'title first (its prepareGame registers the installed license), then retry.';
        }
        throw error;
      }
      handle = domain.oneHandle(reply);
      sourceStorage = source.storage;
      kind = 'base';
    }

    const sizeReply = success(await s.ipc('Game storage size', handle, 4), 'Game storage size');
    const size = Number(sizeReply.data.readBigUInt64LE());

    const reader = {
      size,
      // Mirrors OunceCake's read path; per-call caps enforced inside readStorage.
      read: (offset, length) => filesystem.readStorage(s, handle, offset, length),
    };

    return {
      reader,
      info: { title: resolvedTitle, storage: sourceStorage, size, kind },
      close: async () => {
        try { if (handle != null) await s.close(handle); } finally { await attachment.close(); }
      },
    };
  } catch (error) {
    try { if (handle != null) await s.close(handle); } catch { /* ignore */ }
    await attachment.close();
    throw error;
  }
}

module.exports = { openRomfsStorage };
