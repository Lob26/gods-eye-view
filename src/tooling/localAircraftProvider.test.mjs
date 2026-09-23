import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localAircraftProxy,
  fetchReceiverSnapshot,
  LOCAL_AIRCRAFT_MAX_BODY_BYTES,
} from '../../server/providers/localAircraft.js';
import { parseTapAddress } from '../data/tapAddress.js';

function install(preview = false) {
  const routes = new Map();
  localAircraftProxy()[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes.get('/api/local-aircraft');
}

function request(handler, url, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const responseHeaders = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders[name.toLowerCase()] = value;
      },
      writeHead(status, values = {}) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(values)) this.setHeader(k, v);
      },
      end(body = '') {
        resolve({
          status: this.statusCode,
          headers: responseHeaders,
          body: String(body),
        });
      },
    };
    const req = {
      method,
      url,
      headers,
      socket: { remoteAddress: '127.0.0.1' },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/** Every call is recorded; the default throws so an unexpected fetch fails loudly. */
function stubFetch(
  t,
  impl = () => {
    throw new Error('the route must not reach the network here');
  },
) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  });
  return calls;
}

const snapshot = JSON.stringify({
  now: 1_758_585_600,
  aircraft: [{ hex: 'a1b2c3', lat: 30.27, lon: -97.74, seen_pos: 1 }],
});

test('only GET reaches the receiver route', async (t) => {
  const calls = stubFetch(t);
  for (const preview of [false, true]) {
    const res = await request(
      install(preview),
      '/?base=127.0.0.1:8080',
      'POST',
    );
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
  }
  assert.equal(calls.length, 0);
});

test('a non-local or malformed address is refused before any request is made', async (t) => {
  // The SSRF property this route exists to keep: an address the tap contract
  // rejects must never become a fetch, whatever shape it arrives in.
  const calls = stubFetch(t);
  const handler = install();
  for (const base of [
    null, // parameter absent
    '',
    '8.8.8.8:8080', // public
    '169.254.169.254:80', // cloud metadata, link-local
    'example.com:80', // a name other than localhost / .local
    '10.0.0.1', // no port
    '127.0.0.1:99999', // port out of range
    'http://127.0.0.1:8080', // a URL, not an address
    '127.0.0.1:8080/../admin', // a path
    'user@127.0.0.1:8080', // credentials
    '[::1]:8080', // IPv6, rejected on purpose
  ]) {
    const url = base === null ? '/' : `/?${new URLSearchParams({ base })}`;
    const res = await request(handler, url);
    assert.equal(res.status, 400, `${JSON.stringify(base)} must be refused`);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.equal(calls.length, 0, 'a refused address never reaches fetch');
});

test('a local receiver is read at the fixed path and relayed as-is', async (t) => {
  const calls = stubFetch(t, () => new Response(snapshot, { status: 200 }));
  const handler = install();
  for (const base of [
    '192.168.1.50:8080',
    'localhost:8080',
    'adsb.local:8080',
  ]) {
    const res = await request(
      handler,
      // A client-supplied path must have no effect: the path is the route's.
      `/?${new URLSearchParams({ base, path: '/etc/passwd' })}`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body, snapshot);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'http://192.168.1.50:8080/data/aircraft.json',
      'http://localhost:8080/data/aircraft.json',
      'http://adsb.local:8080/data/aircraft.json',
    ],
  );
  // Redirects are handed back, not followed, so a validated address cannot be
  // steered somewhere the address check never saw.
  assert.ok(calls.every((c) => c.init.redirect === 'manual'));
});

test('a receiver that redirects is refused rather than followed', async (t) => {
  const calls = stubFetch(
    t,
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      }),
  );
  const res = await request(install(), '/?base=192.168.1.50:8080');
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Receiver redirect refused',
  });
  assert.equal(calls.length, 1, 'the redirect target is never requested');
});

test('an unreachable receiver answers generically and logs no host detail', async (t) => {
  stubFetch(t, () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(
        new Error('connect ECONNREFUSED 192.168.1.50:8080'),
        {
          code: 'ECONNREFUSED',
        },
      ),
    });
  });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const res = await request(install(), '/?base=192.168.1.50:8080');
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'Receiver unreachable' });
  // The resolver message names a host on the user's own network.
  for (const text of [res.body, ...warnings]) {
    assert.equal(text.includes('192.168.1.50'), false);
    assert.equal(text.includes('ECONNREFUSED'), false);
  }
});

test('a non-200 receiver, a timeout, and an oversized body each map to a fixed answer', async (t) => {
  let respond;
  stubFetch(t, () => respond());
  const handler = install();

  respond = () => new Response('not found', { status: 404 });
  let res = await request(handler, '/?base=192.168.1.50:8080');
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Receiver did not return a snapshot',
  });

  respond = () => {
    throw new DOMException('The operation was aborted.', 'AbortError');
  };
  res = await request(handler, '/?base=192.168.1.50:8080');
  assert.equal(res.status, 504);
  assert.deepEqual(JSON.parse(res.body), { error: 'Receiver timed out' });

  respond = () =>
    new Response('x'.repeat(LOCAL_AIRCRAFT_MAX_BODY_BYTES + 1), {
      status: 200,
    });
  res = await request(handler, '/?base=192.168.1.50:8080');
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Receiver response too large',
  });
});

test('the timeout bounds a receiver that accepts the connection and never answers', async () => {
  // Measured on WSL: a SYN to a closed loopback port is dropped, not refused,
  // so a missing receiver presents as a hang. The timeout is what turns that
  // into an answer.
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      ),
    );
  await assert.rejects(
    fetchReceiverSnapshot(parseTapAddress('192.168.1.50:8080'), {
      fetchImpl: hanging,
      timeoutMs: 20,
    }),
    { name: 'AbortError' },
  );
});

test(
  'the timeout also bounds a receiver that sends headers and then stalls',
  { timeout: 2000 },
  async () => {
    // The harder case: headers arrive, so fetch() resolves, and then the body
    // never finishes. The timeout only reaches this read because its signal is
    // handed to the body reader; without it this test hangs until its own
    // timeout fails it.
    const stalled = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"now":1,'));
          },
        }),
        { status: 200 },
      );
    await assert.rejects(
      fetchReceiverSnapshot(parseTapAddress('192.168.1.50:8080'), {
        fetchImpl: stalled,
        timeoutMs: 30,
      }),
      { name: 'AbortError' },
    );
  },
);

test('the body cap is enforced while reading', async () => {
  await assert.rejects(
    fetchReceiverSnapshot(parseTapAddress('192.168.1.50:8080'), {
      fetchImpl: async () => new Response('x'.repeat(64)),
      maxBytes: 16,
    }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  const { status, body } = await fetchReceiverSnapshot(
    parseTapAddress('192.168.1.50:8080'),
    { fetchImpl: async () => new Response(snapshot) },
  );
  assert.equal(status, 200);
  assert.equal(body, snapshot);
});

test('a runaway page is throttled before its address is even read', async (t) => {
  const calls = stubFetch(t);
  const handler = install();
  // Refused addresses still count: the limiter sits in front of everything,
  // so it protects the receiver and the dev server alike.
  for (let n = 0; n < 120; n += 1) {
    assert.equal((await request(handler, '/?base=8.8.8.8:80')).status, 400);
  }
  const limited = await request(handler, '/?base=8.8.8.8:80');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '5');
  assert.equal(calls.length, 0);
});

test('a page other than the app cannot drive the route', async (t) => {
  // A simple cross-site GET is sent without a preflight. The page cannot read
  // the answer, but status and timing would still map the user's LAN.
  const calls = stubFetch(t, () => new Response(snapshot, { status: 200 }));
  const handler = install();
  const url = '/?base=192.168.1.1:80';
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' }, // another port on localhost
    { host: 'localhost:4173', origin: 'https://attacker.example' },
    { host: 'localhost:4173', origin: 'null' }, // sandboxed frame
  ]) {
    const res = await request(handler, url, 'GET', headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.deepEqual(JSON.parse(res.body), {
      error: 'Cross-site request refused',
    });
  }
  assert.equal(calls.length, 0, 'a refused page never reaches the receiver');

  // The app's own page, a typed URL, and non-browser clients still get through.
  for (const headers of [
    {
      'sec-fetch-site': 'same-origin',
      host: 'localhost:4173',
      origin: 'http://localhost:4173',
    },
    { 'sec-fetch-site': 'none' },
    {},
  ]) {
    assert.equal(
      (await request(handler, url, 'GET', headers)).status,
      200,
      JSON.stringify(headers),
    );
  }
});

test('a refused page does not spend the caller budget', async (t) => {
  stubFetch(t);
  const handler = install();
  for (let n = 0; n < 200; n += 1) {
    await request(handler, '/?base=8.8.8.8:80', 'GET', {
      'sec-fetch-site': 'cross-site',
    });
  }
  // The same client, now from the app, is not throttled by what the hostile
  // page did — the gate sits in front of the limiter.
  assert.equal((await request(handler, '/?base=8.8.8.8:80')).status, 400);
});
