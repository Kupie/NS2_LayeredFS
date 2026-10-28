'use strict';
// Stage 3: the layered storage object. Presents one virtual romfs image over the
// interval map from romfs-merge.buildLayout, routing each Read(offset, size) to the
// backing source(s): generated metadata (memory), the original storage, or an SD
// override reader. Read-only. Same { size, read(offset, size) } interface as every
// other reader, so the Stage 1 traverser can parse the image it produces.

const { parseOriginal, mergeOverrides, buildLayout } = require('./romfs-merge.cjs');

// Largest source index whose virtualOffset <= offset (binary search).
function lowerSourceIndex(sources, offset) {
  let lo = 0;
  let hi = sources.length; // first index with virtualOffset > offset
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sources[mid].virtualOffset <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

class LayeredStorage {
  constructor(originalReader, sources, imageSize) {
    this.original = originalReader;
    this.sources = sources;
    this.size = imageSize;
  }

  async read(offset, size) {
    if (offset < 0 || size < 0 || offset + size > this.size) {
      throw new Error(`read out of range: ${offset}+${size} > ${this.size}`);
    }
    const out = Buffer.alloc(size);
    let pos = offset;
    let written = 0;
    let i = Math.max(0, lowerSourceIndex(this.sources, pos));

    while (written < size) {
      // Skip sources that end at or before pos.
      while (i < this.sources.length && this.sources[i].virtualOffset + this.sources[i].size <= pos) i += 1;
      const s = this.sources[i];

      if (s && pos >= s.virtualOffset) {
        // pos is inside source s.
        const within = pos - s.virtualOffset;
        const n = Math.min(size - written, s.virtualOffset + s.size - pos);
        if (s.kind === 'memory') {
          s.data.copy(out, written, within, within + n);
        } else if (s.kind === 'original') {
          (await this.original.read(s.origOffset + within, n)).copy(out, written);
        } else {
          (await s.reader.read(within, n)).copy(out, written);
        }
        written += n;
        pos += n;
      } else {
        // Gap before the next source (or past the last): intentional romfs padding,
        // served as zeros. `out` is already zero-filled.
        const gapEnd = s ? s.virtualOffset : this.size;
        const n = Math.min(size - written, gapEnd - pos);
        written += n;
        pos += n;
      }
    }
    return out;
  }
}

// Convenience: original reader + overrides -> { storage, layout }.
async function buildLayeredStorage(originalReader, overrides = {}) {
  const root = await parseOriginal(originalReader);
  mergeOverrides(root, overrides);
  const layout = buildLayout(root);
  return { storage: new LayeredStorage(originalReader, layout.sources, layout.imageSize), layout };
}

module.exports = { LayeredStorage, buildLayeredStorage, lowerSourceIndex };
