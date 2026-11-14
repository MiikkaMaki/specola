import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { ReplayDataset, ReplayPoint } from '../shared/types';

export interface ReplayCampaignOption {
  pairKey: string;
  suspectId: number;
  protectedId: number;
  tag: string;
  label: string;
  fromIso: string;
  toIso: string;
}

export const REPLAY_CAMPAIGN_OPTIONS: ReplayCampaignOption[] = [
  {
    pairKey: '68762-59103',
    suspectId: 68762,
    protectedId: 59103,
    tag: 'RU·LEO',
    label: 'COSMOS 2612 ↔ ICEYE-X36',
    fromIso: '2026-09-25T00:00:00Z',
    toIso: '2026-10-25T00:00:00Z',
  },
  {
    pairKey: '41838-54225',
    suspectId: 41838,
    protectedId: 54225,
    tag: 'CN·GEO',
    label: 'SHIJIAN-17 ↔ HOTBIRD 13G',
    fromIso: '2026-08-15T00:00:00Z',
    toIso: '2026-11-17T00:00:00Z',
  },
  {
    pairKey: '55841-35943',
    suspectId: 55841,
    protectedId: 35943,
    tag: 'RU·GEO',
    label: 'LUCH-2 ↔ COMSATBW-1',
    fromIso: '2026-08-15T00:00:00Z',
    toIso: '2026-11-17T00:00:00Z',
  },
  {
    pairKey: '64199-59103',
    suspectId: 64199,
    protectedId: 59103,
    tag: 'CN·LEO',
    label: 'SHIJIAN-26 ↔ ICEYE-X36',
    fromIso: '2026-10-15T00:00:00Z',
    toIso: '2026-11-17T00:00:00Z',
  },
];

interface ReplayTimelineProps {
  dataset: ReplayDataset | null;
  activeIndex: number;
  onChangeIndex: (index: number) => void;
  selectedPairKey: string;
  loadingReplay: boolean;
  onSelectCampaign: (
    suspectId: number,
    protectedId: number,
    fromIso: string,
    toIso: string,
  ) => Promise<void>;
}

export function ReplayTimeline({
  dataset,
  activeIndex,
  onChangeIndex,
  selectedPairKey,
  loadingReplay,
  onSelectCampaign,
}: ReplayTimelineProps) {
  const [showProvenance, setShowProvenance] = useState(false);
  const [expandedMilestoneId, setExpandedMilestoneId] = useState<string | null>(null);

  if (!dataset || dataset.points.length === 0) {
    return (
      <div className="border border-[#262626] bg-[#0A0A0A] p-5 text-xs text-[#A3A3A3]">
        Loading SGP4 historical campaign telemetry...
      </div>
    );
  }

  const clampedIndex = Math.min(Math.max(0, activeIndex), dataset.points.length - 1);
  const currentPoint: ReplayPoint = dataset.points[clampedIndex];
  const isCosmosCampaign =
    dataset.pair[0] === 68762 && dataset.pair[1] === 59103;

  const width = 940;
  const height = 250;
  const padLeft = 58;
  const padRight = 24;
  const padTop = 22;
  const padBottom = 32;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const startMs = new Date(dataset.points[0].timestampUtc).getTime();
  const endMs = new Date(dataset.points[dataset.points.length - 1].timestampUtc).getTime();
  const rawMax = Math.max(...dataset.points.map((p) => p.distanceKm), 50);
  const maxDist = rawMax * 1.06;

  const timeToX = (iso: string) => {
    const t = new Date(iso).getTime();
    return padLeft + ((t - startMs) / Math.max(1, endMs - startMs)) * plotW;
  };
  const distToY = (distKm: number) => {
    const norm = Math.sqrt(Math.max(0, distKm)) / Math.sqrt(maxDist);
    return padTop + (1 - norm) * plotH;
  };

  const pathD = dataset.points
    .map((pt, idx) => {
      const x = timeToX(pt.timestampUtc);
      const y = distToY(pt.distanceKm);
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const activeX = timeToX(currentPoint.timestampUtc);
  const activeY = distToY(currentPoint.distanceKm);

  const yGridTicks = [
    0,
    Math.round(maxDist * 0.04),
    Math.round(maxDist * 0.16),
    Math.round(maxDist * 0.45),
    Math.round(maxDist * 0.85),
  ];

  const xTickIndices = [0, 0.2, 0.4, 0.6, 0.8, 1].map((frac) =>
    Math.min(dataset.points.length - 1, Math.round(frac * (dataset.points.length - 1))),
  );

  const jumpToTimestamp = (iso: string) => {
    const targetMs = new Date(iso).getTime();
    let bestIdx = 0;
    let bestDiff = Infinity;
    dataset.points.forEach((p, idx) => {
      const diff = Math.abs(new Date(p.timestampUtc).getTime() - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = idx;
      }
    });
    onChangeIndex(bestIdx);
  };

  const markers = dataset.backtestMarkers ?? [];
  const earliestSpecola = markers.find((m) => m.tier !== 'reported');
  const earliestReported = markers.find((m) => m.tier === 'reported');
  const leadStartX = earliestSpecola ? timeToX(earliestSpecola.timestampUtc) : null;
  const leadEndX = earliestReported ? timeToX(earliestReported.timestampUtc) : null;

  return (
    <section className="border border-[#262626] bg-[#0A0A0A] p-4 text-white">
      {/* Campaign Selector (EU vs RU & CN) */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#262626] pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {REPLAY_CAMPAIGN_OPTIONS.map((camp) => {
            const active = selectedPairKey === camp.pairKey || `${dataset.pair[0]}-${dataset.pair[1]}` === camp.pairKey;
            return (
              <button
                key={camp.pairKey}
                type="button"
                disabled={loadingReplay}
                onClick={() => {
                  void onSelectCampaign(camp.suspectId, camp.protectedId, camp.fromIso, camp.toIso);
                }}
                className={`border px-2.5 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'border-white bg-white text-black font-semibold'
                    : 'border-[#262626] bg-black text-[#A3A3A3] hover:border-[#737373] hover:text-white'
                }`}
              >
                <span className="font-mono-tabular mr-1.5 text-[10px]">[{camp.tag}]</span>
                <span>{camp.label}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setShowProvenance((v) => !v)}
          className="border border-[#262626] bg-black px-2.5 py-1.5 font-mono-tabular text-[11px] text-[#A3A3A3] hover:border-white hover:text-white whitespace-nowrap shrink-0"
        >
          {showProvenance ? '− Hide Provenance' : '+ Epoch Provenance'}
        </button>
      </div>

      {/* Expandable Data Provenance Drawer */}
      {showProvenance && (
        <div className="mt-3 border border-[#262626] bg-black p-3 font-mono-tabular text-[11px] text-[#A3A3A3] grid grid-cols-1 gap-2 md:grid-cols-3">
          <div>
            <span className="text-[#737373]">Pair: </span>
            <span className="text-white">
              {dataset.suspectName} (#{dataset.pair[0]}) ↔ {dataset.protectedName} (#{dataset.pair[1]})
            </span>
          </div>
          <div>
            <span className="text-[#737373]">GP Origin: </span>
            <span className="text-white">{dataset.provenance}</span>
            <span className="text-[#737373]"> · Active OMM Epoch: </span>
            <span className="text-white">{currentPoint.ommEpochUsed.slice(0, 16).replace('T', ' ')}Z</span>
          </div>
          <div>
            <span className="text-[#737373]">Min TCA: </span>
            <span className="text-white">
              {dataset.orbitalRadarBenchmark.specolaDistanceKm.toFixed(2)} km @{' '}
              {dataset.orbitalRadarBenchmark.specolaTcaUtc.slice(0, 16).replace('T', ' ')}Z
            </span>
            {isCosmosCampaign && (
              <span className="text-[#737373]">
                {' '}
                (Orbital Radar ref: {dataset.orbitalRadarBenchmark.referenceDistanceKm} km)
              </span>
            )}
          </div>
        </div>
      )}

      {/* Computed Zero-Lookahead Blind Backtest Headline */}
      {isCosmosCampaign && dataset.backtestHeadline && (
        <div className="mt-3 border border-white bg-black px-3.5 py-2 font-mono-tabular text-xs text-white">
          <span className="font-semibold">{dataset.backtestHeadline}</span>
          <span className="ml-2 text-[#737373]">(Zero look-ahead · CREATION_DATE order)</span>
        </div>
      )}

      {/* Static Readout Bar (updates on graph click/hover or milestone selection) */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border border-[#262626] bg-black px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-6 font-mono-tabular text-xs">
          <div>
            <span className="text-[#737373] mr-1.5">UTC</span>
            <span className="font-semibold text-white">
              {currentPoint.timestampUtc.slice(0, 16).replace('T', ' ')}Z
            </span>
          </div>
          <div>
            <span className="text-[#737373] mr-1.5">Range</span>
            <span className="font-semibold text-white">
              {currentPoint.distanceKm.toFixed(2)} km
            </span>
          </div>
          <div>
            <span className="text-[#737373] mr-1.5">Δθ</span>
            <span className="font-semibold text-white">
              {currentPoint.planeAngleDeg.toFixed(3)}°
            </span>
          </div>
          <div>
            <span className="text-[#737373] mr-1.5">Rel V</span>
            <span className="font-semibold text-white">
              {currentPoint.relativeSpeedKms.toFixed(2)} km/s
            </span>
          </div>
          <div>
            <span className="text-[#737373] mr-1.5">Min TCA</span>
            <span className="font-semibold text-white">
              {dataset.orbitalRadarBenchmark.specolaDistanceKm.toFixed(2)} km
            </span>
          </div>
        </div>
        <span className="font-mono-tabular text-[10px] text-[#737373]">
          Click chart to inspect point
        </span>
      </div>

      {/* Monochrome SVG Separation Curve */}
      <div className="mt-2 overflow-x-auto border border-[#262626] bg-black p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full min-w-[620px] h-[290px] cursor-crosshair"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const svgX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
            const frac = Math.min(1, Math.max(0, (svgX - padLeft) / plotW));
            const targetMs = startMs + frac * (endMs - startMs);
            let bestIdx = 0;
            let bestDiff = Infinity;
            dataset.points.forEach((pt, idx) => {
              const d = Math.abs(new Date(pt.timestampUtc).getTime() - targetMs);
              if (d < bestDiff) {
                bestDiff = d;
                bestIdx = idx;
              }
            });
            onChangeIndex(bestIdx);
          }}
        >
          {leadStartX !== null && leadEndX !== null && leadEndX > leadStartX && (
            <>
              <rect
                x={leadStartX}
                y={padTop}
                width={Math.max(4, leadEndX - leadStartX)}
                height={plotH}
                fill="rgba(255, 255, 255, 0.06)"
              />
              <text
                x={(leadStartX + leadEndX) / 2}
                y={padTop + 12}
                textAnchor="middle"
                fill="#FFFFFF"
                fontSize="9.5"
                fontFamily="JetBrains Mono"
              >
                {dataset.earlyWarningLeadDays.toFixed(1)}d Early Warning Lead
              </text>
            </>
          )}

          {markers.map((mk, idx) => {
            const x = timeToX(mk.timestampUtc);
            if (x < padLeft || x > width - padRight) return null;
            const yOffset = padTop + 26 + (idx % 3) * 14;
            const isRightEdge = x > width - padRight - 130;
            return (
              <g key={mk.id}>
                <line
                  x1={x}
                  y1={padTop}
                  x2={x}
                  y2={height - padBottom}
                  stroke={mk.tier === 'reported' ? '#737373' : '#FFFFFF'}
                  strokeWidth={mk.tier === 'WARNING' || mk.tier === 'ALERT' ? '1.3' : '1'}
                  strokeDasharray={mk.tier === 'reported' ? '2 3' : '4 3'}
                />
                <text
                  x={isRightEdge ? x - 4 : x + 4}
                  y={yOffset}
                  textAnchor={isRightEdge ? 'end' : 'start'}
                  fill={mk.tier === 'reported' ? '#A3A3A3' : '#FFFFFF'}
                  fontSize="8.5"
                  fontFamily="JetBrains Mono"
                >
                  {mk.label}
                </text>
              </g>
            );
          })}

          {yGridTicks.map((val, i) => {
            const y = distToY(val);
            return (
              <g key={`${val}-${i}`}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="#1F1F1F"
                />
                <text
                  x={padLeft - 8}
                  y={y + 3}
                  textAnchor="end"
                  fill="#737373"
                  fontSize="9.5"
                  fontFamily="JetBrains Mono"
                >
                  {val}km
                </text>
              </g>
            );
          })}

          <path d={pathD} fill="none" stroke="#FFFFFF" strokeWidth="1.75" />

          <line
            x1={activeX}
            y1={padTop}
            x2={activeX}
            y2={height - padBottom}
            stroke="#737373"
            strokeWidth="1"
          />
          <circle
            cx={activeX}
            cy={activeY}
            r="4.5"
            fill="#FFFFFF"
            stroke="#000000"
            strokeWidth="2"
          />

          {xTickIndices.map((ptIdx) => {
            const iso = dataset.points[ptIdx].timestampUtc;
            const x = timeToX(iso);
            return (
              <text
                key={`${ptIdx}-${iso}`}
                x={x}
                y={height - 9}
                textAnchor="middle"
                fill="#737373"
                fontSize="9.5"
                fontFamily="JetBrains Mono"
              >
                {iso.slice(5, 10)}
              </text>
            );
          })}
        </svg>
      </div>

      {/* Press-to-Expand Campaign Milestones */}
      <div className="mt-3 divide-y divide-[#1F1F1F] border border-[#262626] bg-black">
        {dataset.milestones.map((ms) => {
          const isExpanded = expandedMilestoneId === ms.id;
          const isNearCurrent =
            Math.abs(
              new Date(ms.timestampUtc).getTime() - new Date(currentPoint.timestampUtc).getTime(),
            ) <
            12 * 3600_000;

          return (
            <div key={ms.id} className={isNearCurrent ? 'bg-[#141414]' : 'bg-black'}>
              <button
                type="button"
                onClick={() => {
                  jumpToTimestamp(ms.timestampUtc);
                  setExpandedMilestoneId((prev) => (prev === ms.id ? null : ms.id));
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[#141414]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#737373]" />
                  )}
                  <span className="font-mono-tabular text-[11px] text-[#A3A3A3] shrink-0">
                    {ms.timestampUtc.slice(0, 16).replace('T', ' ')}Z
                  </span>
                  <span className="truncate text-xs font-medium text-white">{ms.label}</span>
                </div>
                <span className="font-mono-tabular text-xs text-white whitespace-nowrap shrink-0">
                  {ms.distanceKm.toFixed(2)} km
                </span>
              </button>

              {isExpanded && (
                <div className="border-t border-[#1F1F1F] bg-[#0A0A0A] px-4 py-2.5 text-xs text-[#A3A3A3] space-y-1.5">
                  <p className="leading-relaxed text-white">{ms.detail}</p>
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-[11px] text-[#737373]">
                    <span>Epoch: {ms.timestampUtc} · Category: {ms.category}</span>
                    {ms.sourceUrl && (
                      <a
                        href={ms.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-sans text-white underline hover:text-[#A3A3A3]"
                      >
                        <span>Source Report</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
