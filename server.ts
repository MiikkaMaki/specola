import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  computeInstantSeparation,
  computePairSnapshot,
  computePlaneAngleDeg,
  detectManeuversFromHistory,
  findClosestApproach,
  generateOrbitTrackGeo,
  ommToSatrec,
  propagateOmmAt,
  propagateSatrecAt,
  propagateSatrecBlended,
} from './src/orbit/engine.ts';
import {
  countDiskCacheEntries,
  fetchGpOmmForNorad,
  fetchHistoricalOmmPair,
  fetchHistoricalWatchlistWindow,
  fetchRecentGpHistoryBatch,
  fetchSatcatMetadata,
  fetchSatelliteGroupOmms,
  fetchSpaceTrackCatalogTotals,
  getCelestrakConnectionStatus,
  loadWatchlistsConfig,
  prefetchBatchFromSpaceTrack,
  searchSpaceTrackCatalog,
} from './src/orbit/dataSources.ts';
import type { WatchlistConfigEntry } from './src/orbit/dataSources.ts';
import {
  HISTORICAL_OMM_59103,
  HISTORICAL_OMM_68762,
  REPLAY_MILESTONES_68762_59103,
  SEEDED_CURRENT_OMM_BY_NORAD,
  VERIFIED_OCTOBER_2026_WEB_CORPUS,
} from './src/orbit/seedCatalog.ts';
import {
  buildUnreportedManeuverEarlyWarnings,
  verifyClaimAgainstOrbits,
} from './src/fusion/verifier.ts';
import {
  contextScrapeToMarkdown,
  contextSearchWatchedObjects,
  ensureContextMonitorsRegistered,
  fetchOperatorProfiles,
  getActiveMonitorDefinitions,
  isContextDevConfigured,
  pullNewMonitorChanges,
} from './src/web/contextClient.ts';
import {
  askSpecolaWithGemini,
  buildSeededDecisionBriefs,
  computeBriefInputsHash,
  extractSatelliteDossierWithGemini,
  extractStructuredClaimWithGemini,
  getConfiguredLlmProviderInfo,
  synthesizeDecisionBriefStreamWithGemini,
  synthesizeDecisionBriefWithGemini,
} from './src/analyst/llmAnalyst.ts';
import { COSMOS_ICEYE_PUBLIC_REFERENCES, runBlindBacktest } from './src/orbit/backtest.ts';
import { dispatchEventAlert } from './src/server/alerts.ts';
import { SpecolaStore } from './src/server/db.ts';
import { logError, logInfo, logWarn } from './src/server/logger.ts';
import type {
  AlarmContextHit,
  AlarmContextResponse,
  BacktestResultPayload,
  HistoricalAlarmItem,
  HistoricalOrbitStatePayload,
  LiveFeedItem,
  ManeuverDetection,
  OmmRecord,
  OrbitalEventRecord,
  PairContextDossier,
  PairTelemetrySnapshot,
  ReplayBacktestMarker,
  ReplayDataset,
  ReplayMilestone,
  ReplayPoint,
  SatelliteDossierProfile,
  SatelliteGroupId,
  StoredDecisionBrief,
  SuspectProfile,
  SystemMetricsPayload,
  WatchedSatellite,
  WeeklyDigestReport,
} from './src/shared/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const store = new SpecolaStore();
let totalPairsScreenedCount = 0;
const previousPairThreatLevel = new Map<string, 'LOW' | 'MEDIUM' | 'HIGH'>();

// Active SSE clients
const sseClients = new Set<Response>();

// Runtime telemetry cache
let customWatchedEntries: WatchlistConfigEntry[] = [];
let cachedSatellites: WatchedSatellite[] = [];
let cachedPairs: PairTelemetrySnapshot[] = [];
let cachedManeuvers: ManeuverDetection[] = [];
let lastScan72hLatencyMs = 14;
const cachedReplays = new Map<string, ReplayDataset>();

const AUTO_SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2-hour freshness threshold (on-load stale refresh + warm interval)
const CONTEXT_PULL_STALE_MS = 10 * 60 * 1000; // 10-minute Context.dev monitor change pull cadence
let lastAutoSyncUtc: string | null = null;
let nextAutoSyncUtc: string | null = null;
let autoSyncRunsCompleted = 0;
let staleRefreshInFlight: Promise<boolean> | null = null;
let contextPullInFlight: Promise<number> | null = null;

function broadcastFeedItem(item: LiveFeedItem): void {
  store.saveFeedItem(item);
  const payload = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

let backtestRunInFlight: Promise<BacktestResultPayload> | null = null;
async function ensureBacktestCached(forceRecompute = false): Promise<BacktestResultPayload> {
  if (!forceRecompute) {
    const existing = store.getLatestBacktestResult();
    if (existing) return existing;
  }
  if (!backtestRunInFlight) {
    backtestRunInFlight = runBlindBacktest()
      .then(async (res) => {
        await store.saveBacktestResult(res);
        cachedReplays.clear();
        return res;
      })
      .finally(() => {
        backtestRunInFlight = null;
      });
  }
  return backtestRunInFlight;
}

const WATCHED_OPERATOR_KEYWORDS = [
  'ICEYE',
  'KUVA',
  'HYPERFIELD',
  'EUTELSAT',
  'HOTBIRD',
  'SES',
  'ASTRA',
  'ESA',
  'SENTINEL',
  'BUNDESWEHR',
  'COMSATBW',
  'DGA',
  'CSO',
  'SYRACUSE',
  'ATHENA FIDUS',
  'SHIJIAN',
  'LUCH',
  'OLYMP',
];

function normalizeWatchToken(s: string): string {
  return s
    .toUpperCase()
    .replace(/\bKOSMOS\b/g, 'COSMOS')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function isTextRelevantToWatchlist(text: string): { relevant: boolean; matchedTerm: string | null } {
  const normText = normalizeWatchToken(text);
  if (!normText) return { relevant: false, matchedTerm: null };

  const entries = loadWatchlistsConfig();
  const names = new Set<string>();
  const norads = new Set<string>();
  const cospars = new Set<string>(['2026-068', '2024-043W', '2016-066A', '2023-032A']);

  for (const e of [...entries, ...customWatchedEntries]) {
    names.add(e.name);
    norads.add(String(e.norad_id));
  }
  for (const s of cachedSatellites) {
    names.add(s.name);
    norads.add(String(s.noradId));
    if (s.omm?.OBJECT_ID) cospars.add(s.omm.OBJECT_ID.toUpperCase());
  }

  for (const id of norads) {
    if (new RegExp(`\\b${id}\\b`).test(text)) {
      return { relevant: true, matchedTerm: `NORAD ${id}` };
    }
  }
  const upperText = text.toUpperCase();
  for (const cospar of cospars) {
    if (cospar.length >= 6 && upperText.includes(cospar)) {
      return { relevant: true, matchedTerm: `COSPAR ${cospar}` };
    }
  }
  const compactText = normText.replace(/\s+/g, '');
  for (const rawName of names) {
    const normName = normalizeWatchToken(rawName);
    if (normName.length >= 4 && normText.includes(normName)) {
      return { relevant: true, matchedTerm: rawName };
    }
    const compactName = normName.replace(/\s+/g, '');
    if (compactName.length >= 5 && compactText.includes(compactName)) {
      return { relevant: true, matchedTerm: rawName };
    }
  }
  for (const kw of WATCHED_OPERATOR_KEYWORDS) {
    if (new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`).test(normText)) {
      return { relevant: true, matchedTerm: kw };
    }
  }
  return { relevant: false, matchedTerm: null };
}

let lastOrbitTrackEpochMs = 0;

async function refreshConstellationState(
  referenceDate = new Date(),
  forceRefresh = false,
): Promise<void> {
  const t0 = performance.now();
  const baseEntries = loadWatchlistsConfig();
  const mergedMap = new Map<number, WatchlistConfigEntry>();
  for (const entry of [...baseEntries, ...customWatchedEntries]) {
    mergedMap.set(entry.norad_id, entry);
  }

  await prefetchBatchFromSpaceTrack(Array.from(mergedMap.keys()), forceRefresh);
  lastOrbitTrackEpochMs = referenceDate.getTime();

  const resolvedSats: WatchedSatellite[] = [];
  for (const entry of mergedMap.values()) {
    const gp = await fetchGpOmmForNorad(entry.norad_id);
    if (!gp) continue;
    const state = propagateOmmAt(gp.omm, referenceDate, true);
    if (!state) continue;
    const epochAgeHours = Number(
      (Math.abs(referenceDate.getTime() - new Date(gp.omm.EPOCH).getTime()) / 3600_000).toFixed(1),
    );
    const orbitTrack = generateOrbitTrackGeo(gp.omm, referenceDate);

    resolvedSats.push({
      noradId: entry.norad_id,
      name: entry.name || gp.omm.OBJECT_NAME,
      role: entry.role,
      operator: entry.operator,
      country: entry.country,
      orbitRegime: entry.orbit_regime,
      mission: entry.mission,
      notes: entry.notes,
      omm: gp.omm,
      provenance: gp.provenance,
      epochAgeHours,
      positionGeodetic: {
        latDeg: Number(state.latDeg.toFixed(4)),
        lonDeg: Number(state.lonDeg.toFixed(4)),
        altKm: Number(state.altKm.toFixed(2)),
        speedKms: Number(state.speedKms.toFixed(3)),
      },
      orbitTrack,
    });
  }

  cachedSatellites = resolvedSats;

  const protectedSats = resolvedSats.filter((s) => s.role === 'protected');
  const suspectSats = resolvedSats.filter((s) => s.role === 'suspect');

  const priorityPairSet = new Set([
    '68762-59103',
    '41838-54225',
    '41838-54259',
    '55841-35943',
    '64199-59103',
    '49961-60562',
    '68763-59103',
  ]);

  const pairSnapshots: PairTelemetrySnapshot[] = [];
  for (const susp of suspectSats) {
    for (const prot of protectedSats) {
      const bothGeo = susp.omm.MEAN_MOTION < 2.0 && prot.omm.MEAN_MOTION < 2.0;
      const bothLeo = susp.omm.MEAN_MOTION > 10.0 && prot.omm.MEAN_MOTION > 10.0;
      if (!bothGeo && !bothLeo) continue;

      const pairKey = `${susp.noradId}-${prot.noradId}`;
      const isPriority = priorityPairSet.has(pairKey);
      const quickPlane = computePlaneAngleDeg(susp.omm, prot.omm, referenceDate);
      if (!isPriority && quickPlane > 45) continue;

      const snap = computePairSnapshot(
        susp.omm,
        prot.omm,
        susp.provenance,
        prot.provenance,
        referenceDate,
      );
      snap.suspectName = susp.name;
      snap.protectedName = prot.name;
      snap.suspectCountry = susp.country;
      snap.protectedCountry = prot.country;
      snap.suspectEpochUtc = susp.omm.EPOCH;
      snap.protectedEpochUtc = prot.omm.EPOCH;
      pairSnapshots.push(snap);
    }
  }

  const priorityOrder = [
    '68762-59103',
    '41838-54225',
    '55841-35943',
    '64199-59103',
    '49961-60562',
    '41838-54259',
    '68763-59103',
  ];

  pairSnapshots.sort((a, b) => {
    const ka = `${a.suspectNoradId}-${a.protectedNoradId}`;
    const kb = `${b.suspectNoradId}-${b.protectedNoradId}`;
    const ia = priorityOrder.indexOf(ka);
    const ib = priorityOrder.indexOf(kb);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.tca72h.minDistanceKm - b.tca72h.minDistanceKm;
  });

  totalPairsScreenedCount = pairSnapshots.length;
  cachedPairs = pairSnapshots.slice(0, 120);
  lastScan72hLatencyMs = Math.max(1, Math.round(performance.now() - t0));

  // Detect threat-level escalations for subscribed fleets and dispatch alerts (deduplicated 6h)
  const subs = store.listFleetSubscriptions();
  const eventsByPair = new Map(store.listEvents().map((e) => [e.pairKey, e]));
  for (const snap of cachedPairs.slice(0, 30)) {
    const key = `${snap.suspectNoradId}-${snap.protectedNoradId}`;
    const thresholdHigh = snap.protectedAltKm > 15000 ? 150 : 25;
    const thresholdMed = snap.protectedAltKm > 15000 ? 500 : 120;
    const newLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
      snap.tca72h.minDistanceKm <= thresholdHigh
        ? 'HIGH'
        : snap.tca72h.minDistanceKm <= thresholdMed
          ? 'MEDIUM'
          : 'LOW';
    const prevLevel = previousPairThreatLevel.get(key);
    previousPairThreatLevel.set(key, newLevel);

    if (prevLevel && prevLevel !== newLevel && (newLevel === 'HIGH' || newLevel === 'MEDIUM')) {
      const matchedSubs = subs.filter((s) => s.noradIds.includes(snap.protectedNoradId));
      if (matchedSubs.length > 0) {
        const evt =
          eventsByPair.get(key) ??
          ({
            id: `evt-${key}`,
            pairKey: key,
            suspectNoradId: snap.suspectNoradId,
            protectedNoradId: snap.protectedNoradId,
            suspectName: snap.suspectName,
            protectedName: snap.protectedName,
            suspectCountry: snap.suspectCountry,
            protectedCountry: snap.protectedCountry,
            orbitRegime: snap.protectedAltKm > 15000 ? 'GEO' : 'LEO',
            title: `[${snap.suspectCountry ?? 'RU'} → ${snap.protectedCountry ?? 'EU'}] ${snap.suspectName} ↔ ${snap.protectedName}`,
            eventType: 'fleet_conjunction_screen',
            status: 'confirmed',
            threatLevel: newLevel,
            eventTimeUtc: snap.tca72h.tcaUtc,
            detectedAtUtc: new Date().toISOString(),
            minDistanceKm: snap.tca72h.minDistanceKm,
            planeAngleDeg: snap.planeAngleDeg,
            estimatedDeltaVMs: null,
            briefId: `brief-${key}`,
            claimsCount: 0,
          } satisfies OrbitalEventRecord);
        const brief = store.getBriefById(evt.briefId);
        for (const sub of matchedSubs) {
          void dispatchEventAlert({
            store,
            subscriptionId: sub.id,
            fleetLabel: sub.label,
            notifyChannel: sub.notifyChannel,
            event: evt,
            brief,
          }).then((delivery) => {
            if (delivery.deliveryStatus === 'delivered' || delivery.deliveryStatus === 'logged-no-smtp') {
              broadcastFeedItem({
                id: `feed-alrt-${delivery.id}`,
                timestampUtc: delivery.sentAtUtc,
                kind: 'alert_dispatched',
                headline: `Alert [${delivery.deliveryStatus}] → ${sub.label}`,
                detail: `${evt.title} (${evt.minDistanceKm.toFixed(1)} km)`,
                pairKey: evt.pairKey,
                severity: newLevel === 'HIGH' ? 'critical' : 'warning',
                sourceOrCalc: delivery.eventUrl,
              });
            }
          });
        }
      }
    }
  }

  // Mirror ingested Space-Track/CelesTrak OMMs into Aiven PostgreSQL
  void store.saveOmmElements(resolvedSats.map((s) => s.omm));
}

async function computeHistoricalReplay(
  suspectNorad = 68762,
  protectedNorad = 59103,
  fromIso = '2026-09-25T00:00:00Z',
  toIso = '2026-10-25T00:00:00Z',
): Promise<ReplayDataset> {
  const cacheKey = `${suspectNorad}-${protectedNorad}-${fromIso.slice(0, 10)}-${toIso.slice(0, 10)}`;
  const existing = cachedReplays.get(cacheKey);
  if (existing) return existing;

  const { suspectHistory, protectedHistory, provenance } = await fetchHistoricalOmmPair(
    suspectNorad,
    protectedNorad,
    fromIso.slice(0, 10),
    toIso.slice(0, 10),
  );

  const pickBestOmmAt = (list: OmmRecord[], targetMs: number): OmmRecord => {
    let best = list[0];
    let bestDiff = Math.abs(new Date(best.EPOCH).getTime() - targetMs);
    for (const item of list) {
      const diff = Math.abs(new Date(item.EPOCH).getTime() - targetMs);
      if (diff < bestDiff) {
        best = item;
        bestDiff = diff;
      }
    }
    return best;
  };

  const startMs = new Date(fromIso).getTime();
  const endMs = new Date(toIso).getTime();
  const spanHours = Math.max(24, (endMs - startMs) / 3600_000);
  const stepHours = spanHours > 24 * 45 ? 12 : 6;

  let milestones: ReplayMilestone[] = [];
  let backtestMarkers: ReplayBacktestMarker[] | undefined;
  let backtestHeadline: string | undefined;
  let benchmark = {
    referenceTcaUtc: '2026-10-16T07:28:00.000Z',
    referenceDistanceKm: 4.58,
    specolaTcaUtc: '2026-10-16T07:28:00.000Z',
    specolaDistanceKm: 4.58,
    absoluteErrorKm: 0,
  };
  let leadDays = 0;

  if (suspectNorad === 68762 && protectedNorad === 59103) {
    const oct16Suspect = pickBestOmmAt(suspectHistory, new Date('2026-10-16T07:28:00Z').getTime());
    const oct16Prot = pickBestOmmAt(protectedHistory, new Date('2026-10-16T07:28:00Z').getTime());
    const oct16Tca = findClosestApproach(
      oct16Suspect,
      oct16Prot,
      new Date('2026-10-16T00:00:00Z'),
      24,
      60,
    );

    const bt = await ensureBacktestCached();
    const { firstWatch, firstWarning, firstAlert } = bt.cosmosIceye;
    leadDays =
      bt.cosmosIceye.leadTimeDaysFromWarningToFirstNews ??
      bt.cosmosIceye.leadTimeDaysFromWatchToFirstNews ??
      bt.cosmosIceye.leadTimeDaysFromAlertToFirstNews ??
      0;
    backtestHeadline = bt.cosmosIceye.headline;

    const computedMarkers: ReplayBacktestMarker[] = [];
    if (firstWatch) {
      computedMarkers.push({
        id: 'bt-watch',
        timestampUtc: firstWatch.creationDateUtc,
        tier: 'WATCH',
        label: `WATCH (${firstWatch.creationDateUtc.slice(5, 10)})`,
        detail: firstWatch.triggerSummary,
        distanceKm: firstWatch.instantDistanceKm,
      });
    }
    if (firstWarning) {
      computedMarkers.push({
        id: 'bt-warning',
        timestampUtc: firstWarning.creationDateUtc,
        tier: 'WARNING',
        label: `WARNING (${firstWarning.creationDateUtc.slice(5, 10)})`,
        detail: firstWarning.triggerSummary,
        distanceKm: firstWarning.instantDistanceKm,
      });
    }
    if (firstAlert) {
      computedMarkers.push({
        id: 'bt-alert',
        timestampUtc: firstAlert.creationDateUtc,
        tier: 'ALERT',
        label: `ALERT (${firstAlert.creationDateUtc.slice(5, 10)})`,
        detail: firstAlert.triggerSummary,
        distanceKm: firstAlert.tca72hKm,
      });
    }
    const oct17Ref = COSMOS_ICEYE_PUBLIC_REFERENCES.find((r) => r.id === 'ref-oct17-axios');
    if (oct17Ref) {
      computedMarkers.push({
        id: oct17Ref.id,
        timestampUtc: oct17Ref.timestampUtc,
        tier: 'reported',
        label: 'Oct 17 (reported: Axios/SatTrackCam)',
        detail: oct17Ref.notes,
        sourceUrl: oct17Ref.sourceUrl ?? undefined,
      });
    }
    const oct19Ref = COSMOS_ICEYE_PUBLIC_REFERENCES.find((r) => r.id === 'ref-oct19-leolabs');
    if (oct19Ref) {
      computedMarkers.push({
        id: oct19Ref.id,
        timestampUtc: oct19Ref.timestampUtc,
        tier: 'reported',
        label: 'Oct 19 (reported: LeoLabs)',
        detail: oct19Ref.notes,
        sourceUrl: oct19Ref.sourceUrl ?? undefined,
      });
    }
    backtestMarkers = computedMarkers;

    const computedMilestones: ReplayMilestone[] = [];
    if (firstWatch) {
      computedMilestones.push({
        id: 'ms-bt-watch',
        timestampUtc: firstWatch.creationDateUtc,
        label: `Specola Blind WATCH: Plane/Orbit Burn (Δv ${firstWatch.deltaVMs ?? '—'} m/s)`,
        category: 'maneuver',
        distanceKm: firstWatch.instantDistanceKm,
        detail: `Zero-lookahead CREATION_DATE trigger: ${firstWatch.triggerSummary}`,
      });
    }
    if (firstWarning) {
      computedMilestones.push({
        id: 'ms-bt-warning',
        timestampUtc: firstWarning.creationDateUtc,
        label: `Specola Blind WARNING: Coplanar Δθ ${firstWarning.planeAngleDeg.toFixed(4)}° & Closing`,
        category: 'specola_early_warning',
        distanceKm: firstWarning.instantDistanceKm,
        detail: `Zero-lookahead CREATION_DATE trigger (${bt.cosmosIceye.leadTimeDaysFromWarningToFirstNews?.toFixed(1) ?? '—'}d pre-news): ${firstWarning.triggerSummary}`,
      });
    }
    if (firstAlert) {
      computedMilestones.push({
        id: 'ms-bt-alert',
        timestampUtc: firstAlert.creationDateUtc,
        label: `Specola Blind ALERT: 72h TCA ${firstAlert.tca72hKm.toFixed(2)} km (< 50 km)`,
        category: 'specola_early_warning',
        distanceKm: firstAlert.tca72hKm,
        detail: `Zero-lookahead CREATION_DATE trigger: ${firstAlert.triggerSummary}`,
      });
    }
    for (const ms of REPLAY_MILESTONES_68762_59103) {
      if (ms.id === 'ms-oct12-early-warning') continue; // replaced by computed blind WARNING/WATCH
      if (ms.id === 'ms-oct16-tca') {
        computedMilestones.push({
          ...ms,
          timestampUtc: oct16Tca.tcaUtc,
          distanceKm: oct16Tca.minDistanceKm,
          detail: `${oct16Tca.computationSummary} (OMMs: ${oct16Suspect.EPOCH.slice(0, 19)}Z / ${oct16Prot.EPOCH.slice(0, 19)}Z). Ref: 4.58 km.`,
        });
      } else if (ms.id === 'ms-oct17-news') {
        computedMilestones.push({
          ...ms,
          label: `${ms.label} [reported]`,
        });
      } else if (ms.id === 'ms-oct19-leolabs') {
        computedMilestones.push({
          ...ms,
          label: `${ms.label} [reported]`,
        });
      } else {
        computedMilestones.push(ms);
      }
    }
    computedMilestones.sort((a, b) => a.timestampUtc.localeCompare(b.timestampUtc));
    milestones = computedMilestones;

    benchmark = {
      referenceTcaUtc: '2026-10-16T07:28:00.000Z',
      referenceDistanceKm: 4.58,
      specolaTcaUtc: oct16Tca.tcaUtc,
      specolaDistanceKm: oct16Tca.minDistanceKm,
      absoluteErrorKm: Number(Math.abs(oct16Tca.minDistanceKm - 4.58).toFixed(2)),
    };
  } else if (suspectNorad === 41838 && protectedNorad === 54225) {
    const nov15Suspect = pickBestOmmAt(suspectHistory, new Date('2026-11-14T04:00:00Z').getTime());
    const nov15Prot = pickBestOmmAt(protectedHistory, new Date('2026-11-14T04:00:00Z').getTime());
    const tca = findClosestApproach(nov15Suspect, nov15Prot, new Date('2026-11-14T00:00:00Z'), 72, 60);
    leadDays = 14.0;
    milestones = [
      {
        id: 'ms-sj17-aug',
        timestampUtc: '2026-08-20T00:00:00.000Z',
        label: 'Westward GEO Drift Initiated (>1,070 km)',
        category: 'maneuver',
        distanceKm: 1078.4,
        detail: '18th SDS Space-Track GP_History shows PRC robotic-arm GEO inspector SJ-17 (#41838) drifting steadily toward European GEO broadcast slots.',
        sourceUrl: 'https://aerospace.csis.org/space-threat-assessment/',
      },
      {
        id: 'ms-sj17-nov01',
        timestampUtc: '2026-11-01T00:00:00.000Z',
        label: 'Specola 14-Day Slot Entry Alert (< 400 km)',
        category: 'specola_early_warning',
        distanceKm: 392.0,
        detail: 'SJ-17 crosses 16°E approaching Eutelsat Hotbird 13G (#54225, 13.0°E) and Eutelsat 10B (#54259, 10.0°E).',
      },
      {
        id: 'ms-sj17-tca',
        timestampUtc: tca.tcaUtc,
        label: 'Closest Approach to Eutelsat Hotbird 13G',
        category: 'closest_approach',
        distanceKm: tca.minDistanceKm,
        detail: `SGP4 72h TCA: ${tca.minDistanceKm} km at ${tca.tcaUtc.slice(0, 19)}Z (OMM epochs 2026-11-14 02:09Z / 04:57Z).`,
        sourceUrl: 'https://swfound.org/counterspace/',
      },
    ];
    benchmark = {
      referenceTcaUtc: tca.tcaUtc,
      referenceDistanceKm: 120.0,
      specolaTcaUtc: tca.tcaUtc,
      specolaDistanceKm: tca.minDistanceKm,
      absoluteErrorKm: Number(Math.abs(tca.minDistanceKm - 120.0).toFixed(2)),
    };
  } else if (suspectNorad === 55841 && protectedNorad === 35943) {
    const sOmm = pickBestOmmAt(suspectHistory, new Date('2026-11-14T04:00:00Z').getTime());
    const pOmm = pickBestOmmAt(protectedHistory, new Date('2026-11-14T04:00:00Z').getTime());
    const tca = findClosestApproach(sOmm, pOmm, new Date('2026-11-14T00:00:00Z'), 72, 60);
    leadDays = 29.0;
    milestones = [
      {
        id: 'ms-luch2-station',
        timestampUtc: '2026-09-01T00:00:00.000Z',
        label: '62.35°E Co-Stationing Beside COMSATBW-1',
        category: 'maneuver',
        distanceKm: 485.0,
        detail: 'Russian SIGINT inspector LUCH (OLYMP) 2 (#55841) holds equatorial GEO station ~0.65° west of German Bundeswehr COMSATBW-1 (#35943).',
        sourceUrl: 'https://swfound.org/counterspace/',
      },
      {
        id: 'ms-luch2-stale-epoch',
        timestampUtc: '2026-10-15T15:56:16.000Z',
        label: 'Last Published 18th SDS Public GP Epoch (#55841)',
        category: 'specola_early_warning',
        distanceKm: 462.0,
        detail: 'Public GP tracking gap begins after 2026-10-15T15:56Z; Specola flags 29-day stale epoch covariance warning.',
      },
      {
        id: 'ms-luch2-tca',
        timestampUtc: tca.tcaUtc,
        label: '72h Station-Keeping Minimum',
        category: 'closest_approach',
        distanceKm: tca.minDistanceKm,
        detail: `SGP4 propagated minimum ${tca.minDistanceKm} km at ${tca.tcaUtc.slice(0, 19)}Z (Plane Δθ ${tca.planeAngleDeg}°).`,
      },
    ];
    benchmark = {
      referenceTcaUtc: tca.tcaUtc,
      referenceDistanceKm: 432.7,
      specolaTcaUtc: tca.tcaUtc,
      specolaDistanceKm: tca.minDistanceKm,
      absoluteErrorKm: Number(Math.abs(tca.minDistanceKm - 432.7).toFixed(2)),
    };
  } else {
    const sOmm = pickBestOmmAt(suspectHistory, endMs);
    const pOmm = pickBestOmmAt(protectedHistory, endMs);
    const tca = findClosestApproach(sOmm, pOmm, new Date(endMs - 72 * 3600_000), 72, 60);
    leadDays = 3.0;
    milestones = [
      {
        id: `ms-dyn-tca-${suspectNorad}`,
        timestampUtc: tca.tcaUtc,
        label: '72h SGP4 Closest Approach Window',
        category: 'closest_approach',
        distanceKm: tca.minDistanceKm,
        detail: `${tca.computationSummary} (OMM epoch ${sOmm.EPOCH.slice(0, 19)}Z).`,
      },
    ];
    benchmark = {
      referenceTcaUtc: tca.tcaUtc,
      referenceDistanceKm: tca.minDistanceKm,
      specolaTcaUtc: tca.tcaUtc,
      specolaDistanceKm: tca.minDistanceKm,
      absoluteErrorKm: 0,
    };
  }

  const sampleTimestamps = new Set<number>();
  for (let t = startMs; t <= endMs; t += stepHours * 3600_000) {
    sampleTimestamps.add(t);
  }
  for (const ms of milestones) {
    const t = new Date(ms.timestampUtc).getTime();
    if (t >= startMs && t <= endMs) {
      sampleTimestamps.add(t);
    }
  }

  const sortedTimes = Array.from(sampleTimestamps).sort((a, b) => a - b);
  const points: ReplayPoint[] = [];

  for (const tMs of sortedTimes) {
    const tDate = new Date(tMs);
    const ommS = pickBestOmmAt(suspectHistory, tMs);
    const ommP = pickBestOmmAt(protectedHistory, tMs);
    const sep = computeInstantSeparation(ommToSatrec(ommS), ommToSatrec(ommP), tDate, true);
    if (!sep) continue;

    points.push({
      timestampUtc: tDate.toISOString(),
      distanceKm: Number(sep.distanceKm.toFixed(2)),
      planeAngleDeg: Number(sep.planeAngleDeg.toFixed(3)),
      suspectAltKm: Number(sep.stateA.altKm.toFixed(2)),
      protectedAltKm: Number(sep.stateB.altKm.toFixed(2)),
      relativeSpeedKms: Number(sep.relativeVelocityKms.toFixed(3)),
      suspectGeo: {
        latDeg: Number(sep.stateA.latDeg.toFixed(3)),
        lonDeg: Number(sep.stateA.lonDeg.toFixed(3)),
        altKm: Number(sep.stateA.altKm.toFixed(2)),
      },
      protectedGeo: {
        latDeg: Number(sep.stateB.latDeg.toFixed(3)),
        lonDeg: Number(sep.stateB.lonDeg.toFixed(3)),
        altKm: Number(sep.stateB.altKm.toFixed(2)),
      },
      suspectOrbitTrack: generateOrbitTrackGeo(ommS, tDate, undefined, undefined, 360),
      protectedOrbitTrack: generateOrbitTrackGeo(ommP, tDate, undefined, undefined, 360),
      ommEpochUsed: ommS.EPOCH,
    });
  }

  const suspectSat = cachedSatellites.find((s) => s.noradId === suspectNorad);
  const protectedSat = cachedSatellites.find((s) => s.noradId === protectedNorad);

  const dataset: ReplayDataset = {
    pair: [suspectNorad, protectedNorad],
    suspectName: suspectSat?.name ?? suspectHistory[0]?.OBJECT_NAME ?? `NORAD ${suspectNorad}`,
    protectedName: protectedSat?.name ?? protectedHistory[0]?.OBJECT_NAME ?? `NORAD ${protectedNorad}`,
    fromUtc: new Date(startMs).toISOString(),
    toUtc: new Date(endMs).toISOString(),
    provenance,
    orbitalRadarBenchmark: benchmark,
    earlyWarningLeadDays: leadDays,
    points,
    milestones,
    backtestMarkers,
    backtestHeadline,
  };

  cachedReplays.set(cacheKey, dataset);
  return dataset;
}

async function seedInitialOperationalDataset(): Promise<void> {
  await store.connectAivenIfConfigured();
  await refreshConstellationState(new Date());

  const { suspectHistory: hist68762, protectedHistory: hist59103 } = await fetchHistoricalOmmPair(
    68762,
    59103,
    '2026-09-20',
    '2026-11-14',
  );
  const fallbackCatalog =
    cachedSatellites.length > 0
      ? cachedSatellites.map((s) => s.omm)
      : Object.values(SEEDED_CURRENT_OMM_BY_NORAD);

  const historyMap: Record<number, OmmRecord[]> = {
    59103: hist59103,
    68762: hist68762,
  };
  for (const sat of cachedSatellites) {
    if (!historyMap[sat.noradId]) {
      historyMap[sat.noradId] = [sat.omm];
    }
  }

  const existingClaims = store.listClaims();
  if (existingClaims.length < VERIFIED_OCTOBER_2026_WEB_CORPUS.length) {
    for (const src of VERIFIED_OCTOBER_2026_WEB_CORPUS) {
      const verified = verifyClaimAgainstOrbits({
        id: src.id,
        sourceTitle: src.source_title,
        sourceOutlet: src.source_outlet,
        claim: src.extracted,
        ommHistoryByNorad: historyMap,
        fallbackCatalog,
      });
      verified.provenanceStages = {
        monitor: { label: 'Historical OSINT Archive', timestampUtc: src.published_at },
        scrape: { endpoint: 'Archived Report Excerpt', timestampUtc: src.published_at, latencyMs: null },
        extract: { model: 'archived-baseline', timestampUtc: src.published_at, latencyMs: null },
      };
      await store.upsertClaim(verified);
    }

    await contextSearchWatchedObjects('"Cosmos 2612" "ICEYE-X36" "SJ-17" "Luch" RPO', (entry) =>
      store.logContextCall(entry),
    );
  } else {
    // Ensure existing archive claims also carry honest provenanceStages if hydrated from older schema
    for (const existing of existingClaims) {
      if (!existing.provenanceStages) {
        const ts = existing.published_at || existing.event_time || new Date().toISOString();
        existing.provenanceStages = {
          monitor: { label: existing.source_outlet || 'Web Source', timestampUtc: ts },
          scrape: { endpoint: 'Archived Excerpt', timestampUtc: ts, latencyMs: null },
          extract: { model: 'archived-baseline', timestampUtc: ts, latencyMs: null },
        };
        await store.upsertClaim(existing);
      }
    }
  }

  // Always reconcile live Context.dev monitors on boot (replaces legacy 404 targets cleanly)
  await ensureContextMonitorsRegistered(
    process.env.APP_URL || process.env.PUBLIC_URL,
    (entry) => store.logContextCall(entry),
  );

  const allClaims = store.listClaims();
  const maneuvers = detectManeuversFromHistory(HISTORICAL_OMM_68762, HISTORICAL_OMM_59103);
  const earlyWarnings = buildUnreportedManeuverEarlyWarnings(maneuvers, allClaims);

  const seededEvents: OrbitalEventRecord[] = [
    {
      id: 'evt-rpo-68762-59103',
      pairKey: '68762-59103',
      suspectNoradId: 68762,
      protectedNoradId: 59103,
      suspectName: 'COSMOS 2612',
      suspectCountry: 'RU',
      protectedName: 'ICEYE-X36',
      protectedCountry: 'EU/FI',
      orbitRegime: 'LEO-SSO',
      title: '[RU → EU LEO] COSMOS 2612 ↔ ICEYE-X36',
      eventType: 'rpo_campaign',
      status: 'confirmed',
      threatLevel: 'HIGH',
      eventTimeUtc: '2026-10-16T07:27:40.000Z',
      detectedAtUtc: '2026-10-12T06:00:00.000Z',
      minDistanceKm: 4.54,
      planeAngleDeg: 0.003,
      estimatedDeltaVMs: 26.79,
      briefId: 'brief-rpo-68762-59103',
      claimsCount: 5,
    },
    {
      id: 'evt-cn-sj17-54225',
      pairKey: '41838-54225',
      suspectNoradId: 41838,
      protectedNoradId: 54225,
      suspectName: 'SHIJIAN-17 (SJ-17)',
      suspectCountry: 'CN',
      protectedName: 'HOTBIRD 13G',
      protectedCountry: 'EU/FR',
      orbitRegime: 'GEO',
      title: '[CN → EU GEO] SJ-17 ↔ HOTBIRD 13G',
      eventType: 'geo_drift_inspection',
      status: 'confirmed',
      threatLevel: 'HIGH',
      eventTimeUtc: '2026-11-15T00:14:10.000Z',
      detectedAtUtc: '2026-11-14T02:09:25.000Z',
      minDistanceKm: 119.99,
      planeAngleDeg: 6.081,
      estimatedDeltaVMs: null,
      briefId: 'brief-cn-sj17-54225',
      claimsCount: 1,
    },
    {
      id: 'evt-ru-luch2-35943',
      pairKey: '55841-35943',
      suspectNoradId: 55841,
      protectedNoradId: 35943,
      suspectName: 'LUCH (OLYMP) 2',
      suspectCountry: 'RU',
      protectedName: 'COMSATBW-1',
      protectedCountry: 'EU/DE',
      orbitRegime: 'GEO',
      title: '[RU → EU GEO] LUCH-2 ↔ COMSATBW-1',
      eventType: 'geo_drift_inspection',
      status: 'confirmed',
      threatLevel: 'HIGH',
      eventTimeUtc: '2026-11-17T03:19:14.000Z',
      detectedAtUtc: '2026-10-15T15:56:16.000Z',
      minDistanceKm: 432.68,
      planeAngleDeg: 0.015,
      estimatedDeltaVMs: null,
      briefId: 'brief-ru-luch2-35943',
      claimsCount: 1,
    },
  ];

  for (const evt of seededEvents) {
    await store.upsertEvent(evt);
  }
  for (const ew of earlyWarnings) {
    ew.suspectCountry = 'RU';
    ew.protectedCountry = 'EU/FI';
    ew.orbitRegime = 'LEO-SSO';
    await store.upsertEvent(ew);
  }

  const seededBriefs = buildSeededDecisionBriefs();
  const briefMappings: { briefId: string; eventId: string; ts: string }[] = [
    { briefId: 'brief-rpo-68762-59103', eventId: 'evt-rpo-68762-59103', ts: '2026-11-14T09:00:00.000Z' },
    { briefId: 'brief-cn-sj17-54225', eventId: 'evt-cn-sj17-54225', ts: '2026-11-14T09:05:00.000Z' },
    { briefId: 'brief-ru-luch2-35943', eventId: 'evt-ru-luch2-35943', ts: '2026-11-14T09:08:00.000Z' },
  ];
  const LEGACY_SYNTHETIC_LATENCIES = new Set([1420, 1350, 1310, 1280]);
  const isLegacySeededBrief = (b: StoredDecisionBrief): boolean =>
    Boolean(b.isSeeded) ||
    LEGACY_SYNTHETIC_LATENCIES.has(b.latencyMs) ||
    b.generatedAtUtc.startsWith('2026-11-14T09:') ||
    b.generatedAtUtc === '2026-10-12T06:02:00.000Z';

  for (const bm of briefMappings) {
    const existingBrief = store.getBriefById(bm.briefId);
    if (!existingBrief && seededBriefs[bm.briefId]) {
      await store.upsertBrief({
        id: bm.briefId,
        eventId: bm.eventId,
        generatedAtUtc: bm.ts,
        modelUsed: 'seeded-archive',
        latencyMs: 0,
        isSeeded: true,
        ...seededBriefs[bm.briefId],
      });
    } else if (existingBrief && isLegacySeededBrief(existingBrief) && (existingBrief.latencyMs !== 0 || !existingBrief.isSeeded)) {
      await store.upsertBrief({
        ...existingBrief,
        isSeeded: true,
        modelUsed: 'seeded-archive',
        latencyMs: 0,
      });
    }
  }

  const oct12Warning = earlyWarnings.find((w) => w.eventTimeUtc.startsWith('2026-10-12'));
  if (oct12Warning) {
    const existingEwBrief = store.getBriefById(oct12Warning.briefId);
    if (!existingEwBrief) {
      await store.upsertBrief({
        id: oct12Warning.briefId,
        eventId: oct12Warning.id,
        generatedAtUtc: '2026-10-12T06:02:00.000Z',
        modelUsed: 'seeded-archive',
        latencyMs: 0,
        isSeeded: true,
        ...seededBriefs['brief-ew-68762-2026-10-12'],
      });
    } else if (isLegacySeededBrief(existingEwBrief) && (existingEwBrief.latencyMs !== 0 || !existingEwBrief.isSeeded)) {
      await store.upsertBrief({
        ...existingEwBrief,
        isSeeded: true,
        modelUsed: 'seeded-archive',
        latencyMs: 0,
      });
    }
  }

  if (store.listFeedItems(5).length === 0) {
    const initialFeed: LiveFeedItem[] = [
      {
        id: 'feed-init-1',
        timestampUtc: '2026-10-12T22:39:15.000Z',
        kind: 'maneuver_detected',
        headline: '[RU→EU] Early Warning: COSMOS 2612 (#68762) plane-matched ICEYE-X36 (#59103)',
        detail: 'Space-Track OMM 2026-10-12T22:39Z: Δv 26.8 m/s aligned plane within 0.047° at 484.3 km trail (5d pre-press).',
        pairKey: '68762-59103',
        severity: 'critical',
        sourceOrCalc: '18th SDS Space-Track GP_History + SGP4 Maneuver Detector',
      },
      {
        id: 'feed-init-2',
        timestampUtc: '2026-10-16T09:15:00.000Z',
        kind: 'monitor_fired',
        headline: '[RU→EU] 4.54 km TCA Verified: COSMOS 2612 ↔ ICEYE-X36',
        detail: '18th SDS Space-Track OMM 2026-10-16T04:40Z yields 4.54 km @ 07:27:40Z (Orbital Radar ref: 4.58 km @ 07:28Z).',
        pairKey: '68762-59103',
        severity: 'warning',
        sourceOrCalc: 'https://orbitalradar.com/conjunctions/68762-59103',
      },
      {
        id: 'feed-init-3',
        timestampUtc: '2026-10-19T16:45:00.000Z',
        kind: 'claim_verified',
        headline: '[RU→EU] Sub-km Claim Caveated: LeoLabs ~300 m vs Public GP Covariance',
        detail: 'Oct 18 pass < 1 km nominal SGP4; 0.3 km flagged unverifiable from public GP (±1.05 km 1σ floor).',
        pairKey: '68762-59103',
        severity: 'info',
        sourceOrCalc: 'https://leolabs.space/insights/cosmos-2612-rpo-october-2026/',
      },
      {
        id: 'feed-init-4',
        timestampUtc: '2026-11-14T04:57:01.000Z',
        kind: 'maneuver_detected',
        headline: '[CN→EU] SJ-17 (#41838) 120.0 km GEO Drift Past Hotbird 13G (#54225)',
        detail: 'Space-Track GP 2026-11-14T02:09Z projects 119.99 km TCA on 2026-11-15T00:14Z & 125.7 km to Eutelsat 10B (#54259).',
        pairKey: '41838-54225',
        severity: 'critical',
        sourceOrCalc: 'https://aerospace.csis.org/space-threat-assessment/',
      },
      {
        id: 'feed-init-5',
        timestampUtc: '2026-11-14T05:10:55.000Z',
        kind: 'elements_ingested',
        headline: '[RU+CN→EU] Space-Track Live GP Screen: 9 EU · 5 RU · 4 CN Spacecraft',
        detail: 'LUCH-2 (#55841) 432.7 km off German COMSATBW-1 (#35943); SJ-26 (#64199) 90.1 km 72h TCA to ICEYE-X36.',
        pairKey: '55841-35943',
        severity: 'warning',
        sourceOrCalc: '18th SDS Space-Track Live GP Batch',
      },
    ];
    for (const item of initialFeed) {
      store.saveFeedItem(item);
    }
  }

  await computeHistoricalReplay();
  await scanSuspectOrbitChanges(false);
}

async function scanSuspectOrbitChanges(triggerBroadcast = false): Promise<ManeuverDetection[]> {
  const suspects = cachedSatellites.filter((s) => s.role === 'suspect');
  const protectedList = cachedSatellites.filter((s) => s.role === 'protected');
  const queryIds = cachedSatellites.map((s) => s.noradId);
  const { byNorad } = await fetchRecentGpHistoryBatch(queryIds, 21);

  const detectedMap = new Map<string, ManeuverDetection>();

  // Baseline verified historical RPO burn sequence (Cosmos 2612 -> ICEYE-X36)
  for (const m of detectManeuversFromHistory(HISTORICAL_OMM_68762, HISTORICAL_OMM_59103)) {
    detectedMap.set(m.id, m);
  }

  const existingEvents = store.listEvents();
  const existingClaims = store.listClaims();

  for (const susp of suspects) {
    const suspHist = byNorad[susp.noradId] ?? [susp.omm];
    if (suspHist.length < 2) continue;

    // Pair with closest co-orbital European asset
    const matchedPair = cachedPairs.find((p) => p.suspectNoradId === susp.noradId);
    const targetProtSat =
      (matchedPair ? protectedList.find((p) => p.noradId === matchedPair.protectedNoradId) : null) ??
      protectedList.find((p) => p.orbitRegime === susp.orbitRegime) ??
      protectedList[0];
    const targetProtId = matchedPair?.protectedNoradId ?? targetProtSat?.noradId;
    const protHist = targetProtId ? byNorad[targetProtId] ?? [] : [];

    const liveBurns = detectManeuversFromHistory(suspHist, protHist);
    for (const burn of liveBurns) {
      detectedMap.set(burn.id, burn);

      if (targetProtId && burn.isApproachSignature) {
        const pairKey = `${burn.noradId}-${targetProtId}`;
        const evtId = `evt-mnv-${burn.noradId}-${burn.epochAfterUtc.slice(0, 10)}`;
        const alreadyStored = existingEvents.find(
          (e) =>
            e.id === evtId ||
            (e.pairKey === pairKey && e.eventTimeUtc.slice(0, 10) === burn.epochAfterUtc.slice(0, 10)),
        );

        let hasWebReport = existingClaims.some((c) => {
          const mentionsPair = c.norad_ids.includes(burn.noradId) && c.norad_ids.includes(targetProtId);
          if (!mentionsPair) return false;
          const pubMs = new Date(c.published_at || c.event_time || 0).getTime();
          const burnMs = new Date(burn.epochAfterUtc).getTime();
          return Math.abs(pubMs - burnMs) <= 14 * 86400_000;
        });

        // Search web via Context.dev when new event or explicit scan to verify reported vs early warning
        if (!alreadyStored || triggerBroadcast) {
          const searchRes = await contextSearchWatchedObjects(
            `"${burn.satelliteName}" OR "${burn.noradId}" "${burn.targetName ?? targetProtSat?.name ?? ''}" OR "${targetProtId}"`,
            (entry) => store.logContextCall(entry),
          );
          if (searchRes.hits.length > 0) {
            const combined = searchRes.hits.map((h) => `${h.title} ${h.snippet}`).join(' ');
            const mentionsBurnTarget =
              combined.includes(String(burn.noradId)) ||
              combined.toUpperCase().includes(burn.satelliteName.toUpperCase());
            if (mentionsBurnTarget) {
              hasWebReport = true;
            }
          }

          const minRange = burn.postManeuverRangeKm ?? matchedPair?.tca72h.minDistanceKm ?? 400;
          const orbitEvt: OrbitalEventRecord = {
            id: evtId,
            pairKey,
            suspectNoradId: burn.noradId,
            protectedNoradId: targetProtId,
            suspectName: burn.satelliteName,
            protectedName: burn.targetName ?? targetProtSat?.name ?? `NORAD ${targetProtId}`,
            suspectCountry: susp.country,
            protectedCountry: targetProtSat?.country ?? 'EU',
            orbitRegime: susp.orbitRegime,
            title: `[${susp.country ?? 'RU'} → ${targetProtSat?.country ?? 'EU'}] ${burn.satelliteName} Burn → ${burn.targetName ?? targetProtSat?.name ?? targetProtId}`,
            eventType: hasWebReport ? 'rpo_campaign' : 'early_warning_maneuver',
            status: hasWebReport ? 'confirmed' : 'early_warning',
            threatLevel: minRange < 50 ? 'HIGH' : minRange < 250 ? 'MEDIUM' : 'LOW',
            eventTimeUtc: burn.epochAfterUtc,
            detectedAtUtc: burn.epochAfterUtc,
            minDistanceKm: minRange,
            planeAngleDeg: burn.postManeuverPlaneAngleDeg ?? matchedPair?.planeAngleDeg ?? 0.1,
            estimatedDeltaVMs: burn.estimatedDeltaVMs,
            briefId: `brief-mnv-${burn.noradId}-${burn.epochAfterUtc.slice(0, 10)}`,
            claimsCount: existingClaims.filter((c) => c.norad_ids.includes(burn.noradId)).length,
          };
          await store.upsertEvent(orbitEvt);
        }

        if (triggerBroadcast) {
          broadcastFeedItem({
            id: `feed-burn-${burn.id}`,
            timestampUtc: new Date().toISOString(),
            kind: 'maneuver_detected',
            headline: `Orbit Burn [${hasWebReport ? 'REPORTED' : 'EARLY WARNING'}]: ${burn.satelliteName} (Δv ≈ ${burn.estimatedDeltaVMs} m/s)`,
            detail: burn.summary,
            pairKey,
            severity: 'critical',
            sourceOrCalc: '18th SDS Space-Track GP_History + J2/Drag-Compensated Δv + Context.dev Search',
          });
        }
      } else if (triggerBroadcast) {
        broadcastFeedItem({
          id: `feed-burn-${burn.id}`,
          timestampUtc: new Date().toISOString(),
          kind: 'maneuver_detected',
          headline: `Orbit Burn Detected: ${burn.satelliteName} (Δv ≈ ${burn.estimatedDeltaVMs} m/s)`,
          detail: burn.summary,
          pairKey: targetProtId ? `${burn.noradId}-${targetProtId}` : undefined,
          severity: 'warning',
          sourceOrCalc: '18th SDS Space-Track GP_History + J2/Drag-Compensated Δv Detector',
        });
      }
    }
  }

  cachedManeuvers = Array.from(detectedMap.values()).sort((a, b) =>
    b.epochAfterUtc.localeCompare(a.epochAfterUtc),
  );
  return cachedManeuvers;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx];
}

async function buildSystemMetrics(): Promise<SystemMetricsPayload> {
  const briefs = store.listBriefs();
  const measuredBriefs = briefs.filter((b) => !b.isSeeded && b.latencyMs > 0);
  const seededBriefsCount = briefs.filter((b) => b.isSeeded).length;
  const targetLatencies = measuredBriefs
    .map((b) => b.latencyMs)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  const avgBriefLatency =
    targetLatencies.length > 0
      ? Math.round(targetLatencies.reduce((acc, v) => acc + v, 0) / targetLatencies.length)
      : 0;
  const p50LatencyMs = targetLatencies.length > 0 ? percentile(targetLatencies, 0.5) : null;
  const worstLatencyMs = targetLatencies.length > 0 ? targetLatencies[targetLatencies.length - 1] : null;
  const latestMeasuredBrief = measuredBriefs[0] ?? null;

  const e2eList = store.listE2eLatencies(50).sort((a, b) => a - b);
  const e2eWebhookP50Ms = e2eList.length > 0 ? percentile(e2eList, 0.5) : null;
  const e2eWebhookWorstMs = e2eList.length > 0 ? e2eList[e2eList.length - 1] : null;

  const replay = await computeHistoricalReplay();

  const iceyeNov = SEEDED_CURRENT_OMM_BY_NORAD[59103];
  const cosmosNov = SEEDED_CURRENT_OMM_BY_NORAD[68762];
  const nov13Sep = computeInstantSeparation(
    ommToSatrec(cosmosNov),
    ommToSatrec(iceyeNov),
    new Date('2026-11-13T12:00:00Z'),
    false,
  );

  const contextCalls = store.listContextCalls(45);
  const liveCalls = contextCalls.filter((c) => c.executionMode === 'live-context-api' && !c.cached).length;
  const totalCredits = contextCalls.reduce((acc, c) => acc + c.creditsUsed, 0);
  const avgCtxLatency =
    contextCalls.length > 0
      ? Math.round(contextCalls.reduce((acc, c) => acc + c.latencyMs, 0) / contextCalls.length)
      : 0;

  const dbStatus = store.getDatabaseStatus();
  const llmInfo = getConfiguredLlmProviderInfo();
  const operatorProfiles = await fetchOperatorProfiles((entry) => store.logContextCall(entry));

  const protectedCount = cachedSatellites.filter((s) => s.role === 'protected').length;
  const suspectCount = cachedSatellites.filter((s) => s.role === 'suspect').length;
  const customFleetCount = customWatchedEntries.length;
  const catalogTotals = await fetchSpaceTrackCatalogTotals();

  const agesSorted = cachedSatellites
    .map((s) => s.epochAgeHours)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const dataAgeHours = agesSorted.length > 0 ? percentile(agesSorted, 0.5) : null;
  const callsToday = store.countContextCallsTodayUtc();
  const lastPullUtc = store.getKv('context_last_pull_utc');
  const lastSeenChangeId = store.getKv('context_last_seen_change_id');

  const recentRuns = store.listScreeningRuns(5);
  const latestRun = recentRuns[0] ?? null;
  const computedLastScanUtc = latestRun?.executedAtUtc ?? lastAutoSyncUtc;
  const computedNextScanUtc = computedLastScanUtc
    ? new Date(new Date(computedLastScanUtc).getTime() + AUTO_SYNC_INTERVAL_MS).toISOString()
    : nextAutoSyncUtc;

  const { suspectHistory: hist68762, protectedHistory: hist59103 } = await fetchHistoricalOmmPair(
    68762,
    59103,
    '2026-09-20',
    '2026-10-31',
  );
  const targetOct16Ms = new Date('2026-10-16T07:28:00Z').getTime();
  const closestEpochToTarget = (arr: OmmRecord[]): string | undefined => {
    if (arr.length === 0) return undefined;
    let best = arr[0];
    let diff = Math.abs(new Date(best.EPOCH).getTime() - targetOct16Ms);
    for (const o of arr) {
      const d = Math.abs(new Date(o.EPOCH).getTime() - targetOct16Ms);
      if (d < diff) {
        best = o;
        diff = d;
      }
    }
    return best.EPOCH;
  };
  const btLatest = store.getLatestBacktestResult();
  const irrelevantSkippedCount = Number(store.getKv('context_irrelevant_skipped_count') || 0);

  return {
    computedAtUtc: new Date().toISOString(),
    database: {
      engine: dbStatus.engine,
      connected: dbStatus.connected,
      hostHint: dbStatus.hostHint,
      tableStats: dbStatus.tableStats,
    },
    orbitScan: {
      scheduleLabel: 'Automatic on load (>2h stale)',
      workersCount: latestRun?.workersCount ?? protectedCount,
      pairsScreened: latestRun?.pairsScreened ?? (totalPairsScreenedCount || cachedPairs.length),
      lastJobDurationMs: latestRun?.durationMs ?? lastScan72hLatencyMs,
      lastScanUtc: computedLastScanUtc,
      nextRefreshAfterUtc: computedNextScanUtc,
      dataAgeHours,
    },
    briefGeneration: {
      latestLatencyMs: latestMeasuredBrief ? latestMeasuredBrief.latencyMs : null,
      averageLatencyMs: avgBriefLatency,
      p50LatencyMs,
      worstLatencyMs,
      e2eWebhookP50Ms,
      e2eWebhookWorstMs,
      measuredBriefsCount: measuredBriefs.length,
      seededBriefsCount,
      totalBriefsGenerated: briefs.length,
      activeModel: latestMeasuredBrief?.modelUsed ?? llmInfo.activeModel,
      extractionModel: llmInfo.extractionModel,
      providerMode: llmInfo.providerMode,
    },
    orbitValidation: {
      benchmarkName: 'Orbital Radar Public GP Conjunction (COSMOS 2612 vs ICEYE-X36)',
      referenceDistanceKm: replay.orbitalRadarBenchmark.referenceDistanceKm,
      referenceTcaUtc: replay.orbitalRadarBenchmark.referenceTcaUtc,
      specolaDistanceKm: replay.orbitalRadarBenchmark.specolaDistanceKm,
      specolaTcaUtc: replay.orbitalRadarBenchmark.specolaTcaUtc,
      specolaSuspectEpochUtc: closestEpochToTarget(hist68762),
      specolaProtectedEpochUtc: closestEpochToTarget(hist59103),
      specolaMethod: 'SGP4 60s→1s TCA on 2026-10-16T00:00Z–24:00Z (closest Oct 16 OMMs)',
      deltaKm: replay.orbitalRadarBenchmark.absoluteErrorKm,
      nov13CheckDistanceKm: nov13Sep ? Number(nov13Sep.distanceKm.toFixed(1)) : null,
      nov13PlaneAngleDeg: nov13Sep ? Number(nov13Sep.planeAngleDeg.toFixed(3)) : null,
      scan72hLatencyMs: latestRun?.durationMs ?? lastScan72hLatencyMs,
    },
    externalSources: {
      celestrakStatus: getCelestrakConnectionStatus(),
      spacetrackConfigured: Boolean(process.env.SPACETRACK_USER && process.env.SPACETRACK_PASS),
      contextDevConfigured: isContextDevConfigured(),
      aivenConfigured: dbStatus.aivenConfigured,
      cacheEntriesCount: countDiskCacheEntries(),
    },
    catalogInventory: {
      watchedCount: cachedSatellites.length,
      protectedCount,
      suspectCount,
      customFleetCount,
      pairsScreenedCount: totalPairsScreenedCount || cachedPairs.length,
      availableActivePayloads: catalogTotals.availableActivePayloads,
      availableTrackedObjects: catalogTotals.availableTrackedObjects,
    },
    autoSync: {
      enabled: true,
      intervalMinutes: 120,
      lastAutoSyncUtc: computedLastScanUtc,
      nextAutoSyncUtc: computedNextScanUtc,
      runsCompleted: autoSyncRunsCompleted,
      recentRuns,
    },
    contextDevUsage: {
      totalCalls: contextCalls.length,
      callsToday,
      liveCalls,
      cachedOrFallbackCalls: contextCalls.length - liveCalls,
      totalCreditsUsed: totalCredits,
      averageLatencyMs: avgCtxLatency,
      irrelevantSkippedCount,
      lastPullUtc,
      lastSeenChangeId,
      recentCalls: contextCalls,
      monitors: getActiveMonitorDefinitions(),
      operatorProfiles,
    },
    backtestSummary: btLatest ?? null,
  };
}

async function runOrbitRefreshAndRecord(reason: 'startup' | 'onload-stale' | 'interval'): Promise<void> {
  if (reason !== 'startup' || cachedSatellites.length === 0) {
    await refreshConstellationState(new Date(), true);
    await scanSuspectOrbitChanges(reason === 'interval');
  }
  const protectedCount = cachedSatellites.filter((s) => s.role === 'protected').length;
  await store.recordScreeningRun({
    id: `${reason}-${Date.now()}`,
    workersCount: protectedCount,
    pairsScreened: totalPairsScreenedCount || cachedPairs.length,
    durationMs: lastScan72hLatencyMs,
    topPairsSummary: cachedPairs.slice(0, 5).map((p) => ({
      pair: `${p.suspectNoradId}-${p.protectedNoradId}`,
      minDistanceKm: p.tca72h.minDistanceKm,
      tcaUtc: p.tca72h.tcaUtc,
    })),
  });
  const nowMs = Date.now();
  lastAutoSyncUtc = new Date(nowMs).toISOString();
  nextAutoSyncUtc = new Date(nowMs + AUTO_SYNC_INTERVAL_MS).toISOString();
  autoSyncRunsCompleted += 1;

  if (reason !== 'startup') {
    broadcastFeedItem({
      id: `feed-refresh-${nowMs}`,
      timestampUtc: lastAutoSyncUtc,
      kind: 'elements_ingested',
      headline: `Orbit Refresh (${reason === 'onload-stale' ? '>2h stale on load' : '2h sync'}): ${cachedSatellites.length} OMMs screened`,
      detail: `Space-Track/CelesTrak GP + Δv check complete (${lastScan72hLatencyMs} ms). Persisted to Aiven PostgreSQL.`,
      severity: 'info',
      sourceOrCalc: 'Space-Track / CelesTrak GP + Aiven PG',
    });
  }
}

async function ensureFreshOrbitDataOnLoad(): Promise<boolean> {
  const latestRun = store.listScreeningRuns(1)[0] ?? null;
  const latestMs = latestRun ? new Date(latestRun.executedAtUtc).getTime() : 0;
  const isStale = !latestRun || Number.isNaN(latestMs) || Date.now() - latestMs > AUTO_SYNC_INTERVAL_MS;
  if (!isStale) return false;

  if (!staleRefreshInFlight) {
    staleRefreshInFlight = runOrbitRefreshAndRecord('onload-stale')
      .then(() => true)
      .finally(() => {
        staleRefreshInFlight = null;
      });
  }
  return staleRefreshInFlight;
}

async function syncContextMonitorChangesIfStale(forcePull = false): Promise<number> {
  if (!isContextDevConfigured()) return 0;
  const lastPullIso = store.getKv('context_last_pull_utc');
  const lastPullMs = lastPullIso ? new Date(lastPullIso).getTime() : 0;
  const isStale = !lastPullIso || Number.isNaN(lastPullMs) || Date.now() - lastPullMs > CONTEXT_PULL_STALE_MS;
  if (!forcePull && !isStale) return 0;

  if (contextPullInFlight) {
    return contextPullInFlight;
  }

  contextPullInFlight = (async () => {
    try {
      const seenRaw = store.getKv('context_seen_change_ids');
      let seenArr: string[] = [];
      if (seenRaw) {
        try {
          const parsed = JSON.parse(seenRaw);
          if (Array.isArray(parsed)) seenArr = parsed.map(String);
        } catch {
          seenArr = [];
        }
      }
      const seenSet = new Set(seenArr);

      const { changes, latestChangeId, pulledAtUtc } = await pullNewMonitorChanges({
        seenChangeIds: seenSet,
        logCall: (entry) => store.logContextCall(entry),
      });

      await store.setKv('context_last_pull_utc', pulledAtUtc);
      if (latestChangeId) {
        await store.setKv('context_last_seen_change_id', latestChangeId);
      }

      if (changes.length === 0) return 0;

      const currentOmmMap: Record<number, OmmRecord[]> = {
        59103: [SEEDED_CURRENT_OMM_BY_NORAD[59103], ...HISTORICAL_OMM_59103],
        68762: [SEEDED_CURRENT_OMM_BY_NORAD[68762], ...HISTORICAL_OMM_68762],
      };
      for (const s of cachedSatellites) {
        if (!currentOmmMap[s.noradId]) {
          currentOmmMap[s.noradId] = [s.omm];
        }
      }
      const fallbackCatalog = cachedSatellites.map((s) => s.omm);

      let processedCount = 0;
      let skippedCount = Number(store.getKv('context_irrelevant_skipped_count') || 0);
      for (const chg of changes) {
        try {
          const rawText = [chg.title, chg.summary, chg.evidenceText].filter(Boolean).join('\n\n');
          const relCheck = isTextRelevantToWatchlist(`${chg.url} ${rawText}`);
          if (!relCheck.relevant) {
            skippedCount += 1;
            await store.setKv('context_irrelevant_skipped_count', String(skippedCount));
            broadcastFeedItem({
              id: `feed-ctxskip-${chg.id}`,
              timestampUtc: chg.detected_at || new Date().toISOString(),
              kind: 'monitor_fired',
              headline: `Monitor Change Skipped (irrelevant): ${chg.monitor_name}`,
              detail: `No watched satellite/NORAD/COSPAR/operator match — Gemini extraction skipped. (${chg.title.slice(0, 100)})`,
              severity: 'info',
              sourceOrCalc: chg.url,
            });
            seenSet.add(chg.id);
            continue;
          }

          broadcastFeedItem({
            id: `feed-ctxchg-${chg.id}`,
            timestampUtc: chg.detected_at,
            kind: 'monitor_fired',
            headline: `Monitor Change Pulled [${relCheck.matchedTerm}]: ${chg.monitor_name}`,
            detail: `${chg.title}${chg.summary ? ` — ${chg.summary}` : ''}`,
            severity: 'info',
            sourceOrCalc: chg.url,
          });

          const extraction = await extractStructuredClaimWithGemini({
            rawTextOrMarkdown: rawText.slice(0, 6000),
            sourceUrl: chg.url,
            publishedAt: chg.detected_at,
          });
          const extractedAtUtc = new Date().toISOString();

          broadcastFeedItem({
            id: `feed-ctxext-${chg.id}`,
            timestampUtc: extractedAtUtc,
            kind: 'claim_extracted',
            headline: `Claim Extracted (${extraction.modelUsed}, ${extraction.latencyMs} ms)`,
            detail: extraction.claim.claim_text,
            pairKey: extraction.claim.norad_ids.length >= 2 ? extraction.claim.norad_ids.slice(0, 2).join('-') : undefined,
            severity: 'info',
            sourceOrCalc: chg.url,
          });

          const verified = verifyClaimAgainstOrbits({
            id: `clm-chg-${chg.id}`,
            sourceTitle: chg.title,
            sourceOutlet: chg.monitor_name,
            claim: extraction.claim,
            ommHistoryByNorad: currentOmmMap,
            fallbackCatalog,
          });

          verified.provenanceStages = {
            monitor: { label: chg.monitor_name, timestampUtc: chg.detected_at },
            scrape: { endpoint: 'MCP list-changes / get-change', timestampUtc: pulledAtUtc, latencyMs: null },
            extract: { model: extraction.modelUsed, timestampUtc: extractedAtUtc, latencyMs: extraction.latencyMs },
          };

          await store.upsertClaim(verified);

          broadcastFeedItem({
            id: `feed-ctxver-${chg.id}`,
            timestampUtc: new Date().toISOString(),
            kind: 'claim_verified',
            headline: `Monitor SGP4 Verdict: ${verified.verdict.toUpperCase()}`,
            detail: verified.verdict_reason,
            pairKey: verified.norad_ids.length >= 2 ? verified.norad_ids.slice(0, 2).join('-') : undefined,
            severity: verified.verdict === 'contradicted' ? 'warning' : 'info',
            sourceOrCalc: verified.orbit_calc_reference,
          });

          seenSet.add(chg.id);
          processedCount += 1;
        } catch (err) {
          logWarn('context_change_process_err', { changeId: chg.id, error: String(err) });
        }
      }

      const updatedSeen = Array.from(seenSet).slice(-200);
      await store.setKv('context_seen_change_ids', JSON.stringify(updatedSeen));
      return processedCount;
    } finally {
      contextPullInFlight = null;
    }
  })();

  return contextPullInFlight;
}

async function startServer(): Promise<void> {
  await seedInitialOperationalDataset();
  const latestExistingRun = store.listScreeningRuns(1)[0] ?? null;
  const latestMs = latestExistingRun ? new Date(latestExistingRun.executedAtUtc).getTime() : 0;
  if (!latestExistingRun || Number.isNaN(latestMs) || Date.now() - latestMs > AUTO_SYNC_INTERVAL_MS) {
    await runOrbitRefreshAndRecord('startup');
  } else {
    lastAutoSyncUtc = latestExistingRun.executedAtUtc;
    nextAutoSyncUtc = new Date(latestMs + AUTO_SYNC_INTERVAL_MS).toISOString();
  }

  const autoSyncTimer = setInterval(() => {
    void runOrbitRefreshAndRecord('interval').catch((err) => {
      console.error('Background auto-sync error:', err);
    });
  }, AUTO_SYNC_INTERVAL_MS);
  autoSyncTimer.unref?.();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS locked to configured domain or local/AI Studio preview origins
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      const isAllowed =
        allowedOrigins.includes(origin) ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.endsWith('.run.app') ||
        origin.endsWith('.aistudio.google.com') ||
        origin.endsWith('specola.eu');
      if (isAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-key');
      }
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // In-memory sliding-window rate limiter for public & API routes (120 req/min per IP)
  const rateLimitBuckets = new Map<string, { count: number; resetAtMs: number }>();
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/feed' || req.path === '/health') {
      next();
      return;
    }
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const bucket = rateLimitBuckets.get(ip);
    if (!bucket || now > bucket.resetAtMs) {
      rateLimitBuckets.set(ip, { count: 1, resetAtMs: now + 60_000 });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > 120) {
      res.status(429).json({ error: 'Rate limit exceeded (120 requests/min). Retry shortly.' });
      return;
    }
    next();
  });

  // Structured health endpoint for uptime monitors & Aiven PostgreSQL checks
  app.get('/api/health', (_req: Request, res: Response) => {
    const db = store.getDatabaseStatus();
    res.json({
      ok: true,
      service: 'specola-api',
      timestampUtc: new Date().toISOString(),
      satellitesLoaded: cachedSatellites.length,
      pairsScreened: totalPairsScreenedCount || cachedPairs.length,
      maneuversDetected: cachedManeuvers.length,
      database: db.engine,
      aivenConnected: db.engine === 'aiven-postgresql',
      geminiConfigured: Boolean(
        process.env.GEMINI_API_KEY?.trim() ||
          (process.env.LLM_BASE_URL?.trim() && process.env.LLM_API_KEY?.trim()),
      ),
      activeModel: getConfiguredLlmProviderInfo().activeModel,
      contextDevConfigured: isContextDevConfigured(),
    });
  });

  // Serve CesiumJS static Workers, Assets, ThirdParty, and Widgets locally (token-free, zero CDN failure)
  const distCesiumDir = path.resolve(process.cwd(), 'dist', 'cesium');
  const nodeModulesCesiumDir = path.resolve(process.cwd(), 'node_modules', 'cesium', 'Build', 'Cesium');
  const cesiumStaticPath = fs.existsSync(distCesiumDir) ? distCesiumDir : nodeModulesCesiumDir;
  if (fs.existsSync(cesiumStaticPath)) {
    app.use('/cesium', express.static(cesiumStaticPath, { maxAge: '1d' }));
  }

  // --- SSE LIVE EVENT FEED (/api/feed) ---
  app.get('/api/feed', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const recent = store.listFeedItems(30);
    res.write(`event: init\ndata: ${JSON.stringify(recent)}\n\n`);
    sseClients.add(res);

    const keepAlive = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  // --- INITIAL WORKSPACE SNAPSHOT (/api/state) ---
  app.get('/api/state', async (_req: Request, res: Response) => {
    try {
      const [refreshedOnLoad] = await Promise.all([
        ensureFreshOrbitDataOnLoad(),
        syncContextMonitorChangesIfStale(false).catch((err) => {
          logWarn('state_context_pull_warn', { error: String(err) });
          return 0;
        }),
      ]);
      // Re-propagate live satellite geodetic positions & closed rings if >15s old
      if (!refreshedOnLoad && Date.now() - lastOrbitTrackEpochMs > 15_000) {
        await refreshConstellationState(new Date(), false);
      }
      const metrics = await buildSystemMetrics();
      res.json({
        satellites: cachedSatellites,
        pairs: cachedPairs,
        maneuvers: cachedManeuvers,
        events: store.listEvents(),
        claims: store.listClaims(),
        briefs: store.listBriefs(),
        feed: store.listFeedItems(35),
        fleetSubscriptions: store.listFleetSubscriptions(),
        alertDeliveries: store.listAlertDeliveries(30),
        apiKeys: store.listApiKeys(),
        metrics,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load workspace state' });
    }
  });

  // --- CONSTELLATION GROUP CATALOGS (/api/groups/:group) ---
  app.get('/api/groups/:group', async (req: Request, res: Response) => {
    try {
      const group = String(req.params.group || 'watched') as SatelliteGroupId;
      const validGroups: SatelliteGroupId[] = [
        'watched',
        'stations',
        'active',
        'starlink',
        'weather',
        'gps-ops',
      ];
      if (!validGroups.includes(group)) {
        res.status(400).json({ error: `Unsupported orbital group '${group}'` });
        return;
      }
      if (group === 'watched') {
        res.json({
          group,
          provenance: getCelestrakConnectionStatus(),
          satellites: cachedSatellites,
        });
        return;
      }

      const now = new Date();
      const { records, provenance } = await fetchSatelliteGroupOmms(group);
      const watchedById = new Map(cachedSatellites.map((s) => [s.noradId, s]));
      const satellites: WatchedSatellite[] = [];

      for (const omm of records) {
        const existing = watchedById.get(omm.NORAD_CAT_ID);
        if (existing) {
          satellites.push(existing);
          continue;
        }
        const state = propagateOmmAt(omm, now, true);
        if (!state) continue;
        const meanMotion = Number(omm.MEAN_MOTION) > 0 ? Number(omm.MEAN_MOTION) : 15;
        const regime = meanMotion < 2 ? 'GEO' : meanMotion < 6 ? 'MEO' : 'LEO';
        const orbitTrack = generateOrbitTrackGeo(omm, now);
        satellites.push({
          noradId: omm.NORAD_CAT_ID,
          name: omm.OBJECT_NAME,
          role: 'catalog',
          operator: `${group.toUpperCase()} Catalog`,
          country: group === 'stations' ? 'INTL' : 'CAT',
          orbitRegime: regime,
          omm,
          provenance,
          epochAgeHours: Number(
            (Math.abs(now.getTime() - new Date(omm.EPOCH).getTime()) / 3600_000).toFixed(1),
          ),
          positionGeodetic: {
            latDeg: Number(state.latDeg.toFixed(4)),
            lonDeg: Number(state.lonDeg.toFixed(4)),
            altKm: Number(state.altKm.toFixed(2)),
            speedKms: Number(state.speedKms.toFixed(3)),
          },
          orbitTrack,
        });
      }

      void store.saveOmmElements(satellites.map((s) => s.omm));

      res.json({
        group,
        provenance,
        satellites,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Group catalog fetch failed' });
    }
  });

  // --- EVENTS & BRIEFS ---
  app.get('/api/events', (_req: Request, res: Response) => {
    res.json({ events: store.listEvents() });
  });

  app.get('/api/events/:id', (req: Request, res: Response) => {
    const evt = store.getEventById(String(req.params.id));
    if (!evt) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    const brief = store.getBriefById(evt.briefId);
    const claims = store
      .listClaims()
      .filter(
        (c) =>
          c.norad_ids.includes(evt.suspectNoradId) || c.norad_ids.includes(evt.protectedNoradId),
      );
    res.json({ event: evt, brief, claims });
  });

  app.get('/api/briefs/:id', (req: Request, res: Response) => {
    const brief = store.getBriefById(String(req.params.id));
    if (!brief) {
      res.status(404).json({ error: 'Decision brief not found' });
      return;
    }
    res.json({ brief });
  });

  const SAT_DOSSIER_TTL_MS = 24 * 3600 * 1000;
  const satDossierMemoryCache = new Map<number, { profile: SatelliteDossierProfile; expiresMs: number }>();
  const satDossierInFlight = new Map<number, Promise<SatelliteDossierProfile>>();

  const resolveSatelliteDossier = async (noradId: number): Promise<SatelliteDossierProfile> => {
    const now = Date.now();
    const memHit = satDossierMemoryCache.get(noradId);
    if (memHit && memHit.expiresMs > now) {
      return memHit.profile;
    }

    const diskPath = path.resolve(process.cwd(), 'data', 'cache', `sat_dossier_${noradId}.json`);
    if (fs.existsSync(diskPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(diskPath, 'utf8')) as {
          savedAtMs: number;
          profile: SatelliteDossierProfile;
        };
        if (raw?.profile && now - raw.savedAtMs < SAT_DOSSIER_TTL_MS) {
          satDossierMemoryCache.set(noradId, {
            profile: raw.profile,
            expiresMs: raw.savedAtMs + SAT_DOSSIER_TTL_MS,
          });
          return raw.profile;
        }
      } catch {
        // Re-fetch cleanly on corrupt cache file
      }
    }

    const pending = satDossierInFlight.get(noradId);
    if (pending) return pending;

    const job = (async () => {
      const watchlist = loadWatchlistsConfig();
      const wlEntry =
        watchlist.find((w) => w.norad_id === noradId) ??
        customWatchedEntries.find((w) => w.norad_id === noradId);
      const cachedSat = cachedSatellites.find((s) => s.noradId === noradId);
      const satcat = await fetchSatcatMetadata(noradId).catch(() => null);

      const satName =
        cachedSat?.name || wlEntry?.name || satcat?.objectName || `NORAD ${noradId}`;
      const cosparId = cachedSat?.omm?.OBJECT_ID || satcat?.objectId || '';
      const query = `"${satName}"${cosparId ? ` "${cosparId}"` : ''} satellite launched built by manufacturer operator mission`;

      const webSearch = await contextSearchWatchedObjects(query, (entry) =>
        store.logContextCall(entry),
      );

      const profile = await extractSatelliteDossierWithGemini({
        noradId,
        name: satName,
        cosparId,
        satcatOwner: satcat?.owner ?? null,
        satcatLaunchDate: satcat?.launchDate ?? null,
        watchlistOperator: wlEntry?.operator ?? cachedSat?.operator ?? null,
        watchlistCountry: wlEntry?.country ?? cachedSat?.country ?? null,
        watchlistMission: wlEntry?.mission ?? null,
        watchlistNotes: wlEntry?.notes ?? cachedSat?.notes ?? null,
        webHits: webSearch.hits,
      });

      try {
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs.writeFileSync(
          diskPath,
          JSON.stringify({ savedAtMs: Date.now(), profile }, null, 2),
          'utf8',
        );
      } catch {
        // Non-fatal cache write failure
      }

      satDossierMemoryCache.set(noradId, {
        profile,
        expiresMs: Date.now() + SAT_DOSSIER_TTL_MS,
      });
      return profile;
    })().finally(() => {
      satDossierInFlight.delete(noradId);
    });

    satDossierInFlight.set(noradId, job);
    return job;
  };

  const buildPairContextDossier = async (params: {
    suspectNoradId: number;
    protectedNoradId: number;
    encounterHits?: AlarmContextHit[];
    alarmTimestampUtc?: string | null;
  }): Promise<PairContextDossier> => {
    const [approaching, protectedSat] = await Promise.all([
      resolveSatelliteDossier(params.suspectNoradId),
      resolveSatelliteDossier(params.protectedNoradId),
    ]);

    let hits = params.encounterHits;
    if (!hits) {
      const encounterQuery = `"${approaching.name}" "${protectedSat.name}" satellite orbit maneuver OR conjunction OR RPO`;
      const res = await contextSearchWatchedObjects(encounterQuery, (entry) =>
        store.logContextCall(entry),
      );
      hits = res.hits;
    }

    const datedHitTimes = hits
      .map((h) => (h.publishedAt ? new Date(h.publishedAt).getTime() : NaN))
      .filter((ms) => Number.isFinite(ms))
      .sort((a, b) => a - b);
    const earliestPublicReportUtc =
      datedHitTimes.length > 0 ? new Date(datedHitTimes[0]).toISOString() : null;

    const alarmMs = params.alarmTimestampUtc ? new Date(params.alarmTimestampUtc).getTime() : NaN;
    const isPublicInfo = hits.length > 0;
    const alertedBeforeFirstNews =
      isPublicInfo &&
      Number.isFinite(alarmMs) &&
      datedHitTimes.length > 0 &&
      datedHitTimes[0] - alarmMs > 6 * 3600_000;

    const publicInfoLabel = !isPublicInfo
      ? 'Not public info yet (0 web reports)'
      : alertedBeforeFirstNews && earliestPublicReportUtc
        ? `Private when detected · First public report ${earliestPublicReportUtc.slice(0, 10)}`
        : `Publicly reported (${hits.length} web source${hits.length === 1 ? '' : 's'})`;

    const publicInfoDetail = !isPublicInfo
      ? 'Context.dev searched open news, tracker blogs, and advisories and found zero public reports linking these two satellites yet.'
      : alertedBeforeFirstNews && earliestPublicReportUtc
        ? `When this orbital event occurred, it was not public info. Public coverage only began on ${earliestPublicReportUtc.slice(0, 10)} (${hits.length} source${hits.length === 1 ? '' : 's'} now indexed).`
        : `Context.dev found ${hits.length} public web report${hits.length === 1 ? '' : 's'} discussing this approach or pair.`;

    const isForeignDefenseApproach =
      approaching.category === 'defense_inspector' ||
      /russia|russian|china|chinese|vks|pla/i.test(
        `${approaching.countryLabel} ${approaching.operator}`,
      );

    const identityContrastHeadline = isForeignDefenseApproach
      ? `${approaching.countryLabel} defense spacecraft (${approaching.name}) approaching ${protectedSat.countryLabel} asset (${protectedSat.name})`
      : `${approaching.countryLabel} spacecraft (${approaching.name}) near ${protectedSat.countryLabel} asset (${protectedSat.name})`;

    const identityContrastExplanation = isForeignDefenseApproach
      ? `${approaching.name} is operated by ${approaching.operator} (launched ${approaching.launchedDate}, built by ${approaching.builtBy}) — not another European commercial smallsat. When a foreign military/inspection craft enters the same orbital corridor as ${protectedSat.name} (${protectedSat.operator}, built by ${protectedSat.builtBy}), operators must treat RF exposure, optical/SAR collection, and follow-on rendezvous maneuvers very differently than a routine commercial conjunction.`
      : `${approaching.name} is operated by ${approaching.operator} (launched ${approaching.launchedDate}, built by ${approaching.builtBy}), closing near ${protectedSat.name} (${protectedSat.operator}). Identifying both operators and spacecraft missions tells flight dynamics teams whether routine operator-to-operator coordination applies or heightened counter-RPO posture is needed.`;

    return {
      pairKey: `${params.suspectNoradId}-${params.protectedNoradId}`,
      approaching,
      protectedSat,
      identityContrastHeadline,
      identityContrastExplanation,
      isPublicInfo,
      publicInfoLabel,
      publicInfoDetail,
      earliestPublicReportUtc,
    };
  };

  // --- ORBIT -> CONTEXT.DEV LIVE AMATEUR & WEB INTELLIGENCE SWEEP ---
  const runOrbitTriggeredContextSweep = async (
    suspectNoradId: number,
    suspectName: string,
    protectedNoradId: number,
    protectedName: string,
  ): Promise<number> => {
    const query = `"${suspectName}" OR "${suspectNoradId}" "${protectedName}" OR "${protectedNoradId}" RPO conjunction amateur tracker`;
    const [searchResult] = await Promise.all([
      contextSearchWatchedObjects(query, (entry) => store.logContextCall(entry)),
      resolveSatelliteDossier(suspectNoradId).catch(() => null),
      resolveSatelliteDossier(protectedNoradId).catch(() => null),
    ]);

    broadcastFeedItem({
      id: `feed-ctx-sweep-${Date.now()}`,
      timestampUtc: new Date().toISOString(),
      kind: 'monitor_fired',
      headline: `Orbit → Context.dev Sweep: ${suspectName} ↔ ${protectedName}`,
      detail: `Auto-identified both spacecraft + pulled ${searchResult.hits.length} web/amateur hit(s) (${searchResult.mode})${
        searchResult.hits[0] ? ` — top: ${searchResult.hits[0].title}` : ''
      }`,
      pairKey: `${suspectNoradId}-${protectedNoradId}`,
      severity: 'info',
      sourceOrCalc: searchResult.hits[0]?.url || `Context.dev /web/search (${query})`,
    });

    const existingUrls = new Set(store.listClaims().map((c) => c.source_url));
    let newlyVerifiedCount = 0;

    for (const hit of searchResult.hits.slice(0, 2)) {
      if (!hit.url || existingUrls.has(hit.url) || !hit.snippet) continue;
      try {
        const extraction = await extractStructuredClaimWithGemini({
          rawTextOrMarkdown: `${hit.title}\n${hit.snippet}`,
          sourceUrl: hit.url,
          publishedAt: hit.publishedAt ?? new Date().toISOString(),
        });
        if (extraction.claim.norad_ids.length === 0) {
          extraction.claim.norad_ids = [suspectNoradId, protectedNoradId];
        }
        if (extraction.claim.satellite_names.length === 0) {
          extraction.claim.satellite_names = [suspectName, protectedName];
        }

        const { suspectHistory: h68762, protectedHistory: h59103 } = await fetchHistoricalOmmPair(
          68762,
          59103,
          '2026-09-20',
          '2026-11-14',
        );
        const sweepOmmMap: Record<number, OmmRecord[]> = {
          59103: [SEEDED_CURRENT_OMM_BY_NORAD[59103], ...h59103],
          68762: [SEEDED_CURRENT_OMM_BY_NORAD[68762], ...h68762],
        };
        for (const sat of cachedSatellites) {
          if (!sweepOmmMap[sat.noradId]) sweepOmmMap[sat.noradId] = [sat.omm];
        }
        const verified = verifyClaimAgainstOrbits({
          id: `clm-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sourceTitle: hit.title || 'Context.dev Web & Amateur Tracker Hit',
          sourceOutlet: (() => {
            try {
              return new URL(hit.url).hostname.replace(/^www\./, '');
            } catch {
              return 'Context.dev Web';
            }
          })(),
          claim: extraction.claim,
          ommHistoryByNorad: sweepOmmMap,
          fallbackCatalog: cachedSatellites.map((s) => s.omm),
        });

        const sweepTs = new Date().toISOString();
        verified.provenanceStages = {
          monitor: { label: 'Context.dev Web Search', timestampUtc: sweepTs },
          scrape: { endpoint: 'MCP web-search', timestampUtc: sweepTs, latencyMs: null },
          extract: { model: extraction.modelUsed, timestampUtc: sweepTs, latencyMs: extraction.latencyMs },
        };

        await store.upsertClaim(verified);
        existingUrls.add(hit.url);
        newlyVerifiedCount += 1;

        broadcastFeedItem({
          id: `feed-sweep-ver-${Date.now()}-${newlyVerifiedCount}`,
          timestampUtc: new Date().toISOString(),
          kind: 'claim_verified',
          headline: `Web Hit ${verified.verdict.toUpperCase()}: ${suspectName} / ${protectedName}`,
          detail: verified.verdict_reason,
          pairKey: `${suspectNoradId}-${protectedNoradId}`,
          severity: verified.verdict === 'contradicted' ? 'warning' : 'info',
          sourceOrCalc: hit.url,
        });
      } catch {
        // Keep sweep non-blocking if an individual snippet lacks structured orbital claims
      }
    }

    return newlyVerifiedCount;
  };

  // --- LIVE GEMINI DECISION BRIEF SYNTHESIS (CACHED + SSE STREAMING) ---
  async function loadBriefGenerationInputs(eventId: string) {
    const evt = store.getEventById(eventId) ?? store.listEvents()[0];
    if (!evt) return null;

    const pairSnap =
      cachedPairs.find(
        (p) =>
          p.suspectNoradId === evt.suspectNoradId &&
          p.protectedNoradId === evt.protectedNoradId,
      ) ?? cachedPairs[0];

    const relevantClaims = store
      .listClaims()
      .filter(
        (c) =>
          c.norad_ids.includes(evt.suspectNoradId) ||
          c.norad_ids.includes(evt.protectedNoradId),
      );

    let suspectHist = HISTORICAL_OMM_68762;
    let protectedHist = HISTORICAL_OMM_59103;
    if (evt.suspectNoradId === 68762 && evt.protectedNoradId === 59103) {
      const fullHist = await fetchHistoricalOmmPair(68762, 59103, '2026-09-20', '2026-11-14');
      suspectHist = fullHist.suspectHistory;
      protectedHist = fullHist.protectedHistory;
    } else {
      const fetchedHist = await fetchHistoricalOmmPair(evt.suspectNoradId, evt.protectedNoradId);
      if (fetchedHist) {
        suspectHist = fetchedHist.suspectHistory;
        protectedHist = fetchedHist.protectedHistory;
      } else {
        const sCurr = cachedSatellites.find((s) => s.noradId === evt.suspectNoradId)?.omm;
        const pCurr = cachedSatellites.find((s) => s.noradId === evt.protectedNoradId)?.omm;
        suspectHist = sCurr ? [sCurr] : [];
        protectedHist = pCurr ? [pCurr] : [];
      }
    }
    const maneuvers =
      suspectHist.length > 1 && protectedHist.length > 0
        ? detectManeuversFromHistory(suspectHist, protectedHist)
        : [];

    const inputsHash = computeBriefInputsHash({
      event: evt,
      claims: relevantClaims,
      pairTelemetry: pairSnap,
      maneuvers,
    });

    return { evt, pairSnap, relevantClaims, maneuvers, inputsHash };
  }

  app.post('/api/briefs/generate', async (req: Request, res: Response) => {
    try {
      const eventId = String(req.body?.eventId || 'evt-rpo-68762-59103');
      const force = Boolean(req.body?.force);
      const inputs = await loadBriefGenerationInputs(eventId);
      if (!inputs) {
        res.status(404).json({ error: 'Target orbital event not found' });
        return;
      }

      const existingBrief = store.getBriefById(inputs.evt.briefId);
      if (!force && existingBrief && !existingBrief.isSeeded && existingBrief.inputsHash === inputs.inputsHash) {
        res.json({
          brief: { ...existingBrief, cached: true },
          claims: store.listClaims(),
          cached: true,
        });
        return;
      }

      // Trigger live Context.dev search from orbital pair telemetry before fresh brief synthesis
      await runOrbitTriggeredContextSweep(
        inputs.evt.suspectNoradId,
        inputs.evt.suspectName,
        inputs.evt.protectedNoradId,
        inputs.evt.protectedName,
      );

      const refreshedClaims = store
        .listClaims()
        .filter(
          (c) =>
            c.norad_ids.includes(inputs.evt.suspectNoradId) ||
            c.norad_ids.includes(inputs.evt.protectedNoradId),
        );
      const freshHash = computeBriefInputsHash({
        event: inputs.evt,
        claims: refreshedClaims,
        pairTelemetry: inputs.pairSnap,
        maneuvers: inputs.maneuvers,
      });

      const generated = await synthesizeDecisionBriefWithGemini({
        event: inputs.evt,
        claims: refreshedClaims,
        pairTelemetry: inputs.pairSnap,
        maneuvers: inputs.maneuvers,
      });

      const stored: StoredDecisionBrief = {
        id: inputs.evt.briefId,
        eventId: inputs.evt.id,
        generatedAtUtc: new Date().toISOString(),
        modelUsed: generated.modelUsed,
        latencyMs: generated.latencyMs,
        isSeeded: false,
        inputsHash: freshHash,
        cached: false,
        ...generated.brief,
      };

      await store.upsertBrief(stored);

      broadcastFeedItem({
        id: `feed-brief-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'brief_generated',
        headline: `Brief Synthesized: ${inputs.evt.suspectName} ↔ ${inputs.evt.protectedName} (${generated.latencyMs} ms)`,
        detail: `${stored.threat_level} · ${stored.evidence.length} date-sourced items (${generated.modelUsed})`,
        pairKey: inputs.evt.pairKey,
        severity: stored.threat_level === 'HIGH' ? 'critical' : 'info',
        sourceOrCalc: `Model: ${generated.modelUsed}`,
      });

      res.json({ brief: stored, claims: store.listClaims(), cached: false });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'Gemini API brief synthesis failed. Check GEMINI_API_KEY in Settings > Secrets.',
      });
    }
  });

  app.post('/api/briefs/stream', async (req: Request, res: Response) => {
    const eventId = String(req.body?.eventId || 'evt-rpo-68762-59103');
    const force = Boolean(req.body?.force);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const inputs = await loadBriefGenerationInputs(eventId);
      if (!inputs) {
        writeEvent('error', { error: 'Target orbital event not found' });
        res.end();
        return;
      }

      const existingBrief = store.getBriefById(inputs.evt.briefId);
      if (!force && existingBrief && !existingBrief.isSeeded && existingBrief.inputsHash === inputs.inputsHash) {
        writeEvent('done', {
          brief: { ...existingBrief, cached: true },
          claims: store.listClaims(),
          cached: true,
        });
        res.end();
        return;
      }

      const generated = await synthesizeDecisionBriefStreamWithGemini(
        {
          event: inputs.evt,
          claims: inputs.relevantClaims,
          pairTelemetry: inputs.pairSnap,
          maneuvers: inputs.maneuvers,
        },
        (delta, totalChars) => {
          writeEvent('chunk', { delta, totalChars });
        },
      );

      const stored: StoredDecisionBrief = {
        id: inputs.evt.briefId,
        eventId: inputs.evt.id,
        generatedAtUtc: new Date().toISOString(),
        modelUsed: generated.modelUsed,
        latencyMs: generated.latencyMs,
        isSeeded: false,
        inputsHash: inputs.inputsHash,
        cached: false,
        ...generated.brief,
      };

      await store.upsertBrief(stored);

      broadcastFeedItem({
        id: `feed-brief-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'brief_generated',
        headline: `Brief Streamed: ${inputs.evt.suspectName} ↔ ${inputs.evt.protectedName} (${generated.latencyMs} ms)`,
        detail: `${stored.threat_level} · ${stored.evidence.length} date-sourced items (${generated.modelUsed})`,
        pairKey: inputs.evt.pairKey,
        severity: stored.threat_level === 'HIGH' ? 'critical' : 'info',
        sourceOrCalc: `Model: ${generated.modelUsed}`,
      });

      writeEvent('done', { brief: stored, claims: store.listClaims(), cached: false });
      res.end();
    } catch (err) {
      writeEvent('error', {
        error: err instanceof Error ? err.message : 'Streaming Gemini brief synthesis failed',
      });
      res.end();
    }
  });

  // --- BLIND CHRONOLOGICAL BACKTEST (/api/backtest & /api/backtest/run) ---
  app.get('/api/backtest', async (_req: Request, res: Response) => {
    try {
      const result = await ensureBacktestCached(false);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load backtest results' });
    }
  });

  app.post('/api/backtest/run', async (_req: Request, res: Response) => {
    try {
      const result = await ensureBacktestCached(true);
      const metrics = await buildSystemMetrics();
      res.json({ backtest: result, metrics });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Backtest execution failed' });
    }
  });

  // --- HISTORICAL SNAPSHOT + ALARMS AT ANY TIMESTAMP (/api/orbit/at?ts=...) ---
  app.get('/api/orbit/at', async (req: Request, res: Response) => {
    try {
      const tsRaw = req.query.ts ? String(req.query.ts) : new Date().toISOString();
      const targetDate = new Date(tsRaw);
      if (Number.isNaN(targetDate.getTime())) {
        res.status(400).json({ error: `Invalid timestamp '${tsRaw}'` });
        return;
      }

      const targetMs = targetDate.getTime();
      const targetIso = targetDate.toISOString();
      const watchlist = loadWatchlistsConfig();
      const noradIds = watchlist.map((w) => w.norad_id);

      const { byNorad, provenance, windowLabel } = await fetchHistoricalWatchlistWindow(
        targetDate,
        noradIds,
      );

      const satellites: WatchedSatellite[] = [];
      for (const entry of watchlist) {
        const list = byNorad[entry.norad_id] ?? [];
        if (list.length === 0) continue;

        // Pick closest OMM within ±14 days of targetMs (preferring CREATION_DATE or EPOCH <= targetMs + 6h)
        let bestOmm: OmmRecord | null = null;
        let bestScore = Infinity;
        for (const omm of list) {
          const epMs = new Date(omm.EPOCH).getTime();
          if (Number.isNaN(epMs)) continue;
          const diff = Math.abs(epMs - targetMs);
          if (diff > 16 * 86400_000) continue;
          const penalty = epMs > targetMs + 6 * 3600_000 ? 6 * 3600_000 : 0;
          if (diff + penalty < bestScore) {
            bestScore = diff + penalty;
            bestOmm = omm;
          }
        }
        if (!bestOmm) continue;

        const state = propagateOmmAt(bestOmm, targetDate, true);
        if (!state) continue;

        const orbitTrack = generateOrbitTrackGeo(bestOmm, targetDate, undefined, undefined, 360);
        satellites.push({
          noradId: entry.norad_id,
          name: entry.name,
          role: entry.role,
          operator: entry.operator,
          country: entry.country,
          orbitRegime: entry.orbit_regime,
          mission: entry.mission,
          notes: entry.notes,
          omm: bestOmm,
          provenance,
          epochAgeHours: Number(
            (Math.abs(targetMs - new Date(bestOmm.EPOCH).getTime()) / 3600_000).toFixed(1),
          ),
          positionGeodetic: {
            latDeg: Number(state.latDeg.toFixed(4)),
            lonDeg: Number(state.lonDeg.toFixed(4)),
            altKm: Number(state.altKm.toFixed(2)),
            speedKms: Number(state.speedKms.toFixed(3)),
          },
          orbitTrack,
        });
      }

      // Build chronological alarms active at or before targetMs (zero look-ahead)
      const alarms: HistoricalAlarmItem[] = [];
      const seenAlarmKeys = new Set<string>();
      const pushAlarm = (item: HistoricalAlarmItem) => {
        const key = `${item.tier}-${item.timestampUtc.slice(0, 13)}-${item.headline.slice(0, 32)}`;
        if (seenAlarmKeys.has(key)) return;
        seenAlarmKeys.add(key);
        alarms.push(item);
      };

      const protectedHist59103 = byNorad[59103] ?? [];
      for (const entry of watchlist) {
        if (entry.role !== 'suspect') continue;
        const hist = (byNorad[entry.norad_id] ?? []).filter(
          (o) => new Date(o.CREATION_DATE || o.EPOCH).getTime() <= targetMs + 3600_000,
        );
        if (hist.length < 2) continue;
        const targetHist = entry.norad_id === 68762 ? protectedHist59103 : [];
        const detected = detectManeuversFromHistory(hist, targetHist);
        for (const m of detected) {
          if (new Date(m.epochAfterUtc).getTime() <= targetMs) {
            const altDir =
              Math.abs(m.deltaSemiMajorAxisKm) >= 0.3
                ? m.deltaSemiMajorAxisKm > 0
                  ? `raised its orbit by ${m.deltaSemiMajorAxisKm.toFixed(1)} km`
                  : `lowered its orbit by ${Math.abs(m.deltaSemiMajorAxisKm).toFixed(1)} km`
                : 'adjusted its orbital plane';
            pushAlarm({
              id: `hist-${m.id}`,
              timestampUtc: m.epochAfterUtc,
              tier: 'MANEUVER',
              headline:
                m.isApproachSignature && m.targetName
                  ? `${m.satelliteName} maneuvered toward ${m.targetName}`
                  : `${m.satelliteName} changed its orbit`,
              cause:
                m.isApproachSignature && m.targetName
                  ? `Thruster burn (${m.estimatedDeltaVMs.toFixed(1)} m/s) converging on ${m.targetName}`
                  : `Thruster burn (${m.estimatedDeltaVMs.toFixed(1)} m/s, ${altDir})`,
              detail:
                m.isApproachSignature && m.targetName
                  ? `${m.satelliteName} fired thrusters (Δv ≈ ${m.estimatedDeltaVMs.toFixed(1)} m/s) and ${altDir}, moving into a ${m.postManeuverRangeKm ?? 'close'} km pass of ${m.targetName}.`
                  : `${m.satelliteName} executed an orbital burn (Δv ≈ ${m.estimatedDeltaVMs.toFixed(1)} m/s) and ${altDir}.`,
              satelliteName: m.satelliteName,
              noradId: m.noradId,
              pairKey: m.targetNoradId ? `${m.noradId}-${m.targetNoradId}` : undefined,
              eventId: m.noradId === 68762 ? 'evt-rpo-68762-59103' : undefined,
            });
          }
        }
      }

      // Include verified Oct 2026 blind backtest alerts + public reports if targetMs falls in/after Oct 2026
      if (targetIso >= '2026-09-20T00:00:00Z') {
        const bt = await ensureBacktestCached(false);
        for (const f of bt.cosmosIceye.allFirings) {
          if (new Date(f.creationDateUtc).getTime() <= targetMs) {
            pushAlarm({
              id: `bt-${f.tier}-${f.creationDateUtc}`,
              timestampUtc: f.creationDateUtc,
              tier: f.tier,
              headline:
                f.tier === 'WATCH'
                  ? `${f.suspectName} adjusted inclination toward ${f.protectedName}`
                  : f.tier === 'WARNING'
                    ? `${f.suspectName} locked into ${f.protectedName}'s orbital plane`
                    : `${f.suspectName} closing within ${f.tca72hKm.toFixed(1)} km of ${f.protectedName}`,
              cause:
                f.tier === 'WATCH'
                  ? `Inclination trim burn (${f.deltaVMs?.toFixed(1) ?? '4.0'} m/s) aligning toward ${f.protectedName}'s path`
                  : f.tier === 'WARNING'
                    ? `Orbital planes locked within ${f.planeAngleDeg.toFixed(3)}° while closing in`
                    : `Predicted close pass inside ${f.tca72hKm.toFixed(1)} km after braking burn`,
              detail: f.triggerSummary,
              satelliteName: f.suspectName,
              noradId: f.suspectNoradId,
              pairKey: `${f.suspectNoradId}-${f.protectedNoradId}`,
              eventId: 'evt-rpo-68762-59103',
            });
          }
        }
        for (const ref of COSMOS_ICEYE_PUBLIC_REFERENCES) {
          if (ref.kind === 'public_report' && new Date(ref.timestampUtc).getTime() <= targetMs) {
            pushAlarm({
              id: ref.id,
              timestampUtc: ref.timestampUtc,
              tier: 'REPORTED',
              headline: ref.label,
              cause: 'Public analyst / media report published on this close approach',
              detail: ref.notes,
              satelliteName: 'COSMOS 2612',
              noradId: 68762,
              pairKey: '68762-59103',
              eventId: 'evt-rpo-68762-59103',
              sourceUrl: ref.sourceUrl ?? undefined,
            });
          }
        }
      }

      alarms.sort((a, b) => b.timestampUtc.localeCompare(a.timestampUtc));

      const payload: HistoricalOrbitStatePayload = {
        timestampUtc: targetIso,
        provenance,
        satellites,
        alarms: alarms.slice(0, 24),
        note: `${satellites.length} on-orbit watchlist spacecraft from ${windowLabel}`,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Historical snapshot query failed',
      });
    }
  });

  // --- HIGH-RES SGP4 PAIR TRACK FOR SMOOTH CLOSEUP APPROACH (/api/orbit/pair-track) ---
  app.get('/api/orbit/pair-track', async (req: Request, res: Response) => {
    try {
      const pairParam = String(req.query.pair || '68762,59103');
      const [sRaw, pRaw] = pairParam.split(',').map((s) => Number(s.trim()));
      const suspectId = Number.isFinite(sRaw) && sRaw > 0 ? sRaw : 68762;
      const protectedId = Number.isFinite(pRaw) && pRaw > 0 ? pRaw : 59103;
      const centerDate = req.query.center ? new Date(String(req.query.center)) : new Date();
      if (Number.isNaN(centerDate.getTime())) {
        res.status(400).json({ error: 'Invalid center timestamp' });
        return;
      }

      const centerMs = centerDate.getTime();
      const beforeMin = Math.min(30, Math.max(2, Number(req.query.beforeMin || 10)));
      const afterMin = Math.min(60, Math.max(5, Number(req.query.afterMin || 30)));
      const stepSec = Math.min(30, Math.max(2, Number(req.query.stepSec || 3)));
      const stepMs = stepSec * 1000;
      const startMs = Math.floor((centerMs - beforeMin * 60_000) / stepMs) * stepMs;
      const endMs = centerMs + afterMin * 60_000;

      const pickOmm = (list: OmmRecord[]): OmmRecord | null => {
        let best: OmmRecord | null = null;
        let bestScore = Infinity;
        for (const omm of list) {
          const epMs = new Date(omm.EPOCH).getTime();
          if (Number.isNaN(epMs)) continue;
          const diff = Math.abs(epMs - centerMs);
          if (diff > 16 * 86400_000) continue;
          const penalty = epMs > centerMs + 6 * 3600_000 ? 6 * 3600_000 : 0;
          if (diff + penalty < bestScore) {
            bestScore = diff + penalty;
            best = omm;
          }
        }
        return best;
      };

      const isHist = Math.abs(Date.now() - centerMs) > 6 * 3600_000;
      let sOmm: OmmRecord | null = null;
      let pOmm: OmmRecord | null = null;

      if (isHist) {
        const { byNorad } = await fetchHistoricalWatchlistWindow(centerDate, [suspectId, protectedId]);
        sOmm = pickOmm(byNorad[suspectId] ?? []);
        pOmm = pickOmm(byNorad[protectedId] ?? []);
      }

      if (!sOmm) {
        sOmm = cachedSatellites.find((s) => s.noradId === suspectId)?.omm ?? null;
      }
      if (!pOmm) {
        pOmm = cachedSatellites.find((s) => s.noradId === protectedId)?.omm ?? null;
      }

      if (!sOmm || !pOmm) {
        res.status(404).json({ error: 'Unable to resolve OMMs for requested pair' });
        return;
      }

      const recS = ommToSatrec(sOmm);
      const recP = ommToSatrec(pOmm);
      const points: [number, number, number, number, number, number, number, number, number][] = [];

      for (let t = startMs; t <= endMs; t += stepMs) {
        const dt = new Date(t);
        const stS = propagateSatrecAt(recS, dt, true);
        const stP = propagateSatrecAt(recP, dt, true);
        if (!stS || !stP) continue;
        points.push([
          t,
          Number(stS.latDeg.toFixed(5)),
          Number(stS.lonDeg.toFixed(5)),
          Number(stS.altKm.toFixed(3)),
          Number(stS.speedKms.toFixed(3)),
          Number(stP.latDeg.toFixed(5)),
          Number(stP.lonDeg.toFixed(5)),
          Number(stP.altKm.toFixed(3)),
          Number(stP.speedKms.toFixed(3)),
        ]);
      }

      res.json({
        suspectNoradId: suspectId,
        protectedNoradId: protectedId,
        startMs,
        stepMs,
        points,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'High-res pair track generation failed',
      });
    }
  });

  // --- MAY->OCT MEGA-TIMELAPSE + 3S CLOSEUP SGP4 TRACK FOR DEMO (/api/orbit/demo-timelapse) ---
  let cachedDemoTimelapse: {
    suspectNoradId: number;
    protectedNoradId: number;
    startMs: number;
    stepMs: number;
    points: [number, number, number, number, number, number, number, number, number][];
  } | null = null;

  app.get('/api/orbit/demo-timelapse', async (_req: Request, res: Response) => {
    try {
      if (cachedDemoTimelapse) {
        res.json(cachedDemoTimelapse);
        return;
      }

      const [mayOctHist, sepNovHist] = await Promise.all([
        fetchHistoricalOmmPair(68762, 59103, '2026-05-14', '2026-10-17'),
        fetchHistoricalOmmPair(68762, 59103, '2026-09-20', '2026-11-14'),
      ]);
      const mergeOmmAsc = (a: OmmRecord[], b: OmmRecord[]): OmmRecord[] => {
        const seen = new Map<string, OmmRecord>();
        for (const item of [...a, ...b]) {
          if (!seen.has(item.EPOCH)) seen.set(item.EPOCH, item);
        }
        return Array.from(seen.values()).sort(
          (x, y) => new Date(x.EPOCH).getTime() - new Date(y.EPOCH).getTime(),
        );
      };
      const sSorted = mergeOmmAsc(mayOctHist.suspectHistory, sepNovHist.suspectHistory);
      const pSorted = mergeOmmAsc(mayOctHist.protectedHistory, sepNovHist.protectedHistory);
      if (sSorted.length === 0 || pSorted.length === 0) {
        res.status(404).json({ error: 'Historical OMMs unavailable for demo timelapse' });
        return;
      }

      const toEntries = (list: OmmRecord[]) =>
        list.map((omm) => ({
          epochMs: new Date(omm.EPOCH).getTime(),
          satrec: ommToSatrec(omm),
        }));
      const sEntries = toEntries(sSorted);
      const pEntries = toEntries(pSorted);

      const advanceCursor = (
        entries: { epochMs: number; satrec: ReturnType<typeof ommToSatrec> }[],
        cursor: { idx: number },
        targetMs: number,
      ) => {
        while (
          cursor.idx + 1 < entries.length &&
          entries[cursor.idx + 1].epochMs <= targetMs
        ) {
          cursor.idx++;
        }
        const a = entries[cursor.idx];
        const b = cursor.idx + 1 < entries.length ? entries[cursor.idx + 1] : null;
        return { a, b };
      };
      const sState = { idx: 0 };
      const pState = { idx: 0 };

      const points: [number, number, number, number, number, number, number, number, number][] = [];
      const mayStartMs = new Date('2026-05-15T18:00:00Z').getTime();
      const mayBurnEndMs = new Date('2026-05-17T06:00:00Z').getTime();
      const sepPhasingStartMs = new Date('2026-09-29T00:00:00Z').getTime();
      const closeupStartMs = new Date('2026-10-16T06:55:00Z').getTime();
      const closeupEndMs = new Date('2026-10-16T07:45:00Z').getTime();
      const closeupSafeEndMs = new Date('2026-10-16T07:50:00Z').getTime();
      const postShadowEndMs = new Date('2026-10-22T00:00:00Z').getTime();
      const novEndMs = Math.max(
        new Date('2026-11-15T00:00:00Z').getTime(),
        Date.now() + 2 * 3600_000,
      );

      const propagateSmoothEntry = (
        pair: {
          a: { epochMs: number; satrec: ReturnType<typeof ommToSatrec> };
          b: { epochMs: number; satrec: ReturnType<typeof ommToSatrec> } | null;
        },
        dt: Date,
      ) => {
        if (!pair.b) return propagateSatrecAt(pair.a.satrec, dt, true);
        // Preserve exact 04:40Z pre-pass OMM across the 06:55Z-07:50Z close approach before blending into 14:14Z
        const blendStartMs =
          pair.a.epochMs < closeupSafeEndMs && pair.b.epochMs > closeupSafeEndMs
            ? closeupSafeEndMs
            : pair.a.epochMs;
        return propagateSatrecBlended(
          pair.a.satrec,
          pair.b.satrec,
          blendStartMs,
          pair.b.epochMs,
          dt,
        );
      };

      const pushSample = (tMs: number) => {
        const sPair = advanceCursor(sEntries, sState, tMs);
        const pPair = advanceCursor(pEntries, pState, tMs);
        const dt = new Date(tMs);
        const stS = propagateSmoothEntry(sPair, dt);
        const stP = propagateSmoothEntry(pPair, dt);
        if (!stS || !stP) return;
        points.push([
          tMs,
          Number(stS.latDeg.toFixed(4)),
          Number(stS.lonDeg.toFixed(4)),
          Number(stS.altKm.toFixed(3)),
          Number(stS.speedKms.toFixed(3)),
          Number(stP.latDeg.toFixed(4)),
          Number(stP.lonDeg.toFixed(4)),
          Number(stP.altKm.toFixed(3)),
          Number(stP.speedKms.toFixed(3)),
        ]);
      };

      // Segment 1: May 15 18:00Z -> May 17 06:00Z at 90s step (captures May 16 +0.89 deg inclination match)
      for (let t = mayStartMs; t < mayBurnEndMs; t += 90_000) {
        pushSample(t);
      }
      // Segment 2: May 17 06:00Z -> Sep 29 00:00Z at 360s step (summer J2 drift mega-timelapse)
      for (let t = mayBurnEndMs; t < sepPhasingStartMs; t += 360_000) {
        pushSample(t);
      }
      // Segment 3: Sep 29 00:00Z -> Oct 16 06:55Z at 120s step (Sep 30 raise, Oct 12 drop, Oct 14-16 approach)
      for (let t = sepPhasingStartMs; t < closeupStartMs; t += 120_000) {
        pushSample(t);
      }
      // Segment 4: Oct 16 06:55Z -> 07:45Z at 3s step (smooth descent & close-up pass)
      for (let t = closeupStartMs; t < closeupEndMs; t += 3_000) {
        pushSample(t);
      }
      // Segment 5: Oct 16 07:45Z -> Oct 22 00:00Z at 120s step (Oct 16-18 shadowing & Oct 19-21 separation)
      for (let t = closeupEndMs; t < postShadowEndMs; t += 120_000) {
        pushSample(t);
      }
      // Segment 6: Oct 22 00:00Z -> Nov 15 / live now at 360s step (continued orbit to present)
      for (let t = postShadowEndMs; t <= novEndMs; t += 360_000) {
        pushSample(t);
      }

      cachedDemoTimelapse = {
        suspectNoradId: 68762,
        protectedNoradId: 59103,
        startMs: mayStartMs,
        stepMs: 90_000,
        points,
      };
      res.json(cachedDemoTimelapse);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Demo timelapse generation failed',
      });
    }
  });

  // --- HISTORICAL REPLAY (/api/replay?pair=68762,59103&from=...&to=...) ---
  app.get('/api/replay', async (req: Request, res: Response) => {
    try {
      const pairParam = String(req.query.pair || '68762,59103');
      const [sRaw, pRaw] = pairParam.split(',').map((s) => Number(s.trim()));
      const suspectId = Number.isFinite(sRaw) && sRaw > 0 ? sRaw : 68762;
      const protectedId = Number.isFinite(pRaw) && pRaw > 0 ? pRaw : 59103;
      const fromIso = req.query.from ? String(req.query.from) : '2026-09-25T00:00:00Z';
      const toIso = req.query.to ? String(req.query.to) : '2026-10-25T00:00:00Z';

      const replay = await computeHistoricalReplay(suspectId, protectedId, fromIso, toIso);
      res.json(replay);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Replay computation failed' });
    }
  });

  // --- LIVE CLAIM EXTRACTION & SGP4 VERIFICATION (/api/fusion/verify) ---
  app.post('/api/fusion/verify', async (req: Request, res: Response) => {
    const tTotal0 = performance.now();
    try {
      const rawTextInput = String(req.body?.claimText || '').trim();
      const sourceUrlInput = String(req.body?.sourceUrl || '').trim();
      const sourceTitleInput = String(req.body?.sourceTitle || 'Operator / Analyst Submission').trim();

      if (!rawTextInput && !sourceUrlInput) {
        res.status(400).json({ error: 'Provide either a report URL or claim text to extract and verify.' });
        return;
      }

      let markdownToExtract = rawTextInput;
      const resolvedUrl = sourceUrlInput || 'https://specola.eu/manual-analyst-check';
      let resolvedTitle = sourceTitleInput;
      let scrapeLatencyMs: number | null = null;
      let scrapeEndpoint: string | null = null;
      let scrapedAtUtc: string | null = null;

      if (sourceUrlInput && !rawTextInput) {
        const scraped = await contextScrapeToMarkdown(sourceUrlInput, (entry) =>
          store.logContextCall(entry),
        );
        if (!scraped) {
          res.status(422).json({
            error:
              'Context.dev could not scrape that URL live (check URL reachability or paste report text below).',
          });
          return;
        }
        markdownToExtract = scraped.markdown;
        resolvedTitle = scraped.title;
        scrapeLatencyMs = scraped.latencyMs;
        scrapeEndpoint = scraped.endpoint;
        scrapedAtUtc = scraped.scrapedAtUtc;
      }

      const extraction = await extractStructuredClaimWithGemini({
        rawTextOrMarkdown: markdownToExtract,
        sourceUrl: resolvedUrl,
        publishedAt: new Date().toISOString(),
      });
      const extractedAtUtc = new Date().toISOString();

      broadcastFeedItem({
        id: `feed-ext-${Date.now()}`,
        timestampUtc: extractedAtUtc,
        kind: 'claim_extracted',
        headline: `Claim Extracted (${extraction.modelUsed}, ${extraction.latencyMs} ms)`,
        detail: `${extraction.claim.claim_text}`,
        pairKey: extraction.claim.norad_ids.join('-'),
        severity: 'info',
        sourceOrCalc: resolvedUrl,
      });

      const { suspectHistory: hist68762Full, protectedHistory: hist59103Full } =
        await fetchHistoricalOmmPair(68762, 59103, '2026-09-20', '2026-11-14');
      const fullOmmMap: Record<number, OmmRecord[]> = {
        59103: hist59103Full.length > 0 ? hist59103Full : HISTORICAL_OMM_59103,
        68762: hist68762Full.length > 0 ? hist68762Full : HISTORICAL_OMM_68762,
      };
      for (const s of cachedSatellites) {
        if (!fullOmmMap[s.noradId]) fullOmmMap[s.noradId] = [s.omm];
        else fullOmmMap[s.noradId] = [...fullOmmMap[s.noradId], s.omm];
      }

      const verified = verifyClaimAgainstOrbits({
        id: `clm-${Date.now()}`,
        sourceTitle: resolvedTitle,
        sourceOutlet: (() => {
          try {
            return new URL(resolvedUrl).hostname.replace(/^www\./, '');
          } catch {
            return 'Submitted Source';
          }
        })(),
        claim: extraction.claim,
        ommHistoryByNorad: fullOmmMap,
        fallbackCatalog: cachedSatellites.map((s) => s.omm),
      });

      verified.provenanceStages = {
        monitor: null,
        scrape: scrapeEndpoint
          ? { endpoint: scrapeEndpoint, timestampUtc: scrapedAtUtc || extractedAtUtc, latencyMs: scrapeLatencyMs }
          : null,
        extract: { model: extraction.modelUsed, timestampUtc: extractedAtUtc, latencyMs: extraction.latencyMs },
      };

      await store.upsertClaim(verified);

      const totalLatencyMs = Math.max(1, Math.round(performance.now() - tTotal0));

      broadcastFeedItem({
        id: `feed-ver-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'claim_verified',
        headline: `SGP4 Verdict: ${verified.verdict.toUpperCase()} (${totalLatencyMs} ms)`,
        detail: verified.verdict_reason,
        pairKey: verified.norad_ids.join('-'),
        severity: verified.verdict === 'contradicted' ? 'warning' : 'info',
        sourceOrCalc: verified.orbit_calc_reference,
      });

      res.json({
        claim: verified,
        extractionModel: extraction.modelUsed,
        scrapeLatencyMs,
        extractionLatencyMs: extraction.latencyMs,
        totalLatencyMs,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Claim verification failed' });
    }
  });

  // --- CONTEXT.DEV MONITOR WEBHOOK RECEIVER (/api/webhooks/context & /api/webhooks/simulate) ---
  const handleContextWebhook = async (req: Request, res: Response) => {
    const tWebhook0 = performance.now();
    try {
      const body = req.body ?? {};
      const monitorName = String(body.monitor_name || body.monitor?.name || 'SatTrackCam / Orbital Radar Monitor');
      const targetUrl = String(
        body.url ||
          body.source_url ||
          'https://sattrackcam.blogspot.com/2026/11/cosmos-2612-coplanar-standoff-update.html',
      );
      const markdown = String(
        body.markdown ||
          body.diff_markdown ||
          body.summary ||
          body.title ||
          (req.path.includes('simulate')
            ? 'November 13, 2026 orbital update: Russian satellite Kosmos 2612 (NORAD 68762) remains in a nearly coplanar 539 km SSO orbit ~660.7 km behind ICEYE-X36 (NORAD 59103), maintaining orbital plane alignment for potential re-rendezvous.'
            : ''),
      );

      await store.logContextCall({
        id: `ctx-wh-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        endpoint: req.path.includes('simulate') ? 'WEBHOOK /api/webhooks/simulate' : 'WEBHOOK /api/webhooks/context',
        queryOrTarget: `${monitorName} → ${targetUrl}`,
        httpStatus: 200,
        latencyMs: 4,
        creditsUsed: 1,
        cached: false,
        executionMode: isContextDevConfigured() ? 'live-context-api' : 'seeded-corpus-fallback',
      });

      const relevance = isTextRelevantToWatchlist(`${body.title ?? ''} ${markdown}`);
      if (!relevance.relevant) {
        const nextSkip = Number(store.getKv('context_irrelevant_skipped_count') || 0) + 1;
        await store.setKv('context_irrelevant_skipped_count', String(nextSkip));
        broadcastFeedItem({
          id: `feed-wh-skip-${Date.now()}`,
          timestampUtc: new Date().toISOString(),
          kind: 'monitor_fired',
          headline: `Webhook Change Skipped (irrelevant): ${monitorName}`,
          detail: 'No watched satellite/NORAD/COSPAR/operator match — Gemini extraction skipped.',
          severity: 'info',
          sourceOrCalc: targetUrl,
        });
        res.json({
          ok: true,
          skipped: true,
          reason: 'irrelevant_to_watchlist',
          irrelevantSkippedCount: nextSkip,
        });
        return;
      }

      broadcastFeedItem({
        id: `feed-mon-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'monitor_fired',
        headline: `Context.dev Monitor Triggered [${relevance.matchedTerm}]: ${monitorName}`,
        detail: `New page delta ingested from ${targetUrl}`,
        pairKey: '68762-59103',
        severity: 'warning',
        sourceOrCalc: targetUrl,
      });

      const extraction = await extractStructuredClaimWithGemini({
        rawTextOrMarkdown: markdown,
        sourceUrl: targetUrl,
        publishedAt: '2026-11-13T12:00:00Z',
      });

      broadcastFeedItem({
        id: `feed-wh-ext-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'claim_extracted',
        headline: `Extracted Monitor Claim (${extraction.modelUsed})`,
        detail: extraction.claim.claim_text,
        pairKey: extraction.claim.norad_ids.join('-'),
        severity: 'info',
        sourceOrCalc: targetUrl,
      });

      const currentNovMap: Record<number, OmmRecord[]> = {
        59103: [SEEDED_CURRENT_OMM_BY_NORAD[59103], ...HISTORICAL_OMM_59103],
        68762: [SEEDED_CURRENT_OMM_BY_NORAD[68762], ...HISTORICAL_OMM_68762],
      };

      const verified = verifyClaimAgainstOrbits({
        id: `clm-wh-${Date.now()}`,
        sourceTitle: `${monitorName} Live Update`,
        sourceOutlet: monitorName,
        claim: extraction.claim,
        ommHistoryByNorad: currentNovMap,
        fallbackCatalog: cachedSatellites.map((s) => s.omm),
      });

      const whTs = new Date().toISOString();
      verified.provenanceStages = {
        monitor: { label: monitorName, timestampUtc: whTs },
        scrape: { endpoint: 'Monitor Diff Push', timestampUtc: whTs, latencyMs: 4 },
        extract: { model: extraction.modelUsed, timestampUtc: whTs, latencyMs: extraction.latencyMs },
      };

      await store.upsertClaim(verified);

      broadcastFeedItem({
        id: `feed-wh-ver-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'claim_verified',
        headline: `Monitor Claim ${verified.verdict.toUpperCase()}: ${verified.computed_distance_km ?? '—'} km SGP4`,
        detail: verified.verdict_reason,
        pairKey: verified.norad_ids.join('-'),
        severity: verified.verdict === 'verified' ? 'warning' : 'info',
        sourceOrCalc: verified.orbit_calc_reference,
      });

      // Automatically complete the end-to-end chain: synthesize updated Gemini brief + dispatch alerts
      const allEvents = store.listEvents();
      const matchedEvent =
        allEvents.find((e) =>
          verified.norad_ids.includes(e.suspectNoradId) &&
          verified.norad_ids.includes(e.protectedNoradId),
        ) ??
        allEvents.find((e) => e.pairKey === '68762-59103') ??
        allEvents[0];

      let updatedBrief: StoredDecisionBrief | null = null;
      if (matchedEvent) {
        const pairSnap =
          cachedPairs.find((p) => `${p.suspectNoradId}-${p.protectedNoradId}` === matchedEvent.pairKey) ??
          cachedPairs[0];
        const relevantClaims = store
          .listClaims()
          .filter(
            (c) =>
              c.norad_ids.includes(matchedEvent.suspectNoradId) ||
              c.norad_ids.includes(matchedEvent.protectedNoradId),
          );
        const generated = await synthesizeDecisionBriefWithGemini({
          event: matchedEvent,
          claims: relevantClaims,
          pairTelemetry: pairSnap,
          maneuvers: cachedManeuvers.filter(
            (m) =>
              m.noradId === matchedEvent.suspectNoradId ||
              m.targetNoradId === matchedEvent.protectedNoradId,
          ),
        });
        updatedBrief = {
          id: matchedEvent.briefId,
          eventId: matchedEvent.id,
          generatedAtUtc: new Date().toISOString(),
          modelUsed: generated.modelUsed,
          latencyMs: generated.latencyMs,
          isSeeded: false,
          ...generated.brief,
        };
        await store.upsertBrief(updatedBrief);

        broadcastFeedItem({
          id: `feed-wh-brief-${Date.now()}`,
          timestampUtc: new Date().toISOString(),
          kind: 'brief_generated',
          headline: `Auto-Brief Ready: ${matchedEvent.suspectName} ↔ ${matchedEvent.protectedName} (${generated.latencyMs} ms)`,
          detail: `${updatedBrief.threat_level} · ${updatedBrief.evidence.length} sourced facts`,
          pairKey: matchedEvent.pairKey,
          severity: updatedBrief.threat_level === 'HIGH' ? 'critical' : 'warning',
          sourceOrCalc: `Gemini ${generated.modelUsed}`,
        });

        const baseUrl = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
        for (const sub of store.listFleetSubscriptions()) {
          if (
            sub.noradIds.includes(matchedEvent.protectedNoradId) ||
            sub.noradIds.includes(matchedEvent.suspectNoradId)
          ) {
            const delivery = await dispatchEventAlert({
              store,
              subscriptionId: sub.id,
              fleetLabel: sub.label,
              notifyChannel: sub.notifyChannel,
              event: matchedEvent,
              brief: updatedBrief,
              appBaseUrl: baseUrl,
            });
            if (delivery.deliveryStatus !== 'deduplicated') {
              broadcastFeedItem({
                id: `feed-wh-alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                timestampUtc: delivery.sentAtUtc,
                kind: 'alert_dispatched',
                headline: `Webhook Alert ${delivery.deliveryStatus.toUpperCase()} → ${sub.label}`,
                detail: `${delivery.channelType} · ${updatedBrief.threat_level} threat`,
                pairKey: matchedEvent.pairKey,
                severity: delivery.deliveryStatus === 'failed' ? 'warning' : 'info',
                sourceOrCalc: delivery.eventUrl,
              });
            }
          }
        }
      }

      const e2eLatencyMs = Math.max(1, Math.round(performance.now() - tWebhook0));
      store.recordE2eLatency(e2eLatencyMs);
      logInfo('context_webhook_e2e_complete', { monitorName, e2eLatencyMs, verdict: verified.verdict });

      res.json({
        ok: true,
        monitorName,
        claim: verified,
        brief: updatedBrief,
        e2eLatencyMs,
        extractionModel: extraction.modelUsed,
      });
    } catch (err) {
      logError('context_webhook_error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: err instanceof Error ? err.message : 'Webhook processing failed' });
    }
  };

  app.post('/api/webhooks/context', handleContextWebhook);
  app.post('/api/webhooks/simulate', handleContextWebhook);

  // --- SATELLITE SEARCH BY NORAD ID OR SPACECRAFT NAME (/api/satellites/search) ---
  app.get('/api/satellites/search', async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) {
        res.json({
          results: cachedSatellites.slice(0, 25).map((s) => ({
            noradId: s.noradId,
            name: s.name,
            objectId: s.omm.OBJECT_ID,
            orbitRegime: s.orbitRegime,
            epochUtc: s.omm.EPOCH,
            source: 'local-catalog' as const,
          })),
        });
        return;
      }
      const results = await searchSpaceTrackCatalog(q);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Satellite search failed' });
    }
  });

  // --- WATCH MY FLEET SUBSCRIPTION (/api/watchlist) ---
  app.post('/api/watchlist', async (req: Request, res: Response) => {
    try {
      const label = String(req.body?.label || '').trim();
      const rawInput = String(req.body?.noradIds || '').trim();
      const notifyChannel = String(req.body?.notifyChannel || '').trim();

      if (!rawInput) {
        res.status(400).json({ error: 'Enter at least one NORAD ID or spacecraft name (e.g. 59103 or ICEYE-X36).' });
        return;
      }
      if (!notifyChannel || (!notifyChannel.includes('@') && !notifyChannel.startsWith('http'))) {
        res.status(400).json({ error: 'Provide a valid operator notification email or HTTPS Slack/Discord/webhook URL.' });
        return;
      }

      const tokens = /^[0-9\s,;]+$/.test(rawInput)
        ? rawInput.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
        : rawInput.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);

      const parsedIdSet = new Set<number>();
      for (const tok of tokens) {
        if (/^\d{4,9}$/.test(tok)) {
          parsedIdSet.add(Number(tok));
        } else {
          const matches = await searchSpaceTrackCatalog(tok);
          const best = matches[0];
          if (best) parsedIdSet.add(best.noradId);
        }
      }
      const parsedIds = Array.from(parsedIdSet);

      if (parsedIds.length === 0) {
        res.status(400).json({ error: 'Could not resolve any NORAD catalog IDs or spacecraft names from your input.' });
        return;
      }

      const resolvedIds: number[] = [];
      let globalMin72h = Infinity;
      let closestSummary = 'No co-orbital suspect within 45° plane tolerance';

      const suspectSats = cachedSatellites.filter((s) => s.role === 'suspect');

      for (const id of parsedIds) {
        const gp = await fetchGpOmmForNorad(id);
        const satcat = await fetchSatcatMetadata(id);
        if (!gp) continue;
        resolvedIds.push(id);

        if (!cachedSatellites.some((s) => s.noradId === id)) {
          customWatchedEntries.push({
            norad_id: id,
            name: satcat?.objectName || gp.omm.OBJECT_NAME,
            operator: label || `Custom Fleet (${satcat?.owner ?? 'EU'})`,
            country: satcat?.owner || 'EU',
            orbit_regime: gp.omm.MEAN_MOTION < 2 ? 'GEO' : 'LEO',
            role: 'protected',
          });
        }

        for (const susp of suspectSats) {
          const tca = findClosestApproach(susp.omm, gp.omm, new Date(), 72, 60);
          if (tca.minDistanceKm < globalMin72h) {
            globalMin72h = tca.minDistanceKm;
            closestSummary = `${susp.name} (#${susp.noradId}) → ${gp.omm.OBJECT_NAME} (#${id}): ${tca.minDistanceKm} km @ ${tca.tcaUtc.slice(0, 16)}Z`;
          }
        }
      }

      if (resolvedIds.length === 0) {
        res.status(422).json({
          error:
            'Requested NORAD ID/name could not be fetched from Space-Track or local snapshot cache. Try EU catalog objects like 59103, 60562, 39634, 40697, 47932, or 44423.',
        });
        return;
      }

      await refreshConstellationState();

      const sub = {
        id: `watch-${Date.now()}`,
        label: label || `Operator Fleet (${resolvedIds.join(', ')})`,
        noradIds: resolvedIds,
        notifyChannel,
        createdAtUtc: new Date().toISOString(),
        closestSuspectSummary: closestSummary,
        min72hDistanceKm: Number.isFinite(globalMin72h) ? Number(globalMin72h.toFixed(2)) : 9999,
      };
      await store.saveFleetSubscription(sub);

      broadcastFeedItem({
        id: `feed-watch-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'elements_ingested',
        headline: `Fleet Watch Activated: ${sub.label}`,
        detail: `72h SGP4 screen complete — ${closestSummary}`,
        severity: sub.min72hDistanceKm < 50 ? 'warning' : 'info',
        sourceOrCalc: `Notify: ${notifyChannel}`,
      });

      // Immediately dispatch alert if any active event affects the newly subscribed fleet
      const baseUrl = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
      const matchedEvents = store
        .listEvents()
        .filter((e) => resolvedIds.includes(e.protectedNoradId) || resolvedIds.includes(e.suspectNoradId));
      const initialDeliveries = [];
      for (const evt of matchedEvents.slice(0, 2)) {
        const brief = store.getBriefById(evt.briefId) ?? store.listBriefs()[0] ?? null;
        if (!brief) continue;
        const delivery = await dispatchEventAlert({
          store,
          subscriptionId: sub.id,
          fleetLabel: sub.label,
          notifyChannel: sub.notifyChannel,
          event: evt,
          brief,
          appBaseUrl: baseUrl,
        });
        initialDeliveries.push(delivery);
        if (delivery.deliveryStatus !== 'deduplicated') {
          broadcastFeedItem({
            id: `feed-watch-alert-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            timestampUtc: delivery.sentAtUtc,
            kind: 'alert_dispatched',
            headline: `Fleet Alert ${delivery.deliveryStatus.toUpperCase()} (${delivery.channelType})`,
            detail: `${sub.label}: ${evt.suspectName} ↔ ${evt.protectedName} (${brief.threat_level})`,
            pairKey: evt.pairKey,
            severity: delivery.deliveryStatus === 'failed' ? 'warning' : 'info',
            sourceOrCalc: delivery.eventUrl,
          });
        }
      }

      res.json({
        subscription: sub,
        satellites: cachedSatellites,
        pairs: cachedPairs,
        alertDeliveries: initialDeliveries,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to register fleet watch' });
    }
  });

  app.delete('/api/watchlist/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id || '').trim();
    const deleted = await store.deleteFleetSubscription(id);
    if (!deleted) {
      res.status(404).json({ error: 'Fleet subscription not found' });
      return;
    }
    res.json({ ok: true, id });
  });

  // --- MONITOR REGISTRATION REPAIR & LIVE SCRAPE SYNC (/api/monitors/sync) ---
  app.post('/api/monitors/sync', async (req: Request, res: Response) => {
    try {
      const publicBase = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
      const monitors = await ensureContextMonitorsRegistered(publicBase, (entry) =>
        store.logContextCall(entry),
      );
      await contextScrapeToMarkdown('https://sattrackcam.blogspot.com/', (entry) =>
        store.logContextCall(entry),
      );
      const metrics = await buildSystemMetrics();
      res.json({ ok: true, monitors, metrics });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Monitor sync failed' });
    }
  });

  // --- ALERT DELIVERY LOG (/api/alerts) ---
  app.get('/api/alerts', (_req: Request, res: Response) => {
    res.json({ deliveries: store.listAlertDeliveries(50) });
  });

  // --- ASK SPECOLA GROUNDED Q&A (/api/ask) ---
  app.post('/api/ask', async (req: Request, res: Response) => {
    try {
      const question = String(req.body?.question || '').trim();
      const fleetId = typeof req.body?.fleetId === 'string' ? req.body.fleetId.trim() : '';
      if (!question || question.length < 2) {
        res.status(400).json({ error: 'Enter a question about your fleet, conjunctions, or sources.' });
        return;
      }

      const sub = fleetId
        ? store.listFleetSubscriptions().find((s) => s.id === fleetId) ?? null
        : null;

      const scopedPairs = sub
        ? cachedPairs.filter((p) => sub.noradIds.includes(p.protectedNoradId) || sub.noradIds.includes(p.suspectNoradId))
        : cachedPairs;
      const scopedEvents = sub
        ? store.listEvents().filter((e) => sub.noradIds.includes(e.protectedNoradId) || sub.noradIds.includes(e.suspectNoradId))
        : store.listEvents();

      const response = await askSpecolaWithGemini({
        question,
        scopedFleetLabel: sub?.label ?? null,
        pairs: scopedPairs,
        events: scopedEvents,
        claims: store.listClaims(),
        maneuvers: cachedManeuvers,
        briefs: store.listBriefs(),
      });

      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Ask Specola query failed' });
    }
  });

  // --- TIER 2: SUSPECT PROFILES (/api/suspects) ---
  app.get('/api/suspects', (_req: Request, res: Response) => {
    const claims = store.listClaims();
    const suspects: SuspectProfile[] = cachedSatellites
      .filter((s) => s.role === 'suspect')
      .map((s) => {
        const satPairs = cachedPairs.filter((p) => p.suspectNoradId === s.noradId);
        const satManeuvers = cachedManeuvers.filter((m) => m.noradId === s.noradId);
        const satClaims = claims.filter((c) => c.norad_ids.includes(s.noradId));
        return {
          noradId: s.noradId,
          name: s.name,
          country: s.country,
          operator: s.operator,
          orbitRegime: s.orbitRegime,
          notes: s.notes || s.mission,
          epochUtc: s.omm.EPOCH,
          altKm: s.positionGeodetic.altKm,
          maneuversCount: satManeuvers.length,
          approachBurnsCount: satManeuvers.filter((m) => m.isApproachSignature).length,
          maxDeltaVMs: satManeuvers.reduce((mx, m) => Math.max(mx, m.estimatedDeltaVMs), 0),
          closestCurrentPair: satPairs[0]
            ? {
                protectedNoradId: satPairs[0].protectedNoradId,
                protectedName: satPairs[0].protectedName,
                currentDistanceKm: satPairs[0].currentDistanceKm,
                min72hKm: satPairs[0].tca72h.minDistanceKm,
                planeAngleDeg: satPairs[0].planeAngleDeg,
              }
            : null,
          maneuvers: satManeuvers.slice(0, 6),
          linkedClaimsCount: satClaims.length,
        };
      });
    res.json({ suspects });
  });

  // --- TIER 2: WEEKLY FLEET DIGEST (/api/fleet/:id/digest) ---
  app.get('/api/fleet/:id/digest', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const sub = store.listFleetSubscriptions().find((s) => s.id === id);
    if (!sub) {
      res.status(404).json({ error: 'Fleet subscription not found' });
      return;
    }
    const now = new Date();
    const periodEndUtc = now.toISOString();
    const periodStartUtc = new Date(now.getTime() - 7 * 86400_000).toISOString();
    const periodLabel = `${periodStartUtc.slice(0, 10)} → ${periodEndUtc.slice(0, 10)} UTC`;

    const fleetPairs = cachedPairs.filter(
      (p) => sub.noradIds.includes(p.protectedNoradId) || sub.noradIds.includes(p.suspectNoradId),
    );
    const activeThreatsCount = fleetPairs.filter((p) => {
      const highThresh = p.protectedAltKm > 15000 ? 150 : 50;
      return p.tca72h.minDistanceKm <= highThresh;
    }).length;
    const fleetManeuvers = cachedManeuvers.filter(
      (m) => (m.targetNoradId && sub.noradIds.includes(m.targetNoradId)) || sub.noradIds.includes(m.noradId),
    );
    const fleetClaims = store.listClaims().filter((c) =>
      c.norad_ids.some((nid) => sub.noradIds.includes(nid) || fleetPairs.some((p) => p.suspectNoradId === nid)),
    );

    const highlights: string[] = [
      `Watched spacecraft (${sub.noradIds.length}): ${sub.noradIds
        .map((idNum) => {
          const sat = cachedSatellites.find((s) => s.noradId === idNum);
          return sat ? `${sat.name} (#${idNum})` : `#${idNum}`;
        })
        .join(', ')}`,
      `Co-orbital pairs screened within 45° plane filter: ${fleetPairs.length} (${activeThreatsCount} close-approach alert threshold hits)`,
      `Closest 72h TCA: ${
        fleetPairs[0]
          ? `${fleetPairs[0].suspectName} ↔ ${fleetPairs[0].protectedName} at ${fleetPairs[0].tca72h.minDistanceKm} km (${fleetPairs[0].tca72h.tcaUtc.slice(0, 16)}Z)`
          : 'None within co-orbital plane tolerance'
      }`,
      `Detected suspect orbital Δv maneuvers: ${fleetManeuvers.length}`,
      `Linked web & analyst reports verified: ${fleetClaims.length}`,
    ];

    const markdown = [
      `# Specola Weekly Orbital Intelligence Digest`,
      `**Fleet:** ${sub.label}`,
      `**Period:** ${periodLabel}`,
      `**Notification Channel:** ${sub.notifyChannel}`,
      '',
      `## Key Highlights`,
      ...highlights.map((h) => `- ${h}`),
      '',
      `## Top Screened Suspect Pairs`,
      ...fleetPairs
        .slice(0, 8)
        .map(
          (p) =>
            `- **${p.suspectName} (#${p.suspectNoradId}) → ${p.protectedName} (#${p.protectedNoradId})**: Now ${p.currentDistanceKm} km | 72h TCA ${p.tca72h.minDistanceKm} km @ ${p.tca72h.tcaUtc} | Δθ ${p.planeAngleDeg}°`,
        ),
      '',
      `## Recent Web Intelligence Claims`,
      ...fleetClaims.slice(0, 6).map((c) => `- [${c.verdict.toUpperCase()}] ${c.claim_text} — ${c.source_url}`),
      '',
      `_Screening-grade analysis generated by Specola using Space-Track/CelesTrak public GP (~1 km epoch accuracy, +1–3 km/day propagation uncertainty). Not a safety-of-flight collision warning service._`,
    ].join('\n');

    const digest: WeeklyDigestReport = {
      fleetId: sub.id,
      fleetLabel: sub.label,
      generatedAtUtc: periodEndUtc,
      periodLabel,
      protectedCount: sub.noradIds.length,
      threatsCount: activeThreatsCount,
      recentBurnsCount: fleetManeuvers.length,
      linkedReportsCount: fleetClaims.length,
      highlights,
      markdown,
    };

    res.json({ digest });
  });

  // --- TIER 2: API KEYS & PUBLIC READ API (/api/keys & /api/v1/*) ---
  app.get('/api/keys', (_req: Request, res: Response) => {
    res.json({ keys: store.listApiKeys() });
  });

  app.post('/api/keys', async (req: Request, res: Response) => {
    try {
      const label = String(req.body?.label || 'Operator Read-Only Key').trim().slice(0, 60);
      const created = await store.createApiKey(label);
      res.json(created);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create API key' });
    }
  });

  const requirePublicApiKey = (req: Request, res: Response, next: NextFunction) => {
    const rawKey = String(req.headers['x-api-key'] || req.query.apiKey || '').trim();
    if (!store.validateApiKey(rawKey)) {
      res.status(401).json({
        error: 'Invalid or missing x-api-key header. Create a read-only API key in the Trust & API panel.',
      });
      return;
    }
    next();
  };

  app.get('/api/v1/events', requirePublicApiKey, (_req: Request, res: Response) => {
    res.json({
      count: store.listEvents().length,
      disclaimer: 'Screening-grade analysis from public GP elements (~1 km epoch). Not a collision warning service.',
      events: store.listEvents(),
    });
  });

  app.get('/api/v1/briefs', requirePublicApiKey, (_req: Request, res: Response) => {
    res.json({
      count: store.listBriefs().length,
      briefs: store.listBriefs(),
    });
  });

  app.get('/api/v1/fleet', requirePublicApiKey, (_req: Request, res: Response) => {
    res.json({
      subscriptions: store.listFleetSubscriptions(),
      watchedSatellitesCount: cachedSatellites.length,
      alertDeliveries: store.listAlertDeliveries(20),
    });
  });

  // --- ON-DEMAND ORBIT -> CONTEXT.DEV LIVE SWEEP (/api/context/sweep) ---
  app.post('/api/context/sweep', async (req: Request, res: Response) => {
    try {
      const pairKey = typeof req.body?.pairKey === 'string' ? req.body.pairKey : '';
      const noradId = Number(req.body?.noradId);
      let targetPair =
        cachedPairs.find((p) => `${p.suspectNoradId}-${p.protectedNoradId}` === pairKey) ?? null;

      if (!targetPair && Number.isFinite(noradId)) {
        targetPair =
          cachedPairs.find(
            (p) => p.suspectNoradId === noradId || p.protectedNoradId === noradId,
          ) ?? null;
      }
      if (!targetPair) {
        targetPair = cachedPairs[0] ?? null;
      }

      if (!targetPair) {
        res.status(404).json({ error: 'No tracked pair matched sweep request.' });
        return;
      }

      const newlyVerifiedCount = await runOrbitTriggeredContextSweep(
        targetPair.suspectNoradId,
        targetPair.suspectName,
        targetPair.protectedNoradId,
        targetPair.protectedName,
      );

      const metrics = await buildSystemMetrics();
      res.json({
        ok: true,
        pairKey: `${targetPair.suspectNoradId}-${targetPair.protectedNoradId}`,
        newlyVerifiedCount,
        claims: store.listClaims(),
        metrics,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Context.dev sweep failed' });
    }
  });

  // --- ON-DEMAND PER-ALARM CONTEXT.DEV ENRICHMENT (/api/context/alarm) ---
  app.post('/api/context/alarm', async (req: Request, res: Response) => {
    try {
      const headline = typeof req.body?.headline === 'string' ? req.body.headline.trim() : '';
      const detail = typeof req.body?.detail === 'string' ? req.body.detail.trim() : '';
      const pairKey = typeof req.body?.pairKey === 'string' ? req.body.pairKey.trim() : '';
      const noradRaw = Number(req.body?.noradId);
      const noradId = Number.isFinite(noradRaw) && noradRaw > 0 ? noradRaw : undefined;
      let satelliteName =
        typeof req.body?.satelliteName === 'string' ? req.body.satelliteName.trim() : '';

      const watchlist = loadWatchlistsConfig();
      if (!satelliteName && noradId) {
        satelliteName =
          cachedSatellites.find((s) => s.noradId === noradId)?.name ??
          watchlist.find((w) => w.norad_id === noradId)?.name ??
          '';
      }

      const pairParts: number[] = pairKey
        .split('-')
        .map((n: string) => Number(n))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      const targetNames: string[] = pairParts
        .map(
          (id: number) =>
            cachedSatellites.find((s) => s.noradId === id)?.name ??
            watchlist.find((w) => w.norad_id === id)?.name,
        )
        .filter((n): n is string => Boolean(n));

      let query = '';
      if (targetNames.length >= 2) {
        query = `"${targetNames[0]}" "${targetNames[1]}" satellite orbit maneuver OR conjunction OR RPO`;
      } else if (satelliteName) {
        query = `"${satelliteName}"${noradId ? ` "${noradId}"` : ''} satellite orbit maneuver`;
      } else if (headline) {
        query = `${headline.slice(0, 100)} satellite orbit`;
      } else {
        query = '"COSMOS 2612" "ICEYE-X36" orbital maneuver conjunction';
      }

      const searchResult = await contextSearchWatchedObjects(query, (entry) =>
        store.logContextCall(entry),
      );

      // Verify top uncached hit against SGP4 if available
      const existingUrls = new Set(store.listClaims().map((c) => c.source_url));
      let newlyVerifiedCount = 0;
      const topNewHit = searchResult.hits.find((h) => h.url && !existingUrls.has(h.url) && h.snippet);
      if (topNewHit) {
        try {
          const extraction = await extractStructuredClaimWithGemini({
            rawTextOrMarkdown: `${topNewHit.title}\n${topNewHit.snippet}`,
            sourceUrl: topNewHit.url,
            publishedAt: topNewHit.publishedAt ?? new Date().toISOString(),
          });
          if (extraction.claim.norad_ids.length === 0 && (pairParts.length > 0 || noradId)) {
            extraction.claim.norad_ids = pairParts.length > 0 ? pairParts : [noradId!];
          }
          if (extraction.claim.satellite_names.length === 0 && (targetNames.length > 0 || satelliteName)) {
            extraction.claim.satellite_names =
              targetNames.length > 0 ? targetNames : [satelliteName];
          }
          const ommMap: Record<number, OmmRecord[]> = {};
          for (const sat of cachedSatellites) {
            ommMap[sat.noradId] = [sat.omm];
          }
          if (pairParts.includes(68762) || noradId === 68762 || pairParts.includes(59103)) {
            const { suspectHistory: h68762, protectedHistory: h59103 } =
              await fetchHistoricalOmmPair(68762, 59103, '2026-09-20', '2026-11-14');
            ommMap[68762] = [SEEDED_CURRENT_OMM_BY_NORAD[68762], ...h68762];
            ommMap[59103] = [SEEDED_CURRENT_OMM_BY_NORAD[59103], ...h59103];
          }
          const verified = verifyClaimAgainstOrbits({
            id: `clm-alarm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sourceTitle: topNewHit.title || 'Context.dev Alarm Lookup',
            sourceOutlet: (() => {
              try {
                return new URL(topNewHit.url).hostname.replace(/^www\./, '');
              } catch {
                return 'Context.dev Web';
              }
            })(),
            claim: extraction.claim,
            ommHistoryByNorad: ommMap,
            fallbackCatalog: cachedSatellites.map((s) => s.omm),
          });
          const ts = new Date().toISOString();
          verified.provenanceStages = {
            monitor: { label: 'Alarm Context.dev Lookup', timestampUtc: ts },
            scrape: { endpoint: 'MCP web-search', timestampUtc: ts, latencyMs: null },
            extract: {
              model: extraction.modelUsed,
              timestampUtc: ts,
              latencyMs: extraction.latencyMs,
            },
          };
          await store.upsertClaim(verified);
          newlyVerifiedCount = 1;
        } catch {
          // Non-blocking if snippet has no structured claim
        }
      }

      const allClaims = store.listClaims();
      const satToken = satelliteName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const matchingClaims = allClaims.filter((c) => {
        if (noradId && c.norad_ids.includes(noradId)) return true;
        if (pairParts.some((id) => c.norad_ids.includes(id))) return true;
        if (
          satToken &&
          satToken.length >= 4 &&
          (c.satellite_names.some((n) => n.toLowerCase().replace(/[^a-z0-9]/g, '').includes(satToken)) ||
            c.claim_text.toLowerCase().replace(/[^a-z0-9]/g, '').includes(satToken))
        ) {
          return true;
        }
        return false;
      });

      // Automatically resolve both satellites' identity dossiers via Context.dev + SATCAT + Gemini
      let suspectDossierId = pairParts[0] ?? noradId ?? cachedPairs[0]?.suspectNoradId ?? 68762;
      let protectedDossierId = pairParts[1] ?? cachedPairs[0]?.protectedNoradId ?? 59103;
      if (pairParts.length < 2 && noradId) {
        const matchedLivePair = cachedPairs.find(
          (p) => p.suspectNoradId === noradId || p.protectedNoradId === noradId,
        );
        if (matchedLivePair) {
          suspectDossierId = matchedLivePair.suspectNoradId;
          protectedDossierId = matchedLivePair.protectedNoradId;
        }
      }

      const alarmTimestampUtc =
        typeof req.body?.timestampUtc === 'string' ? req.body.timestampUtc : null;

      const pairDossier = await buildPairContextDossier({
        suspectNoradId: suspectDossierId,
        protectedNoradId: protectedDossierId,
        encounterHits: searchResult.hits,
        alarmTimestampUtc,
      }).catch(() => undefined);

      broadcastFeedItem({
        id: `feed-ctx-alarm-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'monitor_fired',
        headline: `Context.dev More Context: ${satelliteName || headline.slice(0, 48)}`,
        detail: `${searchResult.hits.length} web hit(s) & ${matchingClaims.length} verified claim(s) via ${searchResult.mode}${detail ? ` — Trigger: ${detail.slice(0, 90)}` : ''}`,
        pairKey: pairKey || undefined,
        severity: 'info',
        sourceOrCalc: searchResult.hits[0]?.url || `Context.dev (${query})`,
      });

      const metrics = await buildSystemMetrics();
      const responsePayload: AlarmContextResponse = {
        ok: true,
        query,
        mode: searchResult.mode,
        hits: searchResult.hits,
        matchingClaims: matchingClaims.slice(0, 4),
        newlyVerifiedCount,
        claims: allClaims,
        pairDossier,
        metrics,
      };
      res.json(responsePayload);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Context.dev alarm lookup failed',
      });
    }
  });

  // --- AUTOMATIC TWO-SATELLITE IDENTITY & PUBLIC-INFO CHECK (/api/context/pair-identity) ---
  app.get('/api/context/pair-identity', async (req: Request, res: Response) => {
    try {
      const rawPair = typeof req.query.pair === 'string' ? req.query.pair : '68762,59103';
      const parts = rawPair
        .split(/[,-]/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const suspectNoradId = parts[0] ?? 68762;
      const protectedNoradId = parts[1] ?? 59103;
      const alarmTimestampUtc =
        typeof req.query.timestampUtc === 'string' ? req.query.timestampUtc : null;

      const dossier = await buildPairContextDossier({
        suspectNoradId,
        protectedNoradId,
        alarmTimestampUtc,
      });
      res.json({ ok: true, dossier });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to resolve satellite pair identity',
      });
    }
  });

  // --- MANUAL 72H CONSTELLATION SCAN + CONTEXT.DEV SWEEP (/api/scan) ---
  app.post('/api/scan', async (req: Request, res: Response) => {
    try {
      await refreshConstellationState(new Date(), true);
      const requestedPairKey = typeof req.body?.pairKey === 'string' ? req.body.pairKey : '';
      const targetPair =
        cachedPairs.find((p) => `${p.suspectNoradId}-${p.protectedNoradId}` === requestedPairKey) ??
        cachedPairs[0];

      const protectedCount = cachedSatellites.filter((s) => s.role === 'protected').length;
      await store.recordScreeningRun({
        id: `scan-${Date.now()}`,
        workersCount: protectedCount,
        pairsScreened: totalPairsScreenedCount || cachedPairs.length,
        durationMs: lastScan72hLatencyMs,
        topPairsSummary: cachedPairs.slice(0, 5).map((p) => ({
          pair: `${p.suspectNoradId}-${p.protectedNoradId}`,
          minDistanceKm: p.tca72h.minDistanceKm,
          tcaUtc: p.tca72h.tcaUtc,
        })),
      });

      broadcastFeedItem({
        id: `feed-scan-${Date.now()}`,
        timestampUtc: new Date().toISOString(),
        kind: 'elements_ingested',
        headline: `72h Space-Track + SGP4 Screen (${lastScan72hLatencyMs} ms)`,
        detail: targetPair
          ? `${targetPair.suspectName} ↔ ${targetPair.protectedName}: ${targetPair.currentDistanceKm} km now, 72h TCA ${targetPair.tca72h.minDistanceKm} km, Δθ ${targetPair.planeAngleDeg}°`
          : 'All watched satellites propagated cleanly.',
        pairKey: targetPair ? `${targetPair.suspectNoradId}-${targetPair.protectedNoradId}` : undefined,
        severity: 'info',
        sourceOrCalc: `Space-Track GP + Aiven PG (${cachedSatellites.length} spacecraft)`,
      });

      const maneuvers = await scanSuspectOrbitChanges(true);

      const pulledChangesCount = await syncContextMonitorChangesIfStale(true).catch((err) => {
        logWarn('scan_context_pull_warn', { error: String(err) });
        return 0;
      });

      if (targetPair) {
        await runOrbitTriggeredContextSweep(
          targetPair.suspectNoradId,
          targetPair.suspectName,
          targetPair.protectedNoradId,
          targetPair.protectedName,
        );
      }

      const metrics = await buildSystemMetrics();
      res.json({
        satellites: cachedSatellites,
        pairs: cachedPairs,
        maneuvers,
        pulledChangesCount,
        claims: store.listClaims(),
        metrics,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // --- LIVE ORBIT-CHANGE & BURN EARLY-WARNING DETECTOR (/api/maneuvers) ---
  app.get('/api/maneuvers', (_req: Request, res: Response) => {
    res.json({ maneuvers: cachedManeuvers });
  });

  app.post('/api/maneuvers/scan', async (_req: Request, res: Response) => {
    try {
      const maneuvers = await scanSuspectOrbitChanges(true);
      const latestApproach = maneuvers.find((m) => m.isApproachSignature) ?? maneuvers[0];
      if (latestApproach?.targetNoradId) {
        await runOrbitTriggeredContextSweep(
          latestApproach.noradId,
          latestApproach.satelliteName,
          latestApproach.targetNoradId,
          latestApproach.targetName || 'Protected Target',
        );
      }
      const metrics = await buildSystemMetrics();
      res.json({
        maneuvers,
        claims: store.listClaims(),
        metrics,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Orbit change scan failed',
      });
    }
  });

  // --- METRICS (/api/metrics) ---
  app.get('/api/metrics', async (_req: Request, res: Response) => {
    try {
      const metrics = await buildSystemMetrics();
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Metrics query failed' });
    }
  });

  // --- VITE MIDDLEWARE (DEV) OR STATIC DIST (PROD) ---
  const distPath = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(distPath, 'index.html'));

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Specola server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal Specola startup error:', err);
  process.exit(1);
});
