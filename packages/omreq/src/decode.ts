import { constants as bufferConstants } from 'node:buffer';
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream';
import zlib from 'node:zlib';
import { OmreqError } from './errors.js';

/** Content codings decoded transparently; zstd only where the runtime has it. */
export type Coding = 'gzip' | 'deflate' | 'br' | 'zstd';
const MAX_CODINGS = 2;
const hasZstd =
  typeof zlib.zstdDecompress === 'function' && typeof zlib.createZstdDecompress === 'function';
// Chrome caps the zstd window at 8 MiB (windowLog 23) for HTTP content.
const zstdOptions = (): zlib.ZstdOptions => ({
  params: { [zlib.constants.ZSTD_d_windowLogMax]: 23 },
});
export const SUPPORTED_CODINGS: readonly Coding[] = Object.freeze(
  hasZstd ? ['gzip', 'deflate', 'br', 'zstd'] : ['gzip', 'deflate', 'br'],
);
/**
 * The codings to undo, in the order they were applied, or undefined when the
 * body must stay as received: no coding, an unknown coding, or a longer chain
 * than the decoder accepts.
 */
export function parseCodings(header: string | null): Coding[] | undefined {
  if (!header) return undefined;
  const codings: Coding[] = [];
  for (const raw of header.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token === '' || token === 'identity') continue;
    const coding = token === 'x-gzip' ? 'gzip' : token;
    if (!(SUPPORTED_CODINGS as readonly string[]).includes(coding)) return undefined;
    codings.push(coding as Coding);
  }
  return codings.length && codings.length <= MAX_CODINGS ? codings : undefined;
}
function decodeFailure(cause: unknown): OmreqError {
  if (cause instanceof OmreqError) return cause;
  if ((cause as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE')
    return new OmreqError('ERR_RESOURCE_LIMIT', 'body', 'Decoded response byte limit exceeded', {
      cause,
    });
  return new OmreqError('ERR_DECODE', 'decode', 'Content-Encoding decoding failed', { cause });
}
// HTTP `deflate` is the zlib format (RFC 9110), but some servers send raw
// DEFLATE; like browsers, both are accepted. A zlib stream starts with a CMF
// byte for method 8 and a header checksum divisible by 31.
function zlibWrapped(head: Uint8Array): boolean {
  const cmf = head[0] as number;
  const flg = head[1] as number;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
}
type Decompress = (input: Uint8Array, options: zlib.ZlibOptions) => Promise<Buffer>;
const run = (
  fn: (buf: Uint8Array, options: object, cb: (error: Error | null, out: Buffer) => void) => void,
  input: Uint8Array,
  options: object,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    fn(input, options, (error, out) => (error ? reject(error) : resolve(out)));
  });
const whole: Record<Coding, Decompress> = {
  gzip: (input, options) => run(zlib.gunzip, input, options),
  deflate: (input, options) =>
    run(
      input.byteLength < 2 || zlibWrapped(input) ? zlib.inflate : zlib.inflateRaw,
      input,
      options,
    ),
  br: (input, options) => run(zlib.brotliDecompress, input, options),
  zstd: (input, options) =>
    run(
      zlib.zstdDecompress as unknown as Parameters<typeof run>[0],
      input,
      Object.assign(zstdOptions(), options),
    ),
};
/** Decodes a complete body; at most `maxBytes` decoded bytes are produced. */
export async function decodeAll(
  input: Uint8Array,
  codings: readonly Coding[],
  maxBytes: number,
): Promise<Buffer> {
  let out = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    for (let i = codings.length - 1; i >= 0; i--) {
      // An empty body with a Content-Encoding is empty, as in browsers.
      if (out.byteLength === 0) break;
      out = await whole[codings[i] as Coding](out, {
        maxOutputLength: Math.min(maxBytes, bufferConstants.MAX_LENGTH),
      });
    }
  } catch (error) {
    throw decodeFailure(error);
  }
  if (out.byteLength > maxBytes)
    throw new OmreqError('ERR_RESOURCE_LIMIT', 'body', 'Decoded response byte limit exceeded');
  return out;
}
/**
 * Inflate that picks the zlib or raw DEFLATE format from the first two bytes
 * and keeps the inner stream's backpressure.
 */
class AutoInflate extends Transform {
  #inner: zlib.Inflate | zlib.InflateRaw | undefined;
  #head: Buffer = Buffer.alloc(0);
  #start(head: Buffer): zlib.Inflate | zlib.InflateRaw {
    const inner =
      head.byteLength < 2 || zlibWrapped(head) ? zlib.createInflate() : zlib.createInflateRaw();
    inner.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) inner.pause();
    });
    inner.on('error', (error) => this.destroy(error));
    this.#inner = inner;
    return inner;
  }
  override _read(size: number): void {
    this.#inner?.resume();
    super._read(size);
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let inner = this.#inner;
    if (!inner) {
      this.#head = Buffer.concat([this.#head, chunk]);
      if (this.#head.byteLength < 2) {
        callback();
        return;
      }
      chunk = this.#head;
      this.#head = Buffer.alloc(0);
      inner = this.#start(chunk);
    }
    if (inner.write(chunk)) callback();
    else inner.once('drain', () => callback());
  }
  override _flush(callback: TransformCallback): void {
    let inner = this.#inner;
    if (!inner) {
      if (!this.#head.byteLength) {
        callback();
        return;
      }
      inner = this.#start(this.#head);
      inner.write(this.#head);
    }
    inner.once('end', () => callback());
    inner.end();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#inner?.destroy();
    callback(error);
  }
}
function decoder(coding: Coding): Transform {
  switch (coding) {
    case 'gzip':
      return zlib.createGunzip();
    case 'deflate':
      return new AutoInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case 'zstd':
      return zlib.createZstdDecompress(zstdOptions()) as unknown as Transform;
  }
}
/**
 * Decodes a body iterator incrementally. The pipeline is built on the first
 * read; `limit` (maxResponseBytes) bounds the decoded total. Returning or
 * failing destroys the pipeline, which returns the raw iterator.
 */
export function decodeIterator(
  raw: AsyncIterableIterator<Uint8Array>,
  codings: readonly Coding[],
  limit: number | null,
  onError: () => void,
): AsyncIterableIterator<Uint8Array> {
  let output: AsyncIterator<Buffer> | undefined;
  let last: Transform | undefined;
  let total = 0;
  let ended = false;
  let pending = false;
  // An empty body with a Content-Encoding is empty, as in browsers; the
  // decoders would report it as truncated. Bytes are inspected as they pass.
  let sawBytes = false;
  const start = (): AsyncIterator<Buffer> => {
    const source = Readable.from(
      (async function* () {
        for (;;) {
          const result = await raw.next();
          if (result.done) return;
          if (result.value.byteLength) sawBytes = true;
          yield result.value;
        }
      })(),
      { objectMode: false, highWaterMark: 65536 },
    );
    source.on('close', () => {
      // Readable.from returns its own generator, not `raw`; dispose the body
      // when the pipeline is torn down before EOF.
      void raw.return?.();
    });
    const stages: Transform[] = [];
    for (let i = codings.length - 1; i >= 0; i--) stages.push(decoder(codings[i] as Coding));
    last = stages.at(-1) as Transform;
    (pipeline as (...streams: unknown[]) => unknown)(source, ...stages, () => {});
    return last[Symbol.asyncIterator]();
  };
  const finish = () => {
    ended = true;
    last?.destroy();
  };
  const next = async (): Promise<IteratorResult<Uint8Array>> => {
    if (ended) return { done: true, value: undefined };
    if (pending) throw new OmreqError('ERR_BODY_USED', 'body', 'Only one body read may be pending');
    pending = true;
    try {
      output ??= start();
      let result: IteratorResult<Buffer>;
      try {
        result = await output.next();
      } catch (error) {
        if (!sawBytes && !(error instanceof OmreqError)) result = { done: true, value: undefined };
        else throw error;
      }
      if (result.done) {
        ended = true;
        return { done: true, value: undefined };
      }
      total += result.value.byteLength;
      if (limit !== null && total > limit)
        throw new OmreqError('ERR_RESOURCE_LIMIT', 'body', 'Decoded response byte limit exceeded');
      return { done: false, value: result.value };
    } catch (error) {
      finish();
      onError();
      throw decodeFailure(error);
    } finally {
      pending = false;
    }
  };
  return {
    next,
    return: async () => {
      finish();
      await raw.return?.();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
