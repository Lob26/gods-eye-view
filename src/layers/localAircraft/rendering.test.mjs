import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contactSpec,
  receiverSummary,
  LOCAL_AIRCRAFT_COLOR_CSS,
  LOCAL_AIRCRAFT_ENTITY_PREFIX,
} from './rendering.js';

const contact = {
  icao: 'a1b2c3',
  callsign: 'ual123',
  latitude: 30.27,
  longitude: -97.74,
  altitudeM: 10668,
  onGround: false,
  track: 271,
  category: 4,
};

test('an airborne contact is placed at its altitude with its heading', () => {
  const spec = contactSpec(contact);
  assert.equal(spec.id, `${LOCAL_AIRCRAFT_ENTITY_PREFIX}a1b2c3`);
  assert.equal(spec.heightM, 10668);
  assert.equal(spec.clampToGround, false);
  assert.equal(spec.headingDeg, 271);
  assert.equal(spec.label, 'UAL123');
  assert.equal(spec.kind, 'airliner'); // OpenSky category 4 / emitter A3
});

test('a contact on the ground, or with no altitude, is clamped rather than placed at zero', () => {
  // Height zero is the ellipsoid, which sits below the terrain almost
  // everywhere a receiver is — a mark placed there is underground.
  for (const variant of [
    { onGround: true, altitudeM: null },
    { onGround: false, altitudeM: null },
    { onGround: false, altitudeM: 0 },
    { onGround: false, altitudeM: -30 },
  ]) {
    const spec = contactSpec({ ...contact, ...variant });
    assert.equal(spec.clampToGround, true, JSON.stringify(variant));
    assert.equal(spec.heightM, 0);
  }
});

test('a contact with no track keeps no heading rather than pointing north', () => {
  assert.equal(contactSpec({ ...contact, track: null }).headingDeg, null);
  assert.equal(contactSpec({ ...contact, track: 0 }).headingDeg, 0);
});

test('the label falls back to the ICAO address', () => {
  assert.equal(contactSpec({ ...contact, callsign: null }).label, 'A1B2C3');
});

test('the receiver summary tells an idle antenna from a quiet sky', () => {
  assert.equal(
    receiverSummary({ heard: 0, positioned: 0 }),
    'Receiver up · hearing no aircraft',
  );
  assert.equal(
    receiverSummary({ heard: 14, positioned: 9 }),
    'Heard 14 · drawing 9',
  );
});

test('local contacts are not drawn in the weather radar magenta', () => {
  // Pure #ff00ff is the radar's heaviest-rain band; a receiver mark over it
  // would disappear.
  assert.notEqual(LOCAL_AIRCRAFT_COLOR_CSS.toLowerCase(), '#ff00ff');
  assert.match(LOCAL_AIRCRAFT_COLOR_CSS, /^#[0-9a-f]{6}$/i);
});
