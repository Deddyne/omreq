export type ErrorPhase =
  | 'configuration'
  | 'native-load'
  | 'initialization'
  | 'queue'
  | 'connect'
  | 'proxy'
  | 'tls'
  | 'upload'
  | 'headers'
  | 'body'
  | 'decode'
  | 'schema'
  | 'shutdown';
export class OmreqError extends Error {
  readonly brand = 'omreq.error.v1';
  constructor(
    readonly code: string,
    readonly phase: ErrorPhase,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OmreqError';
  }
}
export function isOmreqError(error: unknown): error is OmreqError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'brand' in error &&
    error.brand === 'omreq.error.v1'
  );
}
export function nativeError(error: unknown): OmreqError {
  if (isOmreqError(error)) return error;
  if (error instanceof Error) {
    try {
      const data: unknown = JSON.parse(error.message);
      if (
        data &&
        typeof data === 'object' &&
        'code' in data &&
        'phase' in data &&
        'message' in data &&
        typeof data.code === 'string' &&
        typeof data.phase === 'string' &&
        typeof data.message === 'string'
      )
        return new OmreqError(data.code, data.phase as ErrorPhase, data.message, { cause: error });
    } catch {
      /* Native linker errors are classified by the loader. */
    }
  }
  // Anything else is a JavaScript-side failure (a TypeError from a bad
  // argument, a RangeError, a bug), not a transport error from the server.
  return new OmreqError(
    'ERR_INTERNAL',
    'configuration',
    error instanceof Error ? error.message : 'Operation failed',
    { cause: error },
  );
}
export function invalid(message: string): never {
  throw new OmreqError('ERR_INVALID_ARGUMENT', 'configuration', message);
}
export function keys(value: object, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(`${path}.${key}: unknown option`);
}
export function positive(
  value: unknown,
  path: string,
  nullable = false,
  max = 2147483647,
): asserts value is number | null | undefined {
  if (value === undefined || (value === null && nullable)) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max)
    invalid(`${path}: expected a positive integer${nullable ? ' or null' : ''}`);
}
