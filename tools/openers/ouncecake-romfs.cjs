'use strict';
// Read-only romfs storage opener, delegated to OunceCake's EXISTING dump path.
//
// Stage 1 deliberately does not re-derive the handle-location / registry logic. It
// reuses OunceCake's established read-only opener (attachGame -> createGameFiles ->
// open({section:'romfs'})), which already restores whatever temporary state it
// touches. We only read from the handle it returns. Nothing here writes storage,
// patches memory, or alters a pointer beyond what OunceCake's own dump flow does.
//
// Point --ounce at a checked-out OunceCake repo; this requires its engine modules
// from there so there is a single source of truth for the console protocol.

const path = require('node:path');

async function openRomfsStorage({ ounce, run, title, storage, shouldStop = () => false }) {
  const engine = path.join(ounce, 'engine');
  const { attachGame } = require(path.join(engine, 'session.cjs'));
  const { createGameFiles } = require(path.join(engine, 'mounts.cjs'));
  const { discoverGames } = require(path.join(engine, 'content.cjs'));

  const attachment = await attachGame(run);
  let mount;
  try {
    // Resolve which storage medium the title lives on if the caller didn't say.
    let storages = storage != null ? [storage] : null;
    let resolvedTitle = title;
    if (!storages || !resolvedTitle) {
      const games = await discoverGames({ ...attachment, shouldStop });
      const game = resolvedTitle
        ? games.find((g) => g.title === resolvedTitle)
        : games[0];
      if (!game) throw new Error('title not found in library: ' + (resolvedTitle || '(none given)'));
      resolvedTitle = game.title;
      storages = storages || game.storages;
    }

    const files = createGameFiles(attachment);
    let lastError;
    for (const medium of storages) {
      try {
        mount = await files.open({ title: resolvedTitle, storage: medium, section: 'romfs' });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!mount) throw lastError || new Error('could not open romfs for ' + resolvedTitle);

    const { s, filesystem } = attachment;
    const reader = {
      size: mount.size,
      // Mirrors OunceCake's read path exactly; caps are enforced inside readStorage.
      read: (offset, size) => filesystem.readStorage(s, mount.handle, offset, size),
    };

    return {
      reader,
      info: { title: resolvedTitle, storage: mount.source?.storage, size: mount.size },
      close: async () => {
        try { await s.close(mount.handle); } finally { await attachment.close(); }
      },
    };
  } catch (error) {
    await attachment.close();
    throw error;
  }
}

module.exports = { openRomfsStorage };
