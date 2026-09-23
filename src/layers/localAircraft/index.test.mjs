import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createLocalAircraftLayer,
  RECEIVER_UNCONFIGURED,
  RECEIVER_ADDRESS_INVALID,
  LOCAL_AIRCRAFT_COLOR_CSS,
} from './index.js';

function stubViewer() {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    dataSources: {
      add: (dataSource) => added.push(dataSource),
      remove: (dataSource) => removed.push(dataSource),
    },
  };
}

/** A source whose next answer the test decides, one poll at a time. */
function scriptedSource() {
  const queue = [];
  return {
    next(result) {
      queue.push(result);
    },
    async getSnapshot() {
      const result = queue.shift();
      if (typeof result === 'function') return result();
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const contact = (icao, longitude, extra = {}) => ({
  icao,
  callsign: icao.toUpperCase(),
  latitude: 30,
  longitude,
  altitudeM: 9000,
  onGround: false,
  track: 90,
  category: 4,
  positionAgeS: 1,
  rssi: -20,
  ...extra,
});

const snapshot = (...contacts) => ({
  receivedAt: 1,
  heard: contacts.length,
  positioned: contacts.length,
  contacts,
});

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function startedLayer(options = {}) {
  const source = options.source || scriptedSource();
  const layer = createLocalAircraftLayer({ source, ...options });
  const viewer = stubViewer();
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, source, viewer, dataSource: viewer.added[0] };
}

const lon = (entity) =>
  Cesium.Math.toDegrees(
    Cesium.Cartographic.fromCartesian(
      entity.position.getValue(Cesium.JulianDate.now()),
    ).longitude,
  );

test('each poll converges the drawn set onto the snapshot, moving survivors in place', async () => {
  const { layer, source, dataSource } = startedLayer();

  source.next(snapshot(contact('aaa111', -97), contact('bbb222', -96)));
  assert.equal(await layer.update(), true);
  const first = dataSource.entities.getById('local-aircraft:aaa111');
  assert.ok(first);
  assert.equal(dataSource.entities.values.length, 2);

  // aaa111 moved, bbb222 dropped out, ccc333 appeared.
  source.next(snapshot(contact('aaa111', -97.5), contact('ccc333', -95)));
  await layer.update();

  const ids = dataSource.entities.values.map((e) => e.id).sort();
  assert.deepEqual(ids, ['local-aircraft:aaa111', 'local-aircraft:ccc333']);
  const moved = dataSource.entities.getById('local-aircraft:aaa111');
  // The same entity, moved — not a new one — so a mark does not flicker.
  assert.equal(moved, first);
  assert.ok(Math.abs(lon(moved) - -97.5) < 1e-6);
});

test('a contact is drawn in the receiver color, heading-oriented, and never occluded', async () => {
  const { layer, source, dataSource } = startedLayer();
  source.next(snapshot(contact('aaa111', -97, { track: 90 })));
  await layer.update();
  const { billboard } = dataSource.entities.getById('local-aircraft:aaa111');
  const now = Cesium.JulianDate.now();
  assert.ok(
    billboard.color
      .getValue(now)
      .equals(Cesium.Color.fromCssColorString(LOCAL_AIRCRAFT_COLOR_CSS)),
  );
  assert.ok(
    Math.abs(billboard.rotation.getValue(now) - -Cesium.Math.toRadians(90)) <
      1e-9,
  );
  assert.equal(
    billboard.disableDepthTestDistance.getValue(now),
    Number.POSITIVE_INFINITY,
  );
  // Same size as a Flights mark of the same class: near 3x, far 0.5x.
  const scaler = billboard.scaleByDistance.getValue(now);
  assert.deepEqual(
    [scaler.near, scaler.nearValue, scaler.far, scaler.farValue],
    [1000, 3.0, 8000000, 0.5],
  );
  assert.equal(billboard.scale.getValue(now), 1.0); // airliner
});

test('a response that lands after the layer is switched off is discarded', async () => {
  const { layer, source, dataSource } = startedLayer();
  let release;
  source.next(() => new Promise((resolve) => (release = resolve)));
  const pending = layer.update();
  layer.disable();
  release(snapshot(contact('late01', -97)));
  assert.equal(await pending, false);
  assert.equal(dataSource.entities.values.length, 0);
});

test('an unset or rejected address is guidance, not a fault', async () => {
  const { layer, source } = startedLayer();

  source.next(codedError(RECEIVER_UNCONFIGURED));
  assert.equal(await layer.update(), false);
  let stats = layer.getStats();
  assert.equal(stats.status, 'idle');
  assert.equal(stats.error, null);
  assert.match(stats.statusMessage, /Set your receiver address/);

  source.next(codedError(RECEIVER_ADDRESS_INVALID, 'must be local host:port'));
  await layer.update();
  stats = layer.getStats();
  assert.equal(stats.status, 'idle');
  assert.equal(stats.error, null);
  assert.equal(stats.statusMessage, 'must be local host:port');
});

test('a receiver that is up and hears nothing is a valid, quiet state', async () => {
  const { layer, source } = startedLayer();
  source.next(snapshot());
  assert.equal(await layer.update(), true);
  const stats = layer.getStats();
  assert.equal(stats.status, 'empty');
  assert.equal(stats.error, null);
  assert.equal(stats.statusMessage, 'Receiver up · hearing no aircraft');
});

test('heard and drawn both reach the stats row', async () => {
  const { layer, source } = startedLayer();
  source.next({ ...snapshot(contact('aaa111', -97)), heard: 5 });
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.heard, 5);
  // On its own line: in the count column this sentence wrapped the whole
  // row, seen in the browser check.
  assert.equal(stats.countLabel, undefined);
  assert.equal(layer.getRowControls().info, 'Heard 5 · drawing 1');
});

test('an unreachable receiver clears what it had drawn and reports the fault', async () => {
  // A plane last heard before the dongle was pulled is not somewhere it can be
  // shown as present.
  const { layer, source, dataSource } = startedLayer();
  source.next(snapshot(contact('aaa111', -97)));
  await layer.update();
  assert.equal(dataSource.entities.values.length, 1);

  source.next(new Error('Receiver unreachable'));
  assert.equal(await layer.update(), false);
  assert.equal(dataSource.entities.values.length, 0);
  const stats = layer.getStats();
  assert.equal(stats.status, 'error');
  assert.equal(stats.error, 'Receiver unreachable');
  assert.equal(stats.count, 0);

  // Level-triggered: the next good poll converges with no memory of the fault.
  source.next(snapshot(contact('aaa111', -97)));
  await layer.update();
  assert.equal(dataSource.entities.values.length, 1);
  assert.equal(layer.getStats().error, null);
});

test('switching off drops contacts, and teardown removes the data source', async () => {
  const { layer, source, viewer, dataSource } = startedLayer();
  source.next(snapshot(contact('aaa111', -97)));
  await layer.update();
  layer.disable();
  assert.equal(dataSource.entities.values.length, 0);
  assert.equal(dataSource.show, false);
  assert.equal(await layer.update(), false, 'a disabled layer does not poll');

  layer.destroy(viewer);
  assert.deepEqual(viewer.removed, [dataSource]);
});

test('the address chip prompts, sets, cancels and clears', async () => {
  let stored = '';
  const answers = [];
  const receiverAddress = {
    get: () => stored,
    set: (value) => (stored = value),
    prompt: () => answers.shift(),
  };
  const { layer } = startedLayer({ receiverAddress });
  const chip = () => layer.getRowControls().chips[0];

  assert.equal(chip().label, 'SET RECEIVER');
  assert.equal(chip().disabled, false);

  answers.push('  192.168.1.50:8080 ');
  chip().onClick();
  assert.equal(stored, '192.168.1.50:8080');
  assert.equal(chip().label, 'RX 192.168.1.50:8080');

  answers.push(null); // cancelled
  chip().onClick();
  assert.equal(stored, '192.168.1.50:8080');

  answers.push(''); // cleared
  chip().onClick();
  assert.equal(stored, '');

  layer.disable();
  assert.equal(chip().disabled, true);
});

test('a producer with no address offers no chip but keeps the legend', () => {
  // The browser-USB decoder (#134) feeds this layer with nothing to configure.
  const { layer } = startedLayer();
  const controls = layer.getRowControls();
  assert.deepEqual(controls.chips, []);
  assert.equal(controls.legend[0].color, LOCAL_AIRCRAFT_COLOR_CSS);
  assert.match(controls.legend[0].blurb, /trails slightly/);
});

test('the layer requires a snapshot source', () => {
  assert.throws(() => createLocalAircraftLayer({}), TypeError);
});
