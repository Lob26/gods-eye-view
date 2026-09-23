/**
 * @file Receiver-tap source for the local-aircraft layer (#57).
 *
 * The layer reads from any object with `getSnapshot({signal})` resolving to the
 * shape `normalizeReceiverSnapshot` returns. This module is one such source —
 * a dump1090 / readsb receiver reached through `/api/local-aircraft`. The
 * browser-USB path (#134) is meant to be another, decoding 1090 MHz in the page
 * and producing the same snapshot without ever calling the server. Keeping the
 * contract that small is what lets both feed one layer.
 *
 * The receiver address is validated here as well as on the server, with the
 * same `parseTapAddress`, so a typo is reported immediately instead of after a
 * round trip — the reason `tapAddress.js` lives in `src/` at all. The server
 * check is the one that counts; this one is for feedback.
 *
 * @module layers/localAircraft/source
 */

import { parseTapAddress } from '../../data/tapAddress.js';
import { normalizeReceiverSnapshot } from './model.js';

const TAP_ROUTE = '/api/local-aircraft';

/**
 * States the layer reports rather than treats as failures. "Not set up" and
 * "address rejected" are things the user fixes by typing, and must not read as
 * a broken receiver.
 */
export const RECEIVER_UNCONFIGURED = 'RECEIVER_UNCONFIGURED';
export const RECEIVER_ADDRESS_INVALID = 'RECEIVER_ADDRESS_INVALID';

function receiverError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {object} options
 * @param {() => string} options.getBase current `host:port`, read on every
 *   poll so an edited address takes effect on the next tick with no restart.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.maxPositionAgeS] passed to the normalizer.
 */
export function createReceiverTapSource({
  getBase,
  fetchImpl = (...args) => globalThis.fetch(...args),
  maxPositionAgeS,
} = {}) {
  if (typeof getBase !== 'function')
    throw new TypeError('Receiver tap source requires getBase()');

  return {
    kind: 'receiver-tap',

    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const base = String(getBase() ?? '').trim();
      if (!base)
        throw receiverError(RECEIVER_UNCONFIGURED, 'No receiver address set');
      if (!parseTapAddress(base))
        throw receiverError(
          RECEIVER_ADDRESS_INVALID,
          'Receiver address must be a local host:port',
        );

      const url = `${TAP_ROUTE}?${new URLSearchParams({ base })}`;
      const response = await fetchImpl(url, { signal });
      if (!response.ok) {
        // The proxy already answers with a fixed, user-facing string.
        let detail = `HTTP ${response.status}`;
        try {
          detail = (await response.json())?.error || detail;
        } catch {
          /* non-JSON body: keep the status */
        }
        throw new Error(detail);
      }
      const payload = await response.json();
      signal?.throwIfAborted();
      return normalizeReceiverSnapshot(payload, {
        maxPositionAgeS: maxPositionAgeS?.(),
      });
    },
  };
}
