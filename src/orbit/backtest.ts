import type {
  BacktestPairSummary,
  BacktestPublicReference,
  BacktestResultPayload,
  BacktestStepEvent,
  OmmRecord,
} from '../shared/types.ts';
import {
  fetchHistoricalBatchForRange,
  loadWatchlistsConfig,
  type WatchlistConfigEntry,
} from './dataSources.ts';
import {
  computeInstantSeparation,
  computePlaneAngleDeg,
  detectManeuversFromHistory,
  findClosestApproach,
  meanMotionToSemiMajorAxisKm,
  ommToSatrec,
} from './engine.ts';

function getOrderTimestampMs(omm: OmmRecord): { ms: number; iso: string } {
  const raw = omm.CREATION_DATE || omm.EPOCH;
  const ms = new Date(raw).getTime();
  if (Number.isFinite(ms)) {
    return { ms, iso: new Date(ms).toISOString() };
  }
  const epMs = new Date(omm.EPOCH).getTime();
  return { ms: epMs, iso: new Date(epMs).toISOString() };
}

function sameRegime(a: OmmRecord, b: OmmRecord): boolean {
  const aGeo = a.MEAN_MOTION < 2.0;
  const bGeo = b.MEAN_MOTION < 2.0;
  const aLeo = a.MEAN_MOTION > 10.0;
  const bLeo = b.MEAN_MOTION > 10.0;
  return (aGeo && bGeo) || (aLeo && bLeo);
}

/**
 * Known publicly reported orbital events in our monitored cohorts (used ONLY to label
 * post-hoc matches in the false-alarm summary; NEVER used as an input to detection).
 */
const PUBLIC_KNOWN_EVENTS: Record<string, { label: string; url: string }> = {
  '68762-59103': {
    label: 'Oct 16–20 COSMOS 2612 ↔ ICEYE-X36 RPO (Axios / SatTrackCam / LeoLabs)',
    url: 'https://www.axios.com/2026/10/17/russia-ukraine-satellite-space',
  },
  '68763-59103': {
    label: 'Co-manifested April 2026 Soyuz inspector plane near ICEYE-X36 (SatTrackCam)',
    url: 'https://sattrackcam.blogspot.com/2026/10/kosmos-2612-and-iceye-x36-worrisome-cat.html',
  },
  '41838-54225': {
    label: 'PRC SJ-17 GEO drift past Eutelsat Hotbird 13G (CSIS / SWF)',
    url: 'https://aerospace.csis.org/space-threat-assessment/',
  },
  '55841-35943': {
    label: 'Russian Luch (Olymp-2) co-stationed near COMSATBW-1 (SWF Counterspace)',
    url: 'https://swfound.org/counterspace/',
  },
};

export const COSMOS_ICEYE_PUBLIC_REFERENCES: BacktestPublicReference[] = [
  {
    id: 'ref-sep30-data',
    label: 'First Maneuver in Orbit Data',
    timestampUtc: '2026-09-30T12:00:00.000Z',
    kind: 'orbit_data_baseline',
    sourceUrl: 'https://sattrackcam.blogspot.com/2026/10/kosmos-2612-and-iceye-x36-worrisome-cat.html',
    notes: 'Orbital history baseline: COSMOS 2612 initiated plane/altitude phasing burns on 30 Sep 2026 (retrospectively reconstructed Oct 17).',
  },
  {
    id: 'ref-oct17-axios',
    label: 'First News Report (Axios citing LeoLabs)',
    timestampUtc: '2026-10-17T08:00:00.000Z',
    kind: 'public_report',
    sourceUrl: 'https://www.axios.com/2026/10/17/russia-ukraine-satellite-space',
    notes: 'Axios report by Thomas Novelly ("Russia nears U.S. satellite, raising alarm about intent") published Oct 17, 2026.',
  },
  {
    id: 'ref-oct17-sattrackcam',
    label: 'First Amateur SSA Analysis (SatTrackCam Leiden)',
    timestampUtc: '2026-10-17T14:20:00.000Z',
    kind: 'public_report',
    sourceUrl: 'https://sattrackcam.blogspot.com/2026/10/kosmos-2612-and-iceye-x36-worrisome-cat.html',
    notes: 'Dr. Marco Langbroek SatTrackCam blog published Saturday, 17 Oct 2026.',
  },
  {
    id: 'ref-oct19-leolabs',
    label: 'LeoLabs Public Statement / CNN Advisory',
    timestampUtc: '2026-10-19T16:45:00.000Z',
    kind: 'public_report',
    sourceUrl: 'https://www.cnn.com/2026/10/19/science/russian-satellite-iceye-x36-approach',
    notes: 'LeoLabs public tracking confirmation & CNN report on Oct 19, 2026.',
  },
];

interface ChronologicalPacket {
  noradId: number;
  role: 'suspect' | 'protected';
  name: string;
  omm: OmmRecord;
  creationMs: number;
  creationIso: string;
}

/**
 * Executes the exact locked WATCH / WARNING / ALERT blind rules over a chronological
 * CREATION_DATE stream with ZERO look-ahead bias.
 */
function runChronologicalSweep(params: {
  byNorad: Record<number, OmmRecord[]>;
  suspects: { noradId: number; name: string }[];
  protectedAssets: { noradId: number; name: string }[];
}): {
  ommsProcessed: number;
  pairsEvaluated: number;
  firingsByPair: Map<string, BacktestStepEvent[]>;
  pairMeta: Map<string, { suspectNoradId: number; suspectName: string; protectedNoradId: number; protectedName: string }>;
} {
  const { byNorad, suspects, protectedAssets } = params;

  const packets: ChronologicalPacket[] = [];
  for (const s of suspects) {
    for (const omm of byNorad[s.noradId] ?? []) {
      const ord = getOrderTimestampMs(omm);
      packets.push({
        noradId: s.noradId,
        role: 'suspect',
        name: s.name,
        omm,
        creationMs: ord.ms,
        creationIso: ord.iso,
      });
    }
  }
  for (const p of protectedAssets) {
    for (const omm of byNorad[p.noradId] ?? []) {
      const ord = getOrderTimestampMs(omm);
      packets.push({
        noradId: p.noradId,
        role: 'protected',
        name: p.name,
        omm,
        creationMs: ord.ms,
        creationIso: ord.iso,
      });
    }
  }

  // Sort strictly by Space-Track CREATION_DATE ascending
  packets.sort((a, b) => a.creationMs - b.creationMs);

  const knownLatestOmm = new Map<number, OmmRecord>();
  const knownHistoryByNorad = new Map<number, OmmRecord[]>();
  const lastPairRange = new Map<string, number>();
  const lastPairTca72h = new Map<string, number>();
  const firingsByPair = new Map<string, BacktestStepEvent[]>();
  const pairMeta = new Map<
    string,
    { suspectNoradId: number; suspectName: string; protectedNoradId: number; protectedName: string }
  >();
  const evaluatedPairs = new Set<string>();

  const recordFiring = (pairKey: string, evt: BacktestStepEvent) => {
    const arr = firingsByPair.get(pairKey) ?? [];
    arr.push(evt);
    firingsByPair.set(pairKey, arr);
  };

  for (const pkt of packets) {
    const prevOmmForObj = knownLatestOmm.get(pkt.noradId) ?? null;
    const histForObj = knownHistoryByNorad.get(pkt.noradId) ?? [];
    histForObj.push(pkt.omm);
    knownHistoryByNorad.set(pkt.noradId, histForObj);
    knownLatestOmm.set(pkt.noradId, pkt.omm);

    // Only evaluate pair checks when a suspect publishes a new element set
    // (or when a protected asset updates after a suspect is already known)
    const suspectList =
      pkt.role === 'suspect'
        ? [{ noradId: pkt.noradId, name: pkt.name, omm: pkt.omm, prevOmm: prevOmmForObj }]
        : suspects
            .map((s) => {
              const omm = knownLatestOmm.get(s.noradId);
              return omm ? { noradId: s.noradId, name: s.name, omm, prevOmm: omm } : null;
            })
            .filter((x): x is { noradId: number; name: string; omm: OmmRecord; prevOmm: OmmRecord } => x !== null);

    const protList =
      pkt.role === 'protected'
        ? [{ noradId: pkt.noradId, name: pkt.name, omm: pkt.omm }]
        : protectedAssets
            .map((p) => {
              const omm = knownLatestOmm.get(p.noradId);
              return omm ? { noradId: p.noradId, name: p.name, omm } : null;
            })
            .filter((x): x is { noradId: number; name: string; omm: OmmRecord } => x !== null);

    // Check suspect burn ONCE per suspect packet before iterating over protected partners
    const suspectBurnsSelf =
      pkt.role === 'suspect' && prevOmmForObj
        ? detectManeuversFromHistory([prevOmmForObj, pkt.omm])
        : [];
    for (const s of suspectList) {
      const sBurns = s.noradId === pkt.noradId ? suspectBurnsSelf : [];
      for (const p of protList) {
        if (!sameRegime(s.omm, p.omm)) continue;
        const pairKey = `${s.noradId}-${p.noradId}`;
        evaluatedPairs.add(pairKey);
        if (!pairMeta.has(pairKey)) {
          pairMeta.set(pairKey, {
            suspectNoradId: s.noradId,
            suspectName: s.name,
            protectedNoradId: p.noradId,
            protectedName: p.name,
          });
        }

        const evalDate = new Date(pkt.creationMs);
        const satS = ommToSatrec(s.omm);
        const satP = ommToSatrec(p.omm);
        const instant = computeInstantSeparation(satS, satP, evalDate, false);
        if (!instant) continue;

        const instantDistKm = Number(instant.distanceKm.toFixed(2));
        const planeAngleDeg = Number(instant.planeAngleDeg.toFixed(4));

        // Analytical Keplerian apogee/perigee gap check
        const aS = meanMotionToSemiMajorAxisKm(s.omm.MEAN_MOTION);
        const aP = meanMotionToSemiMajorAxisKm(p.omm.MEAN_MOTION);
        const perigeeS = aS * (1 - s.omm.ECCENTRICITY);
        const apogeeS = aS * (1 + s.omm.ECCENTRICITY);
        const perigeeP = aP * (1 - p.omm.ECCENTRICITY);
        const apogeeP = aP * (1 + p.omm.ECCENTRICITY);
        const radialGapKm = Math.max(0, perigeeS - apogeeP, perigeeP - apogeeS);

        // Fast 72h screen ONLY when candidate geometry can trigger WATCH/WARNING/ALERT
        let tca72hKm = instantDistKm;
        let tca72hUtc = pkt.creationIso;

        const shouldRunFull72h =
          planeAngleDeg < 0.35 ||
          instantDistKm < 400 ||
          radialGapKm <= 55 ||
          sBurns.length > 0;

        if (shouldRunFull72h) {
          const stepSec = planeAngleDeg < 0.5 ? 600 : 300;
          let coarseMin = Infinity;
          let coarseBestMs = pkt.creationMs;
          for (let offsetMs = 0; offsetMs <= 72 * 3600_000; offsetMs += stepSec * 1000) {
            const tMs = pkt.creationMs + offsetMs;
            const sep = computeInstantSeparation(satS, satP, new Date(tMs), false);
            if (sep && sep.distanceKm < coarseMin) {
              coarseMin = sep.distanceKm;
              coarseBestMs = tMs;
            }
          }
          if ((planeAngleDeg < 0.5 && coarseMin < 110) || (planeAngleDeg >= 0.5 && coarseMin < 550)) {
            const fineStart = Math.max(pkt.creationMs, coarseBestMs - stepSec * 1000);
            const fineEnd = Math.min(pkt.creationMs + 72 * 3600_000, coarseBestMs + stepSec * 1000);
            const fineHours = Math.max(0.25, (fineEnd - fineStart) / 3600_000);
            const fineTca = findClosestApproach(s.omm, p.omm, new Date(fineStart), fineHours, 20);
            tca72hKm = fineTca.minDistanceKm;
            tca72hUtc = fineTca.tcaUtc;
          } else {
            tca72hKm = Number(coarseMin.toFixed(2));
            tca72hUtc = new Date(coarseBestMs).toISOString();
          }
        }

        const prevRange = lastPairRange.get(pairKey) ?? null;
        const prevTca72 = lastPairTca72h.get(pairKey) ?? null;
        const closingRateKmDay =
          prevRange !== null ? Number(((instantDistKm - prevRange) * 2).toFixed(2)) : null;

        // Rule 1: WATCH — suspect maneuvers (J2/drag compensated) AND reduces plane angle or distance
        if (sBurns.length > 0 && s.prevOmm) {
          const burn = sBurns[sBurns.length - 1];
          const protHist = knownHistoryByNorad.get(p.noradId) ?? [p.omm];
          const prevProtOmm =
            protHist.length >= 2 ? protHist[protHist.length - 2] : p.omm;
          const prevSep = computeInstantSeparation(
            ommToSatrec(s.prevOmm),
            ommToSatrec(prevProtOmm),
            new Date(s.prevOmm.EPOCH),
            false,
          );
          if (burn) {
            const planeBefore = prevSep?.planeAngleDeg ?? computePlaneAngleDeg(s.prevOmm, prevProtOmm, evalDate);
            const reducedPlane = planeAngleDeg < planeBefore - 0.010;
            const reducedDist =
              (prevRange !== null && instantDistKm < prevRange * 0.95) ||
              (prevTca72 !== null && tca72hKm < prevTca72 * 0.95) ||
              (burn.postManeuverRangeKm !== undefined &&
                prevRange !== null &&
                burn.postManeuverRangeKm < prevRange);

            if (reducedPlane || reducedDist) {
              recordFiring(pairKey, {
                tier: 'WATCH',
                creationDateUtc: pkt.creationIso,
                epochUtc: pkt.omm.EPOCH,
                suspectNoradId: s.noradId,
                suspectName: s.name,
                protectedNoradId: p.noradId,
                protectedName: p.name,
                deltaVMs: burn.estimatedDeltaVMs,
                deltaSemiMajorAxisKm: burn.deltaSemiMajorAxisKm,
                deltaInclinationDeg: burn.deltaInclinationDeg,
                residualDeltaRaanDeg: burn.residualDeltaRaanDeg,
                planeAngleDeg,
                instantDistanceKm: instantDistKm,
                tca72hKm,
                tca72hUtc,
                closingRateKmDay,
                triggerSummary: `Burn Δv ${burn.estimatedDeltaVMs} m/s (Δa ${burn.deltaSemiMajorAxisKm} km, ΔΩ_res ${burn.residualDeltaRaanDeg}°) reduced ${
                  reducedPlane ? `plane angle ${planeBefore.toFixed(3)}°→${planeAngleDeg.toFixed(3)}°` : 'range'
                }`,
              });
            }
          }
        }

        // Rule 2: WARNING — plane angle < 0.05° AND suspect is closing on protected satellite
        const isClosing =
          (prevRange !== null && instantDistKm < prevRange) ||
          (prevTca72 !== null && tca72hKm < prevTca72) ||
          tca72hKm < instantDistKm * 0.95;

        if (planeAngleDeg < 0.05 && isClosing) {
          recordFiring(pairKey, {
            tier: 'WARNING',
            creationDateUtc: pkt.creationIso,
            epochUtc: pkt.omm.EPOCH,
            suspectNoradId: s.noradId,
            suspectName: s.name,
            protectedNoradId: p.noradId,
            protectedName: p.name,
            deltaVMs: null,
            deltaSemiMajorAxisKm: null,
            deltaInclinationDeg: null,
            residualDeltaRaanDeg: null,
            planeAngleDeg,
            instantDistanceKm: instantDistKm,
            tca72hKm,
            tca72hUtc,
            closingRateKmDay,
            triggerSummary: `Coplanar Δθ ${planeAngleDeg.toFixed(4)}° < 0.05° & closing (range ${prevRange ?? '—'}→${instantDistKm} km, 72h TCA ${tca72hKm} km)`,
          });
        }

        // Rule 3: ALERT — predicted closest approach within next 72h < 50 km OR current distance < 50 km
        if (tca72hKm < 50 || instantDistKm < 50) {
          recordFiring(pairKey, {
            tier: 'ALERT',
            creationDateUtc: pkt.creationIso,
            epochUtc: pkt.omm.EPOCH,
            suspectNoradId: s.noradId,
            suspectName: s.name,
            protectedNoradId: p.noradId,
            protectedName: p.name,
            deltaVMs: null,
            deltaSemiMajorAxisKm: null,
            deltaInclinationDeg: null,
            residualDeltaRaanDeg: null,
            planeAngleDeg,
            instantDistanceKm: instantDistKm,
            tca72hKm,
            tca72hUtc,
            closingRateKmDay,
            triggerSummary: `Close pass < 50 km: 72h TCA ${tca72hKm} km @ ${tca72hUtc.slice(0, 16)}Z (instant ${instantDistKm} km)`,
          });
        }

        lastPairRange.set(pairKey, instantDistKm);
        lastPairTca72h.set(pairKey, tca72hKm);
      }
    }
  }

  return {
    ommsProcessed: packets.length,
    pairsEvaluated: evaluatedPairs.size,
    firingsByPair,
    pairMeta,
  };
}

function summarizePairs(
  firingsByPair: Map<string, BacktestStepEvent[]>,
  pairMeta: Map<string, { suspectNoradId: number; suspectName: string; protectedNoradId: number; protectedName: string }>,
): {
  totalWatch: number;
  totalWarning: number;
  totalAlert: number;
  matchedPublicEvents: number;
  unmatchedAlertPairs: number;
  byPair: BacktestPairSummary[];
} {
  let totalWatch = 0;
  let totalWarning = 0;
  let totalAlert = 0;
  let matchedPublicEvents = 0;
  let unmatchedAlertPairs = 0;
  const byPair: BacktestPairSummary[] = [];

  for (const [pairKey, evts] of firingsByPair.entries()) {
    const meta = pairMeta.get(pairKey);
    if (!meta || evts.length === 0) continue;

    const watches = evts.filter((e) => e.tier === 'WATCH');
    const warnings = evts.filter((e) => e.tier === 'WARNING');
    const alerts = evts.filter((e) => e.tier === 'ALERT');

    totalWatch += watches.length;
    totalWarning += warnings.length;
    totalAlert += alerts.length;

    const known = PUBLIC_KNOWN_EVENTS[pairKey] ?? null;
    if (known) matchedPublicEvents += 1;
    else if (alerts.length > 0 || warnings.length > 0) unmatchedAlertPairs += 1;

    byPair.push({
      pairKey,
      suspectNoradId: meta.suspectNoradId,
      suspectName: meta.suspectName,
      protectedNoradId: meta.protectedNoradId,
      protectedName: meta.protectedName,
      watchCount: watches.length,
      warningCount: warnings.length,
      alertCount: alerts.length,
      firstWatchUtc: watches[0]?.creationDateUtc ?? null,
      firstWarningUtc: warnings[0]?.creationDateUtc ?? null,
      firstAlertUtc: alerts[0]?.creationDateUtc ?? null,
      matchesPublicReport: Boolean(known),
      matchedReportLabel: known?.label ?? null,
    });
  }

  byPair.sort((a, b) => b.alertCount + b.warningCount - (a.alertCount + a.warningCount));
  return {
    totalWatch,
    totalWarning,
    totalAlert,
    matchedPublicEvents,
    unmatchedAlertPairs,
    byPair,
  };
}

export async function runBlindBacktest(): Promise<BacktestResultPayload> {
  const watchlist: WatchlistConfigEntry[] = loadWatchlistsConfig();
  const allIds = watchlist.map((w) => w.norad_id);
  const suspects = watchlist
    .filter((w) => w.role === 'suspect')
    .map((w) => ({ noradId: w.norad_id, name: w.name }));
  const protectedAssets = watchlist
    .filter((w) => w.role === 'protected')
    .map((w) => ({ noradId: w.norad_id, name: w.name }));

  // 1. Primary Sep 20 – Oct 31 blind sweep across ALL watchlist pairs
  const sepOctData = await fetchHistoricalBatchForRange({
    cacheKey: 'backtest_gp_history_2026-09-20_2026-10-31',
    noradIds: allIds,
    fromDate: '2026-09-20',
    toDate: '2026-10-31',
  });

  const sepOctSweep = runChronologicalSweep({
    byNorad: sepOctData.byNorad,
    suspects,
    protectedAssets,
  });
  const sepOctSummary = summarizePairs(sepOctSweep.firingsByPair, sepOctSweep.pairMeta);

  // Extract COSMOS 2612 (68762) vs ICEYE-X36 (59103) timeline
  const cosmosFirings = sepOctSweep.firingsByPair.get('68762-59103') ?? [];
  const firstWatch = cosmosFirings.find((f) => f.tier === 'WATCH') ?? null;
  const firstWarning = cosmosFirings.find((f) => f.tier === 'WARNING') ?? null;
  const firstAlert = cosmosFirings.find((f) => f.tier === 'ALERT') ?? null;

  const publicNews = COSMOS_ICEYE_PUBLIC_REFERENCES.filter((r) => r.kind === 'public_report');
  const earliestNews = publicNews[0] ?? null;
  const earliestPublicMs = earliestNews ? new Date(earliestNews.timestampUtc).getTime() : null;

  const calcLeadDays = (evt: BacktestStepEvent | null): number | null => {
    if (!evt || earliestPublicMs === null) return null;
    const diffDays = (earliestPublicMs - new Date(evt.creationDateUtc).getTime()) / 86400_000;
    return Number(diffDays.toFixed(1));
  };

  const leadWatch = calcLeadDays(firstWatch);
  const leadWarning = calcLeadDays(firstWarning);
  const leadAlert = calcLeadDays(firstAlert);

  const warningDateStr = firstWarning
    ? `${firstWarning.creationDateUtc.slice(0, 16).replace('T', ' ')}Z`
    : 'did not fire';
  const publicDateStr = earliestNews
    ? `${earliestNews.timestampUtc.slice(0, 10)}`
    : 'unknown';
  const headline =
    firstWarning && leadWarning !== null
      ? `Specola WARNING: ${warningDateStr}. First public report: ${publicDateStr}. Lead time: ${leadWarning.toFixed(1)} days.`
      : firstWatch && leadWatch !== null
        ? `Specola WATCH: ${firstWatch.creationDateUtc.slice(0, 16).replace('T', ' ')}Z (WARNING: none). First public report: ${publicDateStr}. Lead time: ${leadWatch.toFixed(1)} days.`
        : `Specola WARNING: ${warningDateStr}. First public report: ${publicDateStr}. Lead time: 0.0 days.`;

  // 2. May 2026 False-Alarm Sweep across April 2026 Soyuz siblings (68754, 68758, 68759, 68762, 68763, 68764) vs protected LEO
  const maySuspectIds = [68754, 68758, 68759, 68762, 68763, 68764];
  const protectedLeo = watchlist
    .filter((w) => w.role === 'protected' && w.orbit_regime.startsWith('LEO'))
    .map((w) => ({ noradId: w.norad_id, name: w.name }));

  const mayData = await fetchHistoricalBatchForRange({
    cacheKey: 'backtest_gp_history_2026-05-01_2026-06-01',
    noradIds: [...maySuspectIds, ...protectedLeo.map((p) => p.noradId)],
    fromDate: '2026-05-01',
    toDate: '2026-06-01',
  });

  const maySuspectList = maySuspectIds.map((nid) => ({
    noradId: nid,
    name: mayData.byNorad[nid]?.[0]?.OBJECT_NAME || `NORAD ${nid}`,
  }));

  const mayAvailable = maySuspectIds.some((id) => (mayData.byNorad[id]?.length ?? 0) > 1);
  let maySummary = {
    totalWatch: 0,
    totalWarning: 0,
    totalAlert: 0,
    matchedPublicEvents: 0,
    unmatchedAlertPairs: 0,
    byPair: [] as BacktestPairSummary[],
  };
  let mayPairsEvaluated = 0;

  if (mayAvailable) {
    const maySweep = runChronologicalSweep({
      byNorad: mayData.byNorad,
      suspects: maySuspectList,
      protectedAssets: protectedLeo,
    });
    mayPairsEvaluated = maySweep.pairsEvaluated;
    maySummary = summarizePairs(maySweep.firingsByPair, maySweep.pairMeta);
  }

  return {
    id: `backtest-${Date.now()}`,
    ranAtUtc: new Date().toISOString(),
    windowFrom: '2026-09-20T00:00:00Z',
    windowTo: '2026-10-31T23:59:59Z',
    orderingField: 'CREATION_DATE',
    rulesVersion: 'v1-readme-locked',
    cosmosIceye: {
      firstWatch,
      firstWarning,
      firstAlert,
      allFirings: cosmosFirings,
      publicReferences: COSMOS_ICEYE_PUBLIC_REFERENCES,
      earliestPublicReportUtc: earliestNews?.timestampUtc ?? null,
      leadTimeDaysFromWatchToFirstNews: leadWatch,
      leadTimeDaysFromWarningToFirstNews: leadWarning,
      leadTimeDaysFromAlertToFirstNews: leadAlert,
      headline,
    },
    falseAlarmSweepSepOct: {
      pairsEvaluated: sepOctSweep.pairsEvaluated,
      ommsProcessed: sepOctSweep.ommsProcessed,
      totalWatch: sepOctSummary.totalWatch,
      totalWarning: sepOctSummary.totalWarning,
      totalAlert: sepOctSummary.totalAlert,
      matchedPublicEvents: sepOctSummary.matchedPublicEvents,
      unmatchedAlertPairs: sepOctSummary.unmatchedAlertPairs,
      byPair: sepOctSummary.byPair,
    },
    falseAlarmSweepMay2026: {
      available: mayAvailable,
      windowFrom: '2026-05-01T00:00:00Z',
      windowTo: '2026-06-01T00:00:00Z',
      suspectIds: maySuspectIds,
      ommsLoaded: mayData.totalRows,
      pairsEvaluated: mayPairsEvaluated,
      totalWatch: maySummary.totalWatch,
      totalWarning: maySummary.totalWarning,
      totalAlert: maySummary.totalAlert,
      matchedPublicEvents: maySummary.matchedPublicEvents,
      byPair: maySummary.byPair,
      note: mayAvailable
        ? `Evaluated ${mayData.totalRows} Space-Track gp_history OMMs ordered by CREATION_DATE across April 2026 Soyuz objects (${maySuspectIds.join(', ')}) vs ${protectedLeo.length} EU LEO payloads.`
        : 'May 2026 gp_history not available offline; connect Space-Track credentials to populate cache.',
    },
  };
}
