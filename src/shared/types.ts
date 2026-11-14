import { z } from 'zod';

export interface OmmRecord {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  EPHEMERIS_TYPE: 0;
  CLASSIFICATION_TYPE: 'U' | 'C';
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
  CREATION_DATE?: string;
  [key: string]: unknown;
}

export type SatelliteRole = 'protected' | 'suspect' | 'catalog';
export type SatelliteGroupId = 'watched' | 'stations' | 'active' | 'starlink' | 'weather' | 'gps-ops';
export type DataProvenance =
  | 'celestrak-live'
  | 'celestrak-cache'
  | 'spacetrack-history'
  | 'seeded-celestrak-snapshot'
  | 'published-historical-tle-archive';

export interface SatcatMetadata {
  noradId: number;
  objectName: string;
  objectId: string;
  owner: string;
  launchDate?: string;
  opsStatus?: string;
  orbitType?: string;
}

export interface WatchedSatellite {
  noradId: number;
  name: string;
  role: SatelliteRole;
  operator: string;
  country: string;
  orbitRegime: string;
  mission?: string;
  notes?: string;
  omm: OmmRecord;
  provenance: DataProvenance;
  epochAgeHours: number;
  positionGeodetic: {
    latDeg: number;
    lonDeg: number;
    altKm: number;
    speedKms: number;
  };
  orbitTrack: [number, number, number][]; // [lonDeg, latDeg, altMeters]
}

export interface ClosestApproachResult {
  primaryNoradId: number;
  secondaryNoradId: number;
  tcaUtc: string;
  minDistanceKm: number;
  relativeVelocityKms: number;
  planeAngleDeg: number;
  primaryAltKm: number;
  secondaryAltKm: number;
  windowHours: number;
  computationSummary: string;
}

export interface ManeuverDetection {
  id: string;
  noradId: number;
  satelliteName: string;
  epochBeforeUtc: string;
  epochAfterUtc: string;
  deltaSemiMajorAxisKm: number;
  deltaInclinationDeg: number;
  residualDeltaRaanDeg: number;
  estimatedDeltaVMs: number;
  maneuverType: 'phasing_altitude' | 'plane_change' | 'combined_rpo' | 'drift_departure';
  isApproachSignature: boolean;
  targetNoradId?: number;
  targetName?: string;
  postManeuverRangeKm?: number;
  postManeuverPlaneAngleDeg?: number;
  summary: string;
}

export interface PairTelemetrySnapshot {
  suspectNoradId: number;
  protectedNoradId: number;
  suspectName: string;
  protectedName: string;
  suspectCountry?: string;
  protectedCountry?: string;
  computedAtUtc: string;
  currentDistanceKm: number;
  planeAngleDeg: number;
  relativeSpeedKms: number;
  suspectAltKm: number;
  protectedAltKm: number;
  coplanarClassification: 'coplanar_shadow' | 'near_coplanar' | 'distinct_planes';
  tca72h: ClosestApproachResult;
  suspectProvenance: DataProvenance;
  protectedProvenance: DataProvenance;
  suspectEpochUtc?: string;
  protectedEpochUtc?: string;
}

export interface ReplayPoint {
  timestampUtc: string;
  distanceKm: number;
  planeAngleDeg: number;
  suspectAltKm: number;
  protectedAltKm: number;
  relativeSpeedKms: number;
  suspectGeo: { latDeg: number; lonDeg: number; altKm: number };
  protectedGeo: { latDeg: number; lonDeg: number; altKm: number };
  suspectOrbitTrack?: [number, number, number][];
  protectedOrbitTrack?: [number, number, number][];
  ommEpochUsed: string;
}

export interface ReplayMilestone {
  id: string;
  timestampUtc: string;
  label: string;
  category: 'maneuver' | 'specola_early_warning' | 'closest_approach' | 'media_report' | 'departure';
  distanceKm: number;
  detail: string;
  sourceUrl?: string;
}

export interface ReplayBacktestMarker {
  id: string;
  tier: 'WATCH' | 'WARNING' | 'ALERT' | 'reported';
  timestampUtc: string;
  label: string;
  detail: string;
  distanceKm?: number;
  sourceUrl?: string;
}

export interface ReplayDataset {
  pair: [number, number];
  suspectName: string;
  protectedName: string;
  fromUtc: string;
  toUtc: string;
  provenance: DataProvenance;
  orbitalRadarBenchmark: {
    referenceTcaUtc: string;
    referenceDistanceKm: number;
    specolaTcaUtc: string;
    specolaDistanceKm: number;
    absoluteErrorKm: number;
  };
  earlyWarningLeadDays: number;
  points: ReplayPoint[];
  milestones: ReplayMilestone[];
  backtestMarkers?: ReplayBacktestMarker[];
  backtestHeadline?: string;
}

export const ExtractedClaimSchema = z.object({
  satellite_names: z.array(z.string()),
  norad_ids: z.array(z.number()),
  claim_type: z.enum(['approach', 'maneuver', 'interference', 'other']),
  claim_text: z.string(),
  claimed_distance_km: z.number().nullable(),
  event_time: z.string().nullable(),
  source_url: z.string(),
  published_at: z.string().nullable(),
});

export type ExtractedClaimInput = z.infer<typeof ExtractedClaimSchema>;

export type ClaimOrbitVerdict =
  | 'verified'
  | 'contradicted'
  | 'unverifiable'
  | 'approach confirmed, distance below public-data resolution';

export interface ClaimProvenanceStages {
  monitor?: { label: string; timestampUtc: string } | null;
  scrape?: { endpoint: string; timestampUtc: string; latencyMs: number | null } | null;
  extract?: { model: string; timestampUtc: string; latencyMs: number | null } | null;
}

export interface VerifiedWebClaim extends ExtractedClaimInput {
  id: string;
  source_title: string;
  source_outlet: string;
  verdict: ClaimOrbitVerdict;
  verdict_reason: string;
  computed_distance_km: number | null;
  computed_plane_angle_deg: number | null;
  tle_uncertainty_km: number;
  orbit_calc_reference: string;
  evaluation_timestamp_utc?: string | null;
  suspect_omm_epoch?: string | null;
  protected_omm_epoch?: string | null;
  computation_method?: string | null;
  provenanceStages?: ClaimProvenanceStages;
}

export const BriefEvidenceSchema = z.object({
  claim: z.string(),
  source_url: z.string().nullable(),
  source_date: z.string().nullable().optional(),
  data_origin: z.string().nullable().optional(),
  orbit_calc: z.string().nullable(),
  verification_tag: z.enum(['verified', 'caveated_sub_km', 'early_warning', 'contradicted']),
});

export const DecisionBriefSchema = z.object({
  status: z.enum(['confirmed', 'unconfirmed', 'early_warning']),
  threat_level: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  title: z.string(),
  summary: z.string(),
  affected_operators: z.array(z.string()),
  evidence: z.array(BriefEvidenceSchema).min(2),
  recommended_actions: z.array(z.string()).min(2),
  who_to_notify: z.array(z.string()).min(2),
  uncertainty_statement: z.string(),
});

export type DecisionBriefPayload = z.infer<typeof DecisionBriefSchema>;

export interface StoredDecisionBrief extends DecisionBriefPayload {
  id: string;
  eventId: string;
  generatedAtUtc: string;
  modelUsed: string;
  latencyMs: number;
  isSeeded?: boolean;
  inputsHash?: string;
  cached?: boolean;
}

export interface OrbitalEventRecord {
  id: string;
  pairKey: string;
  suspectNoradId: number;
  protectedNoradId: number;
  suspectName: string;
  protectedName: string;
  suspectCountry?: string;
  protectedCountry?: string;
  orbitRegime?: string;
  title: string;
  eventType: 'rpo_campaign' | 'early_warning_maneuver' | 'geo_drift_inspection' | 'fleet_conjunction_screen';
  status: 'confirmed' | 'unconfirmed' | 'early_warning';
  threatLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  eventTimeUtc: string;
  detectedAtUtc: string;
  minDistanceKm: number;
  planeAngleDeg: number;
  estimatedDeltaVMs: number | null;
  briefId: string;
  claimsCount: number;
}

export type FeedEventKind =
  | 'elements_ingested'
  | 'maneuver_detected'
  | 'monitor_fired'
  | 'claim_extracted'
  | 'claim_verified'
  | 'brief_generated'
  | 'alert_dispatched';

export interface LiveFeedItem {
  id: string;
  timestampUtc: string;
  kind: FeedEventKind;
  headline: string;
  detail: string;
  pairKey?: string;
  severity: 'info' | 'warning' | 'critical';
  sourceOrCalc?: string;
}

export interface ContextApiCallRecord {
  id: string;
  timestampUtc: string;
  endpoint: string;
  queryOrTarget: string;
  httpStatus: number;
  latencyMs: number;
  creditsUsed: number;
  cached: boolean;
  executionMode: 'live-context-api' | 'seeded-corpus-fallback';
}

export interface ContextMonitorItem {
  id: string;
  name: string;
  targetType: 'url' | 'search_query';
  target: string;
  cadence: string;
  webhookPath: string;
  status: 'active_live' | 'failed_remote' | 'ready_awaiting_api_key';
  lastCheckedUtc: string;
  lastChangeAtUtc?: string | null;
  lastError?: string | null;
}

export interface OperatorBrandProfile {
  name: string;
  domain: string;
  country: string;
  sector: string;
  summary: string;
  primaryColor: string;
  provenance: 'context-brand-api' | 'verified-operator-profile';
}

export interface FleetSubscription {
  id: string;
  label: string;
  noradIds: number[];
  notifyChannel: string;
  createdAtUtc: string;
  closestSuspectSummary: string;
  min72hDistanceKm: number;
}

export interface AlertDeliveryRecord {
  id: string;
  dedupKey: string;
  subscriptionId: string;
  eventId: string;
  pairKey: string;
  threatLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  channel: string;
  channelType: 'slack' | 'discord' | 'webhook' | 'email';
  deliveryStatus: 'delivered' | 'deduplicated' | 'logged-no-smtp' | 'failed';
  sentAtUtc: string;
  summary: string;
  eventUrl: string;
}

export interface ScreeningRunRecord {
  id: string;
  executedAtUtc: string;
  workersCount: number;
  pairsScreened: number;
  durationMs: number;
}

export interface SuspectProfile {
  noradId: number;
  name: string;
  country: string;
  operator: string;
  orbitRegime: string;
  notes?: string;
  epochUtc: string;
  altKm: number;
  maneuversCount: number;
  approachBurnsCount: number;
  maxDeltaVMs: number;
  closestCurrentPair: {
    protectedNoradId: number;
    protectedName: string;
    currentDistanceKm: number;
    min72hKm: number;
    planeAngleDeg: number;
  } | null;
  maneuvers: ManeuverDetection[];
  linkedClaimsCount: number;
}

export interface AskSpecolaResponse {
  answer: string;
  citations: { label: string; url: string | null; kind: 'web_source' | 'sgp4_event' }[];
  caveats: string;
  modelUsed: string;
  latencyMs: number;
  scopedFleetLabel: string | null;
}

export interface ApiKeyRecord {
  id: string;
  label: string;
  keyPrefix: string;
  createdAtUtc: string;
  lastUsedUtc: string | null;
}

export interface WeeklyDigestReport {
  fleetId: string;
  fleetLabel: string;
  generatedAtUtc: string;
  periodLabel: string;
  protectedCount: number;
  threatsCount: number;
  recentBurnsCount: number;
  linkedReportsCount: number;
  highlights: string[];
  markdown: string;
}

export interface BacktestStepEvent {
  tier: 'WATCH' | 'WARNING' | 'ALERT';
  creationDateUtc: string;
  epochUtc: string;
  suspectNoradId: number;
  suspectName: string;
  protectedNoradId: number;
  protectedName: string;
  deltaVMs: number | null;
  deltaSemiMajorAxisKm: number | null;
  deltaInclinationDeg: number | null;
  residualDeltaRaanDeg: number | null;
  planeAngleDeg: number;
  instantDistanceKm: number;
  tca72hKm: number;
  tca72hUtc: string;
  closingRateKmDay: number | null;
  triggerSummary: string;
}

export interface BacktestPublicReference {
  id: string;
  label: string;
  timestampUtc: string;
  kind: 'orbit_data_baseline' | 'public_report';
  sourceUrl: string | null;
  notes: string;
}

export interface BacktestPairSummary {
  pairKey: string;
  suspectNoradId: number;
  suspectName: string;
  protectedNoradId: number;
  protectedName: string;
  watchCount: number;
  warningCount: number;
  alertCount: number;
  firstWatchUtc: string | null;
  firstWarningUtc: string | null;
  firstAlertUtc: string | null;
  matchesPublicReport: boolean;
  matchedReportLabel: string | null;
}

export interface BacktestResultPayload {
  id: string;
  ranAtUtc: string;
  windowFrom: string;
  windowTo: string;
  orderingField: 'CREATION_DATE';
  rulesVersion: string;
  cosmosIceye: {
    firstWatch: BacktestStepEvent | null;
    firstWarning: BacktestStepEvent | null;
    firstAlert: BacktestStepEvent | null;
    allFirings: BacktestStepEvent[];
    publicReferences: BacktestPublicReference[];
    earliestPublicReportUtc: string | null;
    leadTimeDaysFromWatchToFirstNews: number | null;
    leadTimeDaysFromWarningToFirstNews: number | null;
    leadTimeDaysFromAlertToFirstNews: number | null;
    headline: string;
  };
  falseAlarmSweepSepOct: {
    pairsEvaluated: number;
    ommsProcessed: number;
    totalWatch: number;
    totalWarning: number;
    totalAlert: number;
    matchedPublicEvents: number;
    unmatchedAlertPairs: number;
    byPair: BacktestPairSummary[];
  };
  falseAlarmSweepMay2026: {
    available: boolean;
    windowFrom: string;
    windowTo: string;
    suspectIds: number[];
    ommsLoaded: number;
    pairsEvaluated: number;
    totalWatch: number;
    totalWarning: number;
    totalAlert: number;
    matchedPublicEvents: number;
    byPair: BacktestPairSummary[];
    note: string;
  };
}

export interface SystemMetricsPayload {
  computedAtUtc: string;
  database: {
    engine: 'aiven-postgresql' | 'sqlite-embedded-fallback';
    connected: boolean;
    hostHint: string;
    tableStats?: {
      events: number;
      claims: number;
      briefs: number;
      contextCalls: number;
      screeningRuns: number;
      alertDeliveries?: number;
      tleElements?: number;
    };
  };
  orbitScan: {
    scheduleLabel: string;
    workersCount: number;
    pairsScreened: number;
    lastJobDurationMs: number;
    lastScanUtc: string | null;
    nextRefreshAfterUtc: string | null;
    dataAgeHours?: number | null;
  };
  briefGeneration: {
    latestLatencyMs: number | null;
    averageLatencyMs: number;
    p50LatencyMs?: number | null;
    worstLatencyMs?: number | null;
    e2eWebhookP50Ms?: number | null;
    e2eWebhookWorstMs?: number | null;
    measuredBriefsCount?: number;
    seededBriefsCount?: number;
    totalBriefsGenerated: number;
    activeModel: string;
    extractionModel?: string;
    providerMode: 'gemini-native' | 'openai-compatible-wrapper';
  };
  orbitValidation: {
    benchmarkName: string;
    referenceDistanceKm: number;
    referenceTcaUtc: string;
    specolaDistanceKm: number;
    specolaTcaUtc: string;
    deltaKm: number;
    specolaSuspectEpochUtc?: string | null;
    specolaProtectedEpochUtc?: string | null;
    specolaMethod?: string | null;
    nov13CheckDistanceKm: number | null;
    nov13PlaneAngleDeg: number | null;
    scan72hLatencyMs: number;
  };
  externalSources: {
    celestrakStatus: 'live' | 'cached_or_snapshot_fallback';
    spacetrackConfigured: boolean;
    contextDevConfigured: boolean;
    aivenConfigured: boolean;
    cacheEntriesCount: number;
  };
  catalogInventory?: {
    watchedCount: number;
    protectedCount: number;
    suspectCount: number;
    customFleetCount: number;
    pairsScreenedCount: number;
    availableActivePayloads: number;
    availableTrackedObjects: number;
  };
  autoSync?: {
    enabled: boolean;
    intervalMinutes: number;
    lastAutoSyncUtc: string | null;
    nextAutoSyncUtc: string | null;
    runsCompleted: number;
    recentRuns?: ScreeningRunRecord[];
  };
  contextDevUsage: {
    totalCalls: number;
    callsToday?: number;
    liveCalls: number;
    cachedOrFallbackCalls: number;
    totalCreditsUsed: number;
    averageLatencyMs: number;
    lastPullUtc?: string | null;
    lastSeenChangeId?: string | null;
    irrelevantSkippedCount?: number;
    recentCalls: ContextApiCallRecord[];
    monitors: ContextMonitorItem[];
    operatorProfiles: OperatorBrandProfile[];
  };
  backtestSummary?: BacktestResultPayload | null;
}

export interface HistoricalAlarmItem {
  id: string;
  timestampUtc: string;
  tier: 'ALERT' | 'WARNING' | 'WATCH' | 'MANEUVER' | 'CONTEXT' | 'REPORTED';
  headline: string;
  cause?: string;
  detail: string;
  satelliteName?: string;
  noradId?: number;
  pairKey?: string;
  eventId?: string;
  sourceUrl?: string;
}

export interface AlarmContextHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export type SatelliteIdentityCategory =
  | 'defense_inspector'
  | 'commercial_eo'
  | 'defense_comms'
  | 'science_civil'
  | 'unknown';

export interface SatelliteDossierProfile {
  noradId: number;
  name: string;
  cosparId: string;
  countryCode: string;
  countryLabel: string;
  operator: string;
  builtBy: string;
  launchedDate: string;
  launchVehicleOrSite: string;
  missionSummary: string;
  category: SatelliteIdentityCategory;
  sources: { title: string; url: string }[];
  provenance: 'context-dev-live-gemini' | 'satcat-watchlist-fallback';
  fetchedAtUtc: string;
}

export interface PairContextDossier {
  pairKey: string;
  approaching: SatelliteDossierProfile;
  protectedSat: SatelliteDossierProfile;
  identityContrastHeadline: string;
  identityContrastExplanation: string;
  isPublicInfo: boolean;
  publicInfoLabel: string;
  publicInfoDetail: string;
  earliestPublicReportUtc: string | null;
}

export interface AlarmContextResponse {
  ok: boolean;
  query: string;
  mode: 'live-context-api' | 'seeded-corpus-fallback';
  hits: AlarmContextHit[];
  matchingClaims: VerifiedWebClaim[];
  newlyVerifiedCount: number;
  claims: VerifiedWebClaim[];
  pairDossier?: PairContextDossier;
  metrics?: SystemMetricsPayload;
}

export interface HistoricalOrbitStatePayload {
  timestampUtc: string;
  provenance: DataProvenance;
  satellites: WatchedSatellite[];
  alarms: HistoricalAlarmItem[];
  note: string;
}


