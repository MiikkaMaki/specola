import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import type {
  AlarmContextResponse,
  HistoricalAlarmItem,
  OrbitalEventRecord,
  PairTelemetrySnapshot,
  StoredDecisionBrief,
  SystemMetricsPayload,
  VerifiedWebClaim,
  WatchedSatellite,
} from '../shared/types';

interface AlertContextViewProps {
  alarm: HistoricalAlarmItem;
  satellites: WatchedSatellite[];
  matchedPair: PairTelemetrySnapshot | null;
  matchedEvent: OrbitalEventRecord | null;
  matchedBrief: StoredDecisionBrief | null;
  onBack: () => void;
  onFocusOnGlobe?: (pairKey?: string) => void;
  onOpenEventDossier?: (eventId: string) => void;
  onContextSynced?: (claims: VerifiedWebClaim[], metrics?: SystemMetricsPayload) => void;
}

export function AlertContextView({
  alarm,
  satellites,
  matchedPair,
  matchedEvent,
  matchedBrief,
  onBack,
  onFocusOnGlobe,
  onOpenEventDossier,
  onContextSynced,
}: AlertContextViewProps) {
  const [ctxData, setCtxData] = useState<AlarmContextResponse | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(true);
  const [ctxError, setCtxError] = useState<string | null>(null);

  const primarySat =
    satellites.find((s) => s.noradId === alarm.noradId) ??
    (matchedPair
      ? satellites.find((s) => s.noradId === matchedPair.suspectNoradId)
      : undefined) ??
    null;

  const fetchContext = async () => {
    setLoadingCtx(true);
    setCtxError(null);
    try {
      const res = await fetch('/api/context/alarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headline: alarm.headline,
          detail: alarm.detail,
          satelliteName: alarm.satelliteName,
          noradId: alarm.noradId,
          pairKey: alarm.pairKey,
          timestampUtc: alarm.timestampUtc,
        }),
      });
      const data = (await res.json()) as AlarmContextResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setCtxData(data);
      if (onContextSynced && data.claims) {
        onContextSynced(data.claims, data.metrics);
      }
    } catch (err) {
      setCtxError(err instanceof Error ? err.message : 'Context.dev lookup failed');
    } finally {
      setLoadingCtx(false);
    }
  };

  useEffect(() => {
    void fetchContext();
  }, [alarm.id]);

  const normalizeSentence = (raw?: string | null): string => {
    const trimmed = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  };

  const formatSimpleDateTime = (isoUtc: string): string => {
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return `${isoUtc.slice(0, 16).replace('T', ' ')} UTC`;
    return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  };

  const alarmMs = new Date(alarm.timestampUtc).getTime();
  const datedHitTimes = (ctxData?.hits ?? [])
    .map((h) => (h.publishedAt ? new Date(h.publishedAt).getTime() : NaN))
    .filter((ms) => Number.isFinite(ms));
  const earliestHitMs = datedHitTimes.length > 0 ? Math.min(...datedHitTimes) : null;
  const alertedBeforeEarliestNews =
    Number.isFinite(alarmMs) && earliestHitMs !== null && earliestHitMs - alarmMs > 6 * 3600_000;

  const buildContextParagraphs = (): string[] => {
    const paragraphs: string[] = [];
    const whenPretty = formatSimpleDateTime(alarm.timestampUtc);
    const satLabel = primarySat
      ? `${primarySat.name} (#${primarySat.noradId})`
      : alarm.satelliteName
        ? `${alarm.satelliteName}${alarm.noradId ? ` (#${alarm.noradId})` : ''}`
        : alarm.headline;

    const causeClean = normalizeSentence(alarm.cause);
    const detailClean =
      alarm.detail && alarm.detail.trim() !== (alarm.cause ?? '').trim()
        ? normalizeSentence(alarm.detail)
        : '';

    const whatParts: string[] = [];
    if (matchedPair) {
      whatParts.push(
        `On ${whenPretty}, ${matchedPair.suspectName} triggered an alert because of how it is moving near ${matchedPair.protectedName}.`,
      );
    } else {
      whatParts.push(`On ${whenPretty}, Specola raised an alert for ${satLabel}.`);
    }
    if (causeClean) whatParts.push(causeClean);
    if (detailClean) whatParts.push(detailClean);

    if (matchedPair) {
      if (matchedPair.planeAngleDeg < 0.25) {
        whatParts.push(
          `Both satellites are now flying in almost the exact same path around Earth, and they are set to pass within ${matchedPair.tca72h.minDistanceKm.toFixed(1)} km of each other over the next 3 days.`,
        );
      } else {
        whatParts.push(
          `Their paths around Earth are ${matchedPair.planeAngleDeg.toFixed(1)}° apart right now, and their closest pass over the next 3 days is ${matchedPair.tca72h.minDistanceKm.toFixed(1)} km.`,
        );
      }
    }
    paragraphs.push(whatParts.join(' '));

    const pd = ctxData?.pairDossier;
    if (pd) {
      paragraphs.push(
        `Who is involved: ${pd.approaching.name} is a ${pd.approaching.countryLabel} satellite operated by ${pd.approaching.operator} (launched ${pd.approaching.launchedDate}, built by ${pd.approaching.builtBy}). Your protected satellite ${pd.protectedSat.name} is operated by ${pd.protectedSat.operator} (launched ${pd.protectedSat.launchedDate}, built by ${pd.protectedSat.builtBy}). ${pd.identityContrastExplanation}`,
      );
    }

    if (loadingCtx) {
      paragraphs.push(
        'Checking the open web with Context.dev right now to identify both spacecraft (builder, launch date, operator) and see if this approach is public info yet.',
      );
    } else if (ctxData) {
      if (ctxData.hits.length === 0) {
        paragraphs.push(
          'Is this public info yet? No — Context.dev found zero web reports linking these two satellites yet, so you are seeing this before the public.',
        );
      } else if (alertedBeforeEarliestNews && earliestHitMs !== null) {
        const alertDate = alarm.timestampUtc.slice(0, 10);
        const firstNewsDate = new Date(earliestHitMs).toISOString().slice(0, 10);
        const leadHit = ctxData.hits[0];
        const hitSummary = normalizeSentence(leadHit.snippet || leadHit.title);
        paragraphs.push(
          `Is this public info yet? Not when the alert fired on ${alertDate} — Context.dev found ${ctxData.hits.length} news report${ctxData.hits.length === 1 ? '' : 's'} that came out later (starting ${firstNewsDate}): ${hitSummary}`,
        );
      } else {
        const leadHit = ctxData.hits[0];
        const hitSummary = normalizeSentence(leadHit.snippet || leadHit.title);
        paragraphs.push(
          `Is this public info yet? Yes — Context.dev found ${ctxData.hits.length} public report${ctxData.hits.length === 1 ? '' : 's'} on the web about this. ${hitSummary}`,
        );
      }

      if (ctxData.matchingClaims.length > 0) {
        const supportedCount = ctxData.matchingClaims.filter(
          (c) =>
            c.verdict === 'verified' ||
            c.verdict === 'approach confirmed, distance below public-data resolution',
        ).length;
        paragraphs.push(
          `Fact check: We checked ${ctxData.matchingClaims.length} public claim${ctxData.matchingClaims.length === 1 ? '' : 's'} against the real satellite tracking data (${supportedCount} matched what the satellites actually did).`,
        );
      }
    }

    return paragraphs;
  };

  const contextParagraphs = buildContextParagraphs();

  const webStatusBadge = loadingCtx
    ? 'CHECKING IDENTITY & WEB...'
    : !ctxData
      ? 'WEB CHECK READY'
      : ctxData.hits.length === 0
        ? 'NOT PUBLIC INFO YET · 0 REPORTS'
        : alertedBeforeEarliestNews
          ? `PRIVATE FIRST · ${ctxData.hits.length} LATER WEB REPORT${ctxData.hits.length === 1 ? '' : 'S'}`
          : `PUBLIC INFO · ${ctxData.hits.length} WEB REPORT${ctxData.hits.length === 1 ? '' : 'S'}`;

  return (
    <div className="space-y-4 text-white">
      {/* Header + Clear Plain-English Event/Alert Context Text Block */}
      <section className="border border-[#262626] bg-[#0A0A0A] p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#262626] pb-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 border border-[#262626] bg-black px-2.5 py-1 text-xs text-white hover:border-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Console</span>
            </button>
            <span className="border border-white bg-white px-2 py-0.5 font-mono-tabular text-[11px] font-semibold text-black">
              {alarm.tier}
            </span>
            <span className="font-mono-tabular text-xs text-[#A3A3A3]">
              {alarm.timestampUtc.slice(0, 19).replace('T', ' ')}Z
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {alarm.pairKey && onFocusOnGlobe && (
              <button
                type="button"
                onClick={() => onFocusOnGlobe(alarm.pairKey)}
                className="border border-[#262626] bg-black px-2.5 py-1 text-xs text-white hover:border-white"
              >
                Focus Pair on Globe
              </button>
            )}
            {matchedEvent && onOpenEventDossier && (
              <button
                type="button"
                onClick={() => onOpenEventDossier(matchedEvent.id)}
                className="border border-white bg-white px-2.5 py-1 text-xs font-semibold text-black hover:bg-[#E5E5E5]"
              >
                Open 3D Event Dossier →
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
              Context.dev · Automatic Satellite Identity &amp; Public Check
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-white">
              Here is the context of this event / alert
            </h1>
            <div className="font-mono-tabular text-xs text-[#D4D4D4]">{alarm.headline}</div>
          </div>

          <span className="border border-[#404040] bg-black px-2.5 py-1 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-white">
            {webStatusBadge}
          </span>
        </div>

        {/* Clear Basic-Language Context Text Block */}
        <div className="border border-[#404040] bg-black p-4 sm:p-5 space-y-3">
          {contextParagraphs.map((para, idx) => (
            <p key={idx} className="text-sm sm:text-[15px] leading-relaxed text-[#F5F5F5]">
              {para}
            </p>
          ))}
        </div>

        {/* Automatic Two-Satellite Identity Cards (Built by, Launched, Owner) */}
        {ctxData?.pairDossier && (
          <div className="space-y-3">
            <div className="border border-white/40 bg-[#111111] p-3.5 space-y-1">
              <div className="font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-white">
                Identity &amp; Threat Contrast · {ctxData.pairDossier.publicInfoLabel}
              </div>
              <div className="text-sm font-semibold text-white">
                {ctxData.pairDossier.identityContrastHeadline}
              </div>
              <p className="text-xs leading-relaxed text-[#D4D4D4]">
                {ctxData.pairDossier.identityContrastExplanation}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[
                {
                  badge: 'APPROACHING SATELLITE',
                  sat: ctxData.pairDossier.approaching,
                  highlight: true,
                },
                {
                  badge: 'YOUR / PROTECTED SATELLITE',
                  sat: ctxData.pairDossier.protectedSat,
                  highlight: false,
                },
              ].map(({ badge, sat, highlight }) => (
                <div
                  key={`${badge}-${sat.noradId}`}
                  className={`border p-4 space-y-2.5 ${
                    highlight ? 'border-white/50 bg-[#0D0D0D]' : 'border-[#262626] bg-black'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 border-b border-[#1F1F1F] pb-2">
                    <span className="font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                      {badge}
                    </span>
                    <span className="border border-[#404040] px-1.5 py-0.5 font-mono-tabular text-[10px] text-white">
                      {sat.countryLabel}
                    </span>
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-white">
                      {sat.name}{' '}
                      <span className="font-mono-tabular text-xs font-normal text-[#A3A3A3]">
                        (#{sat.noradId}{sat.cosparId ? ` · ${sat.cosparId}` : ''})
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="font-mono-tabular text-[10px] text-[#737373]">OWNER / OPERATOR</div>
                      <div className="text-white">{sat.operator}</div>
                    </div>
                    <div>
                      <div className="font-mono-tabular text-[10px] text-[#737373]">BUILT BY</div>
                      <div className="text-white">{sat.builtBy}</div>
                    </div>
                    <div>
                      <div className="font-mono-tabular text-[10px] text-[#737373]">LAUNCHED</div>
                      <div className="font-mono-tabular text-white">{sat.launchedDate}</div>
                    </div>
                    <div>
                      <div className="font-mono-tabular text-[10px] text-[#737373]">VEHICLE / SITE</div>
                      <div className="text-[#D4D4D4]">{sat.launchVehicleOrSite}</div>
                    </div>
                  </div>

                  <p className="text-xs leading-relaxed text-[#D4D4D4]">{sat.missionSummary}</p>

                  {sat.sources.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1 border-t border-[#1A1A1A]">
                      {sat.sources.slice(0, 2).map((src, sIdx) => (
                        <a
                          key={`${sat.noradId}-src-${sIdx}`}
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono-tabular text-[10px] text-[#A3A3A3] underline hover:text-white"
                        >
                          <span className="truncate max-w-[200px]">{src.title}</span>
                          <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* What Context.dev Contributes */}
        <div className="border border-[#262626] bg-[#111111] p-3.5 sm:p-4 space-y-1">
          <div className="font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
            Why Context.dev is here
          </div>
          <p className="text-xs sm:text-[13px] leading-relaxed text-[#E5E5E5]">
            <strong className="text-white">Orbit tracking only sees two dots getting close — Context.dev tells you whose satellite it is and whether it is public info.</strong>{' '}
            When two satellites converge, it makes an enormous difference whether the approaching object is a Russian defense inspector or another European commercial smallsat. Context.dev automatically fetches who owns and built both spacecraft, when each launched, and whether anyone on the open web has reported it yet.
          </p>
        </div>
      </section>

      {/* Orbital Snapshot */}
      {(primarySat || matchedPair) && (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {primarySat && (
            <div className="border border-[#262626] bg-[#0A0A0A] p-4 space-y-2">
              <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                Spacecraft Telemetry ({primarySat.name} · #{primarySat.noradId})
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono-tabular text-xs">
                <div>
                  <div className="text-[10px] text-[#737373]">Country / Regime</div>
                  <div className="text-white">
                    {primarySat.country} · {primarySat.orbitRegime}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[#737373]">Alt / Speed</div>
                  <div className="text-white">
                    {primarySat.positionGeodetic.altKm.toFixed(1)} km ·{' '}
                    {primarySat.positionGeodetic.speedKms.toFixed(2)} km/s
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[#737373]">Inclination</div>
                  <div className="text-white">{Number(primarySat.omm.INCLINATION).toFixed(4)}°</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#737373]">Mean Motion</div>
                  <div className="text-white">
                    {Number(primarySat.omm.MEAN_MOTION).toFixed(6)} rev/day
                  </div>
                </div>
              </div>
            </div>
          )}

          {matchedPair && (
            <div className="border border-[#262626] bg-[#0A0A0A] p-4 space-y-2">
              <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                Pair Screening ({matchedPair.suspectName} ↔ {matchedPair.protectedName})
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono-tabular text-xs">
                <div>
                  <div className="text-[10px] text-[#737373]">Current Range</div>
                  <div className="text-white">{matchedPair.currentDistanceKm.toFixed(1)} km</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#737373]">72h Predicted TCA</div>
                  <div className="text-white">{matchedPair.tca72h.minDistanceKm.toFixed(2)} km</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#737373]">Plane Angle Δθ</div>
                  <div className="text-white">{matchedPair.planeAngleDeg.toFixed(3)}°</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#737373]">Plane Regime</div>
                  <div className="text-white uppercase">
                    {matchedPair.coplanarClassification.replace(/_/g, ' ')}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Context.dev Dedicated Intelligence Section */}
      <section className="border border-[#262626] bg-[#0A0A0A] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#262626] pb-2.5">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
              Context.dev Web Check &amp; Sources
            </h2>
            {ctxData && (
              <p className="mt-0.5 font-mono-tabular text-[10px] text-[#737373]">
                Query: {ctxData.query} ·{' '}
                {ctxData.mode === 'live-context-api' ? 'CONTEXT.DEV LIVE' : 'VERIFIED ARCHIVE'}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void fetchContext()}
            disabled={loadingCtx}
            className="inline-flex items-center gap-1.5 border border-[#262626] bg-black px-2.5 py-1 font-mono-tabular text-[11px] text-white hover:border-white disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loadingCtx ? 'animate-spin' : ''}`} />
            <span>{loadingCtx ? 'Searching...' : 'Refresh Context.dev'}</span>
          </button>
        </div>

        {loadingCtx ? (
          <div className="border border-[#262626] bg-black p-4 font-mono-tabular text-xs text-[#A3A3A3]">
            Searching the web with Context.dev to check if anyone has reported this yet...
          </div>
        ) : ctxError ? (
          <div className="border border-[#262626] bg-black p-4 font-mono-tabular text-xs text-white">
            Context.dev error: {ctxError}
          </div>
        ) : !ctxData || (ctxData.hits.length === 0 && ctxData.matchingClaims.length === 0) ? (
          <div className="border border-[#262626] bg-black p-4 text-xs text-[#D4D4D4]">
            Nobody on the web has reported this yet. The orbit engine caught this satellite move
            before any public report appeared.
          </div>
        ) : (
          <div className="space-y-3">
            {ctxData.hits.length > 0 && (
              <div className="divide-y divide-[#1F1F1F] border border-[#262626] bg-black">
                {ctxData.hits.map((hit, idx) => (
                  <div key={`${alarm.id}-hit-${idx}`} className="p-3 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-xs font-semibold text-white">{hit.title}</h3>
                      {hit.url && (
                        <a
                          href={hit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 shrink-0 font-mono-tabular text-[10px] text-[#A3A3A3] underline hover:text-white"
                        >
                          <span>Source</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    {hit.publishedAt && (
                      <div className="font-mono-tabular text-[10px] text-[#737373]">
                        Published: {hit.publishedAt.slice(0, 10)}
                      </div>
                    )}
                    {hit.snippet && (
                      <p className="text-xs leading-relaxed text-[#D4D4D4]">{hit.snippet}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {ctxData.matchingClaims.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-[#737373]">
                  Orbit-Checked Public Claims ({ctxData.matchingClaims.length})
                </div>
                <div className="divide-y divide-[#1F1F1F] border border-[#262626] bg-black">
                  {ctxData.matchingClaims.map((c) => (
                    <div key={c.id} className="p-3 space-y-1 text-xs">
                      <div className="flex items-center justify-between gap-2 font-mono-tabular text-[10px]">
                        <span className="border border-white bg-white px-1.5 py-0.5 font-semibold text-black">
                          {c.verdict.toUpperCase()}
                        </span>
                        <span className="text-[#A3A3A3]">{c.source_outlet}</span>
                      </div>
                      <p className="text-white">{c.claim_text}</p>
                      <p className="font-mono-tabular text-[10px] text-[#A3A3A3]">
                        {c.verdict_reason}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
