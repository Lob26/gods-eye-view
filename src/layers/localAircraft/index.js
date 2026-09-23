import * as Cesium from 'cesium';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  contactSpec,
  receiverSummary,
  LOCAL_AIRCRAFT_COLOR_CSS,
} from './rendering.js';
import { RECEIVER_UNCONFIGURED, RECEIVER_ADDRESS_INVALID } from './source.js';

export * from './model.js';
export * from './rendering.js';
export {
  createReceiverTapSource,
  RECEIVER_UNCONFIGURED,
  RECEIVER_ADDRESS_INVALID,
} from './source.js';

export const LOCAL_AIRCRAFT_LAYER_ID = 'local-aircraft';

/**
 * Own the local-aircraft display: contacts heard by the user's own receiver,
 * drawn alongside public Flights in their own color (#57).
 *
 * The layer is a reconciliation loop over one keyed set. Each poll's snapshot
 * is the desired state; the entity map is the observed state; every tick
 * converges the second onto the first — add what appeared, move what is still
 * there, remove what dropped out. It is level-triggered on purpose: nothing
 * depends on having seen the previous poll, so a receiver restarted mid-poll,
 * a dropped response, or a toggle off and on all converge on the next tick
 * rather than leaving a mark nobody will clear. Entities are moved in place
 * rather than rebuilt, so a mark does not flicker every poll.
 *
 * Non-trackable, as #134 settled for the same layer: these contacts are
 * position-only and deliberately stay out of the tracking and cockpit paths
 * that assume a Flights record.
 *
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source any producer of receiver
 *   snapshots — the receiver tap today, the browser-USB decoder (#134) next.
 * @param {{get: () => string, set: (value: string) => void,
 *   prompt: (current: string) => (string|null)}} [options.receiverAddress]
 *   where the tap's `host:port` lives. Optional because a producer with no
 *   network address — the USB decoder — has nothing to configure, and then no
 *   address chip is offered.
 */
export function createLocalAircraftLayer({ source, receiverAddress } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Local aircraft require a snapshot source');

  const color = Cesium.Color.fromCssColorString(LOCAL_AIRCRAFT_COLOR_CSS);
  // Flights' own distance scale and class sizes: the same airframe on both
  // layers should read as the same size, differing only in colour, or the
  // receiver's marks look like a lesser kind of contact.
  const scaleByDistance = new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5);
  const classScale = (kind) => CLASS_SCALE_2D[kind] ?? 1;
  /** @type {Map<string, Cesium.Entity>} icao → entity */
  const entities = new Map();
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _heard = 0;
  let _positioned = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _status = 'idle';
  let _statusMessage = null;

  function clearContacts() {
    if (_dataSource) _dataSource.entities.removeAll();
    entities.clear();
    _heard = 0;
    _positioned = 0;
  }

  function reconcile(contacts) {
    const seen = new Set();
    for (const contact of contacts) {
      const spec = contactSpec(contact);
      seen.add(spec.id);
      const position = Cesium.Cartesian3.fromDegrees(
        spec.longitude,
        spec.latitude,
        spec.heightM,
      );
      // Cesium billboard rotation is counter-clockwise from north with the
      // world up axis, so a true track is negated. A contact with no track
      // keeps its last heading rather than snapping north.
      const rotation =
        spec.headingDeg === null
          ? undefined
          : -Cesium.Math.toRadians(spec.headingDeg);

      let entity = entities.get(spec.id);
      if (!entity) {
        entity = _dataSource.entities.add({
          id: spec.id,
          name: spec.label,
          position,
          billboard: {
            image: aircraftIcon(spec.kind),
            color,
            scale: classScale(spec.kind),
            scaleByDistance,
            rotation: rotation ?? 0,
            alignedAxis: Cesium.Cartesian3.UNIT_Z,
            heightReference: spec.clampToGround
              ? Cesium.HeightReference.CLAMP_TO_GROUND
              : Cesium.HeightReference.NONE,
            // Barometric altitude is not the ellipsoid height the photoreal
            // tiles use; a mark low on approach can dip under a rooftop. It is
            // a 2D glyph, so it is never occluded rather than half-buried.
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { source: 'local-receiver', icao: contact.icao },
        });
        entities.set(spec.id, entity);
      } else {
        entity.position = position;
        entity.name = spec.label;
        if (rotation !== undefined) entity.billboard.rotation = rotation;
        entity.billboard.image = aircraftIcon(spec.kind);
        entity.billboard.scale = classScale(spec.kind);
        entity.billboard.heightReference = spec.clampToGround
          ? Cesium.HeightReference.CLAMP_TO_GROUND
          : Cesium.HeightReference.NONE;
      }
      entity.properties.positionAgeS = contact.positionAgeS;
      entity.properties.rssi = contact.rssi;
    }

    for (const [id, entity] of entities) {
      if (seen.has(id)) continue;
      _dataSource.entities.remove(entity);
      entities.delete(id);
    }
  }

  return {
    id: LOCAL_AIRCRAFT_LAYER_ID,
    name: 'My Receiver (ADS-B)',
    icon: '📡',
    source: 'Your receiver',
    // Real time is the point of the layer; the proxy's 120/min ceiling leaves
    // room for four times this rate.
    updateInterval: 2000,

    init(viewer) {
      if (_viewer)
        throw new Error('Local aircraft layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LOCAL_AIRCRAFT_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      // Dropped rather than kept for next time: a contact from before the
      // toggle is exactly the stale mark the expiry rule exists to prevent.
      clearContacts();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        reconcile(snapshot.contacts);
        _heard = snapshot.heard;
        _positioned = snapshot.positioned;
        _lastUpdate = Date.now();
        _lastError = null;
        _status = snapshot.heard ? 'ok' : 'empty';
        _statusMessage = snapshot.heard ? null : receiverSummary(snapshot);
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        if (
          error?.code === RECEIVER_UNCONFIGURED ||
          error?.code === RECEIVER_ADDRESS_INVALID
        ) {
          // Guidance, not a fault: the user has something to type, and the
          // panel keeps the chip neutral for an `idle` status.
          clearContacts();
          _status = 'idle';
          _statusMessage =
            error.code === RECEIVER_UNCONFIGURED
              ? 'Set your receiver address (e.g. 192.168.1.50:8080)'
              : error.message;
          _lastError = null;
          return false;
        }
        // An unreachable receiver clears its marks: a plane last heard before
        // the dongle was pulled is not somewhere it can be drawn as present.
        clearContacts();
        _status = 'error';
        _statusMessage = null;
        _lastError = error?.message || 'Receiver unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      clearContacts();
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _status = 'idle';
      _statusMessage = null;
    },

    getRowControls() {
      const chips = [];
      if (receiverAddress) {
        const current = String(receiverAddress.get() ?? '').trim();
        chips.push({
          id: 'set-receiver',
          label: current ? `RX ${current}` : 'SET RECEIVER',
          title:
            'Your dump1090 / readsb address as host:port on your own network — loopback, a private (RFC1918) address, localhost or a .local name',
          disabled: !_enabled,
          onClick: () => {
            const next = receiverAddress.prompt(current);
            // Cancel leaves the address alone; an empty answer clears it. The
            // value is validated on every poll rather than here, so there is
            // one place that decides what a bad address says.
            if (next === null || next === undefined) return;
            receiverAddress.set(String(next).trim());
          },
        });
      }
      return {
        chips,
        // Its own full-width line: the count column is sized for a number,
        // and this sentence wrapped the whole row into four lines there.
        info: _heard
          ? receiverSummary({ heard: _heard, positioned: _positioned })
          : undefined,
        legend: [
          {
            label: 'Your receiver',
            color: LOCAL_AIRCRAFT_COLOR_CSS,
            count: _positioned,
            blurb:
              'Aircraft your own antenna hears, in real time. The same plane on Flights trails slightly: public flights render about one poll behind so their motion stays smooth.',
          },
        ],
      };
    },

    getStats() {
      return {
        count: _positioned,
        heard: _heard,
        lastUpdate: _lastUpdate,
        error: _lastError,
        status: _status,
        statusMessage: _statusMessage,
      };
    },
  };
}
