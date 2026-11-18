import assert from 'node:assert/strict';
import test from 'node:test';
import { startUpload } from '../packages/omreq/dist/upload.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Upload epoch pump did not settle')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function fakeOperation() {
  let epoch = 1,
    demandWaiter;
  const demands = [1];
  const stopped = deferred();
  const endings = new Map([
    [1, deferred()],
    [2, deferred()],
  ]);
  const complete = deferred();
  const writes = [],
    failures = [],
    cancels = [];
  const demand = (value) => {
    if (demandWaiter) {
      const current = demandWaiter;
      demandWaiter = undefined;
      current.resolve(value);
    } else demands.push(value);
  };
  return {
    writes,
    failures,
    cancels,
    complete,
    nextEpoch() {
      epoch = 2;
      demand(2);
    },
    endEpoch(value) {
      endings.get(value).resolve();
    },
    stop() {
      stopped.resolve();
      demand(0);
      for (const end of endings.values()) end.resolve();
    },
    op: {
      waitUploadStopped: () => stopped.promise,
      uploadError: () => null,
      waitUploadEpochEnded: (value) => endings.get(value).promise,
      uploadDemand() {
        if (demands.length) return Promise.resolve(demands.shift());
        assert.equal(demandWaiter, undefined, 'Only one demand may be pending');
        demandWaiter = deferred();
        return demandWaiter.promise;
      },
      uploadFail(value, code) {
        failures.push({ epoch: value, code });
        return value === epoch;
      },
      async uploadWrite(value, chunk, sourceError) {
        assert.equal(sourceError, false);
        if (value !== epoch) return false;
        writes.push({ epoch: value, chunk: chunk === null ? null : Buffer.from(chunk) });
        if (chunk === null) complete.resolve();
        else demand(epoch);
        return true;
      },
      cancel(code) {
        cancels.push(code);
      },
    },
  };
}
function replaySources(first, cleanup) {
  let created = 0;
  return () => {
    if (++created === 1)
      return {
        [Symbol.asyncIterator]() {
          return { next: first, return: cleanup ?? (async () => ({ done: true })) };
        },
      };
    assert.equal(created, 2, 'Only the requested redirect hop may restart the source');
    return {
      async *[Symbol.asyncIterator]() {
        yield Uint8Array.from([65, 66, 67]);
      },
    };
  };
}

for (const failure of ['rejection', 'malformed chunk', 'oversized chunk'])
  test(`T07/T11: a stale upload epoch ${failure} cannot cancel the replay`, async () => {
    const fake = fakeOperation();
    const started = deferred(),
      late = deferred();
    const errors = [];
    let returned = 0;
    const upload = startUpload(
      fake.op,
      {
        replay: replaySources(
          () => {
            started.resolve();
            return late.promise;
          },
          async () => {
            returned++;
            return { done: true };
          },
        ),
      },
      16,
      (error) => errors.push(error),
    );
    try {
      await within(started.promise);
      // Native advanced, while its old epoch-ended notification remains delayed.
      fake.nextEpoch();
      if (failure === 'rejection') late.reject(Error('late old-hop rejection'));
      else
        late.resolve({
          done: false,
          value: failure === 'malformed chunk' ? 'invalid' : new Uint8Array(17),
        });
      await within(fake.complete.promise);
      assert.deepEqual(fake.failures, [
        {
          epoch: 1,
          code: failure === 'oversized chunk' ? 'ERR_RESOURCE_LIMIT' : 'ERR_UPLOAD_SOURCE',
        },
      ]);
      assert.deepEqual(fake.writes, [
        { epoch: 2, chunk: Buffer.from('ABC') },
        { epoch: 2, chunk: null },
      ]);
      assert.equal(returned, 1);
      assert.deepEqual(errors, []);
      assert.deepEqual(fake.cancels, []);
    } finally {
      fake.stop();
      await upload.cleanup();
    }
  });

test('T07/T11: a never-resolving old producer and cleanup do not hold the next replay epoch', async () => {
  const fake = fakeOperation();
  const started = deferred();
  let returned = 0;
  const errors = [];
  const upload = startUpload(
    fake.op,
    {
      replay: replaySources(
        () => {
          started.resolve();
          return new Promise(() => {});
        },
        () => {
          returned++;
          return new Promise(() => {});
        },
      ),
    },
    16,
    (error) => errors.push(error),
  );
  try {
    await within(started.promise);
    fake.nextEpoch();
    fake.endEpoch(1);
    await within(fake.complete.promise);
    assert.equal(returned, 1);
    assert.deepEqual(fake.writes, [
      { epoch: 2, chunk: Buffer.from('ABC') },
      { epoch: 2, chunk: null },
    ]);
    assert.deepEqual(fake.failures, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(fake.cancels, []);
  } finally {
    fake.stop();
    await upload.cleanup();
  }
});
