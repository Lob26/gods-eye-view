/**
 * @file Pure presentation rules for local-aircraft contacts (#57).
 *
 * No Cesium here, so the rules — color, silhouette class, heading, height
 * mode, label — can be tested without a viewer. `index.js` turns these specs
 * into entities.
 *
 * **Color.** Magenta, the choice #134 made for its browser-USB contacts, so the
 * two producers of this layer look the same and a user does not have to learn
 * which of their own receivers a mark came from. Deliberately offset from pure
 * `#ff00ff`, which the weather radar uses for its heaviest-rain band.
 *
 * **Expect it to lead.** A local contact is real time; Flights renders about one
 * poll interval behind so its motion stays smooth. The same airframe on both
 * layers therefore shows the magenta mark slightly ahead of the public one. That
 * is correct and must not be "fixed" by delaying local contacts to match — the
 * point of the layer is what your antenna hears now.
 *
 * @module layers/localAircraft/rendering
 */

import { classifyAircraft } from '../../data/aircraftClass.js';

export const LOCAL_AIRCRAFT_COLOR_CSS = '#ff3ec8';
export const LOCAL_AIRCRAFT_ENTITY_PREFIX = 'local-aircraft:';

/**
 * Presentation spec for one contact.
 *
 * @param {object} contact from `normalizeReceiverSnapshot`.
 * @returns {{id:string, longitude:number, latitude:number, heightM:number,
 *   clampToGround:boolean, kind:string, headingDeg:number|null, label:string}}
 */
export function contactSpec(contact) {
  const airborneHeight =
    Number.isFinite(contact.altitudeM) && contact.altitudeM > 0
      ? contact.altitudeM
      : 0;
  return {
    id: `${LOCAL_AIRCRAFT_ENTITY_PREFIX}${contact.icao}`,
    longitude: contact.longitude,
    latitude: contact.latitude,
    // A contact reporting `ground`, or with no altitude at all, is clamped
    // rather than placed at zero: height zero is the ellipsoid, which sits
    // under the terrain almost everywhere a receiver is.
    clampToGround: contact.onGround || airborneHeight === 0,
    heightM: contact.onGround ? 0 : airborneHeight,
    kind: classifyAircraft({ category: contact.category }),
    headingDeg: Number.isFinite(contact.track) ? contact.track : null,
    label: (contact.callsign || contact.icao || '').toUpperCase(),
  };
}

/**
 * One line describing the receiver, for the layer's stats row.
 *
 * Heard and drawn are reported separately because they legitimately differ: a
 * receiver hears identities before it resolves positions, and drops positions
 * that have gone stale.
 *
 * @param {{heard:number, positioned:number}} snapshot
 * @returns {string}
 */
export function receiverSummary({ heard, positioned }) {
  if (!heard) return 'Receiver up · hearing no aircraft';
  return `Heard ${heard} · drawing ${positioned}`;
}
