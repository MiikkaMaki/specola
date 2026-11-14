import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeInstantSeparation,
  computePlaneAngleDeg,
  detectManeuversFromHistory,
  findClosestApproach,
  ommToSatrec,
} from './engine.ts';
import {
  HISTORICAL_OMM_59103,
  HISTORICAL_OMM_68762,
  SEEDED_CURRENT_OMM_BY_NORAD,
} from './seedCatalog.ts';

test('Nov 13, 2026 CelesTrak snapshot check reproduces ~660.7 km separation and ~539 km coplanar SSO', () => {
  const iceye = SEEDED_CURRENT_OMM_BY_NORAD[59103];
  const cosmos = SEEDED_CURRENT_OMM_BY_NORAD[68762];
  const checkDate = new Date('2026-11-13T12:00:00Z');

  const sep = computeInstantSeparation(ommToSatrec(cosmos), ommToSatrec(iceye), checkDate, true);
  assert.ok(sep, 'Expected valid SGP4 propagation for 68762 and 59103');

  // Expect ~660.7 km separation (within +/- 5 km SGP4 osculating conversion)
  assert.ok(
    Math.abs(sep.distanceKm - 660.7) < 6.0,
    `Expected ~660.7 km separation on Nov 13 2026, got ${sep.distanceKm.toFixed(2)} km`,
  );

  // Both at ~539 km altitude (SSO oblate geodetic height ~535-552 km depending on latitude)
  assert.ok(
    sep.stateA.altKm > 525 && sep.stateA.altKm < 565,
    `Expected ~539 km LEO altitude for COSMOS 2612, got ${sep.stateA.altKm.toFixed(2)} km`,
  );

  // Still nearly coplanar (< 0.25 deg)
  const planeAngle = computePlaneAngleDeg(cosmos, iceye, checkDate);
  assert.ok(planeAngle < 0.25, `Expected nearly coplanar angle < 0.25°, got ${planeAngle.toFixed(3)}°`);
});

test('Oct 16, 2026 closest approach matches Orbital Radar 4.58 km (07:28 UTC) benchmark', () => {
  const iceyeOct16 = HISTORICAL_OMM_59103.find((o) => o.EPOCH.startsWith('2026-10-16'))!;
  const cosmosOct16 = HISTORICAL_OMM_68762.find((o) => o.EPOCH.startsWith('2026-10-16'))!;

  const tca = findClosestApproach(
    cosmosOct16,
    iceyeOct16,
    new Date('2026-10-16T00:00:00Z'),
    24,
    60,
  );

  assert.ok(
    Math.abs(tca.minDistanceKm - 4.58) < 0.45,
    `Expected Oct 16 TCA distance near 4.58 km, got ${tca.minDistanceKm} km`,
  );
  assert.ok(
    tca.tcaUtc.startsWith('2026-10-16T07:2'),
    `Expected TCA near 2026-10-16T07:28Z, got ${tca.tcaUtc}`,
  );
});

test('Maneuver detector identifies COSMOS 2612 approach signatures and Oct 12 ~475 km plane match', () => {
  const maneuvers = detectManeuversFromHistory(HISTORICAL_OMM_68762, HISTORICAL_OMM_59103);
  assert.ok(maneuvers.length >= 3, `Expected >= 3 maneuvers in Sep-Oct 2026 campaign, got ${maneuvers.length}`);

  const oct12Maneuver = maneuvers.find((m) => m.epochAfterUtc.startsWith('2026-10-12'));
  assert.ok(oct12Maneuver, 'Expected maneuver detection at Oct 12 plane-matching epoch');
  assert.equal(oct12Maneuver.isApproachSignature, true);
  assert.ok(
    oct12Maneuver.postManeuverRangeKm !== undefined &&
      Math.abs(oct12Maneuver.postManeuverRangeKm - 475) < 25,
    `Expected ~475 km range on Oct 12, got ${oct12Maneuver.postManeuverRangeKm}`,
  );
});
