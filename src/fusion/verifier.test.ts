import test from 'node:test';
import assert from 'node:assert/strict';
import { detectManeuversFromHistory } from '../orbit/engine.ts';
import {
  HISTORICAL_OMM_59103,
  HISTORICAL_OMM_68762,
  SEEDED_CURRENT_OMM_BY_NORAD,
  VERIFIED_OCTOBER_2026_WEB_CORPUS,
} from '../orbit/seedCatalog.ts';
import {
  buildUnreportedManeuverEarlyWarnings,
  verifyClaimAgainstOrbits,
} from './verifier.ts';
import { computeBriefInputsHash } from '../analyst/llmAnalyst.ts';
import { runBlindBacktest } from '../orbit/backtest.ts';
import type { OrbitalEventRecord, PairTelemetrySnapshot } from '../shared/types.ts';

const historyMap = {
  59103: HISTORICAL_OMM_59103,
  68762: HISTORICAL_OMM_68762,
};
const fallbackCatalog = Object.values(SEEDED_CURRENT_OMM_BY_NORAD);

test('Orbital Radar 4.58 km Oct 16 claim verifies cleanly against SGP4', () => {
  const src = VERIFIED_OCTOBER_2026_WEB_CORPUS[0];
  const res = verifyClaimAgainstOrbits({
    id: src.id,
    sourceTitle: src.source_title,
    sourceOutlet: src.source_outlet,
    claim: src.extracted,
    ommHistoryByNorad: historyMap,
    fallbackCatalog,
  });

  assert.equal(res.verdict, 'verified');
  assert.ok(res.computed_distance_km !== null && Math.abs(res.computed_distance_km - 4.58) < 0.5);
});

test('Sub-kilometer public TLE claim triggers mandatory epistemic guardrail (unverifiable exact sub-km)', () => {
  const leolabsSrc = VERIFIED_OCTOBER_2026_WEB_CORPUS[2]; // 0.3 km claim on Oct 18
  const res = verifyClaimAgainstOrbits({
    id: leolabsSrc.id,
    sourceTitle: leolabsSrc.source_title,
    sourceOutlet: leolabsSrc.source_outlet,
    claim: leolabsSrc.extracted,
    ommHistoryByNorad: historyMap,
    fallbackCatalog,
  });

  assert.equal(res.verdict, 'approach confirmed, distance below public-data resolution');
  assert.match(res.verdict_reason, /below public-GP resolution/i);
  assert.ok(res.evaluation_timestamp_utc);
  assert.ok(res.suspect_omm_epoch);
  assert.ok(res.protected_omm_epoch);
  assert.ok(res.computation_method);
});

test('Fabricated distant claim (e.g. 500 km on Oct 16 close pass) is contradicted by SGP4', () => {
  const res = verifyClaimAgainstOrbits({
    id: 'test-contradicted',
    sourceTitle: 'Bogus Blog Claim',
    sourceOutlet: 'Unverified Blog',
    claim: {
      satellite_names: ['Kosmos 2612', 'ICEYE-X36'],
      norad_ids: [68762, 59103],
      claim_type: 'approach',
      claim_text: 'Kosmos 2612 remained 500 km away from ICEYE-X36 throughout October 16.',
      claimed_distance_km: 500,
      event_time: '2026-10-16T07:28:00Z',
      source_url: 'https://example.org/bogus',
      published_at: '2026-10-16T12:00:00Z',
    },
    ommHistoryByNorad: historyMap,
    fallbackCatalog,
  });

  assert.equal(res.verdict, 'contradicted');
});

test('Unreported Oct 12 plane-matching maneuver triggers Autonomous Early Warning 5 days pre-press', () => {
  const maneuvers = detectManeuversFromHistory(HISTORICAL_OMM_68762, HISTORICAL_OMM_59103);
  const verifiedClaims = VERIFIED_OCTOBER_2026_WEB_CORPUS.map((src) =>
    verifyClaimAgainstOrbits({
      id: src.id,
      sourceTitle: src.source_title,
      sourceOutlet: src.source_outlet,
      claim: src.extracted,
      ommHistoryByNorad: historyMap,
      fallbackCatalog,
    }),
  );

  // Note: all verified claims were published Oct 16–20, whereas Oct 12 maneuver occurred Oct 12!
  const earlyWarnings = buildUnreportedManeuverEarlyWarnings(maneuvers, verifiedClaims);
  assert.ok(earlyWarnings.length >= 1, 'Expected at least 1 unreported early warning before Oct 16');
  const oct12Warning = earlyWarnings.find((w) => w.eventTimeUtc.startsWith('2026-10-12'));
  assert.ok(oct12Warning, 'Expected Oct 12 autonomous early warning');
  assert.equal(oct12Warning.status, 'early_warning');
});

test('computeBriefInputsHash is deterministic and invalidates when claims/event inputs change', () => {
  const evt: OrbitalEventRecord = {
    id: 'evt-test',
    pairKey: '68762-59103',
    suspectNoradId: 68762,
    protectedNoradId: 59103,
    suspectName: 'COSMOS 2612',
    protectedName: 'ICEYE-X36',
    title: 'Test Event',
    eventType: 'rpo_campaign',
    status: 'confirmed',
    threatLevel: 'HIGH',
    eventTimeUtc: '2026-10-16T07:28:00Z',
    detectedAtUtc: '2026-10-13T03:55:05Z',
    minDistanceKm: 4.54,
    planeAngleDeg: 0.004,
    estimatedDeltaVMs: 26.8,
    briefId: 'brief-test',
    claimsCount: 1,
  };
  const pairTel: PairTelemetrySnapshot = {
    suspectNoradId: 68762,
    protectedNoradId: 59103,
    suspectName: 'COSMOS 2612',
    protectedName: 'ICEYE-X36',
    suspectCountry: 'RU',
    protectedCountry: 'EU',
    computedAtUtc: '2026-11-13T12:00:00Z',
    currentDistanceKm: 660,
    planeAngleDeg: 0.02,
    relativeSpeedKms: 0.01,
    suspectAltKm: 539,
    protectedAltKm: 539,
    coplanarClassification: 'coplanar_shadow',
    suspectEpochUtc: '2026-11-13T12:00:00Z',
    protectedEpochUtc: '2026-11-13T12:00:00Z',
    suspectProvenance: 'spacetrack-history',
    protectedProvenance: 'spacetrack-history',
    tca72h: {
      primaryNoradId: 68762,
      secondaryNoradId: 59103,
      minDistanceKm: 650,
      tcaUtc: '2026-11-14T12:00:00Z',
      relativeVelocityKms: 0.01,
      planeAngleDeg: 0.02,
      primaryAltKm: 539,
      secondaryAltKm: 539,
      windowHours: 72,
      computationSummary: 'test',
    },
  };
  const claims = [
    verifyClaimAgainstOrbits({
      id: 'c1',
      sourceTitle: 'Test',
      sourceOutlet: 'Test',
      claim: VERIFIED_OCTOBER_2026_WEB_CORPUS[0].extracted,
      ommHistoryByNorad: historyMap,
      fallbackCatalog,
    }),
  ];
  const h1 = computeBriefInputsHash({ event: evt, claims, pairTelemetry: pairTel, maneuvers: [] });
  const h2 = computeBriefInputsHash({ event: evt, claims, pairTelemetry: pairTel, maneuvers: [] });
  const h3 = computeBriefInputsHash({
    event: { ...evt, threatLevel: 'MEDIUM' },
    claims,
    pairTelemetry: pairTel,
    maneuvers: [],
  });

  assert.equal(h1, h2);
  assert.equal(h1.length, 24);
  assert.notEqual(h1, h3);
});

test('Blind chronological backtest uses CREATION_DATE order with zero look-ahead and fires WATCH/WARNING/ALERT before Oct 17 news', async () => {
  const bt = await runBlindBacktest();
  assert.equal(bt.orderingField, 'CREATION_DATE');
  assert.ok(bt.cosmosIceye.firstWatch, 'Expected WATCH to fire');
  assert.ok(bt.cosmosIceye.firstWarning, 'Expected WARNING to fire');
  assert.ok(bt.cosmosIceye.firstAlert, 'Expected ALERT to fire');

  // Strict chronological ordering and zero look-ahead relative to Oct 17 public news
  const newsMs = new Date(bt.cosmosIceye.earliestPublicReportUtc!).getTime();
  const watchMs = new Date(bt.cosmosIceye.firstWatch.creationDateUtc).getTime();
  const warningMs = new Date(bt.cosmosIceye.firstWarning.creationDateUtc).getTime();
  const alertMs = new Date(bt.cosmosIceye.firstAlert.creationDateUtc).getTime();
  assert.ok(watchMs <= warningMs, 'WATCH must occur at or before WARNING');
  assert.ok(warningMs <= alertMs, 'WARNING must occur at or before ALERT');
  assert.ok(warningMs < newsMs, 'WARNING must fire strictly before first Oct 17 public report');
  assert.ok(bt.falseAlarmSweepSepOct.pairsEvaluated > 0);
  assert.ok(bt.falseAlarmSweepMay2026.available);
});

