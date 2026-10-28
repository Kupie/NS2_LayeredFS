'use strict';
// Read-only romfs storage opener.
//
// This reimplements, natively in this repo, the base-romfs case of OunceCake's
// internal createGameFiles.open({section:'romfs'}) using ONLY OunceCake's published
// exports, so NS2_LayeredFS never requires a patched copy of OunceCake:
//
//   session.cjs : attachGame                         (exported)
//   content.cjs : discoverGames, resolveProgramContent (exported)
//   protocol.cjs: pathRequest, success, resultError     (exported)
//
// The open is a plain read path: resolve the installed Program content's path, then
// OpenDataStorageByPath (cmd 206, type 1 = base romfs) on the FS root, GetSize
// (cmd 4), and reads via attachment.filesystem.readStorage. It does NOT go through
// openProgramRomfs/copyProgramRegistry (the access-control/pointer-swap path), does
// not mount exefs, and modifies nothing.

const path = require('node:path');

async function openRomfsStorage({ ounce, run, title, storage, shouldStop = () => false }) {
  const engine = path.join(ounce, 'engine');
  const { attachGame } = require(path.join(engine, 'session.cjs'));
  const { discoverGames, resolveProgramContent } = require(path.join(engine, 'content.cjs'));
  const { pathRequest, success } = require(path.join(engine, 'protocol.cjs'));

  const attachment = await attachGame(run);
  const { s, root, domain, filesystem, service } = attachment;
  let handle;
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

    const sizeReply = success(await s.ipc('Game storage size', handle, 4), 'Game storage size');
    const size = Number(sizeReply.data.readBigUInt64LE());

    const reader = {
      size,
      // Mirrors OunceCake's read path; per-call caps enforced inside readStorage.
      read: (offset, length) => filesystem.readStorage(s, handle, offset, length),
    };

    return {
      reader,
      info: { title: resolvedTitle, storage: source.storage, size },
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
