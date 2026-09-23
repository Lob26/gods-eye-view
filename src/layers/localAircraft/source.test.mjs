import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReceiverTapSource,
  RECEIVER_UNCONFIGURED,
  RECEIVER_ADDRESS_INVALID,
} from './source.js';

function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    return respond(url, init);
  };
  return { calls, fetchImpl };
}

const payload = {
  now: 1_758_585_600,
  aircraft: [{ hex: 'a1b2c3', lat: 30.27, lon: -97.74, seen_pos: 1 }],
};

test('an unset or non-local address is reported without a round trip', async () => {
  // The same parseTapAddress the server uses, run in the browser so a typo is
  // reported immediately. The server check is the one that counts.
  const { calls, fetchImpl } = recordingFetch(() => {
    throw new Error('must not fetch');
  });
  let base = '';
  const source = createReceiverTapSource({ getBase: () => base, fetchImpl });

  await assert.rejects(source.getSnapshot(), { code: RECEIVER_UNCONFIGURED });
  base = '   ';
  await assert.rejects(source.getSnapshot(), { code: RECEIVER_UNCONFIGURED });
  base = '8.8.8.8:8080';
  await assert.rejects(source.getSnapshot(), {
    code: RECEIVER_ADDRESS_INVALID,
  });
  assert.equal(calls.length, 0);
});

test('a valid address is read through the tap route and normalized', async () => {
  const { calls, fetchImpl } = recordingFetch(() => Response.json(payload));
  let base = '192.168.1.50:8080';
  const source = createReceiverTapSource({ getBase: () => base, fetchImpl });

  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.positioned, 1);
  assert.equal(snapshot.contacts[0].icao, 'a1b2c3');

  // Read on every poll, so an edited address takes effect on the next tick.
  base = 'adsb.local:8080';
  await source.getSnapshot();
  assert.deepEqual(calls, [
    '/api/local-aircraft?base=192.168.1.50%3A8080',
    '/api/local-aircraft?base=adsb.local%3A8080',
  ]);
});

test("the route's own message is what a failed read reports", async () => {
  const { fetchImpl } = recordingFetch(() =>
    Response.json({ error: 'Receiver unreachable' }, { status: 502 }),
  );
  const source = createReceiverTapSource({
    getBase: () => '192.168.1.50:8080',
    fetchImpl,
  });
  await assert.rejects(source.getSnapshot(), /Receiver unreachable/);

  const bare = createReceiverTapSource({
    getBase: () => '192.168.1.50:8080',
    fetchImpl: async () => new Response('<html>', { status: 500 }),
  });
  await assert.rejects(bare.getSnapshot(), /HTTP 500/);
});

test('an aborted poll never reaches the network', async () => {
  const { calls, fetchImpl } = recordingFetch(() => Response.json(payload));
  const source = createReceiverTapSource({
    getBase: () => '192.168.1.50:8080',
    fetchImpl,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(calls.length, 0);
});

test('the source insists on an address provider', () => {
  assert.throws(() => createReceiverTapSource({}), TypeError);
});
