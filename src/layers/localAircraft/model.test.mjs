import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReceiverSnapshot,
  snapshotSeconds,
  DEFAULT_MAX_POSITION_AGE_S,
} from './model.js';
import { normalizeAdsbLolPointResponse } from '../../data/adsbLolFallback.js';

const NOW = 1_758_585_600;

const airliner = {
  hex: 'A1B2C3',
  flight: 'UAL123  ',
  alt_baro: 35000,
  gs: 450,
  track: 271.4,
  baro_rate: -1000,
  category: 'A3',
  lat: 30.27,
  lon: -97.74,
  seen_pos: 1.5,
  seen: 0.5,
  rssi: -21.5,
  messages: 421,
};

test('a readsb row becomes a contact in metres and metres per second', () => {
  const { contacts } = normalizeReceiverSnapshot({
    now: NOW,
    aircraft: [airliner],
  });
  assert.equal(contacts.length, 1);
  const [contact] = contacts;
  assert.equal(contact.icao, 'a1b2c3');
  assert.equal(contact.callsign, 'UAL123');
  assert.equal(contact.altitudeM, 35000 * 0.3048);
  assert.ok(Math.abs(contact.groundSpeedMps - 450 * 0.514444) < 1e-9);
  assert.ok(Math.abs(contact.verticalRateMps - -1000 * 0.00508) < 1e-9);
  assert.equal(contact.track, 271.4);
  assert.equal(contact.onGround, false);
  assert.ok(Math.abs(contact.positionAgeS - 1.5) < 1e-6);
  // Receiver-quality signals survive: judging the antenna is the layer's point.
  assert.equal(contact.rssi, -21.5);
  assert.equal(contact.messages, 421);
});

test('"ground" is a state, not an altitude', () => {
  const { contacts } = normalizeReceiverSnapshot({
    now: NOW,
    aircraft: [{ ...airliner, alt_baro: 'ground', alt_geom: undefined }],
  });
  assert.equal(contacts[0].onGround, true);
  assert.equal(contacts[0].altitudeM, null);
});

test('heard and drawn are counted apart', () => {
  // A receiver hears identities before it resolves positions. Reporting only
  // the drawn count would make a working antenna at the edge of range look
  // idle.
  const snapshot = normalizeReceiverSnapshot({
    now: NOW,
    aircraft: [
      airliner,
      { hex: 'c0ffee', squawk: '7000', seen: 2, rssi: -34 }, // no position yet
      { flight: 'NOHEX' }, // no identity at all: not heard
    ],
  });
  assert.equal(snapshot.heard, 2);
  assert.equal(snapshot.positioned, 1);
  assert.deepEqual(
    snapshot.contacts.map((c) => c.icao),
    ['a1b2c3'],
  );
});

test('a position older than the expiry is dropped instead of drawn stale', () => {
  const edgeOfRange = {
    ...airliner,
    hex: 'bee001',
    seen_pos: DEFAULT_MAX_POSITION_AGE_S + 1,
  };
  const justInside = {
    ...airliner,
    hex: 'bee002',
    seen_pos: DEFAULT_MAX_POSITION_AGE_S - 1,
  };
  const snapshot = normalizeReceiverSnapshot({
    now: NOW,
    aircraft: [edgeOfRange, justInside],
  });
  assert.deepEqual(
    snapshot.contacts.map((c) => c.icao),
    ['bee002'],
  );
  // Still heard: the receiver did hear it, it just cannot place it any more.
  assert.equal(snapshot.heard, 2);

  const tighter = normalizeReceiverSnapshot(
    { now: NOW, aircraft: [justInside] },
    { maxPositionAgeS: 5 },
  );
  assert.equal(tighter.positioned, 0);
});

test('an empty or malformed snapshot is zero contacts, never an error', () => {
  for (const payload of [
    null,
    undefined,
    {},
    { now: NOW },
    { now: NOW, aircraft: 'not a list' },
    { now: NOW, aircraft: [] },
    { now: NOW, aircraft: [null, 42, 'x'] },
  ]) {
    const snapshot = normalizeReceiverSnapshot(payload);
    assert.equal(snapshot.heard, 0);
    assert.deepEqual(snapshot.contacts, []);
  }
});

test('a millisecond clock reads the same as a seconds clock', () => {
  assert.equal(snapshotSeconds(NOW), NOW);
  assert.equal(snapshotSeconds(NOW * 1000), NOW);
  const fromMs = normalizeReceiverSnapshot({
    now: NOW * 1000,
    aircraft: [airliner],
  });
  assert.ok(Math.abs(fromMs.contacts[0].positionAgeS - 1.5) < 1e-6);
});

test('the receiver and adsb.lol paths agree on the same airframe', () => {
  // Field parsing is delegated rather than duplicated, because the two wire
  // formats are one. If someone later forks the parser, this is what notices.
  const local = normalizeReceiverSnapshot({ now: NOW, aircraft: [airliner] })
    .contacts[0];
  const [state] = normalizeAdsbLolPointResponse({
    now: NOW,
    ac: [airliner],
  }).states;
  assert.equal(local.icao, state[0]);
  assert.equal(local.longitude, state[5]);
  assert.equal(local.latitude, state[6]);
  assert.equal(local.altitudeM, state[7]);
  assert.equal(local.groundSpeedMps, state[9]);
  assert.equal(local.track, state[10]);
});
