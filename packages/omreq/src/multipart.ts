import { randomBytes } from 'node:crypto';
import { invalid, OmreqError } from './errors.js';

const slice = Blob.prototype.slice;
const arrayBuffer = Blob.prototype.arrayBuffer;
const blobType = Object.getOwnPropertyDescriptor(Blob.prototype, 'type')?.get;
export function snapshotBlob(blob: Blob): Blob {
  const type: unknown = blobType?.call(blob);
  if (typeof type !== 'string') invalid('Unsupported Blob implementation');
  return slice.call(blob, 0, undefined, type);
}
export async function* blobChunks(blob: Blob, chunkBytes: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += chunkBytes)
    yield new Uint8Array(await arrayBuffer.call(slice.call(blob, offset, offset + chunkBytes)));
}
function limit(message: string): never {
  throw new OmreqError('ERR_RESOURCE_LIMIT', 'queue', message);
}
function escapeParameter(value: string): string {
  return value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
}
function normalizedSize(value: string): number {
  let bytes = Buffer.byteLength(value);
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\r') {
      if (value[i + 1] === '\n') i++;
      else bytes++;
    } else if (value[i] === '\n') bytes++;
  }
  return bytes;
}
export function prepareMultipart(form: FormData, budget: number, chunkBytes: number) {
  const boundary = `----omreq-${randomBytes(24).toString('hex')}`;
  const parts: { header: string; body: string | Blob }[] = [];
  const ending = `--${boundary}--\r\n`;
  let metadata = Buffer.byteLength(ending);
  let retainedBytes = metadata;
  let contentLength = metadata;
  for (const [name, value] of FormData.prototype.entries.call(form)) {
    if (parts.length >= 1000) limit('Multipart supports at most 1000 parts');
    // Reject oversized names before escaping/allocating their encoded representation.
    if (Buffer.byteLength(name) > 65536) limit('Multipart metadata exceeds 64 KiB');
    let disposition = `Content-Disposition: form-data; name="${escapeParameter(name)}"`;
    let body: string | Blob;
    let bytes: number;
    if (typeof value === 'string') {
      body = value;
      bytes = normalizedSize(value);
    } else if (value instanceof Blob) {
      body = snapshotBlob(value);
      const filename = typeof value.name === 'string' ? value.name : 'blob';
      if (Buffer.byteLength(filename) > 65536) limit('Multipart filename exceeds 64 KiB');
      // Only '/' separates paths on the supported (POSIX) platforms; a backslash is a
      // legitimate filename character there.
      const basename = filename.slice(filename.lastIndexOf('/') + 1);
      disposition += `; filename="${escapeParameter(basename)}"\r\nContent-Type: ${body.type || 'application/octet-stream'}`;
      bytes = body.size;
    } else invalid('FormData parts must be strings or Blob/File values');
    const header = `--${boundary}\r\n${disposition}\r\n\r\n`;
    const overhead = Buffer.byteLength(header) + 2;
    metadata += overhead;
    if (metadata > 65536) limit('Multipart metadata exceeds 64 KiB');
    retainedBytes += overhead + (typeof body === 'string' ? bytes : 0);
    if (retainedBytes > budget) limit('Retained multipart byte budget exceeded');
    contentLength += overhead + bytes;
    if (!Number.isSafeInteger(contentLength)) limit('Multipart content length exceeds safe range');
    parts.push({ header, body });
  }
  if (retainedBytes > budget) limit('Retained multipart byte budget exceeded');
  // All bounds are checked before allocating owned UTF-8 buffers. Blob payloads
  // remain immutable external sources and are read only on transport demand.
  const encoded = parts.map(({ header, body }) => ({
    header: Buffer.from(header),
    body: typeof body === 'string' ? Buffer.from(body.replace(/\r\n|\r|\n/g, '\r\n')) : body,
  }));
  const end = Buffer.from(ending);
  const crlf = Buffer.from('\r\n');
  const chunks = async function* () {
    const emit = function* (bytes: Buffer) {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes)
        yield bytes.subarray(offset, offset + chunkBytes);
    };
    for (const part of encoded) {
      yield* emit(part.header);
      if (part.body instanceof Blob) yield* blobChunks(part.body, chunkBytes);
      else yield* emit(part.body);
      yield* emit(crlf);
    }
    yield* emit(end);
  };
  return {
    replay: chunks,
    retainedBytes,
    contentLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary,
  };
}
