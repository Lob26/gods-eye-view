/**
 * @file Contact model for the local-aircraft tap (#57).
 *
 * Turns one `aircraft.json` snapshot from a dump1090-fa / readsb / tar1090
 * receiver into contacts the layer can draw.
 *
 * **The per-aircraft fields are not parsed here.** dump1090's rows and the
 * adsb.lol v2 rows are the same wire shape — `hex`, `seen_pos`, `alt_baro`
 * carrying the string `"ground"`, `geom_rate`, `category` — because adsb.lol
 * serves what readsb produces. So the field reading and the knots/feet/fpm
 * conversions are delegated to `normalizeAdsbLolAircraftState`, and this module
 * owns only what genuinely differs:
 *
 * 1. the envelope (`payload.aircraft` here, `payload.ac` there);
 * 2. the receiver-quality signals that normalizer drops (`rssi`, `messages`),
 *    which exist for the whole point of this layer — judging your own antenna;
 * 3. the heard-vs-positioned split, below.
 *
 * Writing a second field parser here is what #274 is about, and
 * `src/data/tapAddress.js` cites that issue as the reason it exists as one
 * shared module. Same reasoning applies.
 *
 * **Heard is not positioned.** A receiver routinely hears an aircraft whose
 * position it cannot yet resolve — Mode S with no ADS-B position, or a contact
 * at the edge of range that has sent an identity message and nothing else. Every
 * other live layer has one freshness number per snapshot; a receiver does not,
 * because `seen_pos` is per airframe. Both counts are reported: "heard 14,
 * drawing 9" is the honest answer, and a receiver that is up and hearing nothing
 * is a valid state rather than an error.
 *
 * **Contacts expire.** A position older than `maxPositionAgeS` is dropped rather
 * than drawn stale. Without that, an aircraft heard once at the edge of range
 * ghosts on the globe until the layer is toggled off. The 30 s default is the
 * figure #134 settled on for the browser-USB path, kept identical so the two
 * producers of this layer do not disagree about when a contact is gone.
 *
 * @module layers/localAircraft/model
 */

import { normalizeAdsbLolAircraftState } from '../../data/adsbLolFallback.js';

/** Seconds a position may age before the contact stops being drawn. */
export const DEFAULT_MAX_POSITION_AGE_S = 30;

/**
 * Field positions in the OpenSky state vector `normalizeAdsbLolAircraftState`
 * returns. Named rather than indexed inline so the adapter below reads as data
 * movement instead of arithmetic.
 */
const STATE = Object.freeze({
  icao: 0,
  callsign: 1,
  timePosition: 3,
  lastContact: 4,
  longitude: 5,
  latitude: 6,
  altitudeM: 7,
  onGround: 8,
  groundSpeedMps: 9,
  track: 10,
  verticalRateMps: 11,
  geoAltitudeM: 13,
  squawk: 14,
  category: 17,
});

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Seconds carried by a snapshot's `now`, tolerating a millisecond clock.
 *
 * readsb writes seconds; a few forks and proxies write milliseconds. Guessing
 * from magnitude is what `normalizeAdsbLolPointResponse` already does, and the
 * two must agree or the same receiver would report different ages through two
 * paths.
 *
 * @param {unknown} raw
 * @returns {number} epoch seconds
 */
export function snapshotSeconds(raw) {
  const value = finiteOrNull(raw);
  if (value === null) return Math.floor(Date.now() / 1000);
  return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
}

/**
 * Normalize one `aircraft.json` snapshot into drawable contacts.
 *
 * @param {object} payload parsed `aircraft.json`.
 * @param {object} [options]
 * @param {number} [options.maxPositionAgeS=DEFAULT_MAX_POSITION_AGE_S] drop a
 *   contact whose position is older than this.
 * @returns {{receivedAt:number, heard:number, positioned:number,
 *   contacts:Array<object>}} `heard` counts every row carrying an identity,
 *   `positioned` counts the contacts actually returned. A malformed or empty
 *   payload yields zero contacts, never null — a receiver that is up and
 *   hearing nothing is not an error and must not read as one.
 */
export function normalizeReceiverSnapshot(payload, options = {}) {
  const maxPositionAgeS = Number.isFinite(options.maxPositionAgeS)
    ? options.maxPositionAgeS
    : DEFAULT_MAX_POSITION_AGE_S;
  const receivedAt = snapshotSeconds(payload?.now);
  const rows = Array.isArray(payload?.aircraft) ? payload.aircraft : [];

  let heard = 0;
  const contacts = [];
  for (const row of rows) {
    const icao = String(row?.hex || '')
      .trim()
      .toLowerCase();
    if (!icao) continue;
    heard += 1;

    const state = normalizeAdsbLolAircraftState(row, receivedAt);
    if (!state) continue; // heard, but no resolved position yet

    const positionAgeS = Math.max(0, receivedAt - state[STATE.timePosition]);
    if (positionAgeS > maxPositionAgeS) continue;

    contacts.push({
      icao: state[STATE.icao],
      callsign: state[STATE.callsign],
      latitude: state[STATE.latitude],
      longitude: state[STATE.longitude],
      altitudeM: state[STATE.altitudeM] ?? state[STATE.geoAltitudeM],
      onGround: state[STATE.onGround],
      groundSpeedMps: state[STATE.groundSpeedMps],
      track: state[STATE.track],
      verticalRateMps: state[STATE.verticalRateMps],
      squawk: state[STATE.squawk],
      category: state[STATE.category],
      positionAgeS,
      messageAgeS: Math.max(0, receivedAt - state[STATE.lastContact]),
      // Receiver-quality signals, kept because judging your own antenna is what
      // this layer is for. Absent on a browser-USB producer, hence nullable.
      rssi: finiteOrNull(row?.rssi),
      messages: finiteOrNull(row?.messages),
    });
  }

  return { receivedAt, heard, positioned: contacts.length, contacts };
}
