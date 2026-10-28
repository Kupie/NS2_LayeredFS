'use strict';
// Byte-reader abstraction: everything that supplies bytes to the layered storage
// implements { size, async read(offset, size) -> Buffer-of-exactly-size }.
//
// This is the single interface the whole project speaks: the Stage 1 console
// storage reader, the synthetic in-memory romfs, SD override files, and the Stage 3
// LayeredStorage itself all satisfy it, so they compose freely and the module is
// testable on a PC with no console.

const fs = require('node:fs');

// In-memory reader over a Buffer.
function bufferReader(buf) {
  return {
    size: buf.length,
    async read(offset, size) {
      if (offset < 0 || size < 0 || offset + size > buf.length) {
        throw new Error(`read out of range: ${offset}+${size} > ${buf.length}`);
      }
      return Buffer.from(buf.subarray(offset, offset + size));
    },
  };
}

// File-backed reader (for SD override files on a PC). Opens per read; fine for the
// modest read volume here and keeps no fd open across the build.
function fileReader(path) {
  const size = fs.statSync(path).size;
  return {
    size,
    async read(offset, length) {
      const out = Buffer.alloc(length);
      const fd = fs.openSync(path, 'r');
      try {
        let got = 0;
        while (got < length) {
          const n = fs.readSync(fd, out, got, length - got, offset + got);
          if (n === 0) throw new Error(`short read at ${offset + got} of ${path}`);
          got += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      return out;
    },
  };
}

// Wrap a reader so no single underlying read exceeds `maxChunk` bytes, while still
// returning the full requested range. Needed when the backing reader has a per-call
// transfer cap (the console storage reader caps at 0x40000), since a consumer like
// LayeredStorage may ask for a larger contiguous range from one source.
function chunkedReader(reader, maxChunk = 0x40000) {
  return {
    size: reader.size,
    async read(offset, size) {
      if (size <= maxChunk) return reader.read(offset, size);
      const out = Buffer.alloc(size);
      for (let at = 0; at < size; at += maxChunk) {
        const n = Math.min(maxChunk, size - at);
        (await reader.read(offset + at, n)).copy(out, at);
      }
      return out;
    },
  };
}

module.exports = { bufferReader, fileReader, chunkedReader };
