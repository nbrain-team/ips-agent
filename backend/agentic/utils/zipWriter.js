/**
 * Minimal ZIP writer (deflate, no zip64) with one streamed entry.
 *
 * An .xlsx is a ZIP of XML parts. The worksheet part for a large export is
 * tens of MB of XML; building it whole and handing it to a ZIP library holds
 * the XML and its copies in memory at once. Here the worksheet is deflated
 * chunk by chunk as it is generated, so memory is the compressed size plus
 * one chunk.
 */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc, buf) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Deflate an iterable of Buffers, returning { data, crc, size }. */
async function deflateChunks(chunks) {
  const deflate = zlib.createDeflateRaw({ level: 6 });
  const out = [];
  deflate.on('data', (b) => out.push(b));
  const done = new Promise((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  let crc = 0;
  let size = 0;
  for (const chunk of chunks) {
    crc = crc32Update(crc, chunk);
    size += chunk.length;
    if (!deflate.write(chunk)) await new Promise((r) => deflate.once('drain', r));
  }
  deflate.end();
  await done;
  return { data: Buffer.concat(out), crc, size };
}

/**
 * @param {Array<{ name: string, content?: Buffer, chunks?: Iterable<Buffer> }>} entries
 * @returns {Promise<Buffer>}
 */
async function writeZip(entries) {
  const { time, date } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { data, crc, size } = await deflateChunks(entry.chunks || [entry.content]);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

module.exports = { writeZip, crc32Update };
