import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  DataProvenance,
  OmmRecord,
  SatcatMetadata,
  SatelliteGroupId,
  SatelliteRole,
} from '../shared/types.ts';
import {
  HISTORICAL_OMM_59103,
  HISTORICAL_OMM_68762,
  SEEDED_CURRENT_OMM_BY_NORAD,
} from './seedCatalog.ts';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'cache');
const TWO_HOURS_MS = 2 * 3600 * 1000;

let celestrakEgressBlockedUntilMs = 0;
let liveOrbitFeedSucceededOnce = false;

// Cached Space-Track session cookie (valid 90m to strictly honor Space-Track login rate limits)
let spacetrackCookie: string | null = null;
let spacetrackCookieExpiresMs = 0;

export interface WatchlistConfigEntry {
  norad_id: number;
  name: string;
  operator: string;
  country: string;
  orbit_regime: string;
  mission?: string;
  notes?: string;
  role: SatelliteRole;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function readFreshCache<T>(key: string, maxAgeMs = TWO_HOURS_MS): { data: T; ageMs: number } | null {
  ensureCacheDir();
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      savedAtMs: number;
      payload: T;
    };
    const ageMs = Date.now() - raw.savedAtMs;
    if (ageMs <= maxAgeMs) {
      return { data: raw.payload, ageMs };
    }
  } catch {
    return null;
  }
  return null;
}

function writeCache<T>(key: string, payload: T): void {
  ensureCacheDir();
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ savedAtMs: Date.now(), payload }, null, 2),
    'utf8',
  );
}

export function countDiskCacheEntries(): number {
  ensureCacheDir();
  try {
    return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export function getCelestrakConnectionStatus(): 'live' | 'cached_or_snapshot_fallback' {
  return liveOrbitFeedSucceededOnce ? 'live' : 'cached_or_snapshot_fallback';
}

export function isSpaceTrackConfigured(): boolean {
  return Boolean(process.env.SPACETRACK_USER?.trim() && process.env.SPACETRACK_PASS?.trim());
}

export function loadWatchlistsConfig(): WatchlistConfigEntry[] {
  const cfgPath = path.resolve(process.cwd(), 'config', 'watchlists.yaml');
  const rawYaml = fs.readFileSync(cfgPath, 'utf8');
  const parsed = YAML.parse(rawYaml) as {
    protected?: Omit<WatchlistConfigEntry, 'role'>[];
    suspects?: Omit<WatchlistConfigEntry, 'role'>[];
  };

  const entries: WatchlistConfigEntry[] = [];
  for (const item of parsed.protected ?? []) {
    entries.push({ ...item, role: 'protected' });
  }
  for (const item of parsed.suspects ?? []) {
    entries.push({ ...item, role: 'suspect' });
  }
  return entries;
}

async function getSpaceTrackCookie(): Promise<string | null> {
  const user = process.env.SPACETRACK_USER?.trim();
  const pass = process.env.SPACETRACK_PASS?.trim();
  if (!user || !pass) return null;

  if (spacetrackCookie && Date.now() < spacetrackCookieExpiresMs) {
    return spacetrackCookie;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const authRes = await fetch('https://www.space-track.org/ajaxauth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ identity: user, password: pass }).toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const bodyText = await authRes.text();
    if (bodyText.includes('Failed')) {
      spacetrackCookie = null;
      return null;
    }

    const setCookies =
      typeof authRes.headers.getSetCookie === 'function'
        ? authRes.headers.getSetCookie()
        : authRes.headers.get('set-cookie')
          ? [authRes.headers.get('set-cookie') as string]
          : [];

    if (authRes.ok && setCookies.length > 0) {
      spacetrackCookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      spacetrackCookieExpiresMs = Date.now() + 90 * 60 * 1000;
      return spacetrackCookie;
    }
  } catch {
    spacetrackCookie = null;
  }
  return null;
}

async function fetchWithFastRetry(url: string, timeoutMs = 2200, retries = 1): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'Specola-Orbital-Verification/1.0' },
      });
      clearTimeout(timer);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function normalizeSpaceTrackUtc(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Space-Track CREATION_DATE comes as "YYYY-MM-DD HH:MM:SS" in UTC (or ISO).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
    return `${trimmed.replace(' ', 'T')}Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
    return `${trimmed}Z`;
  }
  return trimmed;
}

export function coerceOmmRecord(raw: Record<string, unknown>, fallbackNoradId: number): OmmRecord {
  return {
    OBJECT_NAME: String(raw.OBJECT_NAME ?? `NORAD ${fallbackNoradId}`),
    OBJECT_ID: String(raw.OBJECT_ID ?? 'UNKNOWN'),
    EPOCH: String(raw.EPOCH ?? new Date().toISOString().slice(0, 19)),
    MEAN_MOTION: Number(raw.MEAN_MOTION ?? 15.0),
    ECCENTRICITY: Number(raw.ECCENTRICITY ?? 0.0002),
    INCLINATION: Number(raw.INCLINATION ?? 97.5),
    RA_OF_ASC_NODE: Number(raw.RA_OF_ASC_NODE ?? 0),
    ARG_OF_PERICENTER: Number(raw.ARG_OF_PERICENTER ?? 0),
    MEAN_ANOMALY: Number(raw.MEAN_ANOMALY ?? 0),
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: raw.CLASSIFICATION_TYPE === 'C' ? 'C' : 'U',
    NORAD_CAT_ID: Number(raw.NORAD_CAT_ID ?? fallbackNoradId),
    ELEMENT_SET_NO: Number(raw.ELEMENT_SET_NO ?? 999),
    REV_AT_EPOCH: Number(raw.REV_AT_EPOCH ?? 1000),
    BSTAR: Number(raw.BSTAR ?? 0.00005),
    MEAN_MOTION_DOT: Number(raw.MEAN_MOTION_DOT ?? 0.00001),
    MEAN_MOTION_DDOT: Number(raw.MEAN_MOTION_DDOT ?? 0),
    CREATION_DATE: normalizeSpaceTrackUtc(raw.CREATION_DATE),
  };
}

let lastSpaceTrackBatchMs = 0;

/**
 * Batch-fetches latest GP elements from Space-Track.org in a SINGLE rate-limit-friendly request
 * when SPACETRACK_USER & SPACETRACK_PASS are configured, populating the 2-hour per-NORAD disk cache.
 */
export async function prefetchBatchFromSpaceTrack(
  noradIds: number[],
  forceRefresh = false,
): Promise<void> {
  if (!isSpaceTrackConfigured() || noradIds.length === 0) return;

  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const allowForced = forceRefresh && Date.now() - lastSpaceTrackBatchMs > FIVE_MINUTES_MS;
  const targetIds = allowForced
    ? noradIds
    : noradIds.filter((id) => !readFreshCache<OmmRecord>(`celestrak_gp_${id}`, TWO_HOURS_MS));

  if (targetIds.length === 0) {
    // Cache is warm from recent Space-Track batch
    liveOrbitFeedSucceededOnce = true;
    return;
  }

  const cookie = await getSpaceTrackCookie();
  if (!cookie) return;

  try {
    const csvIds = targetIds.join(',');
    const url = `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/${csvIds}/orderby/NORAD_CAT_ID%20asc/format/json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(url, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      lastSpaceTrackBatchMs = Date.now();
      const rows = (await res.json()) as Record<string, unknown>[];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const nid = Number(r.NORAD_CAT_ID);
          if (Number.isInteger(nid) && nid > 0) {
            writeCache(`celestrak_gp_${nid}`, coerceOmmRecord(r, nid));
            liveOrbitFeedSucceededOnce = true;
          }
        }
      }
    }
  } catch {
    // Fall through gracefully to CelesTrak / seeded snapshot
  }
}

/**
 * Fetches GP JSON for a NORAD catalog ID:
 * 1. Checks 2-hour local disk cache (populated by Space-Track batch or CelesTrak).
 * 2. Tries Space-Track single lookup if SPACETRACK_USER/PASS are set.
 * 3. Tries CelesTrak GP JSON if network egress is open.
 * 4. Falls back cleanly to provenance-labeled seeded snapshots.
 */
export async function fetchGpOmmForNorad(
  noradId: number,
): Promise<{ omm: OmmRecord; provenance: DataProvenance } | null> {
  const cacheKey = `celestrak_gp_${noradId}`;
  const cached = readFreshCache<OmmRecord>(cacheKey, TWO_HOURS_MS);
  if (cached) {
    return {
      omm: cached.data,
      provenance: isSpaceTrackConfigured() ? 'spacetrack-history' : 'celestrak-cache',
    };
  }

  if (isSpaceTrackConfigured()) {
    await prefetchBatchFromSpaceTrack([noradId]);
    const afterBatch = readFreshCache<OmmRecord>(cacheKey, TWO_HOURS_MS);
    if (afterBatch) {
      return { omm: afterBatch.data, provenance: 'spacetrack-history' };
    }
  }

  if (Date.now() > celestrakEgressBlockedUntilMs) {
    try {
      const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=json`;
      const res = await fetchWithFastRetry(url, 2200, 1);
      const arr = (await res.json()) as Record<string, unknown>[];
      if (Array.isArray(arr) && arr.length > 0) {
        const omm = coerceOmmRecord(arr[0], noradId);
        writeCache(cacheKey, omm);
        liveOrbitFeedSucceededOnce = true;
        return { omm, provenance: 'celestrak-live' };
      }
    } catch {
      celestrakEgressBlockedUntilMs = Date.now() + 10 * 60 * 1000;
    }
  }

  const seeded = SEEDED_CURRENT_OMM_BY_NORAD[noradId];
  if (seeded) {
    return { omm: seeded, provenance: 'seeded-celestrak-snapshot' };
  }

  return null;
}

export async function fetchSatcatMetadata(noradId: number): Promise<SatcatMetadata | null> {
  const cacheKey = `celestrak_satcat_${noradId}`;
  const cached = readFreshCache<SatcatMetadata>(cacheKey, TWO_HOURS_MS * 6);
  if (cached) return cached.data;

  if (isSpaceTrackConfigured()) {
    const cookie = await getSpaceTrackCookie();
    if (cookie) {
      try {
        const res = await fetch(
          `https://www.space-track.org/basicspacedata/query/class/satcat/NORAD_CAT_ID/${noradId}/format/json`,
          { headers: { Cookie: cookie, Accept: 'application/json' } },
        );
        if (res.ok) {
          const arr = (await res.json()) as Record<string, unknown>[];
          if (Array.isArray(arr) && arr.length > 0) {
            const item = arr[0];
            const meta: SatcatMetadata = {
              noradId,
              objectName: String(item.SATNAME ?? item.OBJECT_NAME ?? `NORAD ${noradId}`),
              objectId: String(item.INTLDES ?? item.OBJECT_ID ?? ''),
              owner: String(item.COUNTRY ?? item.OWNER ?? 'UNKNOWN'),
              launchDate: item.LAUNCH ? String(item.LAUNCH) : undefined,
            };
            writeCache(cacheKey, meta);
            return meta;
          }
        }
      } catch {
        // Continue to fallback
      }
    }
  }

  if (Date.now() > celestrakEgressBlockedUntilMs) {
    try {
      const url = `https://celestrak.org/satcat/records.php?CATNR=${noradId}&FORMAT=JSON`;
      const res = await fetchWithFastRetry(url, 2000, 0);
      const arr = (await res.json()) as Record<string, unknown>[];
      if (Array.isArray(arr) && arr.length > 0) {
        const item = arr[0];
        const meta: SatcatMetadata = {
          noradId,
          objectName: String(item.OBJECT_NAME ?? `NORAD ${noradId}`),
          objectId: String(item.OBJECT_ID ?? ''),
          owner: String(item.OWNER ?? 'UNKNOWN'),
          launchDate: item.LAUNCH_DATE ? String(item.LAUNCH_DATE) : undefined,
          opsStatus: item.OPS_STATUS_CODE ? String(item.OPS_STATUS_CODE) : undefined,
          orbitType: item.ORBIT_TYPE ? String(item.ORBIT_TYPE) : undefined,
        };
        writeCache(cacheKey, meta);
        return meta;
      }
    } catch {
      celestrakEgressBlockedUntilMs = Date.now() + 10 * 60 * 1000;
    }
  }

  const seeded = SEEDED_CURRENT_OMM_BY_NORAD[noradId];
  if (!seeded) return null;
  return {
    noradId,
    objectName: seeded.OBJECT_NAME,
    objectId: seeded.OBJECT_ID,
    owner: noradId >= 68759 && noradId <= 68764 ? 'CIS' : noradId === 59103 ? 'US/FI' : 'EU',
  };
}

/**
 * Loads Sep 20 – Oct 31, 2026 historical GP element sets for 59103, 68762 (and sister objects 68759-68764)
 * from Space-Track.org when SPACETRACK_USER and SPACETRACK_PASS are configured, caching to disk.
 */
export async function fetchHistoricalOmmPair(
  suspectNorad = 68762,
  protectedNorad = 59103,
  fromDate = '2026-09-20',
  toDate = '2026-11-14',
): Promise<{
  suspectHistory: OmmRecord[];
  protectedHistory: OmmRecord[];
  provenance: DataProvenance;
}> {
  const cacheKey = `spacetrack_hist_${suspectNorad}_${protectedNorad}_${fromDate}_${toDate}`;
  const legacyKey = `spacetrack_hist_${suspectNorad}_${protectedNorad}`;
  const cachedPrimary = readFreshCache<{ suspectHistory: OmmRecord[]; protectedHistory: OmmRecord[] }>(
    cacheKey,
    30 * 24 * 3600 * 1000,
  );
  const cachedLegacy =
    suspectNorad === 68762 && protectedNorad === 59103
      ? readFreshCache<{ suspectHistory: OmmRecord[]; protectedHistory: OmmRecord[] }>(
          legacyKey,
          30 * 24 * 3600 * 1000,
        )
      : null;
  const cached =
    cachedPrimary ??
    (cachedLegacy && cachedLegacy.data.suspectHistory[0]?.CREATION_DATE ? cachedLegacy : null);

  if (cached && cached.data.suspectHistory.length > 0 && cached.data.protectedHistory.length > 0) {
    return { ...cached.data, provenance: 'spacetrack-history' };
  }

  const cookie = await getSpaceTrackCookie();
  if (cookie) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const queryUrl = `https://www.space-track.org/basicspacedata/query/class/gp_history/NORAD_CAT_ID/${suspectNorad},${protectedNorad}/EPOCH/${fromDate}--${toDate}/orderby/EPOCH%20asc/format/json`;
      const dataRes = await fetch(queryUrl, {
        headers: { Cookie: cookie, Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (dataRes.ok) {
        const rows = (await dataRes.json()) as Record<string, unknown>[];
        const suspectHistory = rows
          .filter((r) => Number(r.NORAD_CAT_ID) === suspectNorad)
          .map((r) => coerceOmmRecord(r, suspectNorad));
        const protectedHistory = rows
          .filter((r) => Number(r.NORAD_CAT_ID) === protectedNorad)
          .map((r) => coerceOmmRecord(r, protectedNorad));
        if (suspectHistory.length > 0 && protectedHistory.length > 0) {
          writeCache(cacheKey, { suspectHistory, protectedHistory });
          liveOrbitFeedSucceededOnce = true;
          return { suspectHistory, protectedHistory, provenance: 'spacetrack-history' };
        }
      }
    } catch {
      // Fall through cleanly to verified historical archive or current GP back-propagation
    }
  }

  if (suspectNorad === 68762 && protectedNorad === 59103) {
    return {
      suspectHistory: HISTORICAL_OMM_68762,
      protectedHistory: HISTORICAL_OMM_59103,
      provenance: 'published-historical-tle-archive',
    };
  }

  const sCurrent = (await fetchGpOmmForNorad(suspectNorad))?.omm ?? SEEDED_CURRENT_OMM_BY_NORAD[suspectNorad];
  const pCurrent = (await fetchGpOmmForNorad(protectedNorad))?.omm ?? SEEDED_CURRENT_OMM_BY_NORAD[protectedNorad];
  return {
    suspectHistory: sCurrent ? [sCurrent] : HISTORICAL_OMM_68762,
    protectedHistory: pCurrent ? [pCurrent] : HISTORICAL_OMM_59103,
    provenance: 'seeded-celestrak-snapshot',
  };
}

/**
 * Fetches & permanently caches historical Space-Track gp_history (with CREATION_DATE)
 * for a batch of NORAD IDs over [fromDate, toDate]. Designed for blind chronological backtesting.
 */
export async function fetchHistoricalBatchForRange(params: {
  cacheKey: string;
  noradIds: number[];
  fromDate: string;
  toDate: string;
  forceRefresh?: boolean;
}): Promise<{ byNorad: Record<number, OmmRecord[]>; provenance: DataProvenance; totalRows: number }> {
  const uniqueIds = Array.from(new Set(params.noradIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (!params.forceRefresh) {
    const cached = readFreshCache<{ byNorad: Record<number, OmmRecord[]>; totalRows: number }>(
      params.cacheKey,
      90 * 24 * 3600 * 1000,
    );
    if (cached && cached.data.totalRows > 0) {
      return {
        byNorad: cached.data.byNorad,
        totalRows: cached.data.totalRows,
        provenance: 'spacetrack-history',
      };
    }
  }

  const byNorad: Record<number, OmmRecord[]> = {};
  let totalRows = 0;

  if (isSpaceTrackConfigured() && uniqueIds.length > 0) {
    const cookie = await getSpaceTrackCookie();
    if (cookie) {
      // Query in chunks of 18 NORAD IDs so URLs stay compact and rate limits are respected
      const chunkSize = 18;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
          const queryUrl = `https://www.space-track.org/basicspacedata/query/class/gp_history/NORAD_CAT_ID/${chunk.join(',')}/EPOCH/${params.fromDate}--${params.toDate}/orderby/NORAD_CAT_ID%20asc,EPOCH%20asc/format/json`;
          const res = await fetch(queryUrl, {
            headers: { Cookie: cookie, Accept: 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (res.ok) {
            const rows = (await res.json()) as Record<string, unknown>[];
            if (Array.isArray(rows)) {
              for (const r of rows) {
                const nid = Number(r.NORAD_CAT_ID);
                if (!Number.isInteger(nid) || nid <= 0) continue;
                if (!byNorad[nid]) byNorad[nid] = [];
                byNorad[nid].push(coerceOmmRecord(r, nid));
                totalRows += 1;
              }
            }
          }
        } catch {
          clearTimeout(timer);
        }
      }
      if (totalRows > 0) {
        liveOrbitFeedSucceededOnce = true;
        writeCache(params.cacheKey, { byNorad, totalRows });
        return { byNorad, totalRows, provenance: 'spacetrack-history' };
      }
    }
  }

  // Offline fallback using local archive for 68762 & 59103
  if (params.noradIds.includes(68762)) byNorad[68762] = HISTORICAL_OMM_68762;
  if (params.noradIds.includes(59103)) byNorad[59103] = HISTORICAL_OMM_59103;
  totalRows = (byNorad[68762]?.length ?? 0) + (byNorad[59103]?.length ?? 0);
  return { byNorad, totalRows, provenance: 'published-historical-tle-archive' };
}

/**
 * Loads historical Space-Track gp_history for any date (early October 2026 or years back),
 * reusing existing cached archives first before querying Space-Track gp_history by week/window.
 */
export async function fetchHistoricalWatchlistWindow(
  targetDate: Date,
  noradIds: number[],
): Promise<{ byNorad: Record<number, OmmRecord[]>; provenance: DataProvenance; windowLabel: string }> {
  const dayStr = targetDate.toISOString().slice(0, 10);

  if (dayStr >= '2026-09-20' && dayStr <= '2026-10-31') {
    const oct = await fetchHistoricalBatchForRange({
      cacheKey: 'backtest_gp_history_2026-09-20_2026-10-31',
      noradIds,
      fromDate: '2026-09-20',
      toDate: '2026-10-31',
    });
    return {
      byNorad: oct.byNorad,
      provenance: oct.provenance,
      windowLabel: 'Space-Track gp_history (2026-09-20..2026-10-31)',
    };
  }

  if (dayStr >= '2026-05-01' && dayStr <= '2026-06-01') {
    const may = await fetchHistoricalBatchForRange({
      cacheKey: 'backtest_gp_history_2026-05-01_2026-06-01',
      noradIds,
      fromDate: '2026-05-01',
      toDate: '2026-06-01',
    });
    return {
      byNorad: may.byNorad,
      provenance: may.provenance,
      windowLabel: 'Space-Track gp_history (2026-05-01..2026-06-01)',
    };
  }

  // Snap to 14-day aligned buckets so nearby scrubbing shares one Space-Track disk cache file
  const bucketMs = 14 * 86400_000;
  const tMs = targetDate.getTime();
  const bucketStart = Math.floor(tMs / bucketMs) * bucketMs - 3 * 86400_000;
  const bucketEnd = Math.floor(tMs / bucketMs) * bucketMs + bucketMs + 2 * 86400_000;
  const fromDate = new Date(bucketStart).toISOString().slice(0, 10);
  const toDate = new Date(bucketEnd).toISOString().slice(0, 10);

  const hist = await fetchHistoricalBatchForRange({
    cacheKey: `hist_window_${fromDate}_${toDate}`,
    noradIds,
    fromDate,
    toDate,
  });

  return {
    byNorad: hist.byNorad,
    provenance: hist.provenance,
    windowLabel: `Space-Track gp_history (${fromDate}..${toDate})`,
  };
}

const SPACETRACK_GROUP_QUERIES: Record<Exclude<SatelliteGroupId, 'watched'>, string> = {
  stations:
    'https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/25544,48274,20580,54216,49044,53239/orderby/NORAD_CAT_ID%20asc/format/json',
  // Verified active operational polar & GEO meteorological satellites (NOAA-20/21, Suomi NPP, Metop-B/C, Meteosat-11/12, MTG-S1, Sentinel-3A/5P, GOES-18/19, Himawari-9, FY-3E)
  weather:
    'https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/43013,54234,37849,38771,43689,40732,54743,64723,41335,42969,51850,60133,41836,49008/orderby/NORAD_CAT_ID%20asc/format/json',
  'gps-ops':
    'https://www.space-track.org/basicspacedata/query/class/gp/OBJECT_NAME/~~GPS,~~GSAT/DECAY_DATE/null-val/MEAN_MOTION/%3C3/orderby/EPOCH%20desc/limit/36/format/json',
  starlink:
    'https://www.space-track.org/basicspacedata/query/class/gp/OBJECT_NAME/~~STARLINK/DECAY_DATE/null-val/orderby/EPOCH%20desc/limit/45/format/json',
  active:
    'https://www.space-track.org/basicspacedata/query/class/gp/DECAY_DATE/null-val/OBJECT_TYPE/PAYLOAD/orderby/EPOCH%20desc/limit/55/format/json',
};

const SEEDED_FALLBACK_STATIONS: OmmRecord[] = [
  {
    OBJECT_NAME: 'ISS (ZARYA)',
    OBJECT_ID: '1998-067A',
    EPOCH: '2026-11-14T04:12:00.000000',
    MEAN_MOTION: 15.4956,
    ECCENTRICITY: 0.00068,
    INCLINATION: 51.6401,
    RA_OF_ASC_NODE: 142.12,
    ARG_OF_PERICENTER: 65.4,
    MEAN_ANOMALY: 185.2,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 48200,
    BSTAR: 0.00018,
    MEAN_MOTION_DOT: 0.00012,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'CSS (TIANHE)',
    OBJECT_ID: '2021-035A',
    EPOCH: '2026-11-14T04:05:00.000000',
    MEAN_MOTION: 15.6112,
    ECCENTRICITY: 0.00051,
    INCLINATION: 41.4742,
    RA_OF_ASC_NODE: 218.5,
    ARG_OF_PERICENTER: 92.1,
    MEAN_ANOMALY: 44.8,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 48274,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 29400,
    BSTAR: 0.00021,
    MEAN_MOTION_DOT: 0.00015,
    MEAN_MOTION_DDOT: 0,
  },
  {
    OBJECT_NAME: 'HST',
    OBJECT_ID: '1990-037B',
    EPOCH: '2026-11-14T03:50:00.000000',
    MEAN_MOTION: 15.162,
    ECCENTRICITY: 0.00029,
    INCLINATION: 28.469,
    RA_OF_ASC_NODE: 64.2,
    ARG_OF_PERICENTER: 184.0,
    MEAN_ANOMALY: 112.5,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 20580,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 61200,
    BSTAR: 0.00009,
    MEAN_MOTION_DOT: 0.00004,
    MEAN_MOTION_DDOT: 0,
  },
];

/**
 * Fetches OMM records for standard orbital catalog groups (stations, active, starlink, weather, gps-ops):
 * 1. Checks 2-hour disk cache.
 * 2. Uses live Space-Track GP batch query if configured, or CelesTrak GP JSON if reachable.
 * 3. Falls back cleanly to provenance-labeled local catalog records.
 */
export async function fetchSatelliteGroupOmms(
  group: Exclude<SatelliteGroupId, 'watched'>,
): Promise<{ records: OmmRecord[]; provenance: DataProvenance }> {
  const cacheKey = `group_gp_${group}`;
  const cached = readFreshCache<{ records: OmmRecord[]; provenance: DataProvenance }>(
    cacheKey,
    TWO_HOURS_MS,
  );
  if (cached && cached.data.records.length > 0) {
    return cached.data;
  }

  if (isSpaceTrackConfigured()) {
    const cookie = await getSpaceTrackCookie();
    if (cookie) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        const res = await fetch(SPACETRACK_GROUP_QUERIES[group], {
          headers: { Cookie: cookie, Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const rows = (await res.json()) as Record<string, unknown>[];
          if (Array.isArray(rows) && rows.length > 0) {
            const dedup = new Map<number, OmmRecord>();
            for (const row of rows) {
              const nid = Number(row.NORAD_CAT_ID);
              if (!Number.isInteger(nid) || nid <= 0 || dedup.has(nid)) continue;
              const omm = coerceOmmRecord(row, nid);
              dedup.set(nid, omm);
              writeCache(`celestrak_gp_${nid}`, omm);
            }
            const records = Array.from(dedup.values()).slice(0, 55);
            liveOrbitFeedSucceededOnce = true;
            const payload = { records, provenance: 'spacetrack-history' as DataProvenance };
            writeCache(cacheKey, payload);
            return payload;
          }
        }
      } catch {
        // Fall through to CelesTrak or local fallback
      }
    }
  }

  if (Date.now() > celestrakEgressBlockedUntilMs) {
    try {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
      const res = await fetchWithFastRetry(url, 2200, 0);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (Array.isArray(rows) && rows.length > 0) {
        const records = rows
          .slice(0, 55)
          .map((row) => coerceOmmRecord(row, Number(row.NORAD_CAT_ID) || 0))
          .filter((r) => r.NORAD_CAT_ID > 0);
        liveOrbitFeedSucceededOnce = true;
        const payload = { records, provenance: 'celestrak-live' as DataProvenance };
        writeCache(cacheKey, payload);
        return payload;
      }
    } catch {
      celestrakEgressBlockedUntilMs = Date.now() + 10 * 60 * 1000;
    }
  }

  const fallbackRecords =
    group === 'stations'
      ? SEEDED_FALLBACK_STATIONS
      : Object.values(SEEDED_CURRENT_OMM_BY_NORAD).slice(0, 12);
  return {
    records: fallbackRecords,
    provenance: 'seeded-celestrak-snapshot',
  };
}

/**
 * Fetches recent multi-epoch Space-Track GP_History for a set of NORAD IDs in a SINGLE request
 * to power live orbit-change / maneuver / Δv early-warning detection across all suspects.
 */
export async function fetchRecentGpHistoryBatch(
  noradIds: number[],
  daysBack = 21,
): Promise<{ byNorad: Record<number, OmmRecord[]>; provenance: DataProvenance }> {
  const uniqueIds = Array.from(new Set(noradIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) {
    return { byNorad: {}, provenance: 'seeded-celestrak-snapshot' };
  }

  const cacheKey = `gp_hist_batch_${daysBack}d_${uniqueIds.join('_').slice(0, 64)}`;
  const cached = readFreshCache<{ byNorad: Record<number, OmmRecord[]>; provenance: DataProvenance }>(
    cacheKey,
    TWO_HOURS_MS,
  );
  if (cached) {
    return cached.data;
  }

  const byNorad: Record<number, OmmRecord[]> = {};
  const fromDate = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

  if (isSpaceTrackConfigured()) {
    const cookie = await getSpaceTrackCookie();
    if (cookie) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const queryUrl = `https://www.space-track.org/basicspacedata/query/class/gp_history/NORAD_CAT_ID/${uniqueIds.join(',')}/EPOCH/${fromDate}--${toDate}/orderby/NORAD_CAT_ID%20asc,EPOCH%20asc/format/json`;
        const res = await fetch(queryUrl, {
          headers: { Cookie: cookie, Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          const rows = (await res.json()) as Record<string, unknown>[];
          if (Array.isArray(rows) && rows.length > 0) {
            for (const row of rows) {
              const nid = Number(row.NORAD_CAT_ID);
              if (!Number.isInteger(nid) || nid <= 0) continue;
              if (!byNorad[nid]) byNorad[nid] = [];
              byNorad[nid].push(coerceOmmRecord(row, nid));
            }
            liveOrbitFeedSucceededOnce = true;
            const payload = { byNorad, provenance: 'spacetrack-history' as DataProvenance };
            writeCache(cacheKey, payload);
            return payload;
          }
        }
      } catch {
        // Fall through cleanly to local archived GP history
      }
    }
  }

  for (const nid of uniqueIds) {
    if (nid === 68762) {
      byNorad[nid] = HISTORICAL_OMM_68762;
    } else if (nid === 59103) {
      byNorad[nid] = HISTORICAL_OMM_59103;
    } else if (SEEDED_CURRENT_OMM_BY_NORAD[nid]) {
      byNorad[nid] = [SEEDED_CURRENT_OMM_BY_NORAD[nid]];
    }
  }
  return { byNorad, provenance: 'published-historical-tle-archive' };
}

/**
 * Fetches exact live active catalog totals (active payloads + total on-orbit tracked objects)
 * from Space-Track GP metadata with a 6-hour cache.
 */
export async function fetchSpaceTrackCatalogTotals(): Promise<{
  availableActivePayloads: number;
  availableTrackedObjects: number;
}> {
  const cacheKey = 'spacetrack_catalog_totals';
  const cached = readFreshCache<{
    availableActivePayloads: number;
    availableTrackedObjects: number;
  }>(cacheKey, TWO_HOURS_MS * 3);
  if (cached) return cached.data;

  const fallback = {
    availableActivePayloads: 19849,
    availableTrackedObjects: 35610,
  };

  if (!isSpaceTrackConfigured()) return fallback;
  const cookie = await getSpaceTrackCookie();
  if (!cookie) return fallback;

  try {
    const [pRes, aRes] = await Promise.all([
      fetch(
        'https://www.space-track.org/basicspacedata/query/class/gp/DECAY_DATE/null-val/OBJECT_TYPE/PAYLOAD/format/json/limit/1/metadata/true',
        { headers: { Cookie: cookie } },
      ),
      fetch(
        'https://www.space-track.org/basicspacedata/query/class/gp/DECAY_DATE/null-val/format/json/limit/1/metadata/true',
        { headers: { Cookie: cookie } },
      ),
    ]);
    const pJson = pRes.ok ? ((await pRes.json()) as { request_metadata?: { Total?: number } }) : null;
    const aJson = aRes.ok ? ((await aRes.json()) as { request_metadata?: { Total?: number } }) : null;
    const result = {
      availableActivePayloads: Number(pJson?.request_metadata?.Total) || fallback.availableActivePayloads,
      availableTrackedObjects: Number(aJson?.request_metadata?.Total) || fallback.availableTrackedObjects,
    };
    writeCache(cacheKey, result);
    return result;
  } catch {
    return fallback;
  }
}

export interface CatalogSearchHit {
  noradId: number;
  name: string;
  objectId: string;
  orbitRegime: string;
  epochUtc: string;
  source: 'spacetrack-live' | 'local-catalog';
}

export async function searchSpaceTrackCatalog(query: string): Promise<CatalogSearchHit[]> {
  const clean = query.trim();
  if (!clean) return [];

  const hits = new Map<number, CatalogSearchHit>();
  const addOmm = (omm: OmmRecord, source: CatalogSearchHit['source']) => {
    const n = Number(omm.MEAN_MOTION) || 15;
    hits.set(omm.NORAD_CAT_ID, {
      noradId: omm.NORAD_CAT_ID,
      name: omm.OBJECT_NAME,
      objectId: omm.OBJECT_ID,
      orbitRegime: n < 2 ? 'GEO' : n < 6 ? 'MEO' : 'LEO',
      epochUtc: omm.EPOCH,
      source,
    });
  };

  // Search Space-Track GP by numeric NORAD ID or spacecraft name pattern
  if (isSpaceTrackConfigured()) {
    const cookie = await getSpaceTrackCookie();
    if (cookie) {
      try {
        const isNumeric = /^\d+$/.test(clean);
        const url = isNumeric
          ? `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/${Number(clean)}/format/json/limit/12`
          : `https://www.space-track.org/basicspacedata/query/class/gp/OBJECT_NAME/~~${encodeURIComponent(
              clean.toUpperCase(),
            )}/DECAY_DATE/null-val/orderby/EPOCH%20desc/format/json/limit/12`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, {
          headers: { Cookie: cookie, Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const rows = (await res.json()) as Record<string, unknown>[];
          for (const r of rows) {
            const nid = Number(r.NORAD_CAT_ID);
            if (!Number.isInteger(nid) || nid <= 0) continue;
            const omm = coerceOmmRecord(r, nid);
            writeCache(`celestrak_gp_${nid}`, omm);
            addOmm(omm, 'spacetrack-live');
          }
        }
      } catch {
        // Fall through to local catalog search
      }
    }
  }

  // Always supplement with local seeded/watchlist catalog
  const qLower = clean.toLowerCase();
  for (const omm of Object.values(SEEDED_CURRENT_OMM_BY_NORAD)) {
    if (
      String(omm.NORAD_CAT_ID).includes(qLower) ||
      omm.OBJECT_NAME.toLowerCase().includes(qLower)
    ) {
      if (!hits.has(omm.NORAD_CAT_ID)) addOmm(omm, 'local-catalog');
    }
  }
  for (const entry of loadWatchlistsConfig()) {
    if (
      String(entry.norad_id).includes(qLower) ||
      entry.name.toLowerCase().includes(qLower) ||
      entry.operator.toLowerCase().includes(qLower)
    ) {
      if (!hits.has(entry.norad_id)) {
        hits.set(entry.norad_id, {
          noradId: entry.norad_id,
          name: entry.name,
          objectId: entry.orbit_regime,
          orbitRegime: entry.orbit_regime,
          epochUtc: new Date().toISOString(),
          source: 'local-catalog',
        });
      }
    }
  }

  return Array.from(hits.values()).slice(0, 15);
}

