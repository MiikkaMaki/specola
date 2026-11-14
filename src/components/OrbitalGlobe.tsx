import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import * as topojson from 'topojson-client';
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import type {
  HistoricalAlarmItem,
  HistoricalOrbitStatePayload,
  LiveFeedItem,
  ManeuverDetection,
  OrbitalEventRecord,
  PairContextDossier,
  PairTelemetrySnapshot,
  ReplayPoint,
  SatelliteGroupId,
  WatchedSatellite,
} from '../shared/types';

interface HighResPairTrack {
  suspectNoradId: number;
  protectedNoradId: number;
  startMs: number;
  stepMs: number;
  // [tMs, sLat, sLon, sAltKm, sSpd, pLat, pLon, pAltKm, pSpd]
  points: [number, number, number, number, number, number, number, number, number][];
}

type TimeScaleMode = 'fine' | 'medium' | 'campaign';

const TIME_SCALE_CONFIG: Record<
  TimeScaleMode,
  { shortLabel: string; label: string; minSec: number; maxSec: number; stepSec: number }
> = {
  fine: { shortLabel: '±30m', label: 'Fine ±30m (10s)', minSec: -1800, maxSec: 1800, stepSec: 10 },
  medium: { shortLabel: '±12h', label: 'Orbit ±12h (5m)', minSec: -43200, maxSec: 43200, stepSec: 300 },
  campaign: { shortLabel: '±30d', label: 'Span ±30d (6h)', minSec: -2592000, maxSec: 2592000, stepSec: 21600 },
};

interface OrbitalGlobeProps {
  satellites: WatchedSatellite[];
  groupSatellites?: WatchedSatellite[];
  activeGroup?: SatelliteGroupId;
  viewMode?: 'pair' | 'group';
  regimeFilter?: 'ALL' | 'LEO' | 'GEO';
  selectedPair: PairTelemetrySnapshot | null;
  replayPoint?: ReplayPoint | null;
  onSelectSatellite?: (noradId: number) => void;
  onSweepSatellite?: (noradId: number) => Promise<void>;
  sweepingNorad?: number | null;
  compactHeight?: boolean;
  events?: OrbitalEventRecord[];
  maneuvers?: ManeuverDetection[];
  feed?: LiveFeedItem[];
  onOpenAlertContext?: (alarm: HistoricalAlarmItem) => void;
  onClearPair?: () => void;
  demoTrigger?: { seq: number; timestampUtc: string; speed: number } | null;
  landingResetSeq?: number;
  onDemoComplete?: () => void;
}

type PositionRing = [number, number][];
type FollowTarget = 'free' | 'pair' | number;
type ProximityAlert = {
  level: 'collision' | 'warning';
  satA: WatchedSatellite;
  satB: WatchedSatellite;
  posA: Cesium.Cartesian3;
  posB: Cesium.Cartesian3;
  distanceKm: number;
};

const SPEED_STEPS = [1, 15, 60, 300] as const;
const EARTH_ROT_DEG_PER_SEC = 360 / 86164.0905;
const MU_EARTH_KM3_S2 = 398600.4418;
const R_EARTH_KM = 6378.137;

const DEMO_MAY_START_MS = Date.UTC(2026, 4, 16, 3, 55, 0);
const DEMO_BURN1_START_MS = Date.UTC(2026, 4, 16, 4, 14, 0); // Burn 1 @ 04:20Z (+0.29 deg inc)
const DEMO_BURN1_END_MS = Date.UTC(2026, 4, 16, 4, 26, 0); // 12m @ 90x = 8s slow-mo
const DEMO_BURN2_START_MS = Date.UTC(2026, 4, 16, 16, 59, 0); // Burn 2 @ 17:05Z (+0.60 deg inc -> plane lock)
const DEMO_BURN2_END_MS = Date.UTC(2026, 4, 16, 17, 11, 0); // 12m @ 90x = 8s slow-mo
const DEMO_BURN2_LINGER_END_MS = DEMO_BURN2_END_MS + 3 * 60_000; // +2s linger on coplanar lock
const DEMO_SEP_ZOOM_START_MS = Date.UTC(2026, 8, 28, 18, 0, 0);
const DEMO_BURN3_START_MS = Date.UTC(2026, 8, 30, 11, 26, 0); // Burn 3 @ 11:32Z (+15.5 km)
const DEMO_BURN3_END_MS = Date.UTC(2026, 8, 30, 11, 38, 0); // 12m @ 80x = 9s slow-mo zoomed on COSMOS
const DEMO_BURN4_START_MS = Date.UTC(2026, 8, 30, 16, 16, 0); // Burn 4 @ 16:22Z (+30.99 km -> slower orbit)
const DEMO_BURN4_END_MS = Date.UTC(2026, 8, 30, 16, 28, 0); // 12m @ 80x = 9s slow-mo zoomed on COSMOS
const DEMO_BURN4_LINGER_END_MS = DEMO_BURN4_END_MS + 4 * 60_000; // +3s linger showing lifted orbit
const DEMO_SEP_PULLOUT_END_MS = Date.UTC(2026, 9, 1, 18, 0, 0);
const DEMO_OCT_ZOOM_START_MS = Date.UTC(2026, 9, 12, 0, 0, 0);
const DEMO_BURN6_START_MS = Date.UTC(2026, 9, 12, 22, 32, 0); // Burn 6 @ 22:39Z (-47.8 km -> sped up to match)
const DEMO_BURN6_END_MS = Date.UTC(2026, 9, 12, 22, 48, 0); // 16m @ 80x = 12s slow-mo zoomed on COSMOS
const DEMO_BURN6_LINGER_END_MS = DEMO_BURN6_END_MS + 4 * 60_000; // +3s linger showing same height & speed
const DEMO_OCT_PULLOUT_END_MS = Date.UTC(2026, 9, 13, 12, 0, 0);
const DEMO_DESCENT_PRE1_MS = Date.UTC(2026, 9, 15, 12, 0, 0);
const DEMO_DESCENT_PRE2_MS = Date.UTC(2026, 9, 16, 5, 30, 0);
const DEMO_DESCENT_START_MS = Date.UTC(2026, 9, 16, 6, 55, 0);
const DEMO_DESCENT_END_MS = Date.UTC(2026, 9, 16, 7, 22, 0);
const DEMO_TCA_MS = Date.UTC(2026, 9, 16, 7, 27, 42);
const DEMO_CLOSEUP_END_MS = Date.UTC(2026, 9, 16, 7, 31, 30);

const DEMO_STEP_GATES_MS = [
  DEMO_BURN1_START_MS,
  DEMO_BURN2_START_MS,
  DEMO_SEP_ZOOM_START_MS,
  DEMO_BURN3_START_MS,
  DEMO_BURN4_START_MS,
  DEMO_OCT_ZOOM_START_MS,
  DEMO_BURN6_START_MS,
  DEMO_DESCENT_PRE1_MS,
  DEMO_DESCENT_PRE2_MS,
  DEMO_DESCENT_START_MS,
  DEMO_DESCENT_END_MS,
] as const;

const DEMO_JUMP_STOPS_MS = [
  DEMO_BURN1_START_MS,
  DEMO_BURN2_START_MS - 60_000,
  DEMO_BURN3_START_MS - 2 * 3600_000,
  DEMO_BURN4_START_MS - 60_000,
  DEMO_BURN6_START_MS - 2 * 3600_000,
  DEMO_DESCENT_START_MS,
] as const;

let cachedDemoTimelapseTrack: HighResPairTrack | null = null;

function smoothstep01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function computeDemoAutoSpeed(simMs: number): number {
  if (simMs < DEMO_BURN1_START_MS) return 1_800; // 30m/s brief lead-in (~0.6s)
  if (simMs < DEMO_BURN1_END_MS) return 90; // 90x really slow across May Burn 1 (8s)
  if (simMs < DEMO_BURN2_START_MS) return 28_800; // 8h/s coast to May Burn 2 (1.6s)
  if (simMs < DEMO_BURN2_LINGER_END_MS) return 90; // 90x really slow across May Burn 2 + linger (10s)
  if (simMs < DEMO_SEP_ZOOM_START_MS) return 2_592_000; // 30d/s mega-timelapse across summer (4.5s)
  if (simMs < DEMO_BURN3_START_MS) return 57_600; // 16h/s coast to Sep 30 burn (2.6s)
  if (simMs < DEMO_BURN3_END_MS) return 80; // 80x slow across Sep 30 Burn 3 (9s)
  if (simMs < DEMO_BURN4_START_MS) return 10_800; // 3h/s brief hop to Burn 4 (1.5s)
  if (simMs < DEMO_BURN4_LINGER_END_MS) return 80; // 80x slow across Sep 30 slowdown alert (12s)
  if (simMs < DEMO_SEP_PULLOUT_END_MS) return 43_200; // 12h/s coast out of Sep 30 (2.1s)
  if (simMs < DEMO_OCT_ZOOM_START_MS) return 259_200; // 3d/s silent higher-orbit catch-up coast (3.4s)
  if (simMs < DEMO_BURN6_START_MS) return 36_000; // 10h/s coast to Oct 12 burn (2.2s)
  if (simMs < DEMO_BURN6_LINGER_END_MS) return 80; // 80x slow across Oct 12 speedup alert (15s)
  if (simMs < DEMO_OCT_PULLOUT_END_MS) return 28_800; // 8h/s post-burn coast (1.6s)
  if (simMs < DEMO_DESCENT_PRE1_MS) return 172_800; // 2d/s coast into mid-Oct (1.2s)
  if (simMs < DEMO_DESCENT_PRE2_MS) return 43_200; // 12h/s Oct 15-16 approach (1.4s)
  if (simMs < DEMO_DESCENT_START_MS) return 7_200; // 2h/s final approach to 06:55Z (0.7s)
  if (simMs < DEMO_DESCENT_END_MS) {
    const u = smoothstep01((simMs - DEMO_DESCENT_START_MS) / (DEMO_DESCENT_END_MS - DEMO_DESCENT_START_MS));
    return 1_200 * Math.pow(45 / 1_200, u); // ~6s smooth exponential zoom-in descent
  }
  return 45; // 45x close-up right through 4.54 km closest point
}

function formatDemoSpeedLabel(spd: number): string {
  if (spd >= 86_400) return `${Math.round(spd / 86_400)}d/s`;
  if (spd >= 3_600) return `${Math.round(spd / 3_600)}h/s`;
  if (spd >= 600) return `${Math.round(spd / 60)}m/s`;
  return `${Math.round(spd)}×`;
}

// Exaggerates the May 16 out-of-plane inclination separation visually (14° -> 8° -> 0° coplanar lock)
// so viewers unmistakably see COSMOS 2612 enter ICEYE-X36's plane during Burns 1 & 2.
function computeVisualPlaneTiltRad(simMs: number): number {
  let deg = 0;
  if (simMs < DEMO_BURN1_START_MS) {
    deg = 14.0;
  } else if (simMs < DEMO_BURN1_END_MS) {
    const u = smoothstep01((simMs - DEMO_BURN1_START_MS) / (DEMO_BURN1_END_MS - DEMO_BURN1_START_MS));
    deg = 14.0 - 6.0 * u; // 14° -> 8° during Burn 1
  } else if (simMs < DEMO_BURN2_START_MS) {
    deg = 8.0;
  } else if (simMs < DEMO_BURN2_END_MS) {
    const u = smoothstep01((simMs - DEMO_BURN2_START_MS) / (DEMO_BURN2_END_MS - DEMO_BURN2_START_MS));
    deg = 8.0 * (1.0 - u); // 8° -> 0° during Burn 2 -> coplanar!
  }
  return (deg * Math.PI) / 180;
}

// Exaggerates the Sep 30 (+46.5 km) height raise -> Oct 12 (-47.8 km) drop radially on the globe
// so the higher/slower catch-up orbit and final same-height/same-speed drop are visually unmistakable.
function computeVisualRadialLiftMeters(simMs: number): number {
  let km = 0;
  if (simMs < DEMO_BURN3_START_MS) {
    km = 0;
  } else if (simMs < DEMO_BURN3_END_MS) {
    const u = smoothstep01((simMs - DEMO_BURN3_START_MS) / (DEMO_BURN3_END_MS - DEMO_BURN3_START_MS));
    km = 150 * u; // +15.5 km first step (1/3 of raise)
  } else if (simMs < DEMO_BURN4_START_MS) {
    km = 150;
  } else if (simMs < DEMO_BURN4_END_MS) {
    const u = smoothstep01((simMs - DEMO_BURN4_START_MS) / (DEMO_BURN4_END_MS - DEMO_BURN4_START_MS));
    km = 150 + 300 * u; // +30.99 km second step -> +46.5 km higher (450 km visual gap)
  } else if (simMs < DEMO_BURN6_START_MS) {
    km = 450; // Higher, slower orbit while ICEYE-X36 catches up
  } else if (simMs < DEMO_BURN6_END_MS) {
    const u = smoothstep01((simMs - DEMO_BURN6_START_MS) / (DEMO_BURN6_END_MS - DEMO_BURN6_START_MS));
    km = 450 * (1.0 - u); // -47.8 km final braking drop -> back to exact same height & speed
  }
  return km * 1000;
}

function wrapLonDeg(lon: number): number {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

function computeVisVivaSpeedKms(ommMeanMotion: number, altKm: number): number {
  const nRadSec = (Math.max(0.05, ommMeanMotion) * 2 * Math.PI) / 86400;
  const aKm = Math.cbrt(MU_EARTH_KM3_S2 / (nRadSec * nRadSec));
  const rKm = Math.max(R_EARTH_KM + 120, R_EARTH_KM + altKm);
  const vSq = MU_EARTH_KM3_S2 * (2 / rKm - 1 / aKm);
  return vSq > 0 ? Math.sqrt(vSq) : 7.5;
}

function findTrackSegment(
  pts: HighResPairTrack['points'],
  atMs: number,
): { i0: number; i1: number; alpha: number } {
  const n = pts.length;
  if (atMs <= pts[0][0]) return { i0: 0, i1: 1, alpha: 0 };
  if (atMs >= pts[n - 1][0]) return { i0: n - 2, i1: n - 1, alpha: 1 };
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= atMs) lo = mid;
    else hi = mid;
  }
  const t0 = pts[lo][0];
  const t1 = pts[hi][0];
  const span = Math.max(1, t1 - t0);
  return { i0: lo, i1: hi, alpha: Math.max(0, Math.min(1, (atMs - t0) / span)) };
}

function evalSmoothTrackCartesian(
  pts: HighResPairTrack['points'],
  atMs: number,
  off: number,
): Cesium.Cartesian3 {
  const firstMs = pts[0][0];
  const lastMs = pts[pts.length - 1][0];
  const clampedMs = Math.max(firstMs, Math.min(lastMs, atMs));
  const { i0, i1, alpha } = findTrackSegment(pts, clampedMs);

  const a = pts[i0];
  const b = pts[i1];
  const pPrev = pts[Math.max(0, i0 - 1)];
  const pNext = pts[Math.min(pts.length - 1, i1 + 1)];

  const cPrev = Cesium.Cartesian3.fromDegrees(pPrev[off + 1], pPrev[off], pPrev[off + 2] * 1000);
  const c1 = Cesium.Cartesian3.fromDegrees(a[off + 1], a[off], a[off + 2] * 1000);
  const c2 = Cesium.Cartesian3.fromDegrees(b[off + 1], b[off], b[off + 2] * 1000);
  const cNext = Cesium.Cartesian3.fromDegrees(pNext[off + 1], pNext[off], pNext[off + 2] * 1000);

  const dt = Math.max(1, b[0] - a[0]);
  const span1 = Math.max(1, b[0] - pPrev[0]);
  const span2 = Math.max(1, pNext[0] - a[0]);
  const m1Scale = i0 > 0 ? dt / span1 : 1;
  const m2Scale = i1 < pts.length - 1 ? dt / span2 : 1;

  const m1x = (i0 > 0 ? c2.x - cPrev.x : c2.x - c1.x) * m1Scale;
  const m1y = (i0 > 0 ? c2.y - cPrev.y : c2.y - c1.y) * m1Scale;
  const m1z = (i0 > 0 ? c2.z - cPrev.z : c2.z - c1.z) * m1Scale;

  const m2x = (i1 < pts.length - 1 ? cNext.x - c1.x : c2.x - c1.x) * m2Scale;
  const m2y = (i1 < pts.length - 1 ? cNext.y - c1.y : c2.y - c1.y) * m2Scale;
  const m2z = (i1 < pts.length - 1 ? cNext.z - c1.z : c2.z - c1.z) * m2Scale;

  const u = alpha;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  const raw = new Cesium.Cartesian3(
    h00 * c1.x + h10 * m1x + h01 * c2.x + h11 * m2x,
    h00 * c1.y + h10 * m1y + h01 * c2.y + h11 * m2y,
    h00 * c1.z + h10 * m1z + h01 * c2.z + h11 * m2z,
  );
  const r1 = Cesium.Cartesian3.magnitude(c1);
  const r2 = Cesium.Cartesian3.magnitude(c2);
  const targetR = r1 + (r2 - r1) * u;
  const rawMag = Cesium.Cartesian3.magnitude(raw) || 1;
  return Cesium.Cartesian3.multiplyByScalar(raw, targetR / rawMag, raw);
}

function samplePairTrackAtMs(
  track: HighResPairTrack,
  atMs: number,
  noradId: number,
  buildArc: boolean,
): {
  pos: Cesium.Cartesian3;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  speedKms: number;
  ring: Cesium.Cartesian3[];
} | null {
  const pts = track.points;
  if (pts.length < 2) return null;
  const firstMs = pts[0][0];
  const lastMs = pts[pts.length - 1][0];
  if (atMs < firstMs - 10_000 || atMs > lastMs + 10_000) return null;

  const isSuspect = noradId === track.suspectNoradId;
  const isProtected = noradId === track.protectedNoradId;
  if (!isSuspect && !isProtected) return null;
  const off = isSuspect ? 1 : 5;

  const clampedMs = Math.max(firstMs, Math.min(lastMs, atMs));
  const { i0, i1, alpha } = findTrackSegment(pts, clampedMs);

  const a = pts[i0];
  const b = pts[i1];
  const pos = evalSmoothTrackCartesian(pts, clampedMs, off);

  const latDeg = a[off] + (b[off] - a[off]) * alpha;
  const dLon = wrapLonDeg(b[off + 1] - a[off + 1]);
  const lonDeg = wrapLonDeg(a[off + 1] + dLon * alpha);
  const altKm = a[off + 2] + (b[off + 2] - a[off + 2]) * alpha;
  const speedKms = a[off + 3] + (b[off + 3] - a[off + 3]) * alpha;

  const ring: Cesium.Cartesian3[] = [];
  if (buildArc) {
    // Sub-second Hermite curve around current position so zoomed closeup lines are silky curved arcs
    const halfSpanMs = 150_000;
    const stepMs = 1_500;
    const rStart = Math.max(firstMs, clampedMs - halfSpanMs);
    const rEnd = Math.min(lastMs, clampedMs + halfSpanMs);
    for (let t = rStart; t < clampedMs; t += stepMs) {
      ring.push(evalSmoothTrackCartesian(pts, t, off));
    }
    ring.push(pos);
    for (let t = clampedMs + stepMs; t <= rEnd; t += stepMs) {
      ring.push(evalSmoothTrackCartesian(pts, t, off));
    }
  } else {
    // Dense 8-second sampled ~96-minute orbit ring (~720 smooth curved vertices)
    const halfOrbitMs = 48 * 60_000;
    const stepMs = 8_000;
    const rStart = Math.max(firstMs, clampedMs - halfOrbitMs);
    const rEnd = Math.min(lastMs, clampedMs + halfOrbitMs);
    for (let t = rStart; t <= rEnd; t += stepMs) {
      ring.push(evalSmoothTrackCartesian(pts, t, off));
    }
  }

  return { pos, latDeg, lonDeg, altKm, speedKms, ring };
}

/**
 * Samples a point along a satellite's closed 360-degree SGP4 `orbitTrack` at `offsetSec` seconds
 * from the element snapshot, accounting for orbital progression along the ring AND Earth's
 * sidereal rotation relative to the inertial orbital plane.
 */
function sampleOrbitAtOffset(
  sat: WatchedSatellite,
  offsetSec: number,
): {
  pos: Cesium.Cartesian3;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  speedKms: number;
  ring: Cesium.Cartesian3[];
} {
  const track = sat.orbitTrack;
  const lonDriftDeg = -offsetSec * EARTH_ROT_DEG_PER_SEC;

  if (!track || track.length < 3) {
    const lon = wrapLonDeg(sat.positionGeodetic.lonDeg + lonDriftDeg);
    return {
      pos: Cesium.Cartesian3.fromDegrees(
        lon,
        sat.positionGeodetic.latDeg,
        sat.positionGeodetic.altKm * 1000,
      ),
      latDeg: sat.positionGeodetic.latDeg,
      lonDeg: lon,
      altKm: sat.positionGeodetic.altKm,
      speedKms: sat.positionGeodetic.speedKms,
      ring: [],
    };
  }

  const ring = track.map(([tLon, tLat, tAltM]) =>
    Cesium.Cartesian3.fromDegrees(wrapLonDeg(tLon + lonDriftDeg), tLat, tAltM),
  );

  const meanMotion = Number(sat.omm.MEAN_MOTION) > 0.05 ? Number(sat.omm.MEAN_MOTION) : 15.0;
  const periodSec = 86400 / meanMotion;
  const frac = ((0.5 + offsetSec / periodSec) % 1 + 1) % 1;
  const segments = ring.length - 1;
  const fIdx = frac * segments;
  const i0 = Math.floor(fIdx) % segments;
  const i1 = (i0 + 1) % ring.length;
  const alpha = fIdx - Math.floor(fIdx);

  const pos = Cesium.Cartesian3.lerp(ring[i0], ring[i1], alpha, new Cesium.Cartesian3());
  const carto = Cesium.Cartographic.fromCartesian(pos);
  const altKm = carto.height / 1000;
  return {
    pos,
    latDeg: Cesium.Math.toDegrees(carto.latitude),
    lonDeg: Cesium.Math.toDegrees(carto.longitude),
    altKm,
    speedKms: computeVisVivaSpeedKms(meanMotion, altKm),
    ring,
  };
}

function drawRingsOnCanvas(
  ctx: CanvasRenderingContext2D,
  rings: PositionRing[],
  width: number,
  height: number,
  fill: boolean,
): void {
  const lonToX = (lon: number) => ((lon + 180) / 360) * width;
  const latToY = (lat: number) => ((90 - lat) / 180) * height;

  for (const ring of rings) {
    if (ring.length < 2) continue;
    ctx.beginPath();
    let prevLon = ring[0][0];
    ctx.moveTo(lonToX(prevLon), latToY(ring[0][1]));
    for (let i = 1; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      if (Math.abs(lon - prevLon) > 180) {
        ctx.moveTo(lonToX(lon), latToY(lat));
      } else {
        ctx.lineTo(lonToX(lon), latToY(lat));
      }
      prevLon = lon;
    }
    if (fill) {
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
}

let cachedVectorMapUrl: string | null = null;

async function createMonochromeVectorOverlayUrl(): Promise<string | null> {
  if (cachedVectorMapUrl) return cachedVectorMapUrl;
  try {
    const worldModule = await import('world-atlas/countries-50m.json');
    const topology = (worldModule.default ?? worldModule) as unknown as Parameters<
      typeof topojson.feature
    >[0];
    const countriesObj = (topology as unknown as { objects?: { countries?: unknown } }).objects
      ?.countries;
    if (!countriesObj) return null;

    const geo = topojson.feature(
      topology,
      countriesObj as Parameters<typeof topojson.feature>[1],
    ) as unknown as {
      features: { geometry?: { type: string; coordinates: unknown } }[];
    };

    const width = 4096;
    const height = 2048;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, width, height);

    ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = ((90 - lat) / 180) * height;
      ctx.strokeStyle = lat === 0 ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    for (let lon = -150; lon <= 180; lon += 30) {
      const x = ((lon + 180) / 360) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.48)';
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';

    for (const feature of geo.features) {
      const geom = feature.geometry;
      if (!geom) continue;
      if (geom.type === 'Polygon') {
        const rings = geom.coordinates as PositionRing[];
        drawRingsOnCanvas(ctx, rings, width, height, true);
        drawRingsOnCanvas(ctx, rings, width, height, false);
      } else if (geom.type === 'MultiPolygon') {
        const polygons = geom.coordinates as PositionRing[][];
        for (const rings of polygons) {
          drawRingsOnCanvas(ctx, rings, width, height, true);
          drawRingsOnCanvas(ctx, rings, width, height, false);
        }
      }
    }

    cachedVectorMapUrl = canvas.toDataURL('image/png');
    return cachedVectorMapUrl;
  } catch {
    return null;
  }
}

export function OrbitalGlobe({
  satellites,
  groupSatellites,
  activeGroup = 'watched',
  viewMode = 'group',
  regimeFilter = 'ALL',
  selectedPair,
  replayPoint,
  onSelectSatellite,
  compactHeight = false,
  events = [],
  maneuvers = [],
  feed = [],
  onOpenAlertContext,
  onClearPair,
  demoTrigger = null,
  landingResetSeq = 0,
  onDemoComplete,
}: OrbitalGlobeProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<Cesium.CesiumWidget | null>(null);
  const primitivesRef = useRef<{
    points: Cesium.PointPrimitiveCollection;
    polylines: Cesium.PolylineCollection;
    labels: Cesium.LabelCollection;
  } | null>(null);

  const onSelectRef = useRef(onSelectSatellite);
  onSelectRef.current = onSelectSatellite;
  const onDemoCompleteRef = useRef(onDemoComplete);
  onDemoCompleteRef.current = onDemoComplete;

  const [webglFallback, setWebglFallback] = useState(false);
  const [hoveredNoradId, setHoveredNoradId] = useState<number | null>(null);
  const [pinnedNoradId, setPinnedNoradId] = useState<number | null>(null);
  const hoverHideTimerRef = useRef<number | null>(null);
  const isCardHoveredRef = useRef(false);

  // Interactive simulation, multi-scale time navigation, & historical archive state
  const [isPlaying, setIsPlaying] = useState(true);
  const [speedValue, setSpeedValue] = useState<number>(15);
  const [simOffsetSec, setSimOffsetSec] = useState<number>(0);
  const [simBaseMs, setSimBaseMs] = useState<number>(() => Date.now());
  const [timeScale, setTimeScale] = useState<TimeScaleMode>('medium');
  const [historicalState, setHistoricalState] = useState<HistoricalOrbitStatePayload | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [alarmsExpanded, setAlarmsExpanded] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const [loadingDemoTrack, setLoadingDemoTrack] = useState(false);
  const [dismissedFlashKey, setDismissedFlashKey] = useState<string | null>(null);
  const [pulseFlashKey, setPulseFlashKey] = useState<string | null>(null);
  const [pairDossierByKey, setPairDossierByKey] = useState<Record<string, PairContextDossier>>({});
  const requestedDossiersRef = useRef(new Set<string>());
  const demoAutoRampRef = useRef(false);
  const demoActiveRef = useRef(false);
  demoActiveRef.current = demoActive;
  const [pairTrack, setPairTrack] = useState<HighResPairTrack | null>(null);
  const historicalStateRef = useRef<HistoricalOrbitStatePayload | null>(null);
  historicalStateRef.current = historicalState;
  const pairTrackRef = useRef<HighResPairTrack | null>(null);
  pairTrackRef.current = pairTrack;

  const [showOrbits, setShowOrbits] = useState(true);
  const [followTarget, setFollowTarget] = useState<FollowTarget>(replayPoint ? 'pair' : 'free');
  const [cameraFraming, setCameraFraming] = useState<'orbit' | 'closeup'>(
    replayPoint ? 'closeup' : 'orbit',
  );
  const wasReplayRef = useRef(Boolean(replayPoint));

  useEffect(() => {
    const isReplay = Boolean(replayPoint);
    if (isReplay) {
      setIsPlaying(false);
      if (!wasReplayRef.current) {
        setFollowTarget('pair');
        setCameraFraming('closeup');
      }
    } else if (wasReplayRef.current) {
      setFollowTarget('free');
      setCameraFraming('orbit');
    }
    wasReplayRef.current = isReplay;
  }, [replayPoint]);

  useEffect(() => {
    // Only reset base anchor when staying in live mode
    const isInPast = Math.abs(Date.now() - (simBaseMs + simOffsetSec * 1000)) > 6 * 3600_000;
    if (!isInPast && !historicalState && !demoTrigger) {
      setSimBaseMs(Date.now());
    }
  }, [satellites]);

  const effectiveSimMs = simBaseMs + simOffsetSec * 1000;
  const isHistoricalTime = !replayPoint && Date.now() - effectiveSimMs > 6 * 3600_000;
  const effectiveSimMsRef = useRef(effectiveSimMs);
  effectiveSimMsRef.current = effectiveSimMs;

  const historyBucket = isHistoricalTime
    ? demoActive && speedValue >= 172_800
      ? Math.floor(effectiveSimMs / (14 * 86400_000))
      : Math.floor(effectiveSimMs / (4 * 3600_000))
    : 0;
  const pairTrackBucket = selectedPair ? Math.floor(effectiveSimMs / (30 * 60_000)) : 0;

  // Triggered when user presses "Demo": start May 15 just before COSMOS 2612's +0.89° inclination match -> mega-timelapse -> smooth closeup glide
  useEffect(() => {
    if (!demoTrigger) return;
    const targetMs = new Date(demoTrigger.timestampUtc).getTime();
    if (Number.isNaN(targetMs)) return;
    demoAutoRampRef.current = true;
    setSimBaseMs(targetMs);
    setSimOffsetSec(0);
    setTimeScale('campaign');
    setSpeedValue(demoTrigger.speed);
    setFollowTarget('pair');
    setCameraFraming('orbit');
    setShowOrbits(true);
    setDemoActive(true);
    setDismissedFlashKey(null);
    setPulseFlashKey(null);
    setAlarmsExpanded(false);

    if (cachedDemoTimelapseTrack) {
      setLoadingDemoTrack(false);
      setPairTrack(cachedDemoTimelapseTrack);
      setIsPlaying(true);
      return;
    }

    setIsPlaying(false);
    setLoadingDemoTrack(true);
    let cancelled = false;
    fetch('/api/orbit/demo-timelapse')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: HighResPairTrack | null) => {
        if (!cancelled && data?.points?.length) {
          cachedDemoTimelapseTrack = data;
          setPairTrack(data);
          setIsPlaying(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingDemoTrack(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demoTrigger]);

  // Triggered when user clicks the top-left Specola wordmark: stop Demo animation & return to live landing view
  useEffect(() => {
    if (!landingResetSeq) return;
    demoAutoRampRef.current = false;
    setDemoActive(false);
    setLoadingDemoTrack(false);
    setPairTrack(null);
    setHistoricalState(null);
    setDismissedFlashKey(null);
    setPulseFlashKey(null);
    setAlarmsExpanded(false);
    setSimOffsetSec(0);
    setSimBaseMs(Date.now());
    setSpeedValue(15);
    setTimeScale('medium');
    setIsPlaying(true);
    setFollowTarget('free');
    setCameraFraming('orbit');
    const widget = widgetRef.current;
    if (widget && !widget.isDestroyed()) {
      widget.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(14.0, 49.0, 31_000_000),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      widget.scene.requestRender();
    }
  }, [landingResetSeq]);

  // Sync HUD speed badge, close-up framing flag, and smooth end-of-pass hold during Demo playback
  useEffect(() => {
    if (!demoActive || !demoAutoRampRef.current || !isPlaying || replayPoint) return;

    const targetSpd = Math.round(computeDemoAutoSpeed(effectiveSimMs));
    if (Math.abs(targetSpd - speedValue) > Math.max(15, targetSpd * 0.15)) {
      setSpeedValue(targetSpd);
    }

    if (effectiveSimMs >= DEMO_DESCENT_END_MS - 120_000) {
      if (cameraFraming !== 'closeup') setCameraFraming('closeup');
      if (timeScale !== 'fine') setTimeScale('fine');
    } else if (cameraFraming !== 'orbit') {
      setCameraFraming('orbit');
    }

    if (effectiveSimMs >= DEMO_CLOSEUP_END_MS) {
      demoAutoRampRef.current = false;
      setIsPlaying(false);
      onDemoCompleteRef.current?.();
    }
  }, [demoActive, isPlaying, replayPoint, effectiveSimMs, speedValue, cameraFraming, timeScale]);

  // Fetch true Space-Track historical positions + active alarms when user goes back in time (>6h)
  // Uses 4-hour quantized bucket so 60fps animation frames never abort in-flight fetches
  useEffect(() => {
    if (replayPoint) return;
    if (!isHistoricalTime) {
      if (historicalStateRef.current) setHistoricalState(null);
      return;
    }

    const queryMs = effectiveSimMsRef.current;
    const loadedMs = historicalStateRef.current
      ? new Date(historicalStateRef.current.timestampUtc).getTime()
      : null;
    if (loadedMs !== null && Math.abs(queryMs - loadedMs) <= 6 * 3600_000) {
      return;
    }

    let cancelled = false;
    const delayMs = demoActive ? 0 : 200;
    const timer = window.setTimeout(() => {
      setLoadingHistory(true);
      fetch(`/api/orbit/at?ts=${encodeURIComponent(new Date(queryMs).toISOString())}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: HistoricalOrbitStatePayload | null) => {
          if (!cancelled && data) {
            setHistoricalState(data);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoadingHistory(false);
        });
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [replayPoint, isHistoricalTime, historyBucket, demoTrigger?.seq]);

  // Fetch 3-second resolution SGP4 ephemeris when inspecting a pair so closeup motion & orbit curves stay exact
  // Uses 30-minute quantized bucket + ref check so 60fps animation frames never cancel the fetch
  useEffect(() => {
    if (replayPoint || !selectedPair) {
      if (pairTrackRef.current) setPairTrack(null);
      return;
    }

    const sId = selectedPair.suspectNoradId;
    const pId = selectedPair.protectedNoradId;
    const queryMs = effectiveSimMsRef.current;
    const existing = pairTrackRef.current;
    const covered =
      existing &&
      existing.suspectNoradId === sId &&
      existing.protectedNoradId === pId &&
      existing.points.length > 0 &&
      queryMs >= existing.points[0][0] + 60_000 &&
      queryMs <= existing.points[existing.points.length - 1][0] - 120_000;
    if (covered) return;
    if (demoActive && sId === 68762 && pId === 59103) return;

    let cancelled = false;
    const delayMs = demoActive || cameraFraming === 'closeup' ? 0 : 200;
    const timer = window.setTimeout(() => {
      fetch(
        `/api/orbit/pair-track?pair=${sId},${pId}&center=${encodeURIComponent(
          new Date(queryMs).toISOString(),
        )}&beforeMin=15&afterMin=35&stepSec=3`,
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((data: HighResPairTrack | null) => {
          if (!cancelled && data?.points?.length) {
            setPairTrack(data);
          }
        })
        .catch(() => {});
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    replayPoint,
    selectedPair?.suspectNoradId,
    selectedPair?.protectedNoradId,
    pairTrackBucket,
    demoTrigger?.seq,
    cameraFraming,
    demoActive,
  ]);

  // Merge primary watched list (or loaded historical Space-Track snapshot) with active group satellites
  const sourceCatalog = useMemo(() => {
    if (isHistoricalTime && historicalState && historicalState.satellites.length > 0) {
      return historicalState.satellites;
    }
    if (viewMode === 'group' && activeGroup !== 'watched' && groupSatellites && groupSatellites.length > 0) {
      return groupSatellites;
    }
    return satellites;
  }, [isHistoricalTime, historicalState, viewMode, activeGroup, groupSatellites, satellites]);

  const activeSuspectId = replayPoint ? (selectedPair?.suspectNoradId ?? 68762) : (selectedPair?.suspectNoradId ?? null);
  const activeProtectedId = replayPoint ? (selectedPair?.protectedNoradId ?? 59103) : (selectedPair?.protectedNoradId ?? null);

  const displayedSats = useMemo(() => {
    if (replayPoint) {
      const pairOnly = satellites.filter(
        (s) => s.noradId === activeSuspectId || s.noradId === activeProtectedId,
      );
      return pairOnly.length > 0 ? pairOnly : satellites.slice(0, 2);
    }

    if (viewMode === 'pair' && activeSuspectId !== null && activeProtectedId !== null) {
      const pairOnly = sourceCatalog.filter(
        (s) => s.noradId === activeSuspectId || s.noradId === activeProtectedId,
      );
      return pairOnly.length > 0 ? pairOnly : sourceCatalog.slice(0, 2);
    }

    const filtered = sourceCatalog.filter((s) => {
      if (regimeFilter === 'LEO') return s.positionGeodetic.altKm < 15_000;
      if (regimeFilter === 'GEO') return s.positionGeodetic.altKm >= 15_000;
      return true;
    });

    if (activeSuspectId !== null && activeProtectedId !== null) {
      const existingIds = new Set(filtered.map((s) => s.noradId));
      const activePairExtras = sourceCatalog.filter(
        (s) =>
          (s.noradId === activeSuspectId || s.noradId === activeProtectedId) &&
          !existingIds.has(s.noradId),
      );
      return activePairExtras.length > 0 ? [...activePairExtras, ...filtered] : filtered;
    }

    return filtered;
  }, [viewMode, replayPoint, satellites, sourceCatalog, regimeFilter, activeSuspectId, activeProtectedId]);

  // Initialize Cesium WebGL Globe + CAD-style camera controller once
  useEffect(() => {
    if (!mountRef.current) return;
    if (typeof window !== 'undefined') {
      (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = '/cesium/';
    }

    let widget: Cesium.CesiumWidget | null = null;
    let clickHandler: Cesium.ScreenSpaceEventHandler | null = null;
    let destroyed = false;

    try {
      widget = new Cesium.CesiumWidget(mountRef.current, {
        baseLayer: false,
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
        msaaSamples: 4,
        contextOptions: {
          webgl: { alpha: false, antialias: true },
        },
      });

      const scene = widget.scene;
      scene.backgroundColor = Cesium.Color.BLACK;
      scene.globe.baseColor = Cesium.Color.fromCssColorString('#080808');
      scene.globe.showGroundAtmosphere = true;
      scene.globe.enableLighting = false;
      scene.globe.atmosphereHueShift = 0.0;
      scene.globe.atmosphereSaturationShift = -1.0;
      scene.globe.atmosphereBrightnessShift = -0.35;
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.saturationShift = -1.0;
        scene.skyAtmosphere.brightnessShift = -0.45;
      }
      if (scene.skyBox) {
        scene.skyBox.show = false;
      }

      // CAD-style viewport interaction bindings: LMB / MMB Orbit, Shift+MMB / Shift+LMB Tilt, RMB / Wheel Zoom
      const ctrl = scene.screenSpaceCameraController;
      ctrl.rotateEventTypes = [
        Cesium.CameraEventType.LEFT_DRAG,
        Cesium.CameraEventType.MIDDLE_DRAG,
      ];
      ctrl.tiltEventTypes = [
        {
          eventType: Cesium.CameraEventType.MIDDLE_DRAG,
          modifier: Cesium.KeyboardEventModifier.SHIFT,
        },
        {
          eventType: Cesium.CameraEventType.LEFT_DRAG,
          modifier: Cesium.KeyboardEventModifier.SHIFT,
        },
        Cesium.CameraEventType.PINCH,
      ];
      ctrl.zoomEventTypes = [
        Cesium.CameraEventType.RIGHT_DRAG,
        Cesium.CameraEventType.WHEEL,
        Cesium.CameraEventType.PINCH,
      ];
      ctrl.inertiaSpin = 0.08;
      ctrl.inertiaZoom = 0.08;
      ctrl.inertiaTranslate = 0.08;
      ctrl.minimumZoomDistance = 2_000;
      ctrl.maximumZoomDistance = 300_000_000; // 300,000 km — allow unrestricted zoom-out far past the 35,786 km GEO ring
      if (scene.camera.frustum instanceof Cesium.PerspectiveFrustum) {
        scene.camera.frustum.far = 600_000_000;
      }

      Cesium.TileMapServiceImageryProvider.fromUrl('/cesium/Assets/Textures/NaturalEarthII', {
        fileExtension: 'jpg',
      })
        .then((tmsProvider) => {
          if (destroyed || !widget || widget.isDestroyed()) return;
          const baseLayer = widget.imageryLayers.addImageryProvider(tmsProvider, 0);
          baseLayer.saturation = 0.0;
          baseLayer.brightness = 0.36;
          baseLayer.contrast = 1.55;
          baseLayer.gamma = 0.92;
          widget.scene.requestRender();
        })
        .catch(() => {});

      createMonochromeVectorOverlayUrl()
        .then((dataUrl) => {
          if (!dataUrl || destroyed || !widget || widget.isDestroyed()) return;
          return Cesium.SingleTileImageryProvider.fromUrl(dataUrl);
        })
        .then((vectorProvider) => {
          if (!vectorProvider || destroyed || !widget || widget.isDestroyed()) return;
          widget.imageryLayers.addImageryProvider(vectorProvider);
          widget.scene.requestRender();
        })
        .catch(() => {});

      const polylines = widget.scene.primitives.add(new Cesium.PolylineCollection());
      const points = widget.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      const labels = widget.scene.primitives.add(new Cesium.LabelCollection());
      primitivesRef.current = { points, polylines, labels };

      widget.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(14.0, 49.0, 31_000_000),
      });

      clickHandler = new Cesium.ScreenSpaceEventHandler(widget.scene.canvas);
      clickHandler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
        if (!widget || widget.isDestroyed()) return;
        const picked = widget.scene.pick(movement.endPosition);
        if (picked && picked.id && typeof picked.id === 'number') {
          if (hoverHideTimerRef.current !== null) {
            window.clearTimeout(hoverHideTimerRef.current);
            hoverHideTimerRef.current = null;
          }
          widget.scene.canvas.style.cursor = 'pointer';
          setHoveredNoradId(picked.id);
        } else {
          widget.scene.canvas.style.cursor = 'crosshair';
          if (hoverHideTimerRef.current === null && !isCardHoveredRef.current) {
            hoverHideTimerRef.current = window.setTimeout(() => {
              hoverHideTimerRef.current = null;
              if (!isCardHoveredRef.current) {
                setHoveredNoradId(null);
              }
            }, 220);
          }
        }
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

      clickHandler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
        if (!widget || widget.isDestroyed()) return;
        const picked = widget.scene.pick(movement.position);
        if (picked && picked.id && typeof picked.id === 'number') {
          onSelectRef.current?.(picked.id);
          setPinnedNoradId(picked.id);
        } else {
          setPinnedNoradId(null);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      widgetRef.current = widget;
      widget.scene.requestRender();
    } catch {
      setWebglFallback(true);
    }

    return () => {
      destroyed = true;
      if (hoverHideTimerRef.current !== null) {
        window.clearTimeout(hoverHideTimerRef.current);
      }
      clickHandler?.destroy();
      if (widget && !widget.isDestroyed()) {
        widget.destroy();
      }
      widgetRef.current = null;
      primitivesRef.current = null;
    };
  }, []);

  // Continuous orbit / Demo mega-timelapse animation loop
  useEffect(() => {
    if (!isPlaying || replayPoint) return;

    let rafId = 0;
    let lastFrameMs = performance.now();

    const step = (nowPerf: number) => {
      const dtRealSec = Math.min(0.1, (nowPerf - lastFrameMs) / 1000);
      lastFrameMs = nowPerf;
      setSimOffsetSec((prev) => {
        const curMs = simBaseMs + prev * 1000;
        const activeSpd =
          demoActiveRef.current && demoAutoRampRef.current
            ? computeDemoAutoSpeed(curMs)
            : speedValue;
        let nextMs = curMs + dtRealSec * activeSpd * 1000;
        if (demoActiveRef.current && demoAutoRampRef.current) {
          for (const gateMs of DEMO_STEP_GATES_MS) {
            if (curMs < gateMs && nextMs > gateMs) {
              nextMs = gateMs + 500;
              break;
            }
          }
          if (nextMs > DEMO_CLOSEUP_END_MS) {
            nextMs = DEMO_CLOSEUP_END_MS;
          }
        }
        return (nextMs - simBaseMs) / 1000;
      });
      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying, speedValue, replayPoint, simBaseMs]);

  // Compute live/simulated positions, speeds, closed rings, and collision/proximity alerts
  const frameState = useMemo(() => {
    const isAnimating = !replayPoint && (isPlaying || simOffsetSec !== 0);
    const items: {
      sat: WatchedSatellite;
      pos: Cesium.Cartesian3;
      latDeg: number;
      lonDeg: number;
      altKm: number;
      speedKms: number;
      ring: Cesium.Cartesian3[];
    }[] = [];

    const histLoadedMs =
      isHistoricalTime && historicalState ? new Date(historicalState.timestampUtc).getTime() : null;
    const sampleDeltaSec =
      histLoadedMs !== null ? (effectiveSimMs - histLoadedMs) / 1000 : simOffsetSec;

    for (const sat of displayedSats) {
      const isSuspect = activeSuspectId !== null && sat.noradId === activeSuspectId;
      const isProtected = activeProtectedId !== null && sat.noradId === activeProtectedId;

      if (replayPoint && (isSuspect || isProtected)) {
        const geo = isSuspect ? replayPoint.suspectGeo : replayPoint.protectedGeo;
        const pos = Cesium.Cartesian3.fromDegrees(geo.lonDeg, geo.latDeg, geo.altKm * 1000);
        const histTrack = isSuspect
          ? replayPoint.suspectOrbitTrack
          : replayPoint.protectedOrbitTrack;
        const ring =
          histTrack && histTrack.length > 2
            ? histTrack.map(([tLon, tLat, tAltM]) =>
                Cesium.Cartesian3.fromDegrees(tLon, tLat, tAltM),
              )
            : [];
        items.push({
          sat,
          pos,
          latDeg: geo.latDeg,
          lonDeg: geo.lonDeg,
          altKm: geo.altKm,
          speedKms: computeVisVivaSpeedKms(Number(sat.omm.MEAN_MOTION), geo.altKm),
          ring,
        });
      } else if (
        pairTrack &&
        (isSuspect || isProtected) &&
        (() => {
          const isCloseupArc =
            cameraFraming === 'closeup' ||
            (demoActive && demoAutoRampRef.current && effectiveSimMs >= DEMO_DESCENT_END_MS - 180_000);
          const hit = samplePairTrackAtMs(
            pairTrack,
            effectiveSimMs,
            sat.noradId,
            isCloseupArc,
          );
          if (!hit) return false;
          items.push({
            sat,
            pos: hit.pos,
            latDeg: hit.latDeg,
            lonDeg: hit.lonDeg,
            altKm: hit.altKm,
            speedKms: hit.speedKms,
            ring: hit.ring,
          });
          return true;
        })()
      ) {
        // Sampled directly from 3-second SGP4 pairTrack above
      } else if (isHistoricalTime || isAnimating) {
        const sampled = sampleOrbitAtOffset(sat, sampleDeltaSec);
        items.push({ sat, ...sampled });
      } else {
        const pos = Cesium.Cartesian3.fromDegrees(
          sat.positionGeodetic.lonDeg,
          sat.positionGeodetic.latDeg,
          sat.positionGeodetic.altKm * 1000,
        );
        const ring =
          sat.orbitTrack.length > 2
            ? sat.orbitTrack.map(([tLon, tLat, tAltM]) =>
                Cesium.Cartesian3.fromDegrees(tLon, tLat, tAltM),
              )
            : [];
        items.push({
          sat,
          pos,
          latDeg: sat.positionGeodetic.latDeg,
          lonDeg: sat.positionGeodetic.lonDeg,
          altKm: sat.positionGeodetic.altKm,
          speedKms: sat.positionGeodetic.speedKms,
          ring,
        });
      }
    }

    const suspectItem =
      activeSuspectId !== null
        ? items.find((i) => i.sat.noradId === activeSuspectId) ?? null
        : null;
    const protectedItem =
      activeProtectedId !== null
        ? items.find((i) => i.sat.noradId === activeProtectedId) ?? null
        : null;

    const livePairDistKm =
      replayPoint
        ? replayPoint.distanceKm
        : suspectItem && protectedItem
          ? Cesium.Cartesian3.distance(suspectItem.pos, protectedItem.pos) / 1000
          : selectedPair?.currentDistanceKm ?? null;

    // During Demo, visually exaggerate:
    // 1) May 15-16 out-of-plane tilt (14° -> 9° -> 0° coplanar lock)
    // 2) Sep 30 height raise (+450 km visual halo) -> Oct 12 drop back down to 0 km (same height & speed)
    // while keeping livePairDistKm exact from raw SGP4 coordinates.
    if (
      demoActive &&
      demoAutoRampRef.current &&
      !replayPoint &&
      suspectItem &&
      protectedItem &&
      protectedItem.ring.length >= 16
    ) {
      const tiltRad = computeVisualPlaneTiltRad(effectiveSimMs);
      if (tiltRad > 1e-4) {
        const pRing = protectedItem.ring;
        const p0 = pRing[0];
        const pQ = pRing[Math.floor(pRing.length * 0.25)];
        const nP = Cesium.Cartesian3.cross(p0, pQ, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitudeSquared(nP) > 1) {
          Cesium.Cartesian3.normalize(nP, nP);
          let nodeAxis = Cesium.Cartesian3.cross(nP, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
          if (Cesium.Cartesian3.magnitudeSquared(nodeAxis) > 1e-6) {
            Cesium.Cartesian3.normalize(nodeAxis, nodeAxis);
            // Pick rotation sign that moves inclination toward shallower (< 97.83° -> toward +Z) matching real 96.96°
            const testQ = Cesium.Quaternion.fromAxisAngle(nodeAxis, 0.05);
            const testM = Cesium.Matrix3.fromQuaternion(testQ);
            const testN = Cesium.Matrix3.multiplyByVector(testM, nP, new Cesium.Cartesian3());
            if (testN.z < nP.z) {
              Cesium.Cartesian3.negate(nodeAxis, nodeAxis);
            }
            const rotQ = Cesium.Quaternion.fromAxisAngle(nodeAxis, tiltRad);
            const rotM = Cesium.Matrix3.fromQuaternion(rotQ);
            suspectItem.pos = Cesium.Matrix3.multiplyByVector(
              rotM,
              suspectItem.pos,
              new Cesium.Cartesian3(),
            );
            suspectItem.ring = suspectItem.ring.map((pt) =>
              Cesium.Matrix3.multiplyByVector(rotM, pt, new Cesium.Cartesian3()),
            );
            const exCarto = Cesium.Cartographic.fromCartesian(suspectItem.pos);
            suspectItem.latDeg = Cesium.Math.toDegrees(exCarto.latitude);
            suspectItem.lonDeg = Cesium.Math.toDegrees(exCarto.longitude);
            suspectItem.altKm = exCarto.height / 1000;
          }
        }
      }

      const radialLiftM = computeVisualRadialLiftMeters(effectiveSimMs);
      if (radialLiftM > 1) {
        const liftVec = (v: Cesium.Cartesian3): Cesium.Cartesian3 => {
          const mag = Cesium.Cartesian3.magnitude(v) || 1;
          return Cesium.Cartesian3.multiplyByScalar(
            v,
            (mag + radialLiftM) / mag,
            new Cesium.Cartesian3(),
          );
        };
        suspectItem.pos = liftVec(suspectItem.pos);
        suspectItem.ring = suspectItem.ring.map(liftVec);
        const liftCarto = Cesium.Cartographic.fromCartesian(suspectItem.pos);
        suspectItem.altKm = liftCarto.height / 1000;
      }
    }

    // Scan visible items for Collision Alert (< 5 km) or Proximity Warning (< 50 km LEO / < 150 km GEO)
    let closestAlert: ProximityAlert | null = null;
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const itemA = items[a];
        const itemB = items[b];
        if (Math.abs(itemA.altKm - itemB.altKm) > 350) continue;
        const distKm = Cesium.Cartesian3.distance(itemA.pos, itemB.pos) / 1000;
        const warnThreshold = Math.max(itemA.altKm, itemB.altKm) > 15_000 ? 150 : 50;
        if (distKm < warnThreshold) {
          if (!closestAlert || distKm < closestAlert.distanceKm) {
            closestAlert = {
              level: distKm < 5.0 ? 'collision' : 'warning',
              satA: itemA.sat,
              satB: itemB.sat,
              posA: itemA.pos,
              posB: itemB.pos,
              distanceKm: Number(distKm.toFixed(2)),
            };
          }
        }
      }
    }

    // Determine primary camera follow target
    let targetItem = protectedItem ?? items[0] ?? null;
    if (typeof followTarget === 'number') {
      targetItem = items.find((i) => i.sat.noradId === followTarget) ?? targetItem;
    }

    return {
      items,
      suspectItem,
      protectedItem,
      targetItem,
      livePairDistKm,
      closestAlert,
    };
  }, [
    displayedSats,
    activeSuspectId,
    activeProtectedId,
    replayPoint,
    isPlaying,
    simOffsetSec,
    effectiveSimMs,
    isHistoricalTime,
    historicalState,
    selectedPair,
    followTarget,
    cameraFraming,
    pairTrack,
  ]);

  // Estimate smooth C1-continuous ECEF velocity vector of a pair member so closeup/zoomed cameras track with zero jitter
  const getPairOrbitVelocityDir = (off: 1 | 5 = 5): Cesium.Cartesian3 | null => {
    if (!replayPoint && pairTrack && pairTrack.points.length >= 3) {
      const cPrev = evalSmoothTrackCartesian(pairTrack.points, effectiveSimMs - 8_000, off);
      const cNext = evalSmoothTrackCartesian(pairTrack.points, effectiveSimMs + 8_000, off);
      const diff = Cesium.Cartesian3.subtract(cNext, cPrev, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitudeSquared(diff) > 1) {
        return Cesium.Cartesian3.normalize(diff, diff);
      }
    }
    const ring =
      off === 1
        ? frameState.suspectItem?.ring ?? frameState.protectedItem?.ring
        : frameState.protectedItem?.ring ?? frameState.suspectItem?.ring;
    const pos =
      off === 1
        ? frameState.suspectItem?.pos ?? frameState.protectedItem?.pos
        : frameState.protectedItem?.pos ?? frameState.suspectItem?.pos;
    if (ring && ring.length >= 3 && pos) {
      let closestIdx = 0;
      let bestD2 = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const d2 = Cesium.Cartesian3.distanceSquared(ring[i], pos);
        if (d2 < bestD2) {
          bestD2 = d2;
          closestIdx = i;
        }
      }
      const prevPt = ring[(closestIdx - 1 + ring.length) % ring.length];
      const nextPt = ring[(closestIdx + 1) % ring.length];
      const diff = Cesium.Cartesian3.subtract(nextPt, prevPt, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitudeSquared(diff) > 1) {
        return Cesium.Cartesian3.normalize(diff, diff);
      }
    }
    return null;
  };

  // Helper to orient camera cleanly onto a target or midpoint between both pair sats
  const frameCameraOnTarget = (
    latDeg: number,
    lonDeg: number,
    altKm: number,
    framing: 'orbit' | 'closeup',
    pairSpanKm = 0,
    midpointCartesian?: Cesium.Cartesian3,
  ) => {
    const widget = widgetRef.current;
    if (!widget || widget.isDestroyed()) return;
    const isGeo = altKm > 15_000;
    const spanBoostM = pairSpanKm > 0 ? pairSpanKm * 2_800 : 0;

    const midCart =
      midpointCartesian ?? Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, altKm * 1000);
    const midDir = Cesium.Cartesian3.normalize(midCart, new Cesium.Cartesian3());
    const northAxis = Cesium.Cartesian3.UNIT_Z;

    // Seamless Demo camera flight: May 15 high-orbit -> Oct 15 pan over pair -> Oct 16 exponential glide into slow closeup zoom
    if (demoActive && demoAutoRampRef.current && !replayPoint) {
      const velDir = getPairOrbitVelocityDir();
      let offsetDir = Cesium.Cartesian3.clone(midDir, new Cesium.Cartesian3());
      if (velDir) {
        const side = Cesium.Cartesian3.cross(midDir, velDir, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitudeSquared(side) > 1e-8) {
          Cesium.Cartesian3.normalize(side, side);
          const candidate = new Cesium.Cartesian3();
          Cesium.Cartesian3.add(
            Cesium.Cartesian3.multiplyByScalar(side, 0.88, new Cesium.Cartesian3()),
            Cesium.Cartesian3.multiplyByScalar(midDir, 0.24, new Cesium.Cartesian3()),
            candidate,
          );
          Cesium.Cartesian3.add(
            candidate,
            Cesium.Cartesian3.multiplyByScalar(velDir, -0.40, new Cesium.Cartesian3()),
            candidate,
          );
          offsetDir = Cesium.Cartesian3.normalize(candidate, candidate);
        }
      }

      const rawNorthTan = Cesium.Cartesian3.subtract(
        northAxis,
        Cesium.Cartesian3.multiplyByScalar(
          midDir,
          Cesium.Cartesian3.dot(northAxis, midDir),
          new Cesium.Cartesian3(),
        ),
        new Cesium.Cartesian3(),
      );
      const midNorthTan =
        Cesium.Cartesian3.magnitudeSquared(rawNorthTan) > 1e-6
          ? Cesium.Cartesian3.normalize(rawNorthTan, rawNorthTan)
          : Cesium.Cartesian3.UNIT_X;

      const slerpUnit = (
        v0: Cesium.Cartesian3,
        v1: Cesium.Cartesian3,
        t: number,
      ): Cesium.Cartesian3 => {
        if (t <= 0) return Cesium.Cartesian3.clone(v0, new Cesium.Cartesian3());
        if (t >= 1) return Cesium.Cartesian3.clone(v1, new Cesium.Cartesian3());
        const dot = Math.max(-1, Math.min(1, Cesium.Cartesian3.dot(v0, v1)));
        if (dot > 0.9995) {
          return Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.lerp(v0, v1, t, new Cesium.Cartesian3()),
            new Cesium.Cartesian3(),
          );
        }
        let axis = Cesium.Cartesian3.cross(v0, v1, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitudeSquared(axis) < 1e-8) {
          const fallback =
            Math.abs(v0.y) < 0.9 ? Cesium.Cartesian3.UNIT_Y : Cesium.Cartesian3.UNIT_X;
          axis = Cesium.Cartesian3.cross(v0, fallback, axis);
        }
        Cesium.Cartesian3.normalize(axis, axis);
        const angle = Math.acos(dot) * t;
        const q = Cesium.Quaternion.fromAxisAngle(axis, angle);
        const m = Cesium.Matrix3.fromQuaternion(q);
        return Cesium.Matrix3.multiplyByVector(m, v0, new Cesium.Cartesian3());
      };

      const mayPulloutEndMs = DEMO_BURN2_LINGER_END_MS + 18 * 86400_000;
      const pulloutU =
        effectiveSimMs <= DEMO_BURN2_LINGER_END_MS
          ? 0
          : smoothstep01(
              (effectiveSimMs - DEMO_BURN2_LINGER_END_MS) / (mayPulloutEndMs - DEMO_BURN2_LINGER_END_MS),
            );
      const sepFocusU =
        effectiveSimMs <= DEMO_SEP_ZOOM_START_MS
          ? 0
          : smoothstep01(
              (effectiveSimMs - DEMO_SEP_ZOOM_START_MS) / (DEMO_BURN3_START_MS - DEMO_SEP_ZOOM_START_MS),
            );
      // 60°N polar view for May plane-match -> 36°N summer coast -> 18°N limb overview for Oct phasing coast
      const highAnchorLat = 60.0 - 24.0 * pulloutU - 18.0 * sepFocusU;
      const anchorDir = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.fromDegrees(15.0, highAnchorLat, 0),
        new Cesium.Cartesian3(),
      );

      if (effectiveSimMs < DEMO_DESCENT_START_MS) {
        let baseAltM = 13_500_000;
        if (effectiveSimMs > DEMO_BURN2_LINGER_END_MS && effectiveSimMs < mayPulloutEndMs) {
          baseAltM = 13_500_000 + 11_500_000 * pulloutU; // Pull out 13,500 km -> 25,000 km for summer timelapse
        } else if (effectiveSimMs >= mayPulloutEndMs && effectiveSimMs < DEMO_SEP_ZOOM_START_MS) {
          baseAltM = 25_000_000;
        } else if (effectiveSimMs >= DEMO_SEP_ZOOM_START_MS && effectiveSimMs < DEMO_BURN3_START_MS) {
          baseAltM = 25_000_000 - 13_500_000 * sepFocusU; // 25,000 km -> 11,500 km limb overview
        } else if (effectiveSimMs >= DEMO_BURN3_START_MS) {
          baseAltM = 11_500_000;
        }

        const anchorLook = Cesium.Cartesian3.negate(anchorDir, new Cesium.Cartesian3());
        const rawAnchorUp = Cesium.Cartesian3.subtract(
          northAxis,
          Cesium.Cartesian3.multiplyByScalar(
            anchorLook,
            Cesium.Cartesian3.dot(northAxis, anchorLook),
            new Cesium.Cartesian3(),
          ),
          new Cesium.Cartesian3(),
        );
        const anchorUp =
          Cesium.Cartesian3.magnitudeSquared(rawAnchorUp) > 1e-6
            ? Cesium.Cartesian3.normalize(rawAnchorUp, rawAnchorUp)
            : midNorthTan;

        const camPos = Cesium.Cartesian3.multiplyByScalar(
          anchorDir,
          R_EARTH_KM * 1000 + baseAltM,
          new Cesium.Cartesian3(),
        );
        widget.camera.setView({
          destination: camPos,
          orientation: { direction: anchorLook, up: anchorUp },
        });
        widget.scene.requestRender();
        return;
      }

      // Exponential glide down from 11,500 km high orbit -> 20 km oblique close-up, zooming to 12 km right at TCA (4.54 km)
      const descendU = smoothstep01(
        (effectiveSimMs - DEMO_DESCENT_START_MS) / (DEMO_DESCENT_END_MS - DEMO_DESCENT_START_MS),
      );
      const panU = smoothstep01(descendU * 1.35);
      const tcaProximity = Math.exp(
        -Math.pow((effectiveSimMs - DEMO_TCA_MS) / (6 * 60_000), 2),
      );
      const closeupTargetM =
        effectiveSimMs >= DEMO_DESCENT_END_MS
          ? 20_000 - 8_000 * tcaProximity
          : 20_000;

      const camDistM = 11_500_000 * Math.pow(closeupTargetM / 11_500_000, descendU);
      const slerpedRadial = slerpUnit(anchorDir, midDir, panU);
      const dir = slerpUnit(slerpedRadial, offsetDir, descendU * descendU);
      const lookTarget = Cesium.Cartesian3.multiplyByScalar(
        midCart,
        panU,
        new Cesium.Cartesian3(),
      );
      const camPos = Cesium.Cartesian3.add(
        lookTarget,
        Cesium.Cartesian3.multiplyByScalar(
          dir,
          camDistM + (1 - panU) * (R_EARTH_KM * 1000),
          new Cesium.Cartesian3(),
        ),
        new Cesium.Cartesian3(),
      );
      const lookDir = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(lookTarget, camPos, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      const anchorLook = Cesium.Cartesian3.negate(anchorDir, new Cesium.Cartesian3());
      const anchorNorthUp = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(
          northAxis,
          Cesium.Cartesian3.multiplyByScalar(
            anchorLook,
            Cesium.Cartesian3.dot(northAxis, anchorLook),
            new Cesium.Cartesian3(),
          ),
          new Cesium.Cartesian3(),
        ),
        new Cesium.Cartesian3(),
      );
      const blendedUp = Cesium.Cartesian3.lerp(
        anchorNorthUp,
        midDir,
        descendU,
        new Cesium.Cartesian3(),
      );
      const orthoUp = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(
          blendedUp,
          Cesium.Cartesian3.multiplyByScalar(
            lookDir,
            Cesium.Cartesian3.dot(blendedUp, lookDir),
            new Cesium.Cartesian3(),
          ),
          new Cesium.Cartesian3(),
        ),
        new Cesium.Cartesian3(),
      );

      widget.camera.setView({
        destination: camPos,
        orientation: { direction: lookDir, up: orthoUp },
      });
      widget.scene.requestRender();
      return;
    }

    if (framing === 'closeup') {
      // Steady standoff for <= 25 km so you visibly see the satellites closing across screen; oblique side-angle prevents radial stacking into one blob
      const closeupStandoffKm = isGeo
        ? pairSpanKm > 0
          ? Math.min(35_000, Math.max(30, pairSpanKm * 2.4))
          : 80
        : pairSpanKm > 0
          ? pairSpanKm <= 25
            ? 22
            : Math.min(24_000, pairSpanKm * 2.4)
          : 36;

      const up = midDir;
      const velDir = getPairOrbitVelocityDir();

      if (velDir) {
        const side = Cesium.Cartesian3.cross(up, velDir, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitudeSquared(side) > 1e-8) {
          Cesium.Cartesian3.normalize(side, side);
          const offsetDir = new Cesium.Cartesian3();
          Cesium.Cartesian3.add(
            Cesium.Cartesian3.multiplyByScalar(side, 0.88, new Cesium.Cartesian3()),
            Cesium.Cartesian3.multiplyByScalar(up, 0.24, new Cesium.Cartesian3()),
            offsetDir,
          );
          Cesium.Cartesian3.add(
            offsetDir,
            Cesium.Cartesian3.multiplyByScalar(velDir, -0.40, new Cesium.Cartesian3()),
            offsetDir,
          );
          Cesium.Cartesian3.normalize(offsetDir, offsetDir);
          const camPos = Cesium.Cartesian3.add(
            midCart,
            Cesium.Cartesian3.multiplyByScalar(
              offsetDir,
              closeupStandoffKm * 1000,
              new Cesium.Cartesian3(),
            ),
            new Cesium.Cartesian3(),
          );
          const lookDir = Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.subtract(midCart, camPos, new Cesium.Cartesian3()),
            new Cesium.Cartesian3(),
          );
          widget.camera.setView({
            destination: camPos,
            orientation: { direction: lookDir, up },
          });
          widget.scene.requestRender();
          return;
        }
      }

      widget.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          lonDeg,
          isGeo ? 4.0 : latDeg,
          (altKm + closeupStandoffKm) * 1000,
        ),
        orientation: {
          heading: 0,
          pitch: -Cesium.Math.PI_OVER_TWO,
          roll: 0,
        },
      });
      widget.scene.requestRender();
      return;
    }

    const camAltMeters = isGeo
      ? Math.max(135_000_000, spanBoostM)
      : Math.max(30_000_000, spanBoostM * 1.4);

    widget.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lonDeg, isGeo ? 4.0 : latDeg, camAltMeters),
      orientation: {
        heading: 0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
    widget.scene.requestRender();
  };

  // Compute midpoint + span between suspect & protected so both satellites stay framed
  const computePairFramingCenter = () => {
    const s = frameState.suspectItem;
    const p = frameState.protectedItem;
    if (s && p) {
      const mid = Cesium.Cartesian3.midpoint(s.pos, p.pos, new Cesium.Cartesian3());
      const carto = Cesium.Cartographic.fromCartesian(mid);
      const distKm = Cesium.Cartesian3.distance(s.pos, p.pos) / 1000;
      return {
        latDeg: Cesium.Math.toDegrees(carto.latitude),
        lonDeg: Cesium.Math.toDegrees(carto.longitude),
        altKm: (s.altKm + p.altKm) / 2,
        spanKm: distKm,
        mid,
      };
    }
    const single = frameState.targetItem;
    if (!single) return null;
    return {
      latDeg: single.latDeg,
      lonDeg: single.lonDeg,
      altKm: single.altKm,
      spanKm: 0,
      mid: single.pos,
    };
  };

  // Reframe once only when an explicit pair is chosen (leave Europe default unfocused on initial load)
  useEffect(() => {
    if (replayPoint || !selectedPair) return;
    const center = computePairFramingCenter();
    if (center) {
      frameCameraOnTarget(
        center.latDeg,
        center.lonDeg,
        center.altKm,
        cameraFraming,
        center.spanKm,
        center.mid,
      );
    }
  }, [selectedPair?.suspectNoradId, selectedPair?.protectedNoradId]);

  // Synchronize Cesium primitives & camera follow
  useEffect(() => {
    const widget = widgetRef.current;
    const collections = primitivesRef.current;
    if (!widget || widget.isDestroyed() || !collections) return;

    const { points, polylines, labels } = collections;
    points.removeAll();
    polylines.removeAll();
    labels.removeAll();

    const trackedId = typeof followTarget === 'number' ? followTarget : null;

    for (const item of frameState.items) {
      const { sat, pos, latDeg, lonDeg, ring } = item;
      const isSelectedSuspect = activeSuspectId !== null && sat.noradId === activeSuspectId;
      const isSelectedProtected = activeProtectedId !== null && sat.noradId === activeProtectedId;
      const isFollowed = trackedId !== null && sat.noradId === trackedId;
      const isHovered = sat.noradId === hoveredNoradId || sat.noradId === pinnedNoradId;
      const isHighlighted = isSelectedSuspect || isSelectedProtected || isFollowed || isHovered;
      const inMayPlaneWindow = effectiveSimMs <= DEMO_BURN2_LINGER_END_MS + 10 * 86400_000;
      const inSepOctHeightWindow = effectiveSimMs >= DEMO_SEP_ZOOM_START_MS;
      const showCloseupLabel =
        (cameraFraming === 'closeup' ||
          (demoActive && (inMayPlaneWindow || inSepOctHeightWindow))) &&
        (isSelectedSuspect || isSelectedProtected);

      const isSuspectHighlight = isSelectedSuspect && Boolean(selectedPair);

      points.add({
        id: sat.noradId,
        position: pos,
        pixelSize: isHovered ? 11 : replayPoint ? 8 : isHighlighted ? 9.5 : 6,
        color:
          sat.role === 'protected'
            ? Cesium.Color.WHITE
            : isSuspectHighlight
              ? Cesium.Color.fromCssColorString('#FF5A36')
              : sat.role === 'suspect'
                ? Cesium.Color.fromCssColorString('#141414')
                : Cesium.Color.fromCssColorString('#D4D4D4'),
        outlineColor:
          sat.role === 'protected' ? Cesium.Color.BLACK : Cesium.Color.WHITE,
        outlineWidth: isHovered ? 2.5 : isHighlighted ? 2 : 1.35,
      });

      // Show labels on hover/pin OR during May plane-match, Sep-Oct height/speed match, and closeup views
      if (isHovered || showCloseupLabel) {
        let planeLabelSuffix = '';
        if (demoActive && isSelectedSuspect) {
          if (effectiveSimMs < DEMO_BURN1_END_MS) {
            planeLabelSuffix = ' (96.96° PLANE)';
          } else if (effectiveSimMs < DEMO_BURN2_END_MS) {
            planeLabelSuffix = ' (TILTING → 97.85°)';
          } else if (inMayPlaneWindow) {
            planeLabelSuffix = ' (SAME PLANE 97.85°)';
          } else if (effectiveSimMs >= DEMO_BURN3_START_MS && effectiveSimMs < DEMO_BURN4_END_MS) {
            planeLabelSuffix = ' (RAISING +46.5 KM · SLOWING)';
          } else if (effectiveSimMs >= DEMO_BURN4_END_MS && effectiveSimMs < DEMO_BURN6_START_MS) {
            planeLabelSuffix = ' (HIGHER +46.5 KM · SLOWER)';
          } else if (effectiveSimMs >= DEMO_BURN6_START_MS && effectiveSimMs < DEMO_BURN6_END_MS) {
            planeLabelSuffix = ' (DROPPING -47.8 KM · MATCHING SPEED)';
          } else if (effectiveSimMs >= DEMO_BURN6_END_MS) {
            planeLabelSuffix = ' (SAME HEIGHT · SAME SPEED)';
          }
        } else if (demoActive && isSelectedProtected) {
          if (inMayPlaneWindow) {
            planeLabelSuffix = ' (97.83° TARGET)';
          } else if (effectiveSimMs >= DEMO_BURN3_START_MS && effectiveSimMs < DEMO_BURN6_START_MS) {
            planeLabelSuffix = ' (LOWER ORBIT · FASTER)';
          } else if (effectiveSimMs >= DEMO_BURN6_START_MS) {
            planeLabelSuffix = ' (544 KM · 7.59 km/s)';
          }
        }
        labels.add({
          id: sat.noradId,
          position: pos,
          text: `${sat.name}${planeLabelSuffix || ` (#${sat.noradId})`}`,
          font: '600 11px "JetBrains Mono", monospace',
          fillColor: isSuspectHighlight
            ? Cesium.Color.fromCssColorString('#FF8A6B')
            : Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(
            14,
            isSelectedProtected ? -16 : isSelectedSuspect ? 16 : -10,
          ),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }

      if ((showOrbits || replayPoint) && ring.length > 2) {
        const isDashedSuspect = (Boolean(replayPoint) || cameraFraming === 'closeup') && isSelectedSuspect;
        const suspectAccent = Cesium.Color.fromCssColorString('#FF5A36');
        polylines.add({
          positions: ring,
          width: replayPoint || cameraFraming === 'closeup'
            ? isSelectedProtected
              ? 2.6
              : 2.2
            : isHighlighted
              ? sat.role === 'protected'
                ? 2.5
                : isSuspectHighlight
                  ? 2.4
                  : 1.5
              : 0.9,
          material: isDashedSuspect
            ? Cesium.Material.fromType('PolylineDash', {
                color: suspectAccent.withAlpha(0.95),
                dashLength: 16,
              })
            : Cesium.Material.fromType('Color', {
                color: replayPoint || cameraFraming === 'closeup'
                  ? Cesium.Color.WHITE.withAlpha(0.95)
                  : isHighlighted
                    ? sat.role === 'protected'
                      ? Cesium.Color.WHITE.withAlpha(0.95)
                      : isSuspectHighlight
                        ? suspectAccent.withAlpha(0.95)
                        : Cesium.Color.WHITE.withAlpha(0.55)
                    : Cesium.Color.WHITE.withAlpha(0.24),
              }),
        });
      }

      if (isHighlighted && cameraFraming !== 'closeup') {
        const groundSurface = Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, 0);
        polylines.add({
          positions: [pos, groundSurface],
          width: 0.9,
          material: Cesium.Material.fromType('Color', {
            color: Cesium.Color.WHITE.withAlpha(0.24),
          }),
        });
      }
    }

    // Active encounter tether line
    if (frameState.suspectItem && frameState.protectedItem) {
      polylines.add({
        positions: [frameState.suspectItem.pos, frameState.protectedItem.pos],
        width: 2.2,
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.WHITE,
        }),
      });
    }

    // Highlight closest group alert pair if not already the primary selected pair
    if (
      frameState.closestAlert &&
      !(
        (frameState.closestAlert.satA.noradId === activeSuspectId &&
          frameState.closestAlert.satB.noradId === activeProtectedId) ||
        (frameState.closestAlert.satB.noradId === activeSuspectId &&
          frameState.closestAlert.satA.noradId === activeProtectedId)
      )
    ) {
      polylines.add({
        positions: [frameState.closestAlert.posA, frameState.closestAlert.posB],
        width: 2.4,
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.WHITE,
        }),
      });
    }

    // Smooth camera lock when Follow Selector is active (keeps both pair sats framed)
    if (followTarget === 'pair') {
      const center = computePairFramingCenter();
      if (center) {
        frameCameraOnTarget(
          center.latDeg,
          center.lonDeg,
          center.altKm,
          cameraFraming,
          center.spanKm,
          center.mid,
        );
      }
    } else if (followTarget !== 'free' && frameState.targetItem) {
      const isPairMember =
        frameState.targetItem.sat.noradId === activeSuspectId ||
        frameState.targetItem.sat.noradId === activeProtectedId;
      const pairSpanKm =
        isPairMember && frameState.suspectItem && frameState.protectedItem
          ? Cesium.Cartesian3.distance(frameState.suspectItem.pos, frameState.protectedItem.pos) / 1000
          : 0;
      const center =
        isPairMember && pairSpanKm > 0 ? computePairFramingCenter() : null;
      frameCameraOnTarget(
        center ? center.latDeg : frameState.targetItem.latDeg,
        center ? center.lonDeg : frameState.targetItem.lonDeg,
        center ? center.altKm : frameState.targetItem.altKm,
        cameraFraming,
        pairSpanKm,
        center ? center.mid : frameState.targetItem.pos,
      );
    } else {
      widget.scene.requestRender();
    }
  }, [frameState, showOrbits, followTarget, cameraFraming, activeSuspectId, activeProtectedId, hoveredNoradId, pinnedNoradId, replayPoint]);

  const handleGoLive = () => {
    setDemoActive(false);
    setHistoricalState(null);
    setSimOffsetSec(0);
    setSimBaseMs(Date.now());
    setSpeedValue(1);
    setTimeScale('medium');
    setIsPlaying(true);
  };

  const jumpToTimestampMs = (targetMs: number, nextScale?: TimeScaleMode) => {
    setIsPlaying(false);
    setSimBaseMs(targetMs);
    setSimOffsetSec(0);
    if (nextScale) setTimeScale(nextScale);
  };

  const handleSetFraming = (framing: 'orbit' | 'closeup') => {
    setCameraFraming(framing);
    const center = computePairFramingCenter();
    if (center) {
      frameCameraOnTarget(
        center.latDeg,
        center.lonDeg,
        center.altKm,
        framing,
        center.spanKm,
        center.mid,
      );
    }
  };

  const handleResetEurope = () => {
    const widget = widgetRef.current;
    if (!widget || widget.isDestroyed()) return;
    setFollowTarget('free');
    setCameraFraming('orbit');
    widget.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(14.0, 49.0, 31_000_000),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    widget.scene.requestRender();
  };

  const handleResetGlobe = () => {
    const widget = widgetRef.current;
    if (!widget || widget.isDestroyed()) return;
    setFollowTarget('free');
    setCameraFraming('orbit');
    widget.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(18.0, 22.0, 88_000_000),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    widget.scene.requestRender();
  };

  const handleFocusGeoBelt = () => {
    const widget = widgetRef.current;
    if (!widget || widget.isDestroyed()) return;
    setFollowTarget('free');
    setCameraFraming('orbit');
    widget.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(25.0, 12.0, 125_000_000),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
    widget.scene.requestRender();
  };

  useEffect(() => {
    if (regimeFilter === 'GEO') {
      handleFocusGeoBelt();
    }
  }, [regimeFilter]);

  const simUtcStr = replayPoint
    ? replayPoint.timestampUtc
    : new Date(effectiveSimMs).toISOString();
  const isRealTimeLive =
    !replayPoint &&
    !isHistoricalTime &&
    isPlaying &&
    speedValue === 1 &&
    Math.abs(effectiveSimMs - Date.now()) < 30_000;
  const displayRangeKm = frameState.livePairDistKm ?? null;
  const activeInspectId = pinnedNoradId ?? hoveredNoradId;
  const inspectedItem =
    activeInspectId !== null
      ? frameState.items.find((i) => i.sat.noradId === activeInspectId) ?? null
      : null;

  const scaleCfg = TIME_SCALE_CONFIG[timeScale];

  const formatOffsetLabel = (sec: number): string => {
    const abs = Math.abs(Math.round(sec));
    if (abs < 10) return 'ANCHOR';
    const sign = sec >= 0 ? '+' : '-';
    const days = Math.floor(abs / 86400);
    const hrs = Math.floor((abs % 86400) / 3600);
    const mins = Math.floor((abs % 3600) / 60);
    const secs = abs % 60;
    if (days > 0) return `${sign}${days}d ${String(hrs).padStart(2, '0')}h`;
    if (hrs > 0) return `${sign}${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m`;
    if (mins > 0) return `${sign}${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
    return `${sign}${secs}s`;
  };

  // Active flash alert: only pops up when an orbital change or close pass actually happens
  const activeFlashAlert = useMemo(() => {
    if (replayPoint) return null;
    const alert = frameState.closestAlert;
    const distKm = frameState.livePairDistKm ?? alert?.distanceKm ?? null;
    const activeDist = distKm ?? 4296.8;
    const isCritical = activeDist < 5.0;
    const satAName = alert?.satA.name ?? selectedPair?.suspectName ?? 'COSMOS 2612';
    const satBName = alert?.satB.name ?? selectedPair?.protectedName ?? 'ICEYE-X36';
    const satANorad = alert?.satA.noradId ?? selectedPair?.suspectNoradId ?? 68762;
    const satBNorad = alert?.satB.noradId ?? selectedPair?.protectedNoradId ?? 59103;
    const distLabel =
      activeDist >= 100 ? `${activeDist.toFixed(0)} km` : `${activeDist.toFixed(2)} km`;

    if (demoActive) {
      if (loadingDemoTrack) return null;
      // Flash 1: May 16 Inclination Change
      if (
        effectiveSimMs >= DEMO_BURN1_START_MS &&
        effectiveSimMs < DEMO_BURN2_LINGER_END_MS
      ) {
        return {
          flashKey: 'may-inclination',
          tier: 'WARNING' as const,
          isCritical: false,
          badgeText: 'ALERT · INCLINATION CHANGE',
          headlineText: `${satAName} changed its inclination greatly!`,
          detailText: `May 16: Tilted +0.89° (96.96° → 97.85°) to enter ${satBName}'s exact orbital plane.`,
          satAName,
          satBName,
          satANorad,
          satBNorad,
          distLabel,
        };
      }
      // Flash 2: Sep 30 Height Raise (+46.5 km) -> Slowed Down
      if (
        effectiveSimMs >= DEMO_BURN3_START_MS &&
        effectiveSimMs < DEMO_BURN4_LINGER_END_MS
      ) {
        return {
          flashKey: 'sep-slowed-down',
          tier: 'WARNING' as const,
          isCritical: false,
          badgeText: 'ALERT · ORBIT RAISED (+46.5 KM)',
          headlineText: `${satAName} slowed down!`,
          detailText: `Sep 30: Climbed +46.5 km higher (+15.5 km, then +30.99 km). Higher orbit = slower speed so ${satBName} catches up.`,
          satAName,
          satBName,
          satANorad,
          satBNorad,
          distLabel,
        };
      }
      // Flash 3: Oct 12 Height Drop (-47.8 km) -> Sped Up
      if (
        effectiveSimMs >= DEMO_BURN6_START_MS &&
        effectiveSimMs < DEMO_BURN6_LINGER_END_MS
      ) {
        return {
          flashKey: 'oct-sped-up',
          tier: 'ALERT' as const,
          isCritical: false,
          badgeText: 'ALERT · ORBIT DROPPED (-47.8 KM)',
          headlineText: `${satAName} sped up to match ${satBName}!`,
          detailText: `Oct 12: Dropped 47.8 km back down to ${satBName}'s exact height so both travel at the exact same speed.`,
          satAName,
          satBName,
          satANorad,
          satBNorad,
          distLabel,
        };
      }
      // Flash 4: Oct 16 Close Pass (< 5 km)
      if (effectiveSimMs >= DEMO_DESCENT_END_MS || isCritical) {
        return {
          flashKey: 'oct-close-pass',
          tier: 'ALERT' as const,
          isCritical: true,
          badgeText: 'CRITICAL ALERT · < 5 KM PASS',
          headlineText: `${satAName} is right next to ${satBName}!`,
          detailText: `Same height, same speed — passing within ${distLabel}.`,
          satAName,
          satBName,
          satANorad,
          satBNorad,
          distLabel,
        };
      }
      // Silence everywhere in between!
      return null;
    }

    if (alert !== null && alert.level === 'collision' && alert.distanceKm < 6.0) {
      return {
        flashKey: `live-col-${satANorad}-${satBNorad}`,
        tier: 'ALERT' as const,
        isCritical: true,
        badgeText: 'CRITICAL ALERT · < 5 KM PASS',
        headlineText: `${satAName} is right next to ${satBName}!`,
        detailText: `Live close approach inside ${distLabel}.`,
        satAName,
        satBName,
        satANorad,
        satBNorad,
        distLabel,
      };
    }

    return null;
  }, [
    replayPoint,
    frameState.closestAlert,
    frameState.livePairDistKm,
    selectedPair,
    demoActive,
    loadingDemoTrack,
    effectiveSimMs,
  ]);

  const currentFlashKey = activeFlashAlert?.flashKey ?? null;
  useEffect(() => {
    if (!currentFlashKey) {
      setPulseFlashKey(null);
      return;
    }
    setPulseFlashKey(currentFlashKey);
    const timer = window.setTimeout(() => setPulseFlashKey(null), 1500);
    return () => window.clearTimeout(timer);
  }, [currentFlashKey]);

  // Automatically fetch Context.dev identification (owner, builder, launch date, public status)
  // whenever a pair is focused or two satellites trigger an approach alert.
  const activeIdentityPairKey = activeFlashAlert
    ? `${activeFlashAlert.satANorad}-${activeFlashAlert.satBNorad}`
    : selectedPair
      ? `${selectedPair.suspectNoradId}-${selectedPair.protectedNoradId}`
      : null;

  useEffect(() => {
    if (!activeIdentityPairKey) return;
    if (pairDossierByKey[activeIdentityPairKey] || requestedDossiersRef.current.has(activeIdentityPairKey)) {
      return;
    }
    requestedDossiersRef.current.add(activeIdentityPairKey);
    let cancelled = false;
    fetch(`/api/context/pair-identity?pair=${encodeURIComponent(activeIdentityPairKey)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ok?: boolean; dossier?: PairContextDossier } | null) => {
        if (!cancelled && data?.dossier) {
          setPairDossierByKey((prev) => ({
            ...prev,
            [activeIdentityPairKey]: data.dossier!,
          }));
        }
      })
      .catch(() => {
        requestedDossiersRef.current.delete(activeIdentityPairKey);
      });
    return () => {
      cancelled = true;
    };
  }, [activeIdentityPairKey, pairDossierByKey]);

  // Keep the persistent alert box empty unless an event is actively flashing right now
  const activeCornerAlarms = useMemo<HistoricalAlarmItem[]>(() => {
    if (!activeFlashAlert) return [];
    return [
      {
        id: `flash-${activeFlashAlert.flashKey}`,
        timestampUtc: simUtcStr,
        tier: activeFlashAlert.tier,
        headline: activeFlashAlert.headlineText,
        cause: activeFlashAlert.badgeText,
        detail: activeFlashAlert.detailText,
        satelliteName: activeFlashAlert.satAName,
        noradId: activeFlashAlert.satANorad,
        pairKey: `${activeFlashAlert.satANorad}-${activeFlashAlert.satBNorad}`,
        eventId: 'evt-rpo-68762-59103',
      },
    ];
  }, [activeFlashAlert, simUtcStr]);

  const selectableFollowers = useMemo(() => {
    const seen = new Set<number>();
    const list: WatchedSatellite[] = [];
    for (const item of frameState.items) {
      if (!seen.has(item.sat.noradId)) {
        seen.add(item.sat.noradId);
        list.push(item.sat);
      }
    }
    return list;
  }, [frameState.items]);

  return (
    <div
      className={`relative w-full overflow-hidden border border-[#262626] bg-black ${
        compactHeight ? 'h-[400px] lg:h-[440px]' : 'h-[620px] lg:h-[780px]'
      }`}
      data-state={replayPoint ? 'replay' : isHistoricalTime ? 'historical' : isPlaying ? 'animating' : 'live'}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
    >
      {!webglFallback ? (
        <div
          ref={mountRef}
          data-testid="orbital-globe-canvas"
          className="h-full w-full cursor-crosshair"
        />
      ) : (
        <div
          data-testid="orbital-globe-fallback"
          className="flex h-full w-full items-center justify-center bg-black p-6"
        >
          <svg viewBox="0 0 720 360" className="h-full w-full max-w-2xl">
            <rect width="720" height="360" fill="#080808" stroke="#262626" />
            {frameState.items.map((item) => {
              const x = ((item.lonDeg + 180) / 360) * 720;
              const y = ((90 - item.latDeg) / 180) * 360;
              return (
                <g key={item.sat.noradId}>
                  <circle
                    cx={x}
                    cy={y}
                    r={5}
                    fill={item.sat.role === 'protected' ? '#FFFFFF' : '#000000'}
                    stroke="#FFFFFF"
                    strokeWidth="1.5"
                  />
                  <text x={x + 8} y={y + 4} fill="#FFFFFF" fontSize="10" fontFamily="JetBrains Mono">
                    {item.sat.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* CAD Corner Crosshair Reticles */}
      <div className="pointer-events-none absolute top-2 left-2 h-2.5 w-2.5 border-t border-l border-white/40" />
      <div className="pointer-events-none absolute top-2 right-2 h-2.5 w-2.5 border-t border-r border-white/40" />
      <div className="pointer-events-none absolute bottom-2 left-2 h-2.5 w-2.5 border-b border-l border-white/40" />
      <div className="pointer-events-none absolute bottom-2 right-2 h-2.5 w-2.5 border-b border-r border-white/40" />

      {/* Top HUD: Streamlined Clock & Neutral Global/Pair Bar + Camera Controls */}
      <div className="pointer-events-none absolute top-2 right-2 left-2 flex flex-col gap-1.5">
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-start justify-between gap-1.5">
          {/* Left Column: Fixed-Width Clock + Compact Demo Alert + Alarms Stack */}
          <div className="flex flex-col gap-1.5 w-full sm:w-[355px] shrink-0">
            <div className="pointer-events-auto border border-[#262626] bg-black/90 px-2.5 py-1.5 text-xs overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono-tabular text-xs sm:text-sm font-semibold tracking-tight text-white">
                    {simUtcStr.slice(0, 19).replace('T', ' ')}Z
                  </span>
                  {replayPoint ? (
                    <span className="border border-white/40 bg-black px-2 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-white">
                      APPROACH
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleGoLive}
                      title="Jump back to real-time 1× UTC clock"
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold border transition-colors ${
                        isRealTimeLive
                          ? 'border-white bg-white text-black'
                          : 'border-white bg-black text-white hover:bg-white hover:text-black'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isRealTimeLive ? 'bg-black' : 'bg-white'
                        }`}
                      />
                      <span>{isRealTimeLive ? 'LIVE' : 'GO LIVE'}</span>
                    </button>
                  )}
                </div>

                {selectedPair ? (
                  <div className="flex items-center gap-1.5 font-mono-tabular text-[11px]">
                    <span className="font-semibold text-white truncate max-w-[165px]">
                      {selectedPair.suspectName} ↔ {selectedPair.protectedName}
                    </span>
                    {displayRangeKm !== null && (
                      <span className="font-semibold text-white whitespace-nowrap">
                        {displayRangeKm >= 100
                          ? `${displayRangeKm.toFixed(0)} km`
                          : `${displayRangeKm.toFixed(1)} km`}
                      </span>
                    )}
                    {!replayPoint && onClearPair && (
                      <button
                        type="button"
                        onClick={onClearPair}
                        title="Unfocus satellite pair"
                        className="border border-[#262626] px-1 text-[#A3A3A3] hover:border-white hover:text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="font-mono-tabular text-[11px] text-[#A3A3A3]">
                    {displayedSats.length} TRACKED
                    {isHistoricalTime ? ' · HISTORICAL' : ''}
                  </span>
                )}
              </div>
            </div>

            {/* Slim Demo Controls Bar (always reachable even during silent coast stretches) */}
            {!replayPoint && demoActive && (() => {
              const liveDemoSpeed =
                demoAutoRampRef.current ? computeDemoAutoSpeed(effectiveSimMs) : speedValue;
              const nextJumpMs =
                DEMO_JUMP_STOPS_MS.find((ms) => ms > effectiveSimMs + 30_000) ?? null;
              return (
                <div className="pointer-events-auto flex items-center justify-between gap-2 border border-[#262626] bg-black/92 px-2.5 py-1.5 font-mono-tabular text-[10px] text-white">
                  <span className="text-[#A3A3A3]">
                    {loadingDemoTrack
                      ? 'LOADING DEMO...'
                      : `DEMO · ${formatDemoSpeedLabel(liveDemoSpeed)}`}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setIsPlaying((p) => !p)}
                      className="inline-flex items-center gap-1 border border-[#404040] px-1.5 py-0.5 font-semibold text-white hover:border-white"
                    >
                      {isPlaying ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                      <span>{isPlaying ? 'Pause' : 'Resume'}</span>
                    </button>
                    {nextJumpMs !== null && (
                      <button
                        type="button"
                        onClick={() => {
                          demoAutoRampRef.current = true;
                          setDismissedFlashKey(null);
                          setSimBaseMs(nextJumpMs);
                          setSimOffsetSec(0);
                          setIsPlaying(true);
                        }}
                        className="inline-flex items-center gap-0.5 border border-[#404040] px-1.5 py-0.5 font-semibold text-white hover:border-white"
                        title="Skip ahead to next orbital burn / stage"
                      >
                        <span>Next</span>
                        <SkipForward className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Flash Alert Popup: Only pops up/flashes when an orbital event happens */}
            {activeFlashAlert && dismissedFlashKey !== activeFlashAlert.flashKey && (() => {
              const isFlashingNow = pulseFlashKey === activeFlashAlert.flashKey;
              const isCritical = activeFlashAlert.isCritical;
              return (
                <div
                  key={activeFlashAlert.flashKey}
                  role="alert"
                  className={`pointer-events-auto border p-2.5 text-xs shadow-xl transition-all ${
                    isCritical
                      ? 'border-black bg-white text-black'
                      : 'border-white bg-black/95 text-white'
                  } ${isFlashingNow ? 'ring-2 ring-white' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <AlertTriangle
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                          isFlashingNow ? 'animate-pulse' : ''
                        }`}
                      />
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 font-mono-tabular text-[10px] font-bold uppercase tracking-wider">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              isCritical ? 'bg-black' : 'bg-[#FF5A36]'
                            } ${isFlashingNow ? 'animate-ping' : ''}`}
                          />
                          <span>{activeFlashAlert.badgeText}</span>
                        </div>
                        <div className="text-xs font-bold leading-tight">
                          {activeFlashAlert.headlineText}
                        </div>
                        <div
                          className={`text-[10px] leading-snug ${
                            isCritical ? 'text-black/80' : 'text-[#D4D4D4]'
                          }`}
                        >
                          {activeFlashAlert.detailText}
                        </div>
                        {(() => {
                          const fKey = `${activeFlashAlert.satANorad}-${activeFlashAlert.satBNorad}`;
                          const dossier = pairDossierByKey[fKey];
                          if (!dossier) return null;
                          return (
                            <div
                              className={`mt-1.5 border px-2 py-1 font-mono-tabular text-[9.5px] leading-snug ${
                                isCritical
                                  ? 'border-black/25 bg-black/5 text-black'
                                  : 'border-[#333333] bg-[#0E0E0E] text-[#E5E5E5]'
                              }`}
                            >
                              <div>
                                <strong>{dossier.approaching.name}</strong>: {dossier.approaching.countryLabel} ·{' '}
                                {dossier.approaching.operator} · Built {dossier.approaching.builtBy} · Launched{' '}
                                {dossier.approaching.launchedDate}
                              </div>
                              <div className={isCritical ? 'text-black/75' : 'text-[#A3A3A3]'}>
                                Context.dev: {dossier.publicInfoLabel}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDismissedFlashKey(activeFlashAlert.flashKey)}
                      aria-label="Dismiss alert"
                      className={`border p-0.5 shrink-0 ${
                        isCritical
                          ? 'border-black text-black hover:bg-black hover:text-white'
                          : 'border-[#404040] text-[#A3A3A3] hover:border-white hover:text-white'
                      }`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>

                  {onOpenAlertContext && (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          onOpenAlertContext({
                            id: `flash-${activeFlashAlert.flashKey}`,
                            timestampUtc: simUtcStr,
                            tier: activeFlashAlert.tier,
                            headline: activeFlashAlert.headlineText,
                            cause: activeFlashAlert.detailText,
                            detail: `Distance between satellites at alert time: ${activeFlashAlert.distLabel}`,
                            satelliteName: activeFlashAlert.satAName,
                            noradId: activeFlashAlert.satANorad,
                            pairKey: `${activeFlashAlert.satANorad}-${activeFlashAlert.satBNorad}`,
                            eventId: 'evt-rpo-68762-59103',
                          })
                        }
                        className={`border px-2 py-0.5 font-mono-tabular text-[10px] font-semibold transition-colors ${
                          isCritical
                            ? 'border-black bg-black text-white hover:bg-[#262626]'
                            : 'border-white bg-white text-black hover:bg-[#E5E5E5]'
                        }`}
                      >
                        More info with context.dev
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Top-Left Corner Alarms Box (Stays empty unless an alert is actively flashing) */}
            {!replayPoint && (
              <div className="pointer-events-auto border border-[#262626] bg-black/92 text-xs">
                <button
                  type="button"
                  onClick={() => setAlarmsExpanded((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 border-b border-[#1F1F1F] font-mono-tabular text-[11px] font-semibold text-white hover:text-[#D4D4D4]"
                >
                  <span className="flex items-center gap-1.5">
                    <Bell className="h-3 w-3" />
                    <span>LIVE ALARMS ({activeCornerAlarms.length})</span>
                  </span>
                  {alarmsExpanded ? (
                    <ChevronUp className="h-3 w-3 text-[#737373]" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-[#737373]" />
                  )}
                </button>

                {alarmsExpanded && (
                  <div className="max-h-[240px] overflow-y-auto divide-y divide-[#1A1A1A]">
                    {loadingHistory ? (
                      <div className="px-2.5 py-2 font-mono-tabular text-[10px] text-[#A3A3A3]">
                        Checking orbital data...
                      </div>
                    ) : activeCornerAlarms.length === 0 ? (
                      <div className="px-2.5 py-2 font-mono-tabular text-[10px] text-[#737373]">
                        No active alerts right now — watching orbits for sudden changes.
                      </div>
                    ) : (
                      activeCornerAlarms.map((alarm) => {
                        const isNearCurrent =
                          isHistoricalTime &&
                          Math.abs(new Date(alarm.timestampUtc).getTime() - effectiveSimMs) <=
                            24 * 3600_000;
                        const hasDistinctDetail =
                          Boolean(alarm.detail) &&
                          alarm.detail.trim() !== (alarm.cause ?? '').trim() &&
                          alarm.detail.trim() !== alarm.headline.trim();
                        return (
                          <div
                            key={alarm.id}
                            className={`px-2.5 py-2 space-y-1 ${
                              isNearCurrent ? 'border-l-2 border-l-white bg-[#121212]' : ''
                            }`}
                          >
                            <div className="flex items-center gap-1.5 font-mono-tabular text-[10px]">
                              <span
                                className={`px-1 py-0.2 font-semibold ${
                                  alarm.tier === 'ALERT' || alarm.tier === 'WARNING'
                                    ? 'bg-white text-black'
                                    : 'border border-[#404040] text-white'
                                }`}
                              >
                                {alarm.tier}
                              </span>
                              <span className="text-[#737373] truncate">
                                {alarm.timestampUtc.slice(0, 16).replace('T', ' ')}Z
                              </span>
                            </div>
                            <div className="text-[11px] font-semibold text-white leading-snug">
                              {alarm.headline}
                            </div>
                            <div className="text-[10px] text-[#D4D4D4] leading-snug">
                              <span className="text-[#737373]">What happened: </span>
                              {alarm.cause || alarm.detail}
                            </div>
                            {hasDistinctDetail && (
                              <div className="text-[10px] text-[#A3A3A3] leading-snug">
                                {alarm.detail}
                              </div>
                            )}
                            {alarm.pairKey && pairDossierByKey[alarm.pairKey] && (
                              <div className="border border-[#262626] bg-black px-2 py-1 font-mono-tabular text-[9.5px] text-[#D4D4D4]">
                                <div>
                                  {pairDossierByKey[alarm.pairKey].approaching.countryLabel} ·{' '}
                                  {pairDossierByKey[alarm.pairKey].approaching.operator} · Launched{' '}
                                  {pairDossierByKey[alarm.pairKey].approaching.launchedDate}
                                </div>
                                <div className="text-[#A3A3A3]">
                                  {pairDossierByKey[alarm.pairKey].publicInfoLabel}
                                </div>
                              </div>
                            )}
                            {onOpenAlertContext && (
                              <div className="pt-1">
                                <button
                                  type="button"
                                  onClick={() => onOpenAlertContext(alarm)}
                                  className="border border-white bg-black px-2 py-0.5 font-mono-tabular text-[10px] font-semibold text-white transition-colors hover:bg-white hover:text-black"
                                >
                                  More info with context.dev
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right HUD: CAD Camera Follow + Quick Framing */}
          <div className="pointer-events-auto flex items-center gap-1 overflow-x-auto border border-[#262626] bg-black/90 p-1 max-w-full">
            <label htmlFor="cad-follow-select" className="sr-only">
              Camera Follow Target
            </label>
            <select
              id="cad-follow-select"
              value={String(followTarget)}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === 'free' || raw === 'pair') {
                  setFollowTarget(raw);
                } else {
                  setFollowTarget(Number(raw));
                }
              }}
              className="border border-[#262626] bg-black px-2 py-1 font-mono-tabular text-[11px] text-white outline-none hover:border-white max-w-[175px] shrink-0"
              title="Lock camera to follow both pair satellites or a specific satellite"
            >
              <option value="free">Cam: Free</option>
              {selectedPair && (
                <option value="pair">
                  Follow: {selectedPair.suspectName} + {selectedPair.protectedName}
                </option>
              )}
              {selectableFollowers.map((sat) => (
                <option key={sat.noradId} value={String(sat.noradId)}>
                  Follow: {sat.name} (#{sat.noradId})
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleResetEurope}
              className="px-2 py-1 text-[11px] text-[#A3A3A3] hover:bg-[#141414] hover:text-white"
              title="Center camera on Europe"
            >
              Europe
            </button>
            {selectedPair && (
              <>
                <button
                  type="button"
                  onClick={() => handleSetFraming('orbit')}
                  className={`px-2 py-1 font-mono-tabular text-[11px] border ${
                    cameraFraming === 'orbit'
                      ? 'border-white bg-white text-black font-semibold'
                      : 'border-transparent text-[#A3A3A3] hover:text-white'
                  }`}
                >
                  Orbit
                </button>
                <button
                  type="button"
                  onClick={() => handleSetFraming('closeup')}
                  className={`px-2 py-1 font-mono-tabular text-[11px] border ${
                    cameraFraming === 'closeup'
                      ? 'border-white bg-white text-black font-semibold'
                      : 'border-transparent text-[#A3A3A3] hover:text-white'
                  }`}
                  title="Zoom closely onto active spacecraft pair"
                >
                  Closeup
                </button>
              </>
            )}
            <button
              type="button"
              onClick={handleResetGlobe}
              className="px-2 py-1 text-[11px] text-[#A3A3A3] hover:bg-[#141414] hover:text-white"
            >
              Global
            </button>
            <button
              type="button"
              onClick={handleFocusGeoBelt}
              className="px-2 py-1 font-mono-tabular text-[11px] text-[#A3A3A3] hover:bg-[#141414] hover:text-white"
              title="View full 35,786 km GEO ring"
            >
              GEO
            </button>
          </div>
        </div>

        {/* Standard Proximity Warning Strip (Non-demo proximity watch) */}
        {!replayPoint &&
          !demoActive &&
          frameState.closestAlert &&
          !(activeFlashAlert && dismissedFlashKey !== activeFlashAlert.flashKey) && (
            <div className="flex justify-end">
              <div
                className={`pointer-events-auto flex items-center gap-2 border px-2.5 py-1 font-mono-tabular text-[11px] ${
                  frameState.closestAlert.level === 'collision'
                    ? 'border-white bg-white text-black font-semibold'
                    : 'border-white bg-black/95 text-white'
                }`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {frameState.closestAlert.level === 'collision'
                    ? 'COLLISION ALERT'
                    : 'PROXIMITY WARNING'}
                  : {frameState.closestAlert.satA.name} ↔ {frameState.closestAlert.satB.name} ·{' '}
                  {frameState.closestAlert.distanceKm.toFixed(2)} km
                </span>
              </div>
            </div>
          )}
      </div>

      {/* Hover-Only Satellite Data Card (Name + Orbital Data + Camera Lock) */}
      {inspectedItem && (
        <div
          onMouseEnter={() => {
            isCardHoveredRef.current = true;
            if (hoverHideTimerRef.current !== null) {
              window.clearTimeout(hoverHideTimerRef.current);
              hoverHideTimerRef.current = null;
            }
          }}
          onMouseLeave={() => {
            isCardHoveredRef.current = false;
            if (pinnedNoradId === null) {
              setHoveredNoradId(null);
            }
          }}
          className="pointer-events-auto absolute right-3 bottom-24 z-10 w-[265px] border border-white bg-black/95 p-3 text-xs text-white"
        >
          <div className="flex items-start justify-between gap-2 border-b border-[#1F1F1F] pb-2">
            <div className="min-w-0">
              <div className="truncate font-semibold text-white">{inspectedItem.sat.name}</div>
              <div className="font-mono-tabular text-[10px] text-[#A3A3A3]">
                #{inspectedItem.sat.noradId} · {inspectedItem.sat.country} ·{' '}
                {inspectedItem.sat.orbitRegime}
              </div>
            </div>
            {pinnedNoradId !== null && (
              <button
                type="button"
                onClick={() => {
                  setPinnedNoradId(null);
                  setHoveredNoradId(null);
                }}
                aria-label="Close spacecraft inspector"
                className="p-0.5 text-[#737373] hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-2 space-y-1 font-mono-tabular text-[11px] text-[#A3A3A3]">
            <div>
              Alt / Vel:{' '}
              <span className="text-white">
                {inspectedItem.altKm.toFixed(1)} km · {inspectedItem.speedKms.toFixed(2)} km/s
              </span>
            </div>
            <div>
              Sub-point:{' '}
              <span className="text-white">
                {inspectedItem.latDeg.toFixed(2)}°, {inspectedItem.lonDeg.toFixed(2)}°
              </span>
            </div>
            <div>
              Inc / RAAN:{' '}
              <span className="text-white">
                {Number(inspectedItem.sat.omm.INCLINATION).toFixed(2)}° ·{' '}
                {Number(inspectedItem.sat.omm.RA_OF_ASC_NODE).toFixed(1)}°
              </span>
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                if (followTarget === inspectedItem.sat.noradId) {
                  setFollowTarget('free');
                } else {
                  setFollowTarget(inspectedItem.sat.noradId);
                  setCameraFraming('closeup');
                }
              }}
              className={`w-full border py-1 text-[11px] font-semibold transition-colors ${
                followTarget === inspectedItem.sat.noradId
                  ? 'border-white bg-white text-black'
                  : 'border-white bg-black text-white hover:bg-white hover:text-black'
              }`}
            >
              {followTarget === inspectedItem.sat.noradId ? 'Unlock Camera' : 'Lock Camera'}
            </button>
          </div>
        </div>
      )}

      {/* Bottom Compact 2-Row Time & Playback Controls */}
      <div className="pointer-events-none absolute right-2.5 bottom-2.5 left-2.5 flex flex-col gap-1 border border-[#262626] bg-black/92 px-2.5 py-1.5 text-[11px] text-[#A3A3A3]">
        {!replayPoint ? (
          <>
            {/* Row 1: Play/Speed + Precision Scale Slider + Orbits */}
            <div className="pointer-events-auto flex flex-wrap items-center gap-2 font-mono-tabular text-[10px]">
              <button
                type="button"
                onClick={() => setIsPlaying((p) => !p)}
                className="flex items-center gap-1 border border-white bg-white px-2 py-0.5 text-[11px] font-semibold text-black hover:bg-[#E5E5E5] whitespace-nowrap shrink-0"
              >
                {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                <span>{isPlaying ? 'Pause' : 'Play'}</span>
              </button>

              <div className="flex items-center border border-[#262626] bg-black shrink-0">
                {SPEED_STEPS.map((spd) => (
                  <button
                    key={spd}
                    type="button"
                    onClick={() => {
                      demoAutoRampRef.current = false;
                      setSpeedValue(spd);
                    }}
                    className={`px-1.5 py-0.5 text-[10px] whitespace-nowrap ${
                      speedValue === spd
                        ? 'bg-white text-black font-semibold'
                        : 'text-[#A3A3A3] hover:text-white'
                    }`}
                  >
                    {spd}×
                  </button>
                ))}
                {speedValue > 300 && (
                  <span className="bg-white px-1.5 py-0.5 text-[10px] font-semibold text-black whitespace-nowrap">
                    {formatDemoSpeedLabel(speedValue)}
                  </span>
                )}
              </div>

              <div className="flex items-center border border-[#262626] bg-black shrink-0" title="Time scrollbar precision scale">
                {(['fine', 'medium', 'campaign'] as TimeScaleMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      demoAutoRampRef.current = false;
                      jumpToTimestampMs(effectiveSimMs, mode);
                    }}
                    className={`px-1.5 py-0.5 text-[10px] transition-colors ${
                      timeScale === mode
                        ? 'bg-white text-black font-semibold'
                        : 'text-[#A3A3A3] hover:text-white'
                    }`}
                    title={TIME_SCALE_CONFIG[mode].label}
                  >
                    {TIME_SCALE_CONFIG[mode].shortLabel}
                  </button>
                ))}
              </div>

              <div className="flex flex-1 min-w-[160px] items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    demoAutoRampRef.current = false;
                    setIsPlaying(false);
                    setSimOffsetSec((s) => s - (timeScale === 'fine' ? 60 : 900));
                  }}
                  className="text-[#A3A3A3] hover:text-white shrink-0"
                  title="Step backward"
                >
                  <SkipBack className="h-3 w-3" />
                </button>
                <input
                  type="range"
                  aria-label="Orbital time offset scrollbar"
                  min={scaleCfg.minSec}
                  max={scaleCfg.maxSec}
                  step={scaleCfg.stepSec}
                  value={Math.max(scaleCfg.minSec, Math.min(scaleCfg.maxSec, Math.round(simOffsetSec)))}
                  onChange={(e) => {
                    demoAutoRampRef.current = false;
                    setIsPlaying(false);
                    setSimOffsetSec(Number(e.target.value));
                  }}
                  className="flex-1 accent-white cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => {
                    setIsPlaying(false);
                    setSimOffsetSec((s) => s + (timeScale === 'fine' ? 60 : 900));
                  }}
                  className="text-[#A3A3A3] hover:text-white shrink-0"
                  title="Step forward"
                >
                  <SkipForward className="h-3 w-3" />
                </button>
                <span className="w-[68px] text-right font-semibold text-white shrink-0">
                  {loadingHistory ? 'Loading...' : formatOffsetLabel(simOffsetSec)}
                </span>
              </div>

              <button
                type="button"
                onClick={() => setShowOrbits((v) => !v)}
                className={`border px-2 py-0.5 text-[10px] whitespace-nowrap shrink-0 ${
                  showOrbits
                    ? 'border-white/50 text-white'
                    : 'border-[#262626] text-[#737373] hover:text-white'
                }`}
              >
                Orbits {showOrbits ? 'On' : 'Off'}
              </button>
            </div>

            {/* Row 2: Compact Historical Date Jump + Legend */}
            <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-[10px] border-t border-[#1A1A1A] pt-1">
              <div className="flex flex-wrap items-center gap-1">
                <input
                  type="datetime-local"
                  aria-label="Jump to historical UTC date and time"
                  min="2005-01-01T00:00"
                  max="2027-12-31T23:59"
                  value={simUtcStr.slice(0, 16)}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    const parsed = new Date(`${e.target.value}:00Z`);
                    if (!Number.isNaN(parsed.getTime())) {
                      jumpToTimestampMs(parsed.getTime(), 'fine');
                    }
                  }}
                  className="border border-[#262626] bg-black px-1.5 py-0.5 text-[10px] text-white focus:border-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => jumpToTimestampMs(new Date('2026-10-01T06:00:00Z').getTime(), 'campaign')}
                  className="border border-[#262626] bg-black px-1.5 py-0.5 text-white hover:border-white"
                  title="Jump to beginning of October 2026"
                >
                  Oct 1
                </button>
                <button
                  type="button"
                  onClick={() => jumpToTimestampMs(new Date('2026-10-10T10:34:00Z').getTime(), 'medium')}
                  className="border border-[#262626] bg-black px-1.5 py-0.5 text-white hover:border-white"
                >
                  Oct 10
                </button>
                <button
                  type="button"
                  onClick={() => jumpToTimestampMs(new Date('2026-10-16T07:28:00Z').getTime(), 'fine')}
                  className="border border-[#262626] bg-black px-1.5 py-0.5 text-white hover:border-white"
                >
                  Oct 16
                </button>
                <button
                  type="button"
                  onClick={() => jumpToTimestampMs(effectiveSimMs - 365 * 86400_000, 'campaign')}
                  className="border border-[#262626] bg-black px-1.5 py-0.5 text-[#D4D4D4] hover:border-white hover:text-white"
                  title="Go 1 year further back in Space-Track GP history"
                >
                  -1 Yr
                </button>
                {isHistoricalTime && (
                  <button
                    type="button"
                    onClick={() =>
                      jumpToTimestampMs(Math.min(Date.now(), effectiveSimMs + 365 * 86400_000))
                    }
                    className="border border-[#262626] bg-black px-1.5 py-0.5 text-[#D4D4D4] hover:border-white hover:text-white"
                  >
                    +1 Yr
                  </button>
                )}
              </div>

              <div className="flex items-center gap-3">
                {isHistoricalTime && historicalState && (
                  <span className="text-[#A3A3A3] hidden sm:inline">{historicalState.note}</span>
                )}
                <span className="text-white">● EU</span>
                <span>○ RU/CN</span>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between gap-2 font-mono-tabular text-[10px]">
            <span className="text-[#A3A3A3]">
              Hover either spacecraft for orbital data &amp; camera lock
            </span>
            <div className="flex items-center gap-3">
              <span className="text-white">● EU</span>
              <span>○ RU/CN</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
