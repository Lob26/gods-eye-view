/**
 * @file Proxy for a user's own dump1090 / readsb ADS-B receiver (#57).
 *
 * The browser cannot read `http://192.168.1.50:8080/data/aircraft.json`
 * directly — the receiver serves no CORS headers, and the page is https in any
 * deployment that is not plain localhost. So the address makes a round trip: the
 * browser sends `?base=host:port`, this route validates it and fetches.
 *
 * That round trip is precisely what makes this an SSRF surface, and it is the
 * case `src/data/tapAddress.js` was written for — this is its first consumer.
 * Two rules from it are load-bearing and must not be relaxed locally:
 *
 * 1. `parseTapAddress` returning null is a 400 and **never** a fallback to a
 *    default host. A tap with no valid address has nothing to read, and quietly
 *    substituting `localhost` would turn a typo into a request the user never
 *    asked for.
 * 2. The path is ours, never the client's. `/data/aircraft.json` is what
 *    dump1090-fa, readsb and tar1090 all serve, so there is nothing for a
 *    caller to choose and no path for it to traverse.
 *
 * Redirects are refused rather than followed: a receiver that answers with a
 * 302 is either broken or not a receiver, and following it is exactly how a
 * validated local address turns into a fetch of something else.
 *
 * The response is relayed close to as-is. Normalization lives in
 * `src/layers/localAircraft/model.js` on the browser side, because the
 * browser-USB producer (#134) decodes 1090 MHz locally and never touches this
 * route — putting the parser here would leave that path without one, or with a
 * second copy that drifts.
 *
 * @module server/providers/localAircraft
 */

import { readResponseTextCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { parseTapAddress, tapUrl } from '../../src/data/tapAddress.js';

/** Upstream path every dump1090-fa / readsb / tar1090 build serves. */
const AIRCRAFT_JSON_PATH = '/data/aircraft.json';
/** A receiver on the same LAN answers in milliseconds; this is a stall, not latency. */
const RECEIVER_TIMEOUT_MS = 4000;
/** ~500 aircraft of readsb JSON is well under 1 MB; this is the runaway ceiling. */
export const LOCAL_AIRCRAFT_MAX_BODY_BYTES = 2 * 1024 * 1024;
/**
 * Always on, like the Overpass and debug-log limiters rather than the opt-in
 * cost-bearing ones: this route spends someone else's hardware. A receiver is
 * polled about once a second, so 120/min cannot inconvenience a real user but
 * does stop a runaway page from hammering the device.
 */
const LOCAL_AIRCRAFT_MAX_PER_MIN = 120;

/**
 * Whether a request came from a page other than the app itself.
 *
 * Any website open in the user's browser can fire a simple cross-site GET at
 * `localhost:4173` — no preflight, so the request is made even though the
 * page cannot read the answer. Everywhere else that costs quota. Here the
 * destination is the caller's choice within the user's LAN, so the status and
 * timing alone would make this route a blind port scanner of it. Only the app's
 * own page (`same-origin`) and non-browser clients (`none`, or no header at all)
 * get through.
 *
 * Same rule as the shared gate proposed in #242; this route should move onto
 * that helper once it lands rather than keep a copy.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function isCrossSiteRequest(req) {
  const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;
  // Browsers too old to send Sec-Fetch-Site still send Origin on a cross-site
  // fetch. An opaque origin (`null`, from a sandboxed frame) fails to parse and
  // is refused with the rest.
  const origin = req.headers?.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== String(req.headers?.host || '');
  } catch {
    return true;
  }
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/**
 * Fetch one snapshot from a validated receiver address.
 *
 * Kept apart from the middleware so a test can stand in for a hostile receiver
 * without the address check in the way — the same split `fetchGbfsUpstream`
 * uses.
 *
 * @param {{origin:string}} address from {@link parseTapAddress}.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @param {number} [options.timeoutMs=RECEIVER_TIMEOUT_MS]
 * @param {number} [options.maxBytes=LOCAL_AIRCRAFT_MAX_BODY_BYTES]
 * @returns {Promise<{status:number, body:string}>}
 * @throws {Error} `code:'TAP_REDIRECT'` on any 3xx, `code:'RESPONSE_TOO_LARGE'`
 *   past the cap, `name:'AbortError'` on timeout.
 */
export async function fetchReceiverSnapshot(
  address,
  {
    fetchImpl = fetch,
    timeoutMs = RECEIVER_TIMEOUT_MS,
    maxBytes = LOCAL_AIRCRAFT_MAX_BODY_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchImpl(tapUrl(address, AIRCRAFT_JSON_PATH), {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const error = new Error('Receiver redirected');
      error.code = 'TAP_REDIRECT';
      throw error;
    }
    // Resolves to the body text and throws RESPONSE_TOO_LARGE past the cap.
    // The signal matters: without it the timeout bounds only the headers, and
    // a receiver that stalls mid-body holds the request open indefinitely.
    const body = await readResponseTextCapped(
      upstream,
      maxBytes,
      controller.signal,
    );
    return { status: upstream.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Vite plugin: `GET /api/local-aircraft?base=host:port`.
 *
 * @returns {import('vite').Plugin}
 */
export function localAircraftProxy() {
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: LOCAL_AIRCRAFT_MAX_PER_MIN,
    globalMax: 400,
  });

  const installMiddleware = (server) => {
    server.middlewares.use('/api/local-aircraft', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Allow: 'GET',
        });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      // Before the limiter, so a hostile page cannot spend the user's budget
      // either.
      if (isCrossSiteRequest(req)) {
        send(res, 403, { error: 'Cross-site request refused' });
        return;
      }

      if (!allow(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': '5',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      const address = parseTapAddress(url.searchParams.get('base'));
      if (!address) {
        // Deliberately specific: this one is the user's typo to fix, and the
        // rule is public in SECURITY.md, so naming it leaks nothing.
        send(res, 400, {
          error:
            'Receiver address must be a loopback, private (RFC1918), localhost or .local host:port',
        });
        return;
      }

      try {
        const upstream = await fetchReceiverSnapshot(address);
        if (upstream.status !== 200) {
          send(res, 502, { error: 'Receiver did not return a snapshot' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Tap-Host': address.host,
        });
        res.end(upstream.body);
      } catch (error) {
        if (error?.name === 'AbortError') {
          send(res, 504, { error: 'Receiver timed out' });
          return;
        }
        if (error?.code === 'TAP_REDIRECT') {
          console.warn('[local-aircraft] receiver redirect refused');
          send(res, 502, { error: 'Receiver redirect refused' });
          return;
        }
        if (error?.code === 'RESPONSE_TOO_LARGE') {
          send(res, 502, { error: 'Receiver response too large' });
          return;
        }
        // Generic, and the log carries no upstream text: for an unreachable
        // receiver the JS error is a resolver message naming the user's own
        // LAN host, which is the one thing this route should not echo.
        console.warn('[local-aircraft] receiver unreachable');
        send(res, 502, { error: 'Receiver unreachable' });
      }
    });
  };

  return {
    name: 'local-aircraft-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
