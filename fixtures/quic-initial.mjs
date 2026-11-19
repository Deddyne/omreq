// Decrypts the client Initial packets of QUIC v1 (RFC 9001 section 5) captured by a local
// fixture and normalizes the first flight for comparison with real Chrome.
import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { normalizedClientHello, parseClientHello } from './clienthello.mjs';

const INITIAL_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');

const extract = (salt, key) => createHmac('sha256', salt).update(key).digest();
function expandLabel(secret, label, length) {
  const full = Buffer.from(`tls13 ${label}`);
  const info = Buffer.concat([
    Buffer.from([length >> 8, length & 255, full.length]),
    full,
    Buffer.from([0]),
  ]);
  const out = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    previous = createHmac('sha256', secret)
      .update(Buffer.concat([previous, info, Buffer.from([i])]))
      .digest();
    out.push(previous);
  }
  return Buffer.concat(out).subarray(0, length);
}

function clientKeys(dcid) {
  const secret = expandLabel(extract(INITIAL_SALT, dcid), 'client in', 32);
  return {
    key: expandLabel(secret, 'quic key', 16),
    iv: expandLabel(secret, 'quic iv', 12),
    hp: expandLabel(secret, 'quic hp', 16),
  };
}

function varint(bytes, offset) {
  const first = bytes[offset];
  const length = 1 << (first >> 6);
  let value = BigInt(first & 0x3f);
  for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
  return [value, offset + length];
}
const small = (value) => Number(value);

/** Decrypts every Initial packet in a datagram; other packet types are reported by type. */
export function decryptDatagram(datagram, originalDcid) {
  const packets = [];
  let offset = 0;
  while (offset < datagram.length) {
    const first = datagram[offset];
    if (!(first & 0x80)) {
      packets.push({ type: 'short' });
      break;
    }
    const version = datagram.readUInt32BE(offset + 1);
    const type = (first >> 4) & 3;
    let at = offset + 5;
    const dcid = datagram.subarray(at + 1, at + 1 + datagram[at]);
    at += 1 + dcid.length;
    const scid = datagram.subarray(at + 1, at + 1 + datagram[at]);
    at += 1 + scid.length;
    let tokenLength = 0n;
    if (type === 0) {
      [tokenLength, at] = varint(datagram, at);
      at += small(tokenLength);
    }
    const [length, payload] = varint(datagram, at);
    at = payload;
    const end = at + small(length);
    if (version !== 1 || type !== 0) {
      packets.push({ type: ['initial', '0rtt', 'handshake', 'retry'][type], version });
      offset = end;
      continue;
    }
    // Initial keys always come from the first Destination Connection ID the client chose.
    const keys = clientKeys(originalDcid ?? dcid);
    const sample = datagram.subarray(at + 4, at + 20);
    const mask = createCipheriv('aes-128-ecb', keys.hp, null).update(sample);
    const header = Buffer.from(datagram.subarray(offset, at + 4));
    header[0] ^= mask[0] & 0x0f;
    const pnLength = (header[0] & 3) + 1;
    let pn = 0;
    for (let i = 0; i < pnLength; i++) {
      header[at - offset + i] ^= mask[1 + i];
      pn = pn * 256 + header[at - offset + i];
    }
    const aad = header.subarray(0, at - offset + pnLength);
    const nonce = Buffer.from(keys.iv);
    for (let i = 0; i < 8; i++) nonce[11 - i] ^= Number((BigInt(pn) >> BigInt(8 * i)) & 0xffn);
    const body = datagram.subarray(at + pnLength, end);
    const decipher = createDecipheriv('aes-128-gcm', keys.key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([
      decipher.update(body.subarray(0, body.length - 16)),
      decipher.final(),
    ]);
    packets.push({
      type: 'initial',
      dcid: dcid.toString('hex'),
      scidLength: scid.length,
      tokenLength: small(tokenLength),
      packetNumber: pn,
      frames: parseFrames(plain),
    });
    offset = end;
  }
  return packets;
}

function parseFrames(plain) {
  const frames = [];
  let at = 0;
  while (at < plain.length) {
    const type = plain[at];
    if (type === 0x00) {
      let end = at;
      while (end < plain.length && plain[end] === 0) end++;
      frames.push({ type: 'padding', length: end - at });
      at = end;
    } else if (type === 0x01) {
      frames.push({ type: 'ping' });
      at++;
    } else if (type === 0x06) {
      let offset, length;
      [offset, at] = varint(plain, at + 1);
      [length, at] = varint(plain, at);
      frames.push({
        type: 'crypto',
        offset: small(offset),
        data: plain.subarray(at, at + small(length)),
      });
      at += small(length);
    } else if (type === 0x02 || type === 0x03) {
      // ACK: largest, delay, range count, first range, ranges, optional ECN counts.
      let count, value;
      [value, at] = varint(plain, at + 1);
      [value, at] = varint(plain, at);
      [count, at] = varint(plain, at);
      [value, at] = varint(plain, at);
      for (let i = 0n; i < count * 2n; i++) [value, at] = varint(plain, at);
      if (type === 0x03) for (let i = 0; i < 3; i++) [value, at] = varint(plain, at);
      void value;
      frames.push({ type: 'ack' });
    } else if (type === 0x1c) {
      frames.push({ type: 'connection_close' });
      break;
    } else throw Error(`Unexpected frame 0x${type.toString(16)} in an Initial packet`);
  }
  return frames;
}

/**
 * The client's first flight: the datagrams of one connection up to the one that completes the
 * ClientHello, with the reassembled ClientHello.
 */
export function firstFlight(datagrams) {
  const flight = [];
  const pieces = new Map();
  let dcid;
  for (const datagram of datagrams) {
    if (!(datagram[0] & 0x80) || ((datagram[0] >> 4) & 3) !== 0) continue;
    const own = datagram.subarray(6, 6 + datagram[5]);
    dcid ??= Buffer.from(own);
    // A new DCID means the server answered; the first flight is over.
    if (!own.equals(dcid)) break;
    const packets = decryptDatagram(datagram, dcid);
    const initial = packets.find((p) => p.type === 'initial');
    flight.push({ size: datagram.length, packets });
    for (const frame of initial.frames)
      if (frame.type === 'crypto') pieces.set(frame.offset, frame.data);
    let assembled = Buffer.alloc(0);
    while (pieces.has(assembled.length))
      assembled = Buffer.concat([assembled, pieces.get(assembled.length)]);
    if (assembled.length >= 4 && assembled.length >= assembled.readUIntBE(1, 3) + 4) {
      const record = Buffer.concat([
        Buffer.from([0x16, 0x03, 0x01, assembled.length >> 8, assembled.length & 255]),
        assembled,
      ]);
      return { flight, clientHello: assembled, hello: parseClientHello(record) };
    }
  }
  throw Error('No complete ClientHello in the captured Initial packets');
}

const PARAMETER_NAMES = {
  1: 'max_idle_timeout',
  3: 'max_udp_payload_size',
  4: 'initial_max_data',
  5: 'initial_max_stream_data_bidi_local',
  6: 'initial_max_stream_data_bidi_remote',
  7: 'initial_max_stream_data_uni',
  8: 'initial_max_streams_bidi',
  9: 'initial_max_streams_uni',
  10: 'ack_delay_exponent',
  11: 'max_ack_delay',
  12: 'disable_active_migration',
  14: 'active_connection_id_limit',
  15: 'initial_source_connection_id',
  17: 'version_information',
  32: 'max_datagram_frame_size',
  10930: 'grease_quic_bit',
  12584: 'google_connection_options',
};
const isGreaseVersion = (v) => (v & 0x0f0f0f0f) === 0x0a0a0a0a;

/** QUIC transport parameters with random parts reduced to their observable structure. */
export function normalizedTransportParameters(hex) {
  const bytes = Buffer.from(hex, 'hex');
  const parameters = [];
  let at = 0;
  while (at < bytes.length) {
    let id, length;
    [id, at] = varint(bytes, at);
    [length, at] = varint(bytes, at);
    const value = bytes.subarray(at, at + small(length));
    at += small(length);
    if (id >= 27n && (id - 27n) % 31n === 0n) {
      parameters.push({ name: 'grease', lengthBelow16: value.length < 16 });
      continue;
    }
    const name = PARAMETER_NAMES[small(id)] ?? `0x${id.toString(16)}`;
    if (name === 'version_information') {
      const versions = [];
      for (let i = 0; i < value.length; i += 4) versions.push(value.readUInt32BE(i));
      const available = versions.slice(1);
      parameters.push({
        name,
        chosen: versions[0],
        available: available.filter((v) => !isGreaseVersion(v)),
        greaseVersions: available.filter(isGreaseVersion).length,
      });
    } else if (name === 'initial_source_connection_id' || name.startsWith('0x'))
      parameters.push({
        name,
        length: value.length,
        ...(name.startsWith('0x') && { hex: value.toString('hex') }),
      });
    else if (name === 'google_connection_options')
      parameters.push({ name, hex: value.toString('hex') });
    else if (value.length === 0) parameters.push({ name });
    else parameters.push({ name, value: varint(value, 0)[0].toString() });
  }
  return parameters.sort((a, b) => a.name.localeCompare(b.name));
}

/** The first flight reduced to what must match Chrome, independent of per-connection randomness. */
export function normalizedQuicInitial(datagrams) {
  const { flight, hello } = firstFlight(datagrams);
  const initials = flight.map((d) => d.packets.find((p) => p.type === 'initial'));
  const crypto = initials.flatMap((p) => p.frames.filter((f) => f.type === 'crypto'));
  const normalized = normalizedClientHello(hello);
  normalized.extensions = normalized.extensions.map((e) =>
    e.id === 57 ? { id: 57, parameters: normalizedTransportParameters(e.hex) } : e,
  );
  const firstFrames = initials[0].frames.filter((f) => f.type === 'crypto');
  const total = hello.clientHelloBytes;
  return {
    datagrams: flight.length,
    datagramSizes: [...new Set(flight.map((d) => d.size))],
    dcidLength: initials[0].dcid.length / 2,
    scidLength: initials[0].scidLength,
    tokenLength: initials[0].tokenLength,
    chaos: {
      // MultiPacketChaosProtect: the first packet carries the start and the end.
      firstPacketHasHeadAndTail:
        flight.length > 1
          ? firstFrames.some((f) => f.offset === 0) &&
            firstFrames.some((f) => f.offset + f.data.length === total)
          : null,
      pings: initials.every((p) => p.frames.some((f) => f.type === 'ping')),
      splitCrypto: crypto.length > flight.length,
      spreadPadding: initials.every(
        (p) => p.frames.filter((f) => f.type === 'padding').length > 1 || p.frames.length < 3,
      ),
    },
    clientHello: normalized,
  };
}
