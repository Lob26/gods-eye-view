import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationLocalAircraft } from './localAircraft.js';
import { LAYER_STATE_REGISTRY } from '../../data/layerState.js';

function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

const throwingStorage = {
  getItem() {
    throw new Error('SecurityError: storage blocked');
  },
  setItem() {
    throw new Error('SecurityError: storage blocked');
  },
  removeItem() {
    throw new Error('SecurityError: storage blocked');
  },
};

/** Build the layer and drive its address chip with scripted prompt answers. */
function build({ storage, answers = [] } = {}) {
  const layer = createApplicationLocalAircraft({
    storage,
    promptImpl: () => answers.shift(),
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  const chip = () => layer.getRowControls().chips[0];
  return { layer, chip, answers };
}

test('the receiver address persists in local storage', () => {
  const storage = memoryStorage();
  const first = build({ storage, answers: ['192.168.1.50:8080'] });
  first.chip().onClick();
  assert.equal([...storage.items.values()][0], '192.168.1.50:8080');

  // A second page load reads it back.
  assert.equal(build({ storage }).chip().label, 'RX 192.168.1.50:8080');

  first.answers.push('');
  first.chip().onClick();
  assert.equal(storage.items.size, 0, 'clearing removes the stored value');
});

test('blocked or missing storage still lets the address work for this page', () => {
  // A private window throws on every storage call. Without an in-memory copy
  // the address would be accepted by the prompt and then silently read back
  // as unset — the receiver would never be polled.
  for (const storage of [throwingStorage, undefined]) {
    const { chip, answers } = build({ storage });
    assert.equal(chip().label, 'SET RECEIVER');
    answers.push('adsb.local:8080');
    chip().onClick();
    assert.equal(chip().label, 'RX adsb.local:8080');
  }
});

test('the receiver address never enters a share link', () => {
  // The value is a host on the user's own network: in a URL it would publish
  // their LAN layout to every recipient, and point each of them at an address
  // that means nothing on theirs. Only on/off is shareable.
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'local-aircraft');
  assert.ok(entry, 'the layer is registered');
  assert.equal(entry.disposition, 'enabled-only');
  assert.equal(entry.optionOwner, undefined);
});
