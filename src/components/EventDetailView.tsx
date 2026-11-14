import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Copy, ExternalLink } from 'lucide-react';
import { GeminiBriefCard } from './GeminiBriefCard';
import { OrbitalGlobe } from './OrbitalGlobe';
import type {
  BacktestResultPayload,
  OrbitalEventRecord,
  PairContextDossier,
  PairTelemetrySnapshot,
  ReplayDataset,
  StoredDecisionBrief,
  SystemMetricsPayload,
  VerifiedWebClaim,
  WatchedSatellite,
} from '../shared/types';

interface CheckReportResult {
  claim: VerifiedWebClaim;
  extractionModel: string;
  scrapeLatencyMs: number | null;
  extractionLatencyMs: number;
  totalLatencyMs: number;
}

interface EventDetailViewProps {
  eventId: string;
  satellites: WatchedSatellite[];
  events: OrbitalEventRecord[];
  pairs: PairTelemetrySnapshot[];
  briefs: StoredDecisionBrief[];
  claims: VerifiedWebClaim[];
  metrics?: SystemMetricsPayload | null;
  onBack: () => void;
  onRegenerateBrief: (eventId: string, force?: boolean) => Promise<void>;
  regeneratingBrief: boolean;
  streamPreview?: string | null;
  briefError: string | null;
  onClaimChecked: (claim: VerifiedWebClaim) => void;
}

type EventSubTab = 'approach' | 'brief' | 'sources';

export function EventDetailView({
  eventId,
  satellites,
  events,
  pairs,
  briefs,
  claims,
  metrics,
  onBack,
  onRegenerateBrief,
  regeneratingBrief,
  streamPreview,
  briefError,
  onClaimChecked,
}: EventDetailViewProps) {
  const [copiedLink, setCopiedLink] = useState(false);

  const event = events.find((e) => e.id === eventId) ?? events[0] ?? null;
  const isCosmosIceye = event?.suspectNoradId === 68762 && event?.protectedNoradId === 59103;

  const [subTab, setSubTab] = useState<EventSubTab>(isCosmosIceye ? 'approach' : 'brief');

  useEffect(() => {
    setSubTab(isCosmosIceye ? 'approach' : 'brief');
  }, [eventId, isCosmosIceye]);

  // Context.dev "Check this report" URL verification state
  const [reportUrl, setReportUrl] = useState('');
  const [reportExcerpt, setReportExcerpt] = useState('');
  const [showExcerptFallback, setShowExcerptFallback] = useState(false);
  const [checkingReport, setCheckingReport] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<CheckReportResult | null>(null);

  const [fetchedBacktest, setFetchedBacktest] = useState<BacktestResultPayload | null>(null);
  const [approachDataset, setApproachDataset] = useState<ReplayDataset | null>(null);
  const [pairDossier, setPairDossier] = useState<PairContextDossier | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const backtestData = metrics?.backtestSummary ?? fetchedBacktest;

  useEffect(() => {
    if (!isCosmosIceye || metrics?.backtestSummary || fetchedBacktest) return;
    let cancelled = false;
    fetch('/api/backtest')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.backtest) {
          setFetchedBacktest(data.backtest as BacktestResultPayload);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isCosmosIceye, metrics?.backtestSummary, fetchedBacktest]);

  useEffect(() => {
    if (!event) return;
    let cancelled = false;
    setSelectedIdx(null);
    setHoveredIdx(null);
    setPairDossier(null);
    const fromIso = isCosmosIceye ? '2026-09-25T00:00:00Z' : '2026-10-15T00:00:00Z';
    const toIso = isCosmosIceye ? '2026-10-25T00:00:00Z' : '2026-11-17T00:00:00Z';
    fetch(
      `/api/replay?pair=${event.suspectNoradId},${event.protectedNoradId}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ReplayDataset | null) => {
        if (!cancelled && data?.points?.length) {
          setApproachDataset(data);
        }
      })
      .catch(() => {});

    fetch(
      `/api/context/pair-identity?pair=${event.suspectNoradId},${event.protectedNoradId}&timestampUtc=${encodeURIComponent(event.eventTimeUtc)}`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ok?: boolean; dossier?: PairContextDossier } | null) => {
        if (!cancelled && data?.dossier) {
          setPairDossier(data.dossier);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [event?.id, event?.suspectNoradId, event?.protectedNoradId, event?.eventTimeUtc, isCosmosIceye]);

  const brief =
    briefs.find((b) => b.eventId === event?.id || b.id === event?.briefId) ?? briefs[0] ?? null;
  const matchedPair =
    pairs.find(
      (p) =>
        event &&
        ((p.suspectNoradId === event.suspectNoradId && p.protectedNoradId === event.protectedNoradId) ||
          `${p.suspectNoradId}-${p.protectedNoradId}` === event.pairKey),
    ) ??
    pairs[0] ??
    null;

  const matchedClaims = claims
    .filter(
      (c) =>
        event &&
        (c.norad_ids.includes(event.suspectNoradId) ||
          c.norad_ids.includes(event.protectedNoradId)),
    )
    .sort((a, b) =>
      String(b.published_at || b.event_time || '').localeCompare(
        String(a.published_at || a.event_time || ''),
      ),
    );

  if (!event) {
    return (
      <section className="border border-[#262626] bg-[#0A0A0A] p-6 text-xs text-[#A3A3A3]">
        No orbital event matched `{eventId}`.{' '}
        <button type="button" onClick={onBack} className="underline text-white">
          Return to console
        </button>
      </section>
    );
  }

  const shareUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?event=${encodeURIComponent(event.id)}`
      : `/?event=${encodeURIComponent(event.id)}`;

  const handleCopyShareUrl = () => {
    void navigator.clipboard?.writeText(shareUrl).then(() => {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    });
  };

  const handleCheckReport = async (e: FormEvent) => {
    e.preventDefault();
    const urlClean = reportUrl.trim();
    const textClean = reportExcerpt.trim();
    if (!urlClean && !textClean) {
      setCheckError('Enter a web report URL to check against our orbits.');
      return;
    }
    setCheckingReport(true);
    setCheckError(null);
    setCheckResult(null);
    try {
      const res = await fetch('/api/fusion/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUrl: urlClean,
          claimText: textClean,
          sourceTitle: urlClean || 'Operator URL Check',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCheckError(data.error || `HTTP ${res.status} checking report`);
        return;
      }
      if (data.claim) {
        onClaimChecked(data.claim as VerifiedWebClaim);
        setCheckResult(data as CheckReportResult);
        setReportUrl('');
        setReportExcerpt('');
      }
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Network error checking report');
    } finally {
      setCheckingReport(false);
    }
  };

  const btCosmos = backtestData?.cosmosIceye ?? null;

  // Compute minimal close-approach SVG geometry
  const pts = approachDataset?.points ?? [];
  const w = 880;
  const h = 210;
  const pL = 52;
  const pR = 20;
  const pT = 22;
  const pB = 28;
  const pW = w - pL - pR;
  const pH = h - pT - pB;

  const startMs = pts.length > 0 ? new Date(pts[0].timestampUtc).getTime() : 0;
  const endMs = pts.length > 0 ? new Date(pts[pts.length - 1].timestampUtc).getTime() : 1;
  const maxKm = pts.length > 0 ? Math.max(...pts.map((p) => p.distanceKm), 50) * 1.06 : 1000;
  const toX = (iso: string) => pL + ((new Date(iso).getTime() - startMs) / Math.max(1, endMs - startMs)) * pW;
  const toY = (km: number) => pT + (1 - Math.sqrt(Math.max(0, km)) / Math.sqrt(maxKm)) * pH;

  const curvePath = pts
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${toX(pt.timestampUtc).toFixed(1)},${toY(pt.distanceKm).toFixed(1)}`)
    .join(' ');

  let minIdx = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].distanceKm < pts[minIdx].distanceKm) {
      minIdx = i;
    }
  }
  const activeIdx = hoveredIdx !== null ? hoveredIdx : selectedIdx !== null ? selectedIdx : minIdx;
  const activePoint = pts[activeIdx] ?? null;

  const jumpToIso = (targetIso: string) => {
    if (pts.length === 0) return;
    const targetMs = new Date(targetIso).getTime();
    let best = 0;
    let bestDiff = Infinity;
    pts.forEach((pt, idx) => {
      const diff = Math.abs(new Date(pt.timestampUtc).getTime() - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = idx;
      }
    });
    setSelectedIdx(best);
    setHoveredIdx(null);
  };

  const milestonesToMark = [
    btCosmos?.firstWatch ? { iso: btCosmos.firstWatch.creationDateUtc, label: 'WATCH (Oct 7)', strong: false } : null,
    btCosmos?.firstWarning ? { iso: btCosmos.firstWarning.creationDateUtc, label: 'WARNING (Oct 10)', strong: true } : null,
    btCosmos?.firstAlert ? { iso: btCosmos.firstAlert.creationDateUtc, label: 'ALERT (Oct 15)', strong: true } : null,
    btCosmos?.earliestPublicReportUtc ? { iso: btCosmos.earliestPublicReportUtc, label: 'Media (Oct 17)', strong: false } : null,
  ].filter((x): x is { iso: string; label: string; strong: boolean } => Boolean(x));

  return (
    <div className="space-y-4 text-white">
      {/* Minimal Header + Tab Switch */}
      <section className="border border-[#262626] bg-[#0A0A0A] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#262626] pb-3 no-print">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 border border-[#262626] bg-black px-2.5 py-1 text-xs text-white hover:border-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Console</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center border border-[#262626] bg-black">
              <button
                type="button"
                onClick={() => setSubTab('approach')}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  subTab === 'approach'
                    ? 'bg-white text-black font-semibold'
                    : 'text-[#A3A3A3] hover:text-white'
                }`}
              >
                Close Approach
              </button>
              <button
                type="button"
                onClick={() => setSubTab('brief')}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  subTab === 'brief'
                    ? 'bg-white text-black font-semibold'
                    : 'text-[#A3A3A3] hover:text-white'
                }`}
              >
                AI Brief
              </button>
              <button
                type="button"
                onClick={() => setSubTab('sources')}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  subTab === 'sources'
                    ? 'bg-white text-black font-semibold'
                    : 'text-[#A3A3A3] hover:text-white'
                }`}
              >
                Sources ({matchedClaims.length})
              </button>
            </div>

            <button
              type="button"
              onClick={handleCopyShareUrl}
              className="inline-flex items-center gap-1 border border-[#262626] bg-black px-2.5 py-1 text-[11px] text-white hover:border-white"
            >
              <Copy className="h-3 w-3" />
              <span>{copiedLink ? 'Copied' : 'Share'}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px]">
              <span className="border border-white bg-white px-2 py-0.5 font-semibold text-black">
                {event.threatLevel}
              </span>
              <span className="text-[#A3A3A3]">
                {event.suspectName} (#{event.suspectNoradId}) ↔ {event.protectedName} (#
                {event.protectedNoradId})
              </span>
            </div>
            <h1 className="mt-1 text-lg font-semibold tracking-tight text-white">{event.title}</h1>
          </div>

          <div className="flex flex-wrap items-center gap-4 font-mono-tabular text-xs">
            <div>
              <span className="text-[#737373]">Min Range: </span>
              <strong className="text-white">{event.minDistanceKm.toFixed(2)} km</strong>
            </div>
            <div>
              <span className="text-[#737373]">Closest UTC: </span>
              <strong className="text-white">{event.eventTimeUtc.slice(0, 16).replace('T', ' ')}Z</strong>
            </div>
            <div>
              <span className="text-[#737373]">Current: </span>
              <strong className="text-white">
                {matchedPair ? `${matchedPair.currentDistanceKm.toFixed(1)} km` : '—'}
              </strong>
            </div>
          </div>
        </div>

        {/* Automatic Context.dev Spacecraft Identification Bar */}
        {pairDossier && (
          <div className="grid grid-cols-1 gap-2.5 border-t border-[#1F1F1F] pt-3 lg:grid-cols-3 text-xs">
            <div className="border border-[#262626] bg-black p-3 space-y-1">
              <div className="font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                Context.dev · Approaching Satellite
              </div>
              <div className="font-semibold text-white">
                {pairDossier.approaching.name} · {pairDossier.approaching.countryLabel}
              </div>
              <div className="font-mono-tabular text-[11px] text-[#D4D4D4]">
                Owner: {pairDossier.approaching.operator}
              </div>
              <div className="font-mono-tabular text-[11px] text-[#A3A3A3]">
                Built by: {pairDossier.approaching.builtBy} · Launched: {pairDossier.approaching.launchedDate}
              </div>
            </div>

            <div className="border border-[#262626] bg-black p-3 space-y-1">
              <div className="font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                Context.dev · Protected Satellite
              </div>
              <div className="font-semibold text-white">
                {pairDossier.protectedSat.name} · {pairDossier.protectedSat.countryLabel}
              </div>
              <div className="font-mono-tabular text-[11px] text-[#D4D4D4]">
                Owner: {pairDossier.protectedSat.operator}
              </div>
              <div className="font-mono-tabular text-[11px] text-[#A3A3A3]">
                Built by: {pairDossier.protectedSat.builtBy} · Launched: {pairDossier.protectedSat.launchedDate}
              </div>
            </div>

            <div className="border border-white/40 bg-[#111111] p-3 space-y-1">
              <div className="font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-white">
                Why Identity Matters · {pairDossier.publicInfoLabel}
              </div>
              <p className="text-[11px] leading-relaxed text-[#D4D4D4]">
                {pairDossier.identityContrastExplanation}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* TAB 1 (Default for ICEYE Incident): 3D Approaching Satellites + Close-Approach Curve */}
      {subTab === 'approach' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* 3D Approaching View Synced to Timeline */}
            <section className="lg:col-span-7">
              <OrbitalGlobe
                satellites={satellites}
                selectedPair={matchedPair}
                replayPoint={activePoint}
                compactHeight
              />
            </section>

            {/* Clean Separation Curve + Scrubber Focused on When They Got Close */}
            <section className="lg:col-span-5 border border-[#262626] bg-[#0A0A0A] p-4 flex flex-col justify-between gap-3">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
                    When {event.suspectName} Closed In on {event.protectedName}
                  </h2>
                  {activePoint && (
                    <div className="font-mono-tabular text-xs text-white">
                      {activePoint.timestampUtc.slice(5, 16).replace('T', ' ')}Z ·{' '}
                      <strong>{activePoint.distanceKm.toFixed(1)} km</strong> · Δθ{' '}
                      {activePoint.planeAngleDeg.toFixed(3)}°
                    </div>
                  )}
                </div>

                {pts.length === 0 ? (
                  <div className="border border-[#262626] bg-black p-4 font-mono-tabular text-xs text-[#737373]">
                    Loading close-approach trajectory...
                  </div>
                ) : (
                  <div className="border border-[#262626] bg-black p-2">
                    <svg
                      viewBox={`0 0 ${w} ${h}`}
                      className="w-full h-[215px] cursor-crosshair"
                      onMouseMove={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const svgX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * w;
                        const frac = Math.min(1, Math.max(0, (svgX - pL) / pW));
                        const targetMs = startMs + frac * (endMs - startMs);
                        let bestIdx = 0;
                        let bestDiff = Infinity;
                        pts.forEach((pt, idx) => {
                          const d = Math.abs(new Date(pt.timestampUtc).getTime() - targetMs);
                          if (d < bestDiff) {
                            bestDiff = d;
                            bestIdx = idx;
                          }
                        });
                        setHoveredIdx(bestIdx);
                      }}
                      onClick={() => {
                        if (hoveredIdx !== null) {
                          setSelectedIdx(hoveredIdx);
                        }
                      }}
                      onMouseLeave={() => setHoveredIdx(null)}
                    >
                      {[0, Math.round(maxKm * 0.1), Math.round(maxKm * 0.45), Math.round(maxKm * 0.85)].map(
                        (km, idx) => {
                          const y = toY(km);
                          return (
                            <g key={`${km}-${idx}`}>
                              <line x1={pL} y1={y} x2={w - pR} y2={y} stroke="#1F1F1F" />
                              <text
                                x={pL - 6}
                                y={y + 3}
                                textAnchor="end"
                                fill="#737373"
                                fontSize="11"
                                fontFamily="JetBrains Mono"
                              >
                                {km}km
                              </text>
                            </g>
                          );
                        },
                      )}

                      {isCosmosIceye &&
                        milestonesToMark.map((mk, idx) => {
                          const x = toX(mk.iso);
                          if (x < pL || x > w - pR) return null;
                          const alignEnd = x > w - pR - 110;
                          return (
                            <g key={mk.label}>
                              <line
                                x1={x}
                                y1={pT}
                                x2={x}
                                y2={h - pB}
                                stroke={mk.strong ? '#FFFFFF' : '#737373'}
                                strokeDasharray="3 3"
                              />
                              <text
                                x={alignEnd ? x - 4 : x + 4}
                                y={pT + 12 + (idx % 2) * 14}
                                textAnchor={alignEnd ? 'end' : 'start'}
                                fill={mk.strong ? '#FFFFFF' : '#A3A3A3'}
                                fontSize="10.5"
                                fontFamily="JetBrains Mono"
                              >
                                {mk.label}
                              </text>
                            </g>
                          );
                        })}

                      <path d={curvePath} fill="none" stroke="#FFFFFF" strokeWidth="2" />

                      {activePoint && (
                        <>
                          <line
                            x1={toX(activePoint.timestampUtc)}
                            y1={pT}
                            x2={toX(activePoint.timestampUtc)}
                            y2={h - pB}
                            stroke="#737373"
                          />
                          <circle
                            cx={toX(activePoint.timestampUtc)}
                            cy={toY(activePoint.distanceKm)}
                            r="5.5"
                            fill="#FFFFFF"
                            stroke="#000000"
                            strokeWidth="2"
                          />
                        </>
                      )}

                      {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                        const pt = pts[Math.min(pts.length - 1, Math.round(frac * (pts.length - 1)))];
                        if (!pt) return null;
                        return (
                          <text
                            key={pt.timestampUtc}
                            x={toX(pt.timestampUtc)}
                            y={h - 6}
                            textAnchor="middle"
                            fill="#737373"
                            fontSize="11"
                            fontFamily="JetBrains Mono"
                          >
                            {pt.timestampUtc.slice(5, 10)}
                          </text>
                        );
                      })}
                    </svg>
                  </div>
                )}
              </div>

              {/* Time Scrubber + Phase Jump Buttons to Step the 3D Approach */}
              {pts.length > 0 && (
                <div className="space-y-2.5 border-t border-[#1F1F1F] pt-3">
                  <div className="flex items-center gap-2 font-mono-tabular text-[10px]">
                    <span className="text-[#737373] shrink-0">{pts[0].timestampUtc.slice(5, 10)}</span>
                    <input
                      type="range"
                      aria-label="Scrub 3D close approach timeline"
                      min={0}
                      max={pts.length - 1}
                      step={1}
                      value={activeIdx}
                      onChange={(e) => {
                        setSelectedIdx(Number(e.target.value));
                        setHoveredIdx(null);
                      }}
                      className="flex-1 accent-white cursor-pointer"
                    />
                    <span className="text-[#737373] shrink-0">
                      {pts[pts.length - 1].timestampUtc.slice(5, 10)}
                    </span>
                  </div>

                  {isCosmosIceye ? (
                    <div className="flex flex-wrap items-center gap-1.5 font-mono-tabular text-[10px]">
                      {[
                        { label: 'Sep 30 Raise', iso: '2026-09-30T18:00:00Z' },
                        { label: 'Oct 7 WATCH', iso: '2026-10-07T18:00:00Z' },
                        { label: 'Oct 10 WARNING', iso: '2026-10-10T12:00:00Z' },
                        { label: 'Oct 12 Brake', iso: '2026-10-13T00:00:00Z' },
                        { label: 'Oct 16 Closest', iso: pts[minIdx]?.timestampUtc ?? '2026-10-16T06:00:00Z' },
                      ].map((step) => {
                        const isNear =
                          activePoint &&
                          Math.abs(new Date(activePoint.timestampUtc).getTime() - new Date(step.iso).getTime()) <
                            6 * 3600_000;
                        return (
                          <button
                            key={step.label}
                            type="button"
                            onClick={() => jumpToIso(step.iso)}
                            className={`border px-2 py-1 transition-colors ${
                              isNear
                                ? 'border-white bg-white text-black font-semibold'
                                : 'border-[#262626] bg-black text-[#A3A3A3] hover:border-white hover:text-white'
                            }`}
                          >
                            {step.label}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between font-mono-tabular text-[10px] text-[#737373]">
                      <span>Drag slider or click curve to inspect 3D pass</span>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedIdx(minIdx);
                          setHoveredIdx(null);
                        }}
                        className="border border-white px-2 py-0.5 text-white hover:bg-white hover:text-black"
                      >
                        Jump to Closest
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>

          {/* Chronological Detection Race Timeline: Specola vs US Company vs Dutch Amateur Analyst */}
          {isCosmosIceye && (
            <section className="border border-[#262626] bg-[#0A0A0A] p-4 space-y-3">
              {!btCosmos ? (
                <div className="font-mono-tabular text-xs text-[#737373]">
                  Loading chronological detection timeline...
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1F1F1F] pb-2">
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-white">
                        Who Detected It First — Chronological Timeline (Sep 30 – Oct 19, 2026)
                      </h3>
                      <p className="mt-0.5 font-mono-tabular text-[11px] text-[#A3A3A3]">
                        {btCosmos.headline}
                      </p>
                    </div>
                    <span className="border border-white bg-white px-2 py-0.5 font-mono-tabular text-[11px] font-semibold text-black">
                      +{btCosmos.leadTimeDaysFromWatchToFirstNews?.toFixed(1) ?? '9.6'}d WATCH / +
                      {btCosmos.leadTimeDaysFromWarningToFirstNews?.toFixed(1) ?? '6.9'}d WARNING LEAD
                    </span>
                  </div>

                  {/* Proportional Visual Race Track Bar */}
                  <div className="border border-[#262626] bg-black p-3 space-y-2">
                    <div className="flex items-center justify-between font-mono-tabular text-[10px] text-[#737373]">
                      <span>SEP 30 (First Burn)</span>
                      <span>OCT 07 (Specola WATCH)</span>
                      <span>OCT 10 (Specola WARNING)</span>
                      <span>OCT 17–19 (US Co. &amp; Dutch SSA)</span>
                    </div>
                    <svg viewBox="0 0 880 44" className="w-full h-[44px]">
                      <line x1="16" y1="26" x2="864" y2="26" stroke="#262626" strokeWidth="2" />
                      {[
                        {
                          iso: btCosmos.firstWatch?.creationDateUtc ?? '2026-10-07T17:41:50Z',
                          label: 'Specola WATCH',
                          ours: true,
                        },
                        {
                          iso: btCosmos.firstWarning?.creationDateUtc ?? '2026-10-10T10:34:00Z',
                          label: 'Specola WARNING',
                          ours: true,
                        },
                        {
                          iso: btCosmos.firstAlert?.creationDateUtc ?? '2026-10-15T02:35:00Z',
                          label: 'Specola ALERT',
                          ours: true,
                        },
                        { iso: '2026-10-17T08:00:00Z', label: 'Axios/LeoLabs', ours: false },
                        { iso: '2026-10-17T14:20:00Z', label: 'Dutch SSA', ours: false },
                        { iso: '2026-10-19T16:45:00Z', label: 'LeoLabs/CNN', ours: false },
                      ].map((mk, idx) => {
                        const t0 = new Date('2026-09-30T00:00:00Z').getTime();
                        const t1 = new Date('2026-10-20T00:00:00Z').getTime();
                        const x =
                          16 +
                          Math.min(1, Math.max(0, (new Date(mk.iso).getTime() - t0) / (t1 - t0))) *
                            848;
                        const labelY = idx % 2 === 0 ? 12 : 40;
                        const anchor = x > 760 ? 'end' : x < 110 ? 'start' : 'middle';
                        return (
                          <g
                            key={mk.label}
                            onClick={() => jumpToIso(mk.iso)}
                            className="cursor-pointer"
                          >
                            <line
                              x1={x}
                              y1={16}
                              x2={x}
                              y2={34}
                              stroke={mk.ours ? '#FFFFFF' : '#737373'}
                              strokeWidth={mk.ours ? 2 : 1.25}
                            />
                            <circle
                              cx={x}
                              cy={26}
                              r={mk.ours ? 4.5 : 3.5}
                              fill={mk.ours ? '#FFFFFF' : '#000000'}
                              stroke={mk.ours ? '#000000' : '#A3A3A3'}
                              strokeWidth="1.5"
                            />
                            <text
                              x={x}
                              y={labelY}
                              textAnchor={anchor}
                              fill={mk.ours ? '#FFFFFF' : '#A3A3A3'}
                              fontSize="9.5"
                              fontWeight={mk.ours ? '700' : '400'}
                              fontFamily="JetBrains Mono"
                            >
                              {mk.label}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>

                  {/* Step-by-Step Comparison Rows */}
                  <div className="divide-y divide-[#1F1F1F] border border-[#262626] bg-black">
                    {[
                      btCosmos.firstWatch && {
                        id: 'tl-watch',
                        dateUtc: btCosmos.firstWatch.creationDateUtc,
                        actor: 'SPECOLA (Autonomous Watch)',
                        badge: `WATCH · ${btCosmos.leadTimeDaysFromWatchToFirstNews?.toFixed(1)}d BEFORE MEDIA`,
                        ours: true,
                        detail: `First automated orbital alert: Δv ${btCosmos.firstWatch.deltaVMs?.toFixed(2)} m/s inclination trim (Δi +0.0302°) cut 72h TCA while still ${btCosmos.firstWatch.instantDistanceKm.toFixed(0)} km apart.`,
                        jumpIso: btCosmos.firstWatch.creationDateUtc,
                        url: null as string | null,
                      },
                      btCosmos.firstWarning && {
                        id: 'tl-warning',
                        dateUtc: btCosmos.firstWarning.creationDateUtc,
                        actor: 'SPECOLA (Coplanar Rule)',
                        badge: `WARNING · ${btCosmos.leadTimeDaysFromWarningToFirstNews?.toFixed(1)}d BEFORE MEDIA`,
                        ours: true,
                        detail: `Coplanar plane lock (Δθ ${btCosmos.firstWarning.planeAngleDeg.toFixed(3)}° < 0.05°${btCosmos.firstWarning.closingRateKmDay !== null ? `, closing ${btCosmos.firstWarning.closingRateKmDay.toFixed(0)} km/d` : ''}) showed both planes converged—warning operators to watch for a braking burn (which arrived Oct 12).`,
                        jumpIso: btCosmos.firstWarning.creationDateUtc,
                        url: null as string | null,
                      },
                      btCosmos.firstAlert && {
                        id: 'tl-alert',
                        dateUtc: btCosmos.firstAlert.creationDateUtc,
                        actor: 'SPECOLA (72h TCA Rule)',
                        badge: `ALERT · ${btCosmos.leadTimeDaysFromAlertToFirstNews?.toFixed(1)}d BEFORE MEDIA`,
                        ours: true,
                        detail: `Predicted 72h closest approach dropped below 50 km (${btCosmos.firstAlert.tca72hKm.toFixed(2)} km) over 24 hours before physical closest pass.`,
                        jumpIso: btCosmos.firstAlert.creationDateUtc,
                        url: null as string | null,
                      },
                      {
                        id: 'tl-tca',
                        dateUtc: '2026-10-16T07:28:00Z',
                        actor: 'CLOSEST PASS (TCA)',
                        badge: '4.54 km GP / ~300 m Radar',
                        ours: false,
                        detail: 'Physical closest approach between COSMOS 2612 and ICEYE-X36 in sun-synchronous LEO.',
                        jumpIso: '2026-10-16T07:28:00Z',
                        url: null as string | null,
                      },
                      {
                        id: 'tl-axios',
                        dateUtc: '2026-10-17T08:00:00Z',
                        actor: 'US PRESS & US RADAR CO. (Axios citing LeoLabs)',
                        badge: '+6.9d AFTER SPECOLA WARNING',
                        ours: false,
                        detail: 'First public disclosure: Axios breaks the story citing LeoLabs tracking data (~1 day after closest pass; private customer warnings are unverified).',
                        jumpIso: '2026-10-17T08:00:00Z',
                        url: 'https://www.axios.com/2026/10/17/russia-ukraine-satellite-space',
                      },
                      {
                        id: 'tl-dutch',
                        dateUtc: '2026-10-17T14:20:00Z',
                        actor: 'DUTCH AMATEUR SSA (Dr. Marco Langbroek · SatTrackCam)',
                        badge: '+7.1d AFTER SPECOLA WARNING',
                        ours: false,
                        detail: 'First independent OSINT / amateur orbital analysis reconstructing the Sep 30 – Oct 16 cat-and-mouse trajectory.',
                        jumpIso: '2026-10-17T14:20:00Z',
                        url: 'https://sattrackcam.blogspot.com/2026/10/kosmos-2612-and-iceye-x36-worrisome-cat.html',
                      },
                      {
                        id: 'tl-cnn',
                        dateUtc: '2026-10-19T16:45:00Z',
                        actor: 'US RADAR CO. PUBLIC STATEMENT (LeoLabs on CNN)',
                        badge: '+9.3d AFTER SPECOLA WARNING',
                        ours: false,
                        detail: 'LeoLabs issues public tracking confirmation & CNN broadcast advisory three days after TCA.',
                        jumpIso: '2026-10-19T16:45:00Z',
                        url: 'https://www.cnn.com/2026/10/19/science/russian-satellite-iceye-x36-approach',
                      },
                    ]
                      .filter((x): x is NonNullable<typeof x> => Boolean(x))
                      .map((row) => (
                        <div
                          key={row.id}
                          className={`flex flex-col gap-1.5 p-3 sm:flex-row sm:items-center sm:justify-between ${
                            row.ours ? 'border-l-2 border-l-white bg-[#0F0F0F]' : ''
                          }`}
                        >
                          <div className="space-y-0.5 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px]">
                              <span className="text-white font-semibold">
                                {row.dateUtc.slice(5, 16).replace('T', ' ')}Z
                              </span>
                              <span
                                className={`px-1.5 py-0.5 text-[10px] font-semibold ${
                                  row.ours
                                    ? 'bg-white text-black'
                                    : 'border border-[#333333] text-[#A3A3A3]'
                                }`}
                              >
                                {row.badge}
                              </span>
                              <span className={row.ours ? 'text-white font-semibold' : 'text-[#D4D4D4]'}>
                                {row.actor}
                              </span>
                            </div>
                            <p className="text-xs text-[#A3A3A3] leading-snug">{row.detail}</p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0 font-mono-tabular text-[10px]">
                            <button
                              type="button"
                              onClick={() => jumpToIso(row.jumpIso)}
                              className="border border-[#262626] bg-black px-2 py-1 text-white hover:border-white"
                            >
                              View 3D
                            </button>
                            {row.url && (
                              <a
                                href={row.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 border border-[#262626] bg-black px-2 py-1 text-[#A3A3A3] hover:border-white hover:text-white"
                              >
                                <span>Source</span>
                                <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </>
              )}

              <div className="border border-[#262626] bg-black p-3 space-y-1.5">
                <div className="font-mono-tabular text-[11px] font-semibold uppercase text-white">
                  Could Specola really know from tiny Δa / +0.03° burns before Oct 12? (What was certain vs uncertain)
                </div>
                <p className="text-xs leading-relaxed text-[#D4D4D4]">
                  <strong className="text-white">Why small numbers are physically huge in LEO:</strong> On{' '}
                  <strong className="text-white">Sep 30</strong>, a{' '}
                  <span className="font-mono-tabular text-white">+46.52 km</span> raise shifts Earth&apos;s{' '}
                  <strong className="text-white">J2 nodal precession</strong> rate so COSMOS 2612&apos;s RAAN walks horizontally into ICEYE-X36&apos;s plane while pacing ~55.8°/day slower. On{' '}
                  <strong className="text-white">Oct 7</strong>, an inclination shift of just{' '}
                  <span className="font-mono-tabular text-white">+0.0302°</span> may sound tiny—but at ~6,900 km orbit radius, <span className="font-mono-tabular text-white">6,900 × sin(0.0302°) ≈ 3.64 km</span> of cross-track correction (~4 m/s burn), specifically aligning toward ICEYE-X36&apos;s 97.90° inclination.
                </p>
                <p className="text-xs leading-relaxed text-[#A3A3A3]">
                  <strong className="text-white">Epistemic honesty:</strong> On <strong className="text-white">Oct 7 (WATCH)</strong> and{' '}
                  <strong className="text-white">Oct 10 (WARNING, Δθ = 0.045°)</strong>, Specola could <em>not</em> yet prove a close pass would occur—COSMOS 2612 could still have kept drifting past. What those stages objectively proved was that COSMOS 2612 had aligned into the exact ~6 km-wide orbital corridor of ICEYE-X36 and was closing inbound, warranting active watch until the <strong className="text-white">Oct 12</strong> braking burn (<span className="font-mono-tabular text-white">Δa -47.83 km</span>) confirmed station-keeping.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="border border-[#262626] bg-black p-3 space-y-1">
                  <div className="font-mono-tabular text-[11px] font-semibold uppercase text-white">
                    When did ICEYE know?
                  </div>
                  <p className="text-xs leading-relaxed text-[#D4D4D4]">
                    <strong className="text-white">Exact internal hour is not public.</strong> ICEYE responded reactively to press on Oct 17–20 (<em>&ldquo;We are aware of the situation and tracking it closely&rdquo;</em>). Active operators receive private 18th SDS Conjunction Data Messages (CDMs) or commercial radar (LeoLabs) alerts ~3–7 days before TCA, plus hold live GNSS ephemeris for ICEYE-X36.
                  </p>
                </div>

                <div className="border border-[#262626] bg-black p-3 space-y-1">
                  <div className="font-mono-tabular text-[11px] font-semibold uppercase text-white">
                    Would Specola have known before ICEYE?
                  </div>
                  <p className="text-xs leading-relaxed text-[#D4D4D4]">
                    <strong className="text-white">Before routine safety CDMs (Oct 7–10): Likely yes</strong> — standard &lt; 5 km CDMs ignore objects 9,600 km apart, whereas Specola flags coplanar stalking (Δθ &lt; 0.05°) on <strong className="text-white">Oct 10</strong>.{' '}
                    <strong className="text-white">For Oct 15–16 &amp; vs US 18th SDS: No</strong> — 18th SDS distributes private SP CDMs to operators before public Space-Track GP feeds publish.
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {/* TAB 2: Grounded AI Decision Brief */}
      {subTab === 'brief' && (
        <GeminiBriefCard
          event={event}
          brief={brief}
          onRegenerateBrief={onRegenerateBrief}
          regeneratingBrief={regeneratingBrief}
          streamPreview={streamPreview}
          briefError={briefError}
        />
      )}

      {/* TAB 3: Context.dev URL Verification & Verified Web Sources */}
      {subTab === 'sources' && (
        <section className="border border-[#262626] bg-[#0A0A0A] p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-[#262626] pb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
              Verified Web Sources ({matchedClaims.length})
            </h2>
            <span className="font-mono-tabular text-[10px] text-[#737373]">
              Context.dev → SGP4 Cross-Check
            </span>
          </div>

          <form onSubmit={handleCheckReport} className="border border-[#262626] bg-black p-3 space-y-2 no-print">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="check-report-url" className="text-xs font-medium text-white">
                Check any report URL against orbits
              </label>
              <button
                type="button"
                onClick={() => setShowExcerptFallback((v) => !v)}
                className="font-mono-tabular text-[10px] text-[#737373] underline hover:text-white"
              >
                {showExcerptFallback ? 'Hide text' : '+ Paste excerpt'}
              </button>
            </div>
            <div className="flex gap-2">
              <input
                id="check-report-url"
                type="url"
                value={reportUrl}
                onChange={(e) => setReportUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 border border-[#262626] bg-[#0A0A0A] px-2.5 py-1.5 font-mono-tabular text-xs text-white placeholder:text-[#525252] focus:border-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={checkingReport}
                className="border border-white bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-[#E5E5E5] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {checkingReport ? 'Checking...' : 'Check'}
              </button>
            </div>

            {showExcerptFallback && (
              <textarea
                rows={2}
                value={reportExcerpt}
                onChange={(e) => setReportExcerpt(e.target.value)}
                placeholder="Optional report excerpt..."
                className="w-full border border-[#262626] bg-[#0A0A0A] px-2.5 py-1.5 text-xs text-white placeholder:text-[#525252] focus:border-white focus:outline-none"
              />
            )}

            {checkError && (
              <div className="border border-white bg-[#0A0A0A] p-2 text-xs text-white">
                {checkError}
              </div>
            )}

            {checkResult && (
              <div className="border border-white bg-[#0A0A0A] p-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-[11px]">
                  <span className="border border-white bg-white px-1.5 py-0.5 font-semibold uppercase text-black">
                    {checkResult.claim.verdict}
                  </span>
                  <span className="text-[#A3A3A3]">
                    {checkResult.totalLatencyMs} ms · {checkResult.extractionModel}
                  </span>
                </div>
                <p className="text-xs text-white leading-snug">{checkResult.claim.verdict_reason}</p>
                <div className="font-mono-tabular text-[10px] text-[#737373]">
                  SGP4:{' '}
                  <span className="text-white">
                    {checkResult.claim.computed_distance_km !== null
                      ? `${checkResult.claim.computed_distance_km} km`
                      : 'unresolved'}
                  </span>{' '}
                  @{' '}
                  {checkResult.claim.evaluation_timestamp_utc
                    ? checkResult.claim.evaluation_timestamp_utc.slice(0, 19) + 'Z'
                    : 'unspecified'}
                </div>
              </div>
            )}
          </form>

          {matchedClaims.length === 0 ? (
            <div className="border border-[#262626] bg-black p-3 text-xs text-[#737373]">
              No web sources linked to this orbital pair yet.
            </div>
          ) : (
            <div className="divide-y divide-[#1F1F1F] border border-[#262626] bg-black">
              {matchedClaims.map((c) => {
                const ts = c.published_at || c.event_time || '';
                return (
                  <div key={c.id} className="p-3 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-[10px]">
                      <span className="border border-white px-1.5 py-0.5 font-semibold uppercase text-white">
                        {c.verdict}
                      </span>
                      <span className="text-[#737373]">
                        {c.source_outlet}
                        {ts ? ` · ${ts.slice(0, 16)}Z` : ''}
                      </span>
                    </div>

                    <a
                      href={c.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-white underline hover:text-[#A3A3A3]"
                    >
                      <span>{c.source_title}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>

                    <p className="text-xs text-[#D4D4D4] leading-snug">{c.claim_text}</p>
                    <div className="font-mono-tabular text-[10px] text-[#737373]">
                      {c.orbit_calc_reference}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
