import {
  createClient,
  type HttpVersion,
  type StandardSchemaV1,
} from '../packages/omreq/dist/index.js';
const schema: StandardSchemaV1<unknown, { id: number }> = {
  '~standard': {
    version: 1,
    vendor: 'type-test',
    validate: () => ({ value: { id: 1 } }),
  },
};
async function checkPublicTypes() {
  const client = createClient();
  const limits = client.getStats();
  const active: number = limits.activeOperations;
  const connections: number | null = limits.connections;
  void active; void connections;
  // @ts-expect-error Stats snapshots are immutable.
  limits.origins.push({});
  createClient({ maxActivePerOrigin: 4, maxAggregateBufferedResponseBytes: 1024 });
  createClient({ cookies: false });
  await client.post('https://example.invalid', { body: new FormData() });
  await client.post('https://example.invalid', { body: new Blob(['streamed']) });
  await client.cookies.setCookie('name=value; Secure', 'https://example.invalid');
  const records = await client.cookies.getCookies(new URL('https://example.invalid'));
  const expiry: number | null | undefined = records[0]?.expiresAt;
  void expiry;
  // @ts-expect-error Cookie snapshots are immutable.
  records.push({});
  // @ts-expect-error Cookie records are immutable.
  if (records[0]) records[0].value = 'changed';
  const response = await client.get('https://example.invalid');
  const transformed: { id: number } = await response.json(schema);
  void transformed;
  const redirected = await client.get('https://example.invalid', {
    redirect: 'manual',
    sensitiveHeaders: ['x-api-key'] as const,
    maxRedirects: 3,
  });
  const previousMethod: string | undefined = redirected.redirects[0]?.methodBefore;
  void previousMethod;
  // @ts-expect-error Redirect history is immutable.
  redirected.redirects.push({});
  // @ts-expect-error Individual history records are immutable.
  if (redirected.redirects[0]) redirected.redirects[0].status = 200;
  // @ts-expect-error Redirect policy is a finite set.
  createClient({ redirect: 'automatic' });
  // @ts-expect-error Unvalidated JSON remains unknown.
  const invalid: { id: number } = await response.json();
  void invalid;
  // @ts-expect-error Convenience methods own their method.
  await client.get('https://example.invalid', { method: 'POST' });
  await client.get('https://example.invalid', { headers: new Headers({ authorization: 'x' }) });
  await client.get('https://example.invalid', { headers: new Map([['x-id', ['1', '2']]]) });
  createClient({ headers: new Map([['x-remove', null]]) });
  createClient({ decompress: false });
  await client.get('https://example.invalid', { decompress: true });
  const wasDecoded: boolean = response.decoded;
  const setCookies: readonly string[] = response.headers.getSetCookie();
  void wasDecoded; void setCookies;
  // @ts-expect-error decompress is a boolean.
  createClient({ decompress: 'gzip' });
  const version: HttpVersion = response.httpVersion;
  void version;
  const http3: typeof response.httpVersion = '3';
  void http3;
  // @ts-expect-error HTTP/1.2 does not exist.
  const unsupported: typeof response.httpVersion = '1.2';
  void unsupported;
}
void checkPublicTypes;
