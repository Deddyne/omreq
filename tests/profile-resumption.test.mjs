import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizedClientHello, parseClientHello } from '../fixtures/clienthello.mjs';
import { nodeWireFixture } from '../fixtures/node-wire.mjs';
import { createClient, defineProfile, parseProfile } from '../packages/omreq/dist/index.mjs';

const profile = parseProfile(
  readFileSync(
    new URL('../profiles/chrome-157-macos-arm64.candidate.json', import.meta.url),
    'utf8',
  ),
);
const reference = JSON.parse(
  readFileSync(
    new URL('../fixtures/references/chrome157/resumption-capture.json', import.meta.url),
    'utf8',
  ),
);
for (const scenario of reference.scenarios)
  test(`G1/T23: ${scenario.tlsVersion} resumption matches Chrome and is isolated by client`, async () => {
    const fixture = await nodeWireFixture({
      protocol: 'http/1.1',
      closeResponses: true,
      captureTls: true,
      tlsVersion: scenario.tlsVersion,
    });
    const options = { profile, ca: fixture.ca, trustStore: 'chromium' };
    const first = createClient(options),
      second = createClient(options);
    const noPsk = JSON.parse(JSON.stringify(profile));
    noPsk.transport.tls.preSharedKey = false;
    const disabled = createClient({ ...options, profile: defineProfile(noPsk) });
    try {
      await fixture.label('first');
      for (let i = 0; i < 6; i++) await (await first.get(`${fixture.url}/probe?n=${i}`)).bytes();
      const firstSnapshot = await fixture.snapshot();
      const firstConnections = firstSnapshot.connections.filter((c) => c.label === 'first');
      assert.equal(firstConnections.length, 6, 'Each response closes its HTTP1 connection');
      assert.equal(firstConnections[0].sessionReused, false);
      assert(
        firstConnections.some((c) => c.sessionReused),
        'Server must accept a resumed session',
      );
      for (const connection of firstConnections) {
        assert.equal(connection.tlsVersion, scenario.tlsVersion);
        assert.equal(connection.alpn, 'http/1.1');
        const expected = scenario.connections.find(
          (c) => c.sessionReused === connection.sessionReused,
        );
        const actual = firstSnapshot.handshakes[connection.handshake].hello;
        assert.equal(connection.cipher, expected.cipher);
        assert.deepEqual(
          normalizedClientHello(actual),
          normalizedClientHello(parseClientHello(Buffer.from(expected.rawHex, 'hex'))),
        );
        if (scenario.tlsVersion === 'TLSv1.3')
          assert.equal(
            actual.extensions.some((e) => e.id === 41),
            connection.sessionReused,
          );
      }
      await fixture.label('second');
      await (await second.get(`${fixture.url}/isolated`)).bytes();
      assert.equal(
        (await fixture.snapshot()).connections.at(-1).sessionReused,
        false,
        'No cross-client session',
      );
      await fixture.label('disabled');
      for (let i = 0; i < 3; i++)
        await (await disabled.get(`${fixture.url}/no-psk?n=${i}`)).bytes();
      const disabledConnections = (await fixture.snapshot()).connections.filter(
        (c) => c.label === 'disabled',
      );
      assert.equal(disabledConnections.length, 3);
      assert(disabledConnections.every((c) => !c.sessionReused));
    } finally {
      await Promise.all([first.close(), second.close(), disabled.close()]);
      for (const client of [first, second, disabled]) {
        assert.equal(client.getStats().activeOperations, 0);
        assert.equal(client.getStats().nativeTasks, 0);
      }
      await fixture.close();
    }
  });

test('G1: PSK evidence parser preserves structure and rejects malformed vectors', () => {
  const u16 = (value) => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
  };
  const vector = (bytes) => Buffer.concat([u16(bytes.length), bytes]);
  const identity = Buffer.concat([vector(Buffer.alloc(192, 1)), Buffer.alloc(4)]);
  const binder = Buffer.concat([Buffer.from([32]), Buffer.alloc(32, 2)]);
  const psk = Buffer.concat([vector(identity), vector(binder)]);
  const hello = (payload, trailing = Buffer.alloc(0)) => {
    const extension = Buffer.concat([u16(41), vector(payload), trailing]);
    const body = Buffer.concat([
      u16(0x0303),
      Buffer.alloc(32),
      Buffer.from([0]),
      vector(u16(0x1301)),
      Buffer.from([1, 0]),
      vector(extension),
    ]);
    const header = Buffer.alloc(4);
    header[0] = 1;
    header.writeUIntBE(body.length, 1, 3);
    return Buffer.concat([Buffer.from([22, 3, 1]), u16(body.length + 4), header, body]);
  };
  const parsed = parseClientHello(hello(psk));
  assert.deepEqual(parsed.extensions[0].psk, {
    identities: [{ length: 192 }],
    binders: [{ length: 32 }],
    last: true,
  });
  const changed = Buffer.from(psk);
  changed.fill(9, 4, 196); // Ticket value, with lengths unchanged.
  changed.fill(7, changed.length - 32); // Binder value.
  assert.deepEqual(
    normalizedClientHello(parsed),
    normalizedClientHello(parseClientHello(hello(changed))),
  );
  assert.equal(
    parseClientHello(hello(psk, Buffer.from([0, 23, 0, 0]))).extensions[0].psk.last,
    false,
  );
  for (const invalid of [
    Buffer.alloc(0),
    psk.subarray(0, -1),
    Buffer.concat([u16(0), vector(binder)]),
    Buffer.concat([vector(identity), u16(0)]),
    Buffer.concat([vector(identity), vector(Buffer.concat([Buffer.from([31]), Buffer.alloc(31)]))]),
    Buffer.concat([vector(identity), vector(Buffer.concat([binder, binder]))]),
  ])
    assert.throws(() => parseClientHello(hello(invalid)));
});
