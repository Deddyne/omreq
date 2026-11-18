// Parser for bounded TLS first-flight evidence from controlled local fixtures.
export const isGrease = (id) => (id & 0x0f0f) === 0x0a0a && id >> 8 === (id & 255);
export function parseClientHello(records) {
  const pieces = [];
  let recordOffset = 0;
  while (recordOffset + 5 <= records.length) {
    const length = records.readUInt16BE(recordOffset + 3);
    if (recordOffset + length + 5 > records.length) return undefined;
    if (records[recordOffset] === 22)
      pieces.push(records.subarray(recordOffset + 5, recordOffset + 5 + length));
    recordOffset += length + 5;
  }
  const bytes = Buffer.concat(pieces);
  if (bytes.length < 4 || bytes[0] !== 1 || bytes.length < bytes.readUIntBE(1, 3) + 4)
    return undefined;
  const end = bytes.readUIntBE(1, 3) + 4;
  let offset = 4;
  const take = (length) => {
    if (offset + length > end) throw Error('Truncated ClientHello');
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const u8 = () => take(1)[0];
  const u16 = () => take(2).readUInt16BE(0);
  const legacyVersion = u16();
  take(32);
  const sessionIdLength = u8();
  take(sessionIdLength);
  const ciphers = take(u16());
  const cipherSuites = [];
  if (ciphers.length % 2) throw Error('Invalid cipher vector');
  for (let i = 0; i < ciphers.length; i += 2) cipherSuites.push(ciphers.readUInt16BE(i));
  const compressionMethods = [...take(u8())];
  const extensionEnd = offset + 2 + bytes.readUInt16BE(offset);
  u16();
  if (extensionEnd !== end) throw Error('Invalid extension vector');
  const extensions = [];
  while (offset < extensionEnd) {
    const id = u16(),
      data = take(u16());
    const extension = { id, length: data.length, hex: data.toString('hex') };
    if ([10, 13, 27, 43].includes(id)) {
      const prefix = id === 27 || id === 43 ? 1 : 2;
      const length = prefix === 1 ? data[0] : data.readUInt16BE(0);
      if (length !== data.length - prefix || length % 2) throw Error('Invalid algorithm vector');
      extension.values = [];
      for (let i = prefix; i < data.length; i += 2) extension.values.push(data.readUInt16BE(i));
    }
    if (id === 16 || id === 17513 || id === 17613) {
      if (data.readUInt16BE(0) !== data.length - 2) throw Error('Invalid ALPN/ALPS vector');
      extension.protocols = [];
      for (let i = 2; i < data.length; ) {
        const length = data[i++];
        if (i + length > data.length) throw Error('Truncated protocol');
        extension.protocols.push(data.subarray(i, i + length).toString('ascii'));
        i += length;
      }
    }
    if (id === 51) {
      if (data.readUInt16BE(0) !== data.length - 2) throw Error('Invalid key-share vector');
      extension.shares = [];
      for (let i = 2; i < data.length; ) {
        const group = data.readUInt16BE(i),
          length = data.readUInt16BE(i + 2);
        i += 4;
        if (i + length > data.length) throw Error('Truncated key share');
        extension.shares.push({ group, length });
        i += length;
      }
    }
    if (id === 65037) {
      if (data.length < 10) throw Error('Truncated ECH extension');
      const encLength = data.readUInt16BE(6);
      const payloadOffset = 8 + encLength;
      if (payloadOffset + 2 > data.length) throw Error('Truncated ECH encapsulated key');
      const payloadLength = data.readUInt16BE(payloadOffset);
      if (payloadOffset + 2 + payloadLength !== data.length)
        throw Error('Invalid ECH payload length');
      extension.ech = {
        type: data[0],
        kdf: data.readUInt16BE(1),
        aead: data.readUInt16BE(3),
        encLength,
        payloadLength,
      };
    }
    if (id === 51764) {
      if (data.readUInt16BE(0) !== data.length - 2) throw Error('Invalid trust-anchor vector');
      extension.ids = [];
      for (let i = 2; i < data.length; ) {
        const length = data[i++];
        if (!length || i + length > data.length) throw Error('Invalid trust-anchor ID');
        extension.ids.push(data.subarray(i, i + length).toString('hex'));
        i += length;
      }
    }
    if (id === 41) {
      let i = 0;
      const read = (length) => {
        if (i + length > data.length) throw Error('Truncated PSK extension');
        const value = data.subarray(i, i + length);
        i += length;
        return value;
      };
      const identitiesEnd = read(2).readUInt16BE(0) + 2;
      const identities = [];
      while (i < identitiesEnd) {
        const length = read(2).readUInt16BE(0);
        if (!length || i + length + 4 > identitiesEnd) throw Error('Invalid PSK identity');
        read(length);
        read(4); // obfuscated_ticket_age is random per server ticket / wall time.
        identities.push({ length });
      }
      if (i !== identitiesEnd || !identities.length) throw Error('Invalid PSK identities');
      const bindersEnd = i + 2 + read(2).readUInt16BE(0);
      const binders = [];
      while (i < bindersEnd) {
        const length = read(1)[0];
        if (length < 32 || i + length > bindersEnd) throw Error('Invalid PSK binder');
        read(length);
        binders.push({ length });
      }
      if (i !== data.length || bindersEnd !== data.length || binders.length !== identities.length)
        throw Error('Invalid PSK binders');
      extension.psk = { identities, binders, last: offset === extensionEnd };
    }
    extensions.push(extension);
  }
  return {
    legacyVersion,
    sessionIdLength,
    compressionMethods,
    clientHelloBytes: end,
    cipherSuites,
    extensions,
  };
}
export function normalizedClientHello(hello) {
  return {
    legacyVersion: hello.legacyVersion,
    sessionIdLength: hello.sessionIdLength,
    compressionMethods: hello.compressionMethods,
    cipherSuites: hello.cipherSuites.filter((id) => !isGrease(id)),
    // Chrome permutes extension order. Values with per-connection randomness are
    // compared structurally, and every normalization is explicit here.
    extensions: hello.extensions
      .filter((e) => !isGrease(e.id))
      .map((e) => {
        if (e.psk) return { id: e.id, psk: e.psk };
        // TLS 1.2 ticket contents and the server's opaque encrypted ticket
        // cannot be compared literally, but their length remains observable.
        if (e.id === 35) return { id: e.id, ticketLength: e.length };
        if (e.shares) return { id: e.id, shares: e.shares.filter((s) => !isGrease(s.group)) };
        if (e.values) return { id: e.id, values: e.values.filter((id) => !isGrease(id)) };
        if (e.ids) return { id: e.id, ids: e.ids };
        if (e.protocols) return { id: e.id, protocols: e.protocols };
        // ECH GREASE contains random HPKE material and a bounded random payload size.
        if (e.ech) {
          const { payloadLength, ...structure } = e.ech;
          // Pinned BoringSSL setup_ech_grease chooses 32 * U[4,7] + 16.
          // Validate this envelope, rather than pretending the size is constant.
          return {
            id: e.id,
            ech: structure,
            payloadSizeClass: [144, 176, 208, 240].includes(payloadLength)
              ? 'grease-144..240-step32'
              : payloadLength,
          };
        }
        return { id: e.id, hex: e.hex };
      })
      .sort((a, b) => a.id - b.id),
    grease: {
      cipher: hello.cipherSuites.filter(isGrease).length,
      extensions: hello.extensions
        .filter((e) => isGrease(e.id))
        .map((e) => e.length)
        .sort((a, b) => a - b),
      groups: hello.extensions.find((e) => e.id === 10)?.values.filter(isGrease).length ?? 0,
      signatures: hello.extensions.find((e) => e.id === 13)?.values.filter(isGrease).length ?? 0,
      versions: hello.extensions.find((e) => e.id === 43)?.values.filter(isGrease).length ?? 0,
      keyShares:
        hello.extensions
          .find((e) => e.id === 51)
          ?.shares.filter((e) => isGrease(e.group))
          .map((e) => e.length) ?? [],
    },
  };
}
