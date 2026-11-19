// QPACK (RFC 9204) and HTTP/3 frame helpers for the wire fixtures. Field sections are decoded
// without a dynamic table, which is what a peer that advertises no table capacity receives.

// biome-ignore format: generated table
const STATIC = [[":authority",""],[":path","/"],["age","0"],["content-disposition",""],["content-length","0"],["cookie",""],["date",""],["etag",""],["if-modified-since",""],["if-none-match",""],["last-modified",""],["link",""],["location",""],["referer",""],["set-cookie",""],[":method","CONNECT"],[":method","DELETE"],[":method","GET"],[":method","HEAD"],[":method","OPTIONS"],[":method","POST"],[":method","PUT"],[":scheme","http"],[":scheme","https"],[":status","103"],[":status","200"],[":status","304"],[":status","404"],[":status","503"],["accept","*/*"],["accept","application/dns-message"],["accept-encoding","gzip, deflate, br"],["accept-ranges","bytes"],["access-control-allow-headers","cache-control"],["access-control-allow-headers","content-type"],["access-control-allow-origin","*"],["cache-control","max-age=0"],["cache-control","max-age=2592000"],["cache-control","max-age=604800"],["cache-control","no-cache"],["cache-control","no-store"],["cache-control","public, max-age=31536000"],["content-encoding","br"],["content-encoding","gzip"],["content-type","application/dns-message"],["content-type","application/javascript"],["content-type","application/json"],["content-type","application/x-www-form-urlencoded"],["content-type","image/gif"],["content-type","image/jpeg"],["content-type","image/png"],["content-type","text/css"],["content-type","text/html; charset=utf-8"],["content-type","text/plain"],["content-type","text/plain;charset=utf-8"],["range","bytes=0-"],["strict-transport-security","max-age=31536000"],["strict-transport-security","max-age=31536000; includesubdomains"],["strict-transport-security","max-age=31536000; includesubdomains; preload"],["vary","accept-encoding"],["vary","origin"],["x-content-type-options","nosniff"],["x-xss-protection","1; mode=block"],[":status","100"],[":status","204"],[":status","206"],[":status","302"],[":status","400"],[":status","403"],[":status","421"],[":status","425"],[":status","500"],["accept-language",""],["access-control-allow-credentials","FALSE"],["access-control-allow-credentials","TRUE"],["access-control-allow-headers","*"],["access-control-allow-methods","get"],["access-control-allow-methods","get, post, options"],["access-control-allow-methods","options"],["access-control-expose-headers","content-length"],["access-control-request-headers","content-type"],["access-control-request-method","get"],["access-control-request-method","post"],["alt-svc","clear"],["authorization",""],["content-security-policy","script-src 'none'; object-src 'none'; base-uri 'none'"],["early-data","1"],["expect-ct",""],["forwarded",""],["if-range",""],["origin",""],["purpose","prefetch"],["server",""],["timing-allow-origin","*"],["upgrade-insecure-requests","1"],["user-agent",""],["x-forwarded-for",""],["x-frame-options","deny"],["x-frame-options","sameorigin"]];

// HPACK Huffman codes (RFC 7541 Appendix B) as hex code:bit length, by byte value.
const HUFFMAN =
  '1ff8:13,7fffd8:23,fffffe2:28,fffffe3:28,fffffe4:28,fffffe5:28,fffffe6:28,fffffe7:28,fffffe8:28,ffffea:24,3ffffffc:30,fffffe9:28,fffffea:28,3ffffffd:30,fffffeb:28,fffffec:28,fffffed:28,fffffee:28,fffffef:28,ffffff0:28,ffffff1:28,ffffff2:28,3ffffffe:30,ffffff3:28,ffffff4:28,ffffff5:28,ffffff6:28,ffffff7:28,ffffff8:28,ffffff9:28,ffffffa:28,ffffffb:28,14:6,3f8:10,3f9:10,ffa:12,1ff9:13,15:6,f8:8,7fa:11,3fa:10,3fb:10,f9:8,7fb:11,fa:8,16:6,17:6,18:6,0:5,1:5,2:5,19:6,1a:6,1b:6,1c:6,1d:6,1e:6,1f:6,5c:7,fb:8,7ffc:15,20:6,ffb:12,3fc:10,1ffa:13,21:6,5d:7,5e:7,5f:7,60:7,61:7,62:7,63:7,64:7,65:7,66:7,67:7,68:7,69:7,6a:7,6b:7,6c:7,6d:7,6e:7,6f:7,70:7,71:7,72:7,fc:8,73:7,fd:8,1ffb:13,7fff0:19,1ffc:13,3ffc:14,22:6,7ffd:15,3:5,23:6,4:5,24:6,5:5,25:6,26:6,27:6,6:5,74:7,75:7,28:6,29:6,2a:6,7:5,2b:6,76:7,2c:6,8:5,9:5,2d:6,77:7,78:7,79:7,7a:7,7b:7,7ffe:15,7fc:11,3ffd:14,1ffd:13,ffffffc:28,fffe6:20,3fffd2:22,fffe7:20,fffe8:20,3fffd3:22,3fffd4:22,3fffd5:22,7fffd9:23,3fffd6:22,7fffda:23,7fffdb:23,7fffdc:23,7fffdd:23,7fffde:23,ffffeb:24,7fffdf:23,ffffec:24,ffffed:24,3fffd7:22,7fffe0:23,ffffee:24,7fffe1:23,7fffe2:23,7fffe3:23,7fffe4:23,1fffdc:21,3fffd8:22,7fffe5:23,3fffd9:22,7fffe6:23,7fffe7:23,ffffef:24,3fffda:22,1fffdd:21,fffe9:20,3fffdb:22,3fffdc:22,7fffe8:23,7fffe9:23,1fffde:21,7fffea:23,3fffdd:22,3fffde:22,fffff0:24,1fffdf:21,3fffdf:22,7fffeb:23,7fffec:23,1fffe0:21,1fffe1:21,3fffe0:22,1fffe2:21,7fffed:23,3fffe1:22,7fffee:23,7fffef:23,fffea:20,3fffe2:22,3fffe3:22,3fffe4:22,7ffff0:23,3fffe5:22,3fffe6:22,7ffff1:23,3ffffe0:26,3ffffe1:26,fffeb:20,7fff1:19,3fffe7:22,7ffff2:23,3fffe8:22,1ffffec:25,3ffffe2:26,3ffffe3:26,3ffffe4:26,7ffffde:27,7ffffdf:27,3ffffe5:26,fffff1:24,1ffffed:25,7fff2:19,1fffe3:21,3ffffe6:26,7ffffe0:27,7ffffe1:27,3ffffe7:26,7ffffe2:27,fffff2:24,1fffe4:21,1fffe5:21,3ffffe8:26,3ffffe9:26,ffffffd:28,7ffffe3:27,7ffffe4:27,7ffffe5:27,fffec:20,fffff3:24,fffed:20,1fffe6:21,3fffe9:22,1fffe7:21,1fffe8:21,7ffff3:23,3fffea:22,3fffeb:22,1ffffee:25,1ffffef:25,fffff4:24,fffff5:24,3ffffea:26,7ffff4:23,3ffffeb:26,7ffffe6:27,3ffffec:26,3ffffed:26,7ffffe7:27,7ffffe8:27,7ffffe9:27,7ffffea:27,7ffffeb:27,ffffffe:28,7ffffec:27,7ffffed:27,7ffffee:27,7ffffef:27,7fffff0:27,3ffffee:26';

const tree = (() => {
  const root = {};
  HUFFMAN.split(',').forEach((entry, symbol) => {
    const [hex, length] = entry.split(':');
    const code = Number.parseInt(hex, 16);
    let node = root;
    for (let bit = Number(length) - 1; bit >= 0; bit--) {
      const side = Math.floor(code / 2 ** bit) % 2;
      if (bit === 0) node[side] = symbol;
      else {
        node[side] ??= {};
        node = node[side];
      }
    }
  });
  return root;
})();

export function huffmanDecode(bytes) {
  const out = [];
  let node = tree;
  for (const byte of bytes)
    for (let bit = 7; bit >= 0; bit--) {
      const next = node[(byte >> bit) & 1];
      if (next === undefined) return null;
      if (typeof next === 'number') {
        out.push(next);
        node = tree;
      } else node = next;
    }
  return Buffer.from(out).toString('latin1');
}

/** Reads a QUIC variable-length integer at `offset`; returns [value, next offset]. */
export function readVarint(bytes, offset) {
  if (offset >= bytes.length) throw RangeError('varint past the end');
  const first = bytes[offset];
  const length = 1 << (first >> 6);
  if (offset + length > bytes.length) throw RangeError('varint past the end');
  let value = BigInt(first & 0x3f);
  for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
  return [value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value, offset + length];
}

export function prefixInt(bytes, offset, bits) {
  const mask = (1 << bits) - 1;
  let value = bytes[offset] & mask;
  let next = offset + 1;
  if (value < mask) return [value, next];
  let shift = 0;
  for (;;) {
    const byte = bytes[next++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return [value, next];
  }
}

function prefixString(bytes, offset, bits) {
  const huffman = (bytes[offset] >> bits) & 1;
  const [length, start] = prefixInt(bytes, offset, bits);
  const raw = bytes.subarray(start, start + length);
  return [huffman ? huffmanDecode(raw) : raw.toString('latin1'), start + length, huffman === 1];
}

/**
 * Decodes a QPACK field section that only references the static table. Returns the fields with
 * the representation each one used, so encodings can be compared and not only the values.
 */
export function decodeFieldSection(block) {
  const bytes = Buffer.from(block);
  const [requiredInsertCount, afterCount] = prefixInt(bytes, 0, 8);
  const [base, start] = prefixInt(bytes, afterCount, 7);
  if (requiredInsertCount !== 0 || base !== 0) throw Error('dynamic table reference');
  const fields = [];
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (byte & 0x80) {
      if (!(byte & 0x40)) throw Error('dynamic table reference');
      let index;
      [index, offset] = prefixInt(bytes, offset, 6);
      const [name, value] = STATIC[index];
      fields.push({ name, value, kind: 'indexed', index });
    } else if (byte & 0x40) {
      if (!(byte & 0x10)) throw Error('dynamic table reference');
      const neverIndexed = (byte & 0x20) !== 0;
      let index, value, huffman;
      [index, offset] = prefixInt(bytes, offset, 4);
      [value, offset, huffman] = prefixString(bytes, offset, 7);
      fields.push({
        name: STATIC[index][0],
        value,
        kind: 'name-ref',
        index,
        huffman,
        neverIndexed,
      });
    } else if (byte & 0x20) {
      const neverIndexed = (byte & 0x10) !== 0;
      let name, value, nameHuffman, huffman;
      [name, offset, nameHuffman] = prefixString(bytes, offset, 3);
      [value, offset, huffman] = prefixString(bytes, offset, 7);
      fields.push({ name, value, kind: 'literal', nameHuffman, huffman, neverIndexed });
    } else throw Error('dynamic table reference');
  }
  return fields;
}

/** Splits HTTP/3 frames from `offset`. A trailing partial frame is returned as `rest`. */
export function parseFrames(data, offset = 0) {
  const bytes = Buffer.from(data);
  const frames = [];
  let next = offset;
  while (next < bytes.length) {
    const start = next;
    let type, length, body;
    try {
      [type, next] = readVarint(bytes, next);
      [length, body] = readVarint(bytes, next);
    } catch {
      return { frames, rest: bytes.subarray(start) };
    }
    if (body + Number(length) > bytes.length) return { frames, rest: bytes.subarray(start) };
    next = body + Number(length);
    frames.push({ type, payload: bytes.subarray(body, next), raw: bytes.subarray(start, next) });
  }
  return { frames, rest: Buffer.alloc(0) };
}

/** Parses a SETTINGS payload into [id, value] pairs in wire order. */
export function parseSettings(payload) {
  const settings = [];
  let offset = 0;
  while (offset < payload.length) {
    let id, value;
    [id, offset] = readVarint(payload, offset);
    [value, offset] = readVarint(payload, offset);
    settings.push([id, value]);
  }
  return settings;
}

/** Reserved ("GREASE") codepoints are 0x1f * N + 0x21 (RFC 9114 section 7.2.8). */
export const isReserved = (value) =>
  BigInt(value) >= 0x21n && (BigInt(value) - 0x21n) % 0x1fn === 0n;
