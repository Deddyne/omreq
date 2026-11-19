// Reduces one recorded HTTP/3 connection (fixtures/http3-wire.mjs) to what a server observes
// and what must match real Chrome: the QUIC first flight, the unidirectional streams, the
// control stream and the request HEADERS. Per-connection randomness (GREASE values, connection
// IDs, stream IDs, the port in :authority) is reduced to its structure.
import {
  decodeFieldSection,
  isReserved,
  parseFrames,
  parseSettings,
  prefixInt,
  readVarint,
} from './qpack.mjs';
import { normalizedQuicInitial } from './quic-initial.mjs';

const FRAME_HEADERS = 0x01;
const FRAME_SETTINGS = 0x04;
const FRAME_PRIORITY_UPDATE = 0xf0700;
const STREAM_TYPES = { 0: 'control', 1: 'push', 2: 'qpack-encoder', 3: 'qpack-decoder' };

/** Concatenated bytes per stream of one fixture connection, in stream order. */
function streams(events, connection, kind) {
  const out = new Map();
  for (const e of events)
    if (e.connection === connection && e.event === kind && e.data)
      out.set(
        e.stream,
        Buffer.concat([out.get(e.stream) ?? Buffer.alloc(0), Buffer.from(e.data, 'hex')]),
      );
  return [...out.entries()].sort(([a], [b]) => a - b).map(([stream, data]) => ({ stream, data }));
}

/**
 * A QPACK decoder stream as the instructions about compared requests. A decoder stream that
 * only cancels other requests (Chrome cancels pending requests when it shuts down) is left out.
 */
function decoderStream({ data, offset }, position) {
  const instructions = [];
  let at = offset;
  while (at < data.length) {
    const byte = data[at];
    let kind, value;
    if (byte & 0x80) [kind, [value, at]] = ['section-ack', prefixInt(data, at, 7)];
    else if (byte & 0x40) [kind, [value, at]] = ['stream-cancellation', prefixInt(data, at, 6)];
    else [kind, [value, at]] = ['insert-count-increment', prefixInt(data, at, 6)];
    const request = kind === 'insert-count-increment' ? undefined : position.get(value / 4);
    if (kind === 'insert-count-increment' || request !== undefined)
      instructions.push({ kind, request });
  }
  return instructions.length ? { type: 'qpack-decoder', instructions } : null;
}

/** The datagrams one client sent; `from` and `to` bound the capture by index. */
export function clientDatagrams(datagrams, { from = 0, to = datagrams.length } = {}) {
  const slice = datagrams.slice(from, to);
  const client = slice[0]?.client;
  return slice
    .filter((d) => d.client === client)
    .map((d) => (Buffer.isBuffer(d.data) ? d.data : Buffer.from(d.data, 'hex')));
}

/** A request's HEADERS as a server's QPACK decoder sees them, with the port removed. */
export function normalizedFields(block) {
  return decodeFieldSection(block).map((field) =>
    field.name === ':authority'
      ? { ...field, value: field.value.replace(/:\d+$/, ':PORT') }
      : field,
  );
}

/**
 * Summarizes connection `connection` of a fixture capture, comparing only the requests whose
 * `:path` is listed in `paths`, in that order.
 */
export function summarizeHttp3({ events, datagrams }, connection, paths) {
  const requests = streams(events, connection, 'request').map(({ stream, data }) => {
    const { frames } = parseFrames(data);
    const index = frames.findIndex((f) => f.type === FRAME_HEADERS);
    if (index < 0) throw Error(`Request stream ${stream} has no HEADERS frame`);
    const headers = frames[index].payload;
    const fields = normalizedFields(headers);
    return {
      stream,
      path: fields.find((f) => f.name === ':path')?.value,
      // Frames before HEADERS (Chrome sends none) and the exact field section.
      before: frames.slice(0, index).map((f) => (isReserved(f.type) ? 'grease' : f.type)),
      headersHex: headers.toString('hex'),
      fields,
      body: frames.slice(index + 1).reduce((n, f) => n + (f.type === 0 ? f.payload.length : 0), 0),
    };
  });
  const compared = paths.map((path) => {
    const request = requests.find((r) => r.path === path);
    if (!request) throw Error(`No request for ${path} on connection ${connection}`);
    return request;
  });
  const position = new Map(compared.map((r, i) => [r.stream, i]));

  const uni = streams(events, connection, 'uni').map(({ data }) => {
    const [type, offset] = readVarint(data, 0);
    return {
      type: isReserved(type) ? 'grease' : (STREAM_TYPES[type] ?? `0x${type.toString(16)}`),
      data,
      offset,
    };
  });
  const control = uni.find((s) => s.type === 'control');
  if (!control) throw Error(`Connection ${connection} has no control stream`);
  const frames = parseFrames(control.data, control.offset).frames.flatMap((f) => {
    if (f.type === FRAME_SETTINGS)
      return [
        {
          type: 'settings',
          settings: parseSettings(f.payload).map(([id, value]) =>
            isReserved(id) ? 'grease' : [Number(id), Number(value)],
          ),
        },
      ];
    if (f.type === FRAME_PRIORITY_UPDATE) {
      const [stream, offset] = readVarint(f.payload, 0);
      // Stream IDs depend on which other requests the client made; keep only compared ones.
      const request = position.get(Number(stream) / 4);
      return request === undefined
        ? []
        : [
            {
              type: 'priority_update',
              request,
              value: f.payload.subarray(offset).toString('latin1'),
            },
          ];
    }
    if (isReserved(f.type)) return [{ type: 'grease', payloadBelow4: f.payload.length < 4 }];
    return [{ type: Number(f.type), length: f.payload.length }];
  });

  return {
    initial: normalizedQuicInitial(datagrams),
    uniStreams: uni
      .map((s) => (s.type === 'qpack-decoder' ? decoderStream(s, position) : s.type))
      .filter(Boolean),
    control: frames,
    requests: compared.map(({ stream: _, ...r }) => r),
  };
}
