import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
} from 'satellite.js';
import type { SatRec } from 'satellite.js';
import type {
  ClosestApproachResult,
  ManeuverDetection,
  OmmRecord,
  PairTelemetrySnapshot,
  DataProvenance,
} from '../shared/types.ts';

export const MU_EARTH_KM3_S2 = 398600.4418;
export const EARTH_RADIUS_KM = 6378.137;
export const J2_EARTH = 1.08262668e-3;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export interface PropagatedState {
  positionEciKm: { x: number; y: number; z: number };
  velocityEciKms: { x: number; y: number; z: number };
  latDeg: number;
  lonDeg: number;
  altKm: number;
  speedKms: number;
  angularMomentumUnit: { x: number; y: number; z: number };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function normalizeSignedAngleDeg(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

const satrecCache = new WeakMap<OmmRecord, SatRec>();

export function ommToSatrec(omm: OmmRecord): SatRec {
  let cached = satrecCache.get(omm);
  if (!cached) {
    cached = json2satrec(omm);
    satrecCache.set(omm, cached);
  }
  return cached;
}

export function meanMotionToSemiMajorAxisKm(revsPerDay: number): number {
  const nRadPerSec = (revsPerDay * 2 * Math.PI) / 86400;
  return Math.cbrt(MU_EARTH_KM3_S2 / (nRadPerSec * nRadPerSec));
}

export function propagateSatrecAt(satrec: SatRec, date: Date, includeGeodetic = true): PropagatedState | null {
  const pv = propagate(satrec, date);
  if (!pv || !pv.position || !pv.velocity || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean') {
    return null;
  }

  const { x, y, z } = pv.position;
  const { x: vx, y: vy, z: vz } = pv.velocity;

  // Specific orbital angular momentum h = r x v
  const hx = y * vz - z * vy;
  const hy = z * vx - x * vz;
  const hz = x * vy - y * vx;
  const hMag = Math.hypot(hx, hy, hz) || 1;

  const speedKms = Math.hypot(vx, vy, vz);
  const rMag = Math.hypot(x, y, z);

  let latDeg = 0;
  let lonDeg = 0;
  let altKm = rMag - EARTH_RADIUS_KM;

  if (includeGeodetic) {
    const gmst = gstime(date);
    const geo = eciToGeodetic(pv.position, gmst);
    latDeg = degreesLat(geo.latitude);
    lonDeg = degreesLong(geo.longitude);
    altKm = geo.height;
  }

  return {
    positionEciKm: { x, y, z },
    velocityEciKms: { x: vx, y: vy, z: vz },
    latDeg,
    lonDeg,
    altKm,
    speedKms,
    angularMomentumUnit: { x: hx / hMag, y: hy / hMag, z: hz / hMag },
  };
}

export function propagateOmmAt(omm: OmmRecord, date: Date, includeGeodetic = true): PropagatedState | null {
  const satrec = ommToSatrec(omm);
  return propagateSatrecAt(satrec, date, includeGeodetic);
}

/**
 * Smoothly blends two bracketing SGP4 propagations in ECI spherical coordinates (direction slerp + radius lerp)
 * over [blendStartMs, blendEndMs] so OMM epoch transitions never produce orbital zigzags or teleportation jumps.
 */
export function propagateSatrecBlended(
  recA: SatRec,
  recB: SatRec | null,
  blendStartMs: number,
  blendEndMs: number,
  date: Date,
): PropagatedState | null {
  const tMs = date.getTime();
  if (!recB || recA === recB || blendEndMs <= blendStartMs || tMs <= blendStartMs) {
    return propagateSatrecAt(recA, date, true);
  }
  if (tMs >= blendEndMs) {
    return propagateSatrecAt(recB, date, true);
  }
  const stA = propagateSatrecAt(recA, date, false);
  const stB = propagateSatrecAt(recB, date, false);
  if (!stA) return propagateSatrecAt(recB, date, true);
  if (!stB) return propagateSatrecAt(recA, date, true);

  const rawU = clamp((tMs - blendStartMs) / (blendEndMs - blendStartMs), 0, 1);
  const w = rawU * rawU * (3 - 2 * rawU);

  const pA = stA.positionEciKm;
  const pB = stB.positionEciKm;
  const rA = Math.hypot(pA.x, pA.y, pA.z) || 1;
  const rB = Math.hypot(pB.x, pB.y, pB.z) || 1;
  const uAx = pA.x / rA;
  const uAy = pA.y / rA;
  const uAz = pA.z / rA;
  const uBx = pB.x / rB;
  const uBy = pB.y / rB;
  const uBz = pB.z / rB;

  const dot = clamp(uAx * uBx + uAy * uBy + uAz * uBz, -1, 1);
  let ux: number;
  let uy: number;
  let uz: number;
  if (dot > 0.999999) {
    const lx = uAx + (uBx - uAx) * w;
    const ly = uAy + (uBy - uAy) * w;
    const lz = uAz + (uBz - uAz) * w;
    const lm = Math.hypot(lx, ly, lz) || 1;
    ux = lx / lm;
    uy = ly / lm;
    uz = lz / lm;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta) || 1e-8;
    const kA = Math.sin((1 - w) * theta) / sinTheta;
    const kB = Math.sin(w * theta) / sinTheta;
    ux = uAx * kA + uBx * kB;
    uy = uAy * kA + uBy * kB;
    uz = uAz * kA + uBz * kB;
  }

  const r = rA + (rB - rA) * w;
  const eciBlend = { x: ux * r, y: uy * r, z: uz * r };
  const gmst = gstime(date);
  const geo = eciToGeodetic(eciBlend, gmst);
  return {
    positionEciKm: eciBlend,
    velocityEciKms: {
      x: stA.velocityEciKms.x + (stB.velocityEciKms.x - stA.velocityEciKms.x) * w,
      y: stA.velocityEciKms.y + (stB.velocityEciKms.y - stA.velocityEciKms.y) * w,
      z: stA.velocityEciKms.z + (stB.velocityEciKms.z - stA.velocityEciKms.z) * w,
    },
    latDeg: degreesLat(geo.latitude),
    lonDeg: degreesLong(geo.longitude),
    altKm: geo.height,
    speedKms: stA.speedKms + (stB.speedKms - stA.speedKms) * w,
    angularMomentumUnit: stA.angularMomentumUnit,
  };
}

/**
 * Computes exact 3D angle between two orbital planes using osculating SGP4 angular momentum vectors,
 * falling back to analytical spherical-trigonometry from inclination & RAAN if propagation is unavailable.
 */
export function computePlaneAngleDeg(ommA: OmmRecord, ommB: OmmRecord, date: Date): number {
  const stateA = propagateOmmAt(ommA, date, false);
  const stateB = propagateOmmAt(ommB, date, false);

  if (stateA && stateB) {
    const dot = clamp(
      stateA.angularMomentumUnit.x * stateB.angularMomentumUnit.x +
        stateA.angularMomentumUnit.y * stateB.angularMomentumUnit.y +
        stateA.angularMomentumUnit.z * stateB.angularMomentumUnit.z,
      -1,
      1,
    );
    return Math.acos(dot) * RAD_TO_DEG;
  }

  return computeAnalyticalPlaneAngleDeg(
    ommA.INCLINATION,
    ommA.RA_OF_ASC_NODE,
    ommB.INCLINATION,
    ommB.RA_OF_ASC_NODE,
  );
}

export function computeAnalyticalPlaneAngleDeg(
  inc1Deg: number,
  raan1Deg: number,
  inc2Deg: number,
  raan2Deg: number,
): number {
  const i1 = inc1Deg * DEG_TO_RAD;
  const i2 = inc2Deg * DEG_TO_RAD;
  const dRaan = (raan1Deg - raan2Deg) * DEG_TO_RAD;
  const cosTheta = clamp(
    Math.cos(i1) * Math.cos(i2) + Math.sin(i1) * Math.sin(i2) * Math.cos(dRaan),
    -1,
    1,
  );
  return Math.acos(cosTheta) * RAD_TO_DEG;
}

export function computeInstantSeparation(
  satrecA: SatRec,
  satrecB: SatRec,
  date: Date,
  includeGeodetic = false,
): {
  distanceKm: number;
  relativeVelocityKms: number;
  planeAngleDeg: number;
  stateA: PropagatedState;
  stateB: PropagatedState;
} | null {
  const stateA = propagateSatrecAt(satrecA, date, includeGeodetic);
  const stateB = propagateSatrecAt(satrecB, date, includeGeodetic);
  if (!stateA || !stateB) return null;

  const dx = stateA.positionEciKm.x - stateB.positionEciKm.x;
  const dy = stateA.positionEciKm.y - stateB.positionEciKm.y;
  const dz = stateA.positionEciKm.z - stateB.positionEciKm.z;
  const distanceKm = Math.hypot(dx, dy, dz);

  const dvx = stateA.velocityEciKms.x - stateB.velocityEciKms.x;
  const dvy = stateA.velocityEciKms.y - stateB.velocityEciKms.y;
  const dvz = stateA.velocityEciKms.z - stateB.velocityEciKms.z;
  const relativeVelocityKms = Math.hypot(dvx, dvy, dvz);

  const dot = clamp(
    stateA.angularMomentumUnit.x * stateB.angularMomentumUnit.x +
      stateA.angularMomentumUnit.y * stateB.angularMomentumUnit.y +
      stateA.angularMomentumUnit.z * stateB.angularMomentumUnit.z,
    -1,
    1,
  );
  const planeAngleDeg = Math.acos(dot) * RAD_TO_DEG;

  return {
    distanceKm,
    relativeVelocityKms,
    planeAngleDeg,
    stateA,
    stateB,
  };
}

/**
 * Vectorized 2-stage coarse-to-fine Time of Closest Approach (TCA) search over an arbitrary window (default 72h).
 * Stage 1: 60-second SGP4 ECI grid.
 * Stage 2: 1-second local scan +/- 90s around the top 4 candidate minima, followed by golden-section sub-second polish.
 */
export function findClosestApproach(
  ommPrimary: OmmRecord,
  ommSecondary: OmmRecord,
  windowStart: Date,
  windowHours = 72,
  coarseStepSec = 60,
): ClosestApproachResult {
  const satA = ommToSatrec(ommPrimary);
  const satB = ommToSatrec(ommSecondary);

  const startMs = windowStart.getTime();
  const endMs = startMs + windowHours * 3600 * 1000;
  const stepMs = coarseStepSec * 1000;

  const samples: { tMs: number; distKm: number }[] = [];
  for (let tMs = startMs; tMs <= endMs; tMs += stepMs) {
    const sep = computeInstantSeparation(satA, satB, new Date(tMs), false);
    if (sep) {
      samples.push({ tMs, distKm: sep.distanceKm });
    }
  }

  // Collect local minima + global boundary minima
  const candidateTimesMs: { tMs: number; distKm: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const prev = i > 0 ? samples[i - 1].distKm : Infinity;
    const curr = samples[i].distKm;
    const next = i < samples.length - 1 ? samples[i + 1].distKm : Infinity;
    if (curr <= prev && curr <= next) {
      candidateTimesMs.push(samples[i]);
    }
  }
  candidateTimesMs.sort((a, b) => a.distKm - b.distKm);
  const topCandidates = candidateTimesMs.slice(0, 4);
  if (topCandidates.length === 0 && samples.length > 0) {
    topCandidates.push(samples[0]);
  }

  let bestMs = startMs;
  let bestDistKm = Infinity;

  // Stage 2A: 1-second fine scan around top candidates
  for (const cand of topCandidates) {
    const fineStart = Math.max(startMs, cand.tMs - 90_000);
    const fineEnd = Math.min(endMs, cand.tMs + 90_000);
    for (let t = fineStart; t <= fineEnd; t += 1000) {
      const sep = computeInstantSeparation(satA, satB, new Date(t), false);
      if (sep && sep.distanceKm < bestDistKm) {
        bestDistKm = sep.distanceKm;
        bestMs = t;
      }
    }
  }

  // Stage 2B: Golden-section refinement within +/- 1500 ms around bestMs
  let left = Math.max(startMs, bestMs - 1500);
  let right = Math.min(endMs, bestMs + 1500);
  const invPhi = (Math.sqrt(5) - 1) / 2;
  for (let iter = 0; iter < 14; iter++) {
    const c = right - (right - left) * invPhi;
    const d = left + (right - left) * invPhi;
    const sc = computeInstantSeparation(satA, satB, new Date(c), false);
    const sd = computeInstantSeparation(satA, satB, new Date(d), false);
    if (!sc || !sd) break;
    if (sc.distanceKm < sd.distanceKm) {
      right = d;
    } else {
      left = c;
    }
  }
  bestMs = Math.round((left + right) / 2);

  const bestDetail = computeInstantSeparation(satA, satB, new Date(bestMs), true);
  const tcaIso = new Date(bestMs).toISOString();

  if (!bestDetail) {
    return {
      primaryNoradId: Number(ommPrimary.NORAD_CAT_ID),
      secondaryNoradId: Number(ommSecondary.NORAD_CAT_ID),
      tcaUtc: tcaIso,
      minDistanceKm: 99999,
      relativeVelocityKms: 0,
      planeAngleDeg: 0,
      primaryAltKm: 0,
      secondaryAltKm: 0,
      windowHours,
      computationSummary: 'SGP4 propagation out of range for epoch.',
    };
  }

  const roundedDist = Number(bestDetail.distanceKm.toFixed(2));
  const roundedVel = Number(bestDetail.relativeVelocityKms.toFixed(3));
  const roundedPlane = Number(bestDetail.planeAngleDeg.toFixed(3));

  return {
    primaryNoradId: Number(ommPrimary.NORAD_CAT_ID),
    secondaryNoradId: Number(ommSecondary.NORAD_CAT_ID),
    tcaUtc: tcaIso,
    minDistanceKm: roundedDist,
    relativeVelocityKms: roundedVel,
    planeAngleDeg: roundedPlane,
    primaryAltKm: Number(bestDetail.stateA.altKm.toFixed(2)),
    secondaryAltKm: Number(bestDetail.stateB.altKm.toFixed(2)),
    windowHours,
    computationSummary: `SGP4 60s→1s TCA: ${roundedDist} km at ${tcaIso.slice(0, 19)}Z (rel-v ${roundedVel} km/s, plane Δθ ${roundedPlane}°)`,
  };
}

/**
 * Computes secular J2 nodal precession rate (deg/day) so natural oblateness drift is never mistaken for a burn.
 */
export function computeExpectedJ2RaanRateDegPerDay(omm: OmmRecord): number {
  const aKm = meanMotionToSemiMajorAxisKm(omm.MEAN_MOTION);
  const e = omm.ECCENTRICITY;
  const pKm = aKm * (1 - e * e);
  const nRadPerSec = (omm.MEAN_MOTION * 2 * Math.PI) / 86400;
  const incRad = omm.INCLINATION * DEG_TO_RAD;

  const omegaDotRadPerSec =
    -1.5 * J2_EARTH * Math.pow(EARTH_RADIUS_KM / pKm, 2) * nRadPerSec * Math.cos(incRad);
  return omegaDotRadPerSec * RAD_TO_DEG * 86400;
}

/**
 * Detects non-Keplerian / non-J2 orbital maneuvers across consecutive element sets,
 * estimates delta-v via vis-viva + plane-change kinematics, and flags "approach signatures"
 * that reduce plane angle or separation toward a protected asset.
 */
export function detectManeuversFromHistory(
  history: OmmRecord[],
  protectedTargetHistory?: OmmRecord[],
): ManeuverDetection[] {
  if (history.length < 2) return [];

  const sorted = [...history].sort(
    (a, b) => new Date(a.EPOCH).getTime() - new Date(b.EPOCH).getTime(),
  );
  const sortedTarget = protectedTargetHistory
    ? [...protectedTargetHistory].sort(
        (a, b) => new Date(a.EPOCH).getTime() - new Date(b.EPOCH).getTime(),
      )
    : [];

  const pickClosestOmm = (list: OmmRecord[], epochMs: number): OmmRecord | undefined => {
    if (list.length === 0) return undefined;
    let best = list[0];
    let bestDiff = Math.abs(new Date(best.EPOCH).getTime() - epochMs);
    for (const item of list) {
      const diff = Math.abs(new Date(item.EPOCH).getTime() - epochMs);
      if (diff < bestDiff) {
        best = item;
        bestDiff = diff;
      }
    }
    return best;
  };

  const detections: ManeuverDetection[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    const tPrev = new Date(prev.EPOCH).getTime();
    const tCurr = new Date(curr.EPOCH).getTime();
    const dtDays = (tCurr - tPrev) / 86400_000;
    if (dtDays <= 0.01) continue;

    const aPrev = meanMotionToSemiMajorAxisKm(prev.MEAN_MOTION);
    const aCurr = meanMotionToSemiMajorAxisKm(curr.MEAN_MOTION);
    // Expected natural drag semi-major axis change from MEAN_MOTION_DOT (dn/dt ≈ 2 * MEAN_MOTION_DOT)
    const expectedDeltaN = 2 * prev.MEAN_MOTION_DOT * dtDays;
    const aExpectedDrag = meanMotionToSemiMajorAxisKm(prev.MEAN_MOTION + expectedDeltaN);
    const residualDeltaAKm = (aCurr - aPrev) - (aExpectedDrag - aPrev);

    const deltaIncDeg = curr.INCLINATION - prev.INCLINATION;

    const expectedRaanDriftDeg = computeExpectedJ2RaanRateDegPerDay(prev) * dtDays;
    const rawDeltaRaan = normalizeSignedAngleDeg(curr.RA_OF_ASC_NODE - prev.RA_OF_ASC_NODE);
    const residualDeltaRaanDeg = normalizeSignedAngleDeg(rawDeltaRaan - expectedRaanDriftDeg);

    // Thresholds above normal LEO SGP4 fit noise (~0.15 km in a, ~0.008 deg in i, ~0.02 deg residual RAAN)
    const hasAltitudeBurn = Math.abs(residualDeltaAKm) >= 0.35;
    const hasPlaneBurn =
      Math.abs(deltaIncDeg) >= 0.012 || Math.abs(residualDeltaRaanDeg) >= 0.03;

    if (!hasAltitudeBurn && !hasPlaneBurn) continue;

    // Vis-viva orbital speed v ≈ sqrt(mu / a)
    const vOrbitalMs = Math.sqrt(MU_EARTH_KM3_S2 / aPrev) * 1000;
    // Tangential Δv for semi-major axis change: Δv_a ≈ (v / (2a)) * |Δa|
    const dvTangentialMs = (vOrbitalMs / (2 * aPrev)) * Math.abs(residualDeltaAKm);

    // Out-of-plane angle change Δθ ≈ sqrt(Δi^2 + (sin(i) * ΔΩ_res)^2)
    const sinInc = Math.sin(prev.INCLINATION * DEG_TO_RAD);
    const planeChangeRad =
      Math.hypot(deltaIncDeg, sinInc * residualDeltaRaanDeg) * DEG_TO_RAD;
    const dvPlaneMs = 2 * vOrbitalMs * Math.sin(planeChangeRad / 2);

    const estimatedDeltaVMs = Number(Math.hypot(dvTangentialMs, dvPlaneMs).toFixed(2));
    if (estimatedDeltaVMs < 0.18) continue;

    let isApproachSignature = false;
    let postManeuverRangeKm: number | undefined;
    let postManeuverPlaneAngleDeg: number | undefined;
    let targetNoradId: number | undefined;
    let targetName: string | undefined;

    const targetBefore = pickClosestOmm(sortedTarget, tPrev);
    const targetAfter = pickClosestOmm(sortedTarget, tCurr);

    if (targetBefore && targetAfter) {
      targetNoradId = Number(targetAfter.NORAD_CAT_ID);
      targetName = targetAfter.OBJECT_NAME;

      const planeBefore = computePlaneAngleDeg(prev, targetBefore, new Date(tPrev));
      const planeAfter = computePlaneAngleDeg(curr, targetAfter, new Date(tCurr));
      const sepAfter = computeInstantSeparation(
        ommToSatrec(curr),
        ommToSatrec(targetAfter),
        new Date(tCurr),
        false,
      );
      const tcaBefore = findClosestApproach(prev, targetBefore, new Date(tPrev), 24, 120);
      const tcaAfter = findClosestApproach(curr, targetAfter, new Date(tCurr), 24, 120);

      postManeuverRangeKm = sepAfter
        ? Number(sepAfter.distanceKm.toFixed(2))
        : tcaAfter.minDistanceKm;
      postManeuverPlaneAngleDeg = Number(planeAfter.toFixed(3));

      const reducedPlane = planeAfter < planeBefore - 0.015 || planeAfter < 0.25;
      const reducedRange = tcaAfter.minDistanceKm < tcaBefore.minDistanceKm * 0.88;
      if (reducedPlane && (reducedRange || (postManeuverRangeKm ?? 999) < 550)) {
        isApproachSignature = true;
      }
    }

    let maneuverType: ManeuverDetection['maneuverType'] = 'phasing_altitude';
    if (hasAltitudeBurn && hasPlaneBurn) {
      maneuverType = 'combined_rpo';
    } else if (hasPlaneBurn) {
      maneuverType = 'plane_change';
    } else if (!isApproachSignature && postManeuverRangeKm && postManeuverRangeKm > 40) {
      maneuverType = 'drift_departure';
    }

    detections.push({
      id: `mnv-${curr.NORAD_CAT_ID}-${curr.EPOCH.slice(0, 10)}`,
      noradId: Number(curr.NORAD_CAT_ID),
      satelliteName: curr.OBJECT_NAME,
      epochBeforeUtc: prev.EPOCH,
      epochAfterUtc: curr.EPOCH,
      deltaSemiMajorAxisKm: Number(residualDeltaAKm.toFixed(3)),
      deltaInclinationDeg: Number(deltaIncDeg.toFixed(4)),
      residualDeltaRaanDeg: Number(residualDeltaRaanDeg.toFixed(4)),
      estimatedDeltaVMs,
      maneuverType,
      isApproachSignature,
      targetNoradId,
      targetName,
      postManeuverRangeKm,
      postManeuverPlaneAngleDeg,
      summary: `${curr.OBJECT_NAME} executed Δv ≈ ${estimatedDeltaVMs} m/s (Δa ${residualDeltaAKm >= 0 ? '+' : ''}${residualDeltaAKm.toFixed(2)} km, residual ΔΩ ${residualDeltaRaanDeg >= 0 ? '+' : ''}${residualDeltaRaanDeg.toFixed(3)}°)${
        isApproachSignature && targetName
          ? ` — APPROACH SIGNATURE converging on ${targetName} (plane Δθ ${postManeuverPlaneAngleDeg}°, 24h min range ${postManeuverRangeKm} km)`
          : ''
      }`,
    });
  }

  return detections;
}

export function generateOrbitTrackGeo(
  omm: OmmRecord,
  centerDate: Date,
  durationMinutes?: number,
  _stepMinutes?: number,
  stepCount = 360,
): [number, number, number][] {
  const satrec = ommToSatrec(omm);
  const meanMotion = Number(omm.MEAN_MOTION) > 0.05 ? Number(omm.MEAN_MOTION) : 15.0;
  const fullPeriodMinutes = 1440 / meanMotion;
  const spanMinutes =
    durationMinutes && durationMinutes > fullPeriodMinutes * 1.2
      ? durationMinutes
      : fullPeriodMinutes;
  const numSteps = Math.max(24, stepCount);

  const points: [number, number, number][] = [];
  const halfMs = (spanMinutes / 2) * 60_000;
  const centerMs = centerDate.getTime();
  // Freeze Earth orientation at centerDate so the entire 3D orbital ring passes through
  // the satellite's current geodetic sub-point AND closes 360 deg around Earth (LEO & GEO).
  const gmstRef = gstime(centerDate);

  for (let i = 0; i < numSteps; i++) {
    const frac = i / numSteps;
    const t = centerMs - halfMs + frac * (spanMinutes * 60_000);
    const pv = propagate(satrec, new Date(t));
    if (
      pv &&
      pv.position &&
      typeof pv.position !== 'boolean'
    ) {
      const geo = eciToGeodetic(pv.position, gmstRef);
      const latDeg = degreesLat(geo.latitude);
      const lonDeg = degreesLong(geo.longitude);
      const altKm = geo.height;
      if (Number.isFinite(lonDeg) && Number.isFinite(latDeg) && Number.isFinite(altKm)) {
        points.push([
          Number(lonDeg.toFixed(4)),
          Number(latDeg.toFixed(4)),
          Math.round(altKm * 1000),
        ]);
      }
    }
  }

  // Explicitly close the ring back onto the starting vertex around the whole globe
  if (points.length > 2) {
    points.push([...points[0]]);
  }
  return points;
}

export function computePairSnapshot(
  suspectOmm: OmmRecord,
  protectedOmm: OmmRecord,
  suspectProvenance: DataProvenance,
  protectedProvenance: DataProvenance,
  atDate: Date,
): PairTelemetrySnapshot {
  const satSuspect = ommToSatrec(suspectOmm);
  const satProtected = ommToSatrec(protectedOmm);
  const sep = computeInstantSeparation(satSuspect, satProtected, atDate, true);
  const tca72h = findClosestApproach(suspectOmm, protectedOmm, atDate, 72, 60);

  const currentDistanceKm = sep ? Number(sep.distanceKm.toFixed(2)) : tca72h.minDistanceKm;
  const planeAngleDeg = sep ? Number(sep.planeAngleDeg.toFixed(3)) : tca72h.planeAngleDeg;
  const relativeSpeedKms = sep ? Number(sep.relativeVelocityKms.toFixed(3)) : tca72h.relativeVelocityKms;
  const suspectAltKm = sep ? Number(sep.stateA.altKm.toFixed(2)) : tca72h.primaryAltKm;
  const protectedAltKm = sep ? Number(sep.stateB.altKm.toFixed(2)) : tca72h.secondaryAltKm;

  let coplanarClassification: PairTelemetrySnapshot['coplanarClassification'] = 'distinct_planes';
  if (planeAngleDeg < 0.35) {
    coplanarClassification = 'coplanar_shadow';
  } else if (planeAngleDeg < 2.0) {
    coplanarClassification = 'near_coplanar';
  }

  return {
    suspectNoradId: Number(suspectOmm.NORAD_CAT_ID),
    protectedNoradId: Number(protectedOmm.NORAD_CAT_ID),
    suspectName: suspectOmm.OBJECT_NAME,
    protectedName: protectedOmm.OBJECT_NAME,
    computedAtUtc: atDate.toISOString(),
    currentDistanceKm,
    planeAngleDeg,
    relativeSpeedKms,
    suspectAltKm,
    protectedAltKm,
    coplanarClassification,
    tca72h,
    suspectProvenance,
    protectedProvenance,
  };
}

/**
 * Estimates 1-sigma public GP/TLE positional covariance (km) at targetTime relative to element epoch.
 * Public TLE baseline error: ~1.0 km at epoch + ~2.0 km/day along-track drift.
 */
export function estimatePublicTleUncertaintyKm(omm: OmmRecord, targetDate: Date): number {
  const ageDays = Math.abs(targetDate.getTime() - new Date(omm.EPOCH).getTime()) / 86400_000;
  return Number((1.0 + 1.85 * ageDays).toFixed(2));
}
