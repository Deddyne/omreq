import { invalid, nativeError, OmreqError } from './errors.js';
import { blobChunks, prepareMultipart, snapshotBlob } from './multipart.js';
import type { NativeOperation } from './native.js';
export type UploadSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
export type BodyInput = string | ArrayBuffer | ArrayBufferView | Blob | FormData | UploadSource;
export interface PreparedBody {
  bytes?: Buffer;
  source?: UploadSource;
  replay?: () => UploadSource;
  contentLength?: number;
  retainedBytes?: number;
  contentType?: string;
  /** Multipart boundary of a FormData body, which an explicit content-type must carry. */
  boundary?: string;
}
export function prepareBody(
  body: BodyInput | undefined,
  budget: number,
  chunkBytes: number,
): PreparedBody {
  if (body === undefined) return {};
  if (typeof body === 'string') return { bytes: Buffer.from(body) };
  if (body instanceof Blob) {
    const blob = snapshotBlob(body);
    return {
      replay: () => blobChunks(blob, chunkBytes),
      contentLength: blob.size,
      ...(blob.type ? { contentType: blob.type } : {}),
    };
  }
  if (body instanceof FormData) return prepareMultipart(body, budget, chunkBytes);
  if (body instanceof ArrayBuffer) {
    try {
      return { bytes: Buffer.from(new Uint8Array(body)) };
    } catch {
      invalid('Detached body buffer');
    }
  }
  if (ArrayBuffer.isView(body)) {
    if (body.buffer instanceof SharedArrayBuffer)
      invalid('SharedArrayBuffer bodies are unsupported');
    try {
      return { bytes: Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
    } catch {
      invalid('Detached body buffer');
    }
  }
  if (
    body &&
    (typeof (body as ReadableStream<Uint8Array>).getReader === 'function' ||
      typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function')
  )
    return { source: body as UploadSource };
  invalid('Unsupported body source');
}
export interface UploadControl {
  stop(): void;
  cleanup(): Promise<void>;
}
export function startUpload(
  op: NativeOperation,
  prepared: PreparedBody,
  maxInputChunkBytes: number,
  onError: (error: unknown) => void,
): UploadControl {
  let stopped = false;
  let source = prepared.source;
  let replay = prepared.replay;
  type Reader = {
    next: () => Promise<IteratorResult<Uint8Array>>;
    cancel: () => Promise<unknown>;
    cleanup?: Promise<void>;
  };
  let reader: Reader | undefined;
  // Interrupts the one read in flight. Each read gets its own short-lived
  // promise: racing every read against long-lived stop/epoch promises (as
  // Promise.race does) attaches a reaction per read that JSC keeps alive with
  // its chunk, so Bun retained the whole uploaded body.
  let interrupt: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    interrupt?.();
  };
  const cleanupReader = (current: Reader | undefined): Promise<void> => {
    if (!current) return Promise.resolve();
    current.cleanup ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve()
            .then(current.cancel)
            .catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 100);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return current.cleanup;
  };
  let clean: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    stop();
    source = undefined;
    replay = undefined;
    clean ??= cleanupReader(reader).finally(() => {
      reader = undefined;
    });
    return clean;
  };
  // Native records an upload error when the final response arrived before
  // the source finished (the transport then aborts the body instead of
  // ending it cleanly); report it so the truncation is not silent.
  const onStopped = () => {
    const failure = op.uploadError();
    if (failure !== null) onError(nativeError(new Error(failure)));
    stop();
  };
  void op.waitUploadStopped().then(onStopped, onStopped);
  const acquire = (input: UploadSource): Reader => {
    if ('getReader' in input && typeof input.getReader === 'function') {
      const acquired = input.getReader();
      return {
        next: async () => {
          const result = await acquired.read();
          return result.done
            ? { done: true, value: undefined }
            : { done: false, value: result.value };
        },
        cancel: async () => {
          try {
            await acquired.cancel();
          } finally {
            acquired.releaseLock();
          }
        },
      };
    }
    const iterator = (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    let busy = 0;
    return {
      next: () => {
        busy++;
        return Promise.resolve(iterator.next()).finally(() => {
          busy--;
        });
      },
      cancel: () => {
        // An async generator queues return() behind a pending next(), so a
        // hung producer would never answer it. Request the close and wait only
        // when nothing is in flight; a queued close still runs once the
        // pending step settles.
        let closing: Promise<unknown>;
        try {
          closing = Promise.resolve(iterator.return?.()).catch(() => {});
        } catch {
          closing = Promise.resolve();
        }
        return busy ? Promise.resolve() : closing;
      },
    };
  };
  const pump = async () => {
    let epoch = 0;
    let hopEnded = false;
    let eof = false;
    let pending: Buffer | undefined;
    while (!stopped) {
      const demanded = await op.uploadDemand();
      if (!demanded || stopped) break;
      try {
        if (demanded !== epoch) {
          await cleanupReader(reader);
          reader = undefined;
          if (stopped) break;
          epoch = demanded;
          hopEnded = false;
          eof = false;
          pending = undefined;
          const watchedEpoch = epoch;
          void op.waitUploadEpochEnded(epoch).then(() => {
            if (epoch !== watchedEpoch) return;
            hopEnded = true;
            interrupt?.();
          });
          const input = replay ? replay() : source;
          source = undefined;
          if (!input)
            throw new OmreqError(
              'ERR_BODY_NOT_REPLAYABLE',
              'upload',
              'Upload source cannot be restarted',
            );
          reader = acquire(input);
        }
        if (hopEnded) continue;
        if (eof)
          throw new OmreqError(
            'ERR_UPLOAD_SOURCE',
            'upload',
            'Transport requested bytes after EOF',
          );
        let emptyChunks = 0;
        while (!pending?.length && !stopped && !hopEnded) {
          const activeReader = reader;
          if (!activeReader)
            throw new OmreqError('ERR_UPLOAD_SOURCE', 'upload', 'Upload reader is unavailable');
          const result = await new Promise<IteratorResult<Uint8Array> | undefined>(
            (resolve, reject) => {
              interrupt = () => resolve(undefined);
              Promise.resolve().then(activeReader.next).then(resolve, reject);
            },
          );
          interrupt = undefined;
          if (!result || stopped || hopEnded) break;
          if (result.done) {
            await op.uploadWrite(epoch, null, false);
            eof = true;
            await cleanupReader(reader);
            reader = undefined;
            break;
          }
          if (
            !(result.value instanceof Uint8Array) ||
            result.value.buffer instanceof SharedArrayBuffer
          )
            throw new OmreqError(
              'ERR_UPLOAD_SOURCE',
              'upload',
              'Upload chunks must be Uint8Array backed by ordinary memory',
            );
          if (result.value.byteLength > maxInputChunkBytes)
            throw new OmreqError(
              'ERR_RESOURCE_LIMIT',
              'upload',
              'Upload chunk exceeds maxInputChunkBytes',
            );
          if (!result.value.byteLength && ++emptyChunks > 256)
            throw new OmreqError(
              'ERR_UPLOAD_SOURCE',
              'upload',
              'Upload source returned too many empty chunks without progress',
            );
          // A zero-copy view: the native bridge copies the bytes before
          // uploadWrite settles, and the next chunk is requested only after
          // this one has been written. Producers must not mutate a chunk
          // after handing it over until their next read is requested.
          pending = Buffer.from(
            result.value.buffer,
            result.value.byteOffset,
            result.value.byteLength,
          );
        }
        if (stopped) break;
        if (hopEnded || eof) continue;
        if (!pending) continue;
        const size = Math.min(pending.length, 65536);
        if (!(await op.uploadWrite(epoch, pending.subarray(0, size), false))) {
          pending = undefined;
          await cleanupReader(reader);
          reader = undefined;
          continue;
        }
        pending = pending.subarray(size);
      } catch (error) {
        if (stopped) break;
        const code =
          error instanceof OmreqError && error.code === 'ERR_RESOURCE_LIMIT'
            ? 'ERR_RESOURCE_LIMIT'
            : 'ERR_UPLOAD_SOURCE';
        if (op.uploadFail(epoch, code)) {
          onError(error);
          break;
        }
        // The native redirect already ended this epoch. A late rejection or
        // malformed chunk belongs to that old attempt, never the next hop.
        pending = undefined;
        await cleanupReader(reader);
        reader = undefined;
      }
    }
  };
  void pump()
    .catch((error: unknown) => {
      if (stopped) return;
      onError(error);
      op.cancel(
        error instanceof OmreqError && error.code === 'ERR_RESOURCE_LIMIT'
          ? 'ERR_RESOURCE_LIMIT'
          : 'ERR_UPLOAD_SOURCE',
      );
    })
    .finally(() => {
      void cleanup();
    });
  return { stop, cleanup };
}
