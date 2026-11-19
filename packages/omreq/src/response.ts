import { type Coding, decodeAll, decodeIterator, parseCodings } from './decode.js';
import { invalid, nativeError, OmreqError, positive } from './errors.js';
import { ResponseHeaders } from './headers.js';
import type { NativeOperation } from './native.js';
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output }
      | { readonly issues: readonly unknown[] }
      | Promise<{ readonly value: Output } | { readonly issues: readonly unknown[] }>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}
/** Protocol of the final response. HTTP/1.0 is accepted from legacy servers. */
export type HttpVersion = '1.0' | '1.1' | '2' | '3';
export interface ResponseMeta {
  status: number;
  url: string;
  httpVersion: HttpVersion;
  /** Pairs, or the native `name\0value\0…` form parsed on first use. */
  headers: string | [string, string][];
  redirects: RedirectHop[];
}
/**
 * Transparent decoding of the response body, set by the client only when the
 * request allows it and the response has a body that can carry a coding.
 */
export interface DecodeOptions {
  /** maxResponseBytes, applied to the decoded total as well. */
  readonly limit: number | null;
}
const NO_REDIRECTS: readonly RedirectHop[] = Object.freeze([]);
export interface RedirectHop {
  readonly status: number;
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly methodBefore: string;
  readonly methodAfter: string;
}
export type BodyState = 'unread' | 'reading' | 'consumed' | 'disposed' | 'errored';
// A response dropped without reading or dispose() would otherwise hold its
// operation slot until consumerIdleMs (forever with null). Collecting the
// response object cancels its operation.
const abandoned = new FinalizationRegistry<NativeOperation>((operation) => {
  operation.cancel('ERR_BODY_DISPOSED');
});
function decoderFor(label: string): TextDecoder | undefined {
  try {
    return new TextDecoder(label);
  } catch {
    return undefined;
  }
}
export class OmreqResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  readonly httpVersion: HttpVersion;
  readonly headers: ResponseHeaders;
  readonly originalHeaders: ResponseHeaders;
  readonly redirects: readonly RedirectHop[];
  /**
   * True when the body is transparently decoded from its Content-Encoding.
   * `headers` then omits Content-Encoding and Content-Length, which remain in
   * `originalHeaders`.
   */
  readonly decoded: boolean;
  readonly body: AsyncIterable<Uint8Array> & { toWebStream(): ReadableStream<Uint8Array> };
  #state: BodyState = 'unread';
  #used = false;
  #disposed: Promise<void> | undefined;
  // The whole body, when it arrived together with the headers. The native
  // operation has then already finished.
  #inline: Buffer | undefined;
  // Streams the body; absent when the whole body arrived with the headers.
  readonly #operation: NativeOperation | undefined;
  // Settles when native cleanup completes; undefined once already clean.
  readonly #cleanup: Promise<void> | undefined;
  // Codings to undo, in the order the server applied them.
  readonly #codings: readonly Coding[] | undefined;
  readonly #limit: number | null;
  constructor(
    meta: ResponseMeta,
    operation: NativeOperation | undefined,
    private readonly maxBuffered: number,
    private readonly onFinish: () => void,
    private readonly abortCause: () => unknown,
    cleanup: Promise<void> | undefined,
    inline?: Buffer,
    decode?: DecodeOptions,
  ) {
    this.#operation = operation;
    this.#cleanup = cleanup;
    this.#inline = inline;
    this.status = meta.status;
    this.ok = meta.status >= 200 && meta.status < 300;
    this.url = meta.url;
    this.redirects = meta.redirects.length
      ? Object.freeze(meta.redirects.map((hop) => Object.freeze({ ...hop })))
      : NO_REDIRECTS;
    this.httpVersion = meta.httpVersion;
    const headers = new ResponseHeaders(meta.headers);
    // Raw native headers are only parsed when a coding may be present.
    const codings =
      decode &&
      (typeof meta.headers !== 'string' ||
        meta.headers.startsWith('content-encoding\0') ||
        meta.headers.includes('\0content-encoding\0'))
        ? parseCodings(headers.get('content-encoding'))
        : undefined;
    this.#codings = codings;
    this.#limit = decode?.limit ?? null;
    this.decoded = codings !== undefined;
    this.originalHeaders = headers;
    this.headers = codings
      ? new ResponseHeaders(
          [...headers].filter(([n]) => n !== 'content-encoding' && n !== 'content-length'),
        )
      : headers;
    this.body = Object.freeze({
      [Symbol.asyncIterator]: () => this.#iterator(),
      toWebStream: () => this.#web(),
    });
    if (operation) abandoned.register(this, operation, this);
    Object.freeze(this);
  }
  #settled(): Promise<void> | undefined {
    const operation = this.#operation;
    if (!operation) return this.#cleanup;
    abandoned.unregister(this);
    return operation.cleaned() ? undefined : this.#cleanup;
  }
  #ended(state: BodyState): void {
    if (this.#state !== 'disposed') this.#state = state;
    this.onFinish();
  }
  #failure(error: unknown): OmreqError {
    const converted = nativeError(error);
    if (converted.code === 'ERR_ABORTED')
      return new OmreqError(converted.code, converted.phase, converted.message, {
        cause: this.abortCause(),
      });
    return converted;
  }
  get bodyState(): BodyState {
    return this.#state;
  }
  get bodyUsed(): boolean {
    return this.#used;
  }
  #claim(): void {
    if (this.#state === 'disposed')
      throw new OmreqError('ERR_BODY_DISPOSED', 'body', 'Response has been disposed');
    if (this.#used)
      throw new OmreqError('ERR_BODY_USED', 'body', 'Response body already has an owner');
    this.#used = true;
    this.#state = 'reading';
  }
  #iterator(): AsyncIterableIterator<Uint8Array> {
    const raw = this.#rawIterator();
    return this.#codings
      ? decodeIterator(raw, this.#codings, this.#limit, () => this.#ended('errored'))
      : raw;
  }
  #rawIterator(): AsyncIterableIterator<Uint8Array> {
    this.#claim();
    let ended = false;
    let pending = false;
    const next = async (): Promise<IteratorResult<Uint8Array>> => {
      if (ended) return { done: true, value: undefined };
      if (pending)
        throw new OmreqError('ERR_BODY_USED', 'body', 'Only one body read may be pending');
      pending = true;
      try {
        if (this.#state === 'disposed')
          throw new OmreqError('ERR_BODY_DISPOSED', 'body', 'Response has been disposed');
        const inline = this.#inline;
        this.#inline = undefined;
        if (inline !== undefined && inline.byteLength > 0) return { done: false, value: inline };
        const chunk = this.#operation ? await this.#operation.read() : null;
        if (chunk === null) {
          await this.#settled();
          ended = true;
          this.#ended('consumed');
          return { done: true, value: undefined };
        }
        return { done: false, value: chunk };
      } catch (error) {
        await this.#settled()?.catch(() => {});
        ended = true;
        this.#ended('errored');
        throw this.#failure(error);
      } finally {
        pending = false;
      }
    };
    return {
      next,
      return: async () => {
        ended = true;
        await this.dispose();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  #web(): ReadableStream<Uint8Array> {
    const iterator = this.#iterator();
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const result = await iterator.next();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          } catch (e) {
            controller.error(e);
          }
        },
        cancel: async () => {
          await iterator.return?.();
        },
      },
      { highWaterMark: 0 },
    );
  }
  async bytes(options: { maxBytes?: number } = {}): Promise<Uint8Array> {
    positive(options.maxBytes, 'maxBytes', false, Number.MAX_SAFE_INTEGER);
    const max = options.maxBytes ?? this.maxBuffered;
    this.#claim();
    const inline = this.#inline;
    if (inline !== undefined) {
      this.#inline = undefined;
      if (inline.byteLength > max) {
        this.#ended('errored');
        throw new OmreqError('ERR_RESOURCE_LIMIT', 'body', 'Buffered response byte limit exceeded');
      }
      await this.#settled();
      return this.#decoded(inline, max);
    }
    let out: Buffer;
    try {
      // One native call collects the rest of the body into a single buffer,
      // charged to the client's aggregate buffer budget while it is filled.
      out = await (this.#operation as NativeOperation).readAll(max);
      await this.#settled();
    } catch (error) {
      this.#operation?.cancel('ERR_BODY_DISPOSED');
      await this.#settled()?.catch(() => {});
      this.#ended('errored');
      throw this.#failure(error);
    }
    return this.#decoded(out, max);
  }
  /** Finishes a complete read; `max` bounds both the encoded and decoded body. */
  async #decoded(body: Buffer, max: number): Promise<Uint8Array> {
    if (this.#codings) {
      try {
        body = await decodeAll(body, this.#codings, Math.min(max, this.#limit ?? max));
      } catch (error) {
        this.#ended('errored');
        throw error;
      }
    }
    this.#ended('consumed');
    return body;
  }
  async text(
    options: { encoding?: string; fatal?: boolean; maxBytes?: number } = {},
  ): Promise<string> {
    // Resolve the decoder before consuming the body: an unsupported encoding
    // must not leave the caller with a body that can no longer be read.
    let decoder: TextDecoder | undefined;
    const fatal = options.fatal ?? false;
    if (options.encoding !== undefined) {
      try {
        decoder = new TextDecoder(options.encoding, { fatal });
      } catch {
        throw new OmreqError('ERR_DECODE', 'decode', 'Unsupported text encoding');
      }
    } else {
      const label = /charset\s*=\s*["']?([^\s;"']+)/i.exec(
        this.headers.get('content-type') ?? '',
      )?.[1];
      // An unknown charset in the response falls back to UTF-8, like browsers.
      const known = label === undefined ? undefined : decoderFor(label)?.encoding;
      decoder = new TextDecoder(known ?? 'utf-8', { fatal });
    }
    const bytes = await this.bytes(options);
    try {
      return decoder.decode(bytes);
    } catch (cause) {
      throw new OmreqError('ERR_DECODE', 'decode', 'Text decoding failed', { cause });
    }
  }
  async json(): Promise<unknown>;
  async json<S extends StandardSchemaV1>(
    schema: S,
  ): Promise<NonNullable<S['~standard']['types']>['output']>;
  async json(schema?: StandardSchemaV1): Promise<unknown> {
    if (
      schema !== undefined &&
      (schema?.['~standard']?.version !== 1 || typeof schema['~standard'].validate !== 'function')
    )
      invalid('Expected a Standard Schema v1 validator');
    const bytes = await this.bytes();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new OmreqError('ERR_DECODE', 'decode', 'JSON must contain valid UTF-8', { cause });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new OmreqError('ERR_JSON_PARSE', 'decode', 'Response does not contain valid JSON', {
        cause,
      });
    }
    if (schema === undefined) return value;
    try {
      const result = await schema['~standard'].validate(value);
      if ('issues' in result && result.issues !== undefined)
        throw new OmreqError(
          'ERR_SCHEMA_VALIDATION',
          'schema',
          'Response failed schema validation',
        );
      if (!('value' in result))
        throw new OmreqError('ERR_SCHEMA_VALIDATION', 'schema', 'Validator returned no output');
      return result.value;
    } catch (cause) {
      if (cause instanceof OmreqError) throw cause;
      throw new OmreqError('ERR_SCHEMA_VALIDATION', 'schema', 'Response schema validator failed', {
        cause,
      });
    }
  }
  dispose(): Promise<void> {
    if (this.#disposed) return this.#disposed;
    this.#inline = undefined;
    if (this.#state !== 'consumed' && this.#state !== 'errored') {
      this.#state = 'disposed';
      this.#operation?.cancel('ERR_BODY_DISPOSED');
    }
    this.#disposed = Promise.resolve(this.#settled()).then(() => this.onFinish());
    return this.#disposed;
  }
  /** `await using response = await client.get(url)` disposes an unread body. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}
