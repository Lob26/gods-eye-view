import {
  createLocalAircraftLayer,
  createReceiverTapSource,
} from '../../layers/localAircraft/index.js';

/**
 * Where the receiver address is kept.
 *
 * `localStorage`, deliberately not the layer's share-link parameters: the value
 * is a host on the user's own network, so putting it in a URL would publish
 * their LAN layout to anyone the link is sent to — and would point every
 * recipient at an address that means nothing on their network.
 */
const RECEIVER_ADDRESS_KEY = 'gev-local-aircraft-receiver';

function createReceiverAddressStore({ storage, promptImpl }) {
  // Storage can be missing or throw (private window, blocked site data). The
  // in-memory copy is what keeps the layer usable then: the address still
  // works, it just does not survive a reload.
  let memory = '';
  return {
    get() {
      try {
        return storage?.getItem(RECEIVER_ADDRESS_KEY) || memory;
      } catch {
        return memory;
      }
    },
    set(value) {
      memory = value;
      try {
        if (value) storage?.setItem(RECEIVER_ADDRESS_KEY, value);
        else storage?.removeItem(RECEIVER_ADDRESS_KEY);
      } catch {
        /* storage blocked: `memory` carries it for this page */
      }
    },
    prompt(current) {
      return promptImpl(
        'Receiver address (host:port on your network), e.g. 192.168.1.50:8080',
        current,
      );
    },
  };
}

/** Construct the local-aircraft layer fed by the user's dump1090 / readsb receiver. */
export function createApplicationLocalAircraft({
  storage = globalThis.localStorage,
  promptImpl = (...args) => globalThis.prompt?.(...args) ?? null,
} = {}) {
  const receiverAddress = createReceiverAddressStore({ storage, promptImpl });
  return createLocalAircraftLayer({
    source: createReceiverTapSource({ getBase: () => receiverAddress.get() }),
    receiverAddress,
  });
}
