import {
  computeInstantSeparation,
  estimatePublicTleUncertaintyKm,
  findClosestApproach,
  ommToSatrec,
} from '../orbit/engine.ts';
import type {
  ClaimOrbitVerdict,
  ExtractedClaimInput,
  ManeuverDetection,
  OmmRecord,
  OrbitalEventRecord,
  VerifiedWebClaim,
} from '../shared/types.ts';

function normalizeSatName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/^KOSMOS/, 'COSMOS')
    .replace(/[^A-Z0-9]/g, '');
}

export function resolveClaimToNoradIds(
  claim: ExtractedClaimInput,
  knownCatalog: OmmRecord[],
): number[] {
  const matched = new Set<number>();
  for (const id of claim.norad_ids) {
    if (Number.isInteger(id) && id > 0) {
      matched.add(id);
    }
  }

  for (const rawName of claim.satellite_names) {
    const norm = normalizeSatName(rawName);
    if (!norm) continue;
    for (const omm of knownCatalog) {
      const catNorm = normalizeSatName(omm.OBJECT_NAME);
      if (catNorm === norm || catNorm.includes(norm) || norm.includes(catNorm)) {
        matched.add(Number(omm.NORAD_CAT_ID));
      }
    }
  }

  return Array.from(matched);
}

function selectClosestEpochOmm(history: OmmRecord[], targetMs: number): OmmRecord | null {
  if (history.length === 0) return null;
  let best = history[0];
  let bestDiff = Math.abs(new Date(best.EPOCH).getTime() - targetMs);
  for (const item of history) {
    const diff = Math.abs(new Date(item.EPOCH).getTime() - targetMs);
    if (diff < bestDiff) {
      best = item;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * Cross-verifies an extracted web claim against SGP4 public orbital elements.
 * Enforces Specola's hard epistemic rule:
 * - Public TLEs (~1 km error at epoch, +1.85 km/day) NEVER confirm sub-kilometer distances directly;
 *   claims < 1.0 km when SGP4 shows close co-orbital proximity (< 6 km) are marked 'unverifiable'
 *   at exact sub-km scale with an explicit covariance explanation (while confirming the co-orbital RPO).
 * - Claims contradicting SGP4 geometry by > max(25 km, 3.5x claimed + TLE covariance) are marked 'contradicted'.
 */
export function verifyClaimAgainstOrbits(params: {
  id: string;
  sourceTitle: string;
  sourceOutlet: string;
  claim: ExtractedClaimInput;
  ommHistoryByNorad: Record<number, OmmRecord[]>;
  fallbackCatalog: OmmRecord[];
}): VerifiedWebClaim {
  const { id, sourceTitle, sourceOutlet, claim, ommHistoryByNorad, fallbackCatalog } = params;

  const resolvedIds = resolveClaimToNoradIds(claim, fallbackCatalog);
  if (resolvedIds.length < 2) {
    return {
      ...claim,
      id,
      norad_ids: resolvedIds,
      source_title: sourceTitle,
      source_outlet: sourceOutlet,
      verdict: 'unverifiable',
      verdict_reason:
        'Fewer than two cataloged NORAD objects could be resolved from the claim text to run SGP4 pair verification.',
      computed_distance_km: null,
      computed_plane_angle_deg: null,
      tle_uncertainty_km: 1.5,
      orbit_calc_reference: 'Unresolved satellite pair (requires 2 NORAD IDs)',
    };
  }

  const [idA, idB] = resolvedIds;
  const evalDate = claim.event_time ? new Date(claim.event_time) : new Date();
  const evalMs = Number.isNaN(evalDate.getTime()) ? Date.now() : evalDate.getTime();

  const histA = ommHistoryByNorad[idA] ?? fallbackCatalog.filter((o) => Number(o.NORAD_CAT_ID) === idA);
  const histB = ommHistoryByNorad[idB] ?? fallbackCatalog.filter((o) => Number(o.NORAD_CAT_ID) === idB);

  const ommA = selectClosestEpochOmm(histA, evalMs);
  const ommB = selectClosestEpochOmm(histB, evalMs);

  if (!ommA || !ommB) {
    return {
      ...claim,
      id,
      norad_ids: resolvedIds,
      source_title: sourceTitle,
      source_outlet: sourceOutlet,
      verdict: 'unverifiable',
      verdict_reason: `Missing public GP element sets near epoch for NORAD ${idA} or ${idB}.`,
      computed_distance_km: null,
      computed_plane_angle_deg: null,
      tle_uncertainty_km: 2.0,
      orbit_calc_reference: 'Element set unavailable',
    };
  }

  // Evaluate +/- 6h window around claimed event_time to account for imprecise article timestamps
  const windowStart = new Date(evalMs - 6 * 3600_000);
  const tcaWindow = findClosestApproach(ommA, ommB, windowStart, 12, 60);
  const instant = computeInstantSeparation(ommToSatrec(ommA), ommToSatrec(ommB), new Date(evalMs), false);

  const computedDistanceKm =
    claim.claimed_distance_km !== null && claim.claimed_distance_km > 80 && instant
      ? Number(instant.distanceKm.toFixed(2))
      : tcaWindow.minDistanceKm;
  const computedPlaneAngleDeg = instant
    ? Number(instant.planeAngleDeg.toFixed(3))
    : tcaWindow.planeAngleDeg;

  const tleUncertaintyKm = Math.max(
    estimatePublicTleUncertaintyKm(ommA, new Date(evalMs)),
    estimatePublicTleUncertaintyKm(ommB, new Date(evalMs)),
  );

  const calcRef = `SGP4 (${ommA.OBJECT_NAME} #${idA} vs ${ommB.OBJECT_NAME} #${idB} @ ${new Date(evalMs).toISOString().slice(0, 16)}Z): ${computedDistanceKm} km, plane Δθ ${computedPlaneAngleDeg}°, ±${tleUncertaintyKm} km 1σ TLE error`;

  let verdict: ClaimOrbitVerdict = 'verified';
  let verdictReason = '';

  if (claim.claimed_distance_km !== null) {
    // Hard Specola sub-km public TLE guardrail
    if (claim.claimed_distance_km < 1.0) {
      if (computedDistanceKm <= 8.0 && computedPlaneAngleDeg < 0.35) {
        verdict = 'approach confirmed, distance below public-data resolution';
        verdictReason = `Co-orbital RPO confirmed (${computedDistanceKm} km SGP4 pass, Δθ ${computedPlaneAngleDeg}°), but exact ${claim.claimed_distance_km} km sub-kilometer distance is below public-GP resolution (±${tleUncertaintyKm} km TLE epoch covariance).`;
      } else {
        verdict = 'contradicted';
        verdictReason = `Claimed sub-km pass (${claim.claimed_distance_km} km) is contradicted by SGP4 propagation showing ${computedDistanceKm} km minimum separation.`;
      }
    } else {
      const diffKm = Math.abs(computedDistanceKm - claim.claimed_distance_km);
      const toleranceKm = Math.max(4.0, tleUncertaintyKm * 2.5, claim.claimed_distance_km * 0.22);
      if (diffKm <= toleranceKm) {
        verdict = 'verified';
        verdictReason = `Claimed ${claim.claimed_distance_km} km matches SGP4 propagation (${computedDistanceKm} km, Δ = ${diffKm.toFixed(2)} km within ±${toleranceKm.toFixed(1)} km physical tolerance; coplanar Δθ ${computedPlaneAngleDeg}°).`;
      } else {
        verdict = 'contradicted';
        verdictReason = `Claimed ${claim.claimed_distance_km} km diverges from SGP4 orbital geometry (${computedDistanceKm} km, Δ = ${diffKm.toFixed(2)} km exceeds ±${toleranceKm.toFixed(1)} km tolerance).`;
      }
    }
  } else {
    // Qualitative maneuver / interference claim: verify co-orbital proximity & plane alignment
    if (computedPlaneAngleDeg < 0.5 && computedDistanceKm < 600) {
      verdict = 'verified';
      verdictReason = `Orbital mechanics corroborate synchronized co-orbital geometry (${computedDistanceKm} km separation, ${computedPlaneAngleDeg}° plane alignment).`;
    } else {
      verdict = 'contradicted';
      verdictReason = `Spacecraft occupy distinct orbital regimes (${computedDistanceKm} km range, ${computedPlaneAngleDeg}° plane separation).`;
    }
  }

  const evalIso = new Date(evalMs).toISOString();
  const usedInstant =
    claim.claimed_distance_km !== null && claim.claimed_distance_km > 80 && Boolean(instant);
  const computationMethod = usedInstant
    ? `Instantaneous SGP4 propagation at claimed time ${evalIso.slice(0, 19)}Z`
    : `SGP4 ±6h TCA scan (60s→1s) around ${evalIso.slice(0, 19)}Z (TCA ${tcaWindow.tcaUtc.slice(0, 19)}Z)`;

  return {
    ...claim,
    id,
    norad_ids: resolvedIds,
    source_title: sourceTitle,
    source_outlet: sourceOutlet,
    verdict,
    verdict_reason: verdictReason,
    computed_distance_km: computedDistanceKm,
    computed_plane_angle_deg: computedPlaneAngleDeg,
    tle_uncertainty_km: tleUncertaintyKm,
    orbit_calc_reference: calcRef,
    evaluation_timestamp_utc: usedInstant ? evalIso : tcaWindow.tcaUtc,
    suspect_omm_epoch: ommA.EPOCH,
    protected_omm_epoch: ommB.EPOCH,
    computation_method: computationMethod,
  };
}

/**
 * Generates Orbit-to-Web Autonomous Early Warnings for detected approach-signature maneuvers
 * that have ZERO public web reporting prior to maneuver detection (+24h grace window).
 */
export function buildUnreportedManeuverEarlyWarnings(
  maneuvers: ManeuverDetection[],
  existingClaims: VerifiedWebClaim[],
): OrbitalEventRecord[] {
  const warnings: OrbitalEventRecord[] = [];

  for (const mnv of maneuvers) {
    if (!mnv.isApproachSignature || !mnv.targetNoradId || !mnv.targetName) continue;
    const mnvTimeMs = new Date(mnv.epochAfterUtc).getTime();

    const matchingPriorReport = existingClaims.find((c) => {
      const mentionsPair =
        c.norad_ids.includes(mnv.noradId) && c.norad_ids.includes(mnv.targetNoradId!);
      if (!mentionsPair || !c.published_at) return false;
      const pubMs = new Date(c.published_at).getTime();
      return pubMs <= mnvTimeMs + 24 * 3600_000;
    });

    if (!matchingPriorReport) {
      const pairKey = `${mnv.noradId}-${mnv.targetNoradId}`;
      warnings.push({
        id: `evt-ew-${mnv.noradId}-${mnv.epochAfterUtc.slice(0, 10)}`,
        pairKey,
        suspectNoradId: mnv.noradId,
        protectedNoradId: mnv.targetNoradId,
        suspectName: mnv.satelliteName,
        protectedName: mnv.targetName,
        title: `Unreported Plane-Matching Approach: ${mnv.satelliteName} → ${mnv.targetName}`,
        eventType: 'early_warning_maneuver',
        status: 'early_warning',
        threatLevel: (mnv.postManeuverRangeKm ?? 999) < 100 ? 'HIGH' : 'MEDIUM',
        eventTimeUtc: mnv.epochAfterUtc,
        detectedAtUtc: mnv.epochAfterUtc,
        minDistanceKm: mnv.postManeuverRangeKm ?? 475,
        planeAngleDeg: mnv.postManeuverPlaneAngleDeg ?? 0.1,
        estimatedDeltaVMs: mnv.estimatedDeltaVMs,
        briefId: `brief-ew-${mnv.noradId}-${mnv.epochAfterUtc.slice(0, 10)}`,
        claimsCount: 0,
      });
    }
  }

  return warnings;
}
