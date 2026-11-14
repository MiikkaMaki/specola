import { X } from 'lucide-react';
import type { SystemMetricsPayload } from '../shared/types';

interface UnderTheHoodDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  metrics: SystemMetricsPayload | null;
  onRunBacktest?: () => Promise<void>;
  runningBacktest?: boolean;
}

export function UnderTheHoodDrawer({
  isOpen,
  onClose,
  metrics,
  onRunBacktest,
  runningBacktest = false,
}: UnderTheHoodDrawerProps) {
  if (!isOpen) return null;

  const brief = metrics?.briefGeneration;
  const orbit = metrics?.orbitValidation;
  const scan = metrics?.orbitScan;
  const db = metrics?.database;
  const ctx = metrics?.contextDevUsage;
  const bt = metrics?.backtestSummary;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/75 no-print"
      role="dialog"
      aria-modal="true"
      aria-label="Under the hood architecture, latency, accuracy and Context.dev call log"
    >
      <div className="flex h-full w-full max-w-[780px] flex-col border-l border-white bg-black text-white">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-[#262626] px-5 py-3.5">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
              Under the Hood · Architecture, Metrics &amp; Call Log
            </h2>
            <p className="mt-0.5 font-mono-tabular text-[11px] text-[#737373]">
              All metrics read directly from PostgreSQL / SQLite telemetry tables.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 border border-[#262626] bg-[#0A0A0A] px-2.5 py-1 text-xs text-white hover:border-white"
          >
            <X className="h-3.5 w-3.5" />
            <span>Close</span>
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 1. Four-Service Architecture Diagram */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
              01 · Stateless Verification Architecture
            </h3>
            <div className="border border-[#262626] bg-[#0A0A0A] p-3">
              <svg viewBox="0 0 680 190" className="w-full h-auto">
                <rect x="0" y="0" width="680" height="190" fill="#000000" />

                {/* Left Inputs: Context.dev + Space-Track SGP4 */}
                <rect x="14" y="18" width="185" height="62" fill="#0A0A0A" stroke="#FFFFFF" strokeWidth="1" />
                <text x="26" y="40" fill="#FFFFFF" fontSize="11" fontWeight="600" fontFamily="monospace">
                  1. CONTEXT.DEV
                </text>
                <text x="26" y="57" fill="#A3A3A3" fontSize="9.5" fontFamily="monospace">
                  Monitors · Scrape · Search
                </text>
                <text x="26" y="71" fill="#737373" fontSize="9" fontFamily="monospace">
                  MCP / REST → Webhook
                </text>

                <rect x="14" y="108" width="185" height="62" fill="#0A0A0A" stroke="#737373" strokeWidth="1" />
                <text x="26" y="130" fill="#FFFFFF" fontSize="11" fontWeight="600" fontFamily="monospace">
                  2. SGP4 ENGINE
                </text>
                <text x="26" y="147" fill="#A3A3A3" fontSize="9.5" fontFamily="monospace">
                  72h Screening &amp; Δv Scan
                </text>
                <text x="26" y="161" fill="#737373" fontSize="9" fontFamily="monospace">
                  Space-Track GP + CelesTrak
                </text>

                {/* Connectors */}
                <line x1="199" y1="49" x2="248" y2="85" stroke="#737373" strokeWidth="1.2" />
                <line x1="199" y1="139" x2="248" y2="103" stroke="#737373" strokeWidth="1.2" />

                {/* Center Reasoning: Gemini */}
                <rect x="248" y="54" width="185" height="80" fill="#0A0A0A" stroke="#FFFFFF" strokeWidth="1.25" />
                <text x="260" y="78" fill="#FFFFFF" fontSize="11" fontWeight="600" fontFamily="monospace">
                  3. GEMINI REASONING
                </text>
                <text x="260" y="96" fill="#D4D4D4" fontSize="9.5" fontFamily="monospace">
                  Extract: {brief?.extractionModel || 'gemini-4-hydrogen'}
                </text>
                <text x="260" y="112" fill="#D4D4D4" fontSize="9.5" fontFamily="monospace">
                  Brief: {brief?.activeModel || 'gemini-4-carbon'}
                </text>
                <text x="260" y="126" fill="#737373" fontSize="9" fontFamily="monospace">
                  Sentence → Source / Orbit
                </text>

                {/* Connector to Aiven */}
                <line x1="433" y1="94" x2="480" y2="94" stroke="#FFFFFF" strokeWidth="1.2" />

                {/* Right State: Aiven PostgreSQL */}
                <rect x="480" y="28" width="186" height="132" fill="#0A0A0A" stroke="#FFFFFF" strokeWidth="1" />
                <text x="492" y="52" fill="#FFFFFF" fontSize="11" fontWeight="600" fontFamily="monospace">
                  4. AIVEN POSTGRESQL
                </text>
                <text x="492" y="69" fill="#A3A3A3" fontSize="9.5" fontFamily="monospace">
                  Persistent Stateless-Host DB
                </text>
                <text x="492" y="92" fill="#D4D4D4" fontSize="9" fontFamily="monospace">
                  · Live SSE Event Feed
                </text>
                <text x="492" y="108" fill="#D4D4D4" fontSize="9" fontFamily="monospace">
                  · OMM Separation History
                </text>
                <text x="492" y="124" fill="#D4D4D4" fontSize="9" fontFamily="monospace">
                  · Claims &amp; Brief Latency
                </text>
                <text x="492" y="140" fill="#D4D4D4" fontSize="9" fontFamily="monospace">
                  · Context.dev Call Log
                </text>
              </svg>
            </div>
          </section>

          {/* 2. Real Database Latency & Orbit Accuracy Metrics */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
              02 · Measured Latency &amp; Orbital Accuracy Metrics
            </h3>
            {!metrics ? (
              <div className="border border-[#262626] bg-[#0A0A0A] p-3 text-xs text-[#737373]">
                Loading database metrics...
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="border border-[#262626] bg-[#0A0A0A] p-3 font-mono-tabular text-xs space-y-1">
                  <div className="text-[10px] uppercase text-[#737373]">
                    Gemini Synthesis Latency ({brief?.activeModel} · Extract {brief?.extractionModel || 'gemini-4-hydrogen'})
                  </div>
                  <div className="text-white font-semibold">
                    {brief?.p50LatencyMs !== null && brief?.p50LatencyMs !== undefined
                      ? `p50 ${brief.p50LatencyMs} ms · worst ${brief.worstLatencyMs} ms`
                      : 'No live Gemini runs stored yet'}
                  </div>
                  <div className="text-[11px] text-[#A3A3A3]">
                    Latest:{' '}
                    {brief?.latestLatencyMs !== null && brief?.latestLatencyMs !== undefined
                      ? `${brief.latestLatencyMs} ms`
                      : '—'}{' '}
                    · {brief?.measuredBriefsCount ?? 0} live / {brief?.seededBriefsCount ?? 0} seeded
                  </div>
                  <div className="text-[11px] text-[#737373]">
                    Webhook E2E:{' '}
                    {brief?.e2eWebhookP50Ms !== null && brief?.e2eWebhookP50Ms !== undefined
                      ? `p50 ${brief.e2eWebhookP50Ms} ms · worst ${brief.e2eWebhookWorstMs} ms`
                      : 'Run Simulate Webhook to measure'}
                  </div>
                </div>

                <div className="border border-[#262626] bg-[#0A0A0A] p-3 font-mono-tabular text-xs space-y-1">
                  <div className="text-[10px] uppercase text-[#737373]">
                    SGP4 Accuracy vs Public Benchmark
                  </div>
                  <div className="text-white font-semibold">
                    {orbit?.specolaDistanceKm.toFixed(2)} km @ {orbit?.specolaTcaUtc.slice(0, 19)}Z (ref{' '}
                    {orbit?.referenceDistanceKm} km @ 07:28Z)
                  </div>
                  <div className="text-[11px] text-[#A3A3A3]">
                    Δ {orbit?.deltaKm.toFixed(2)} km · Nov separation:{' '}
                    {orbit?.nov13CheckDistanceKm !== null && orbit?.nov13CheckDistanceKm !== undefined
                      ? `${orbit.nov13CheckDistanceKm.toFixed(1)} km`
                      : '—'}{' '}
                    (Δθ{' '}
                    {orbit?.nov13PlaneAngleDeg !== null && orbit?.nov13PlaneAngleDeg !== undefined
                      ? `${orbit.nov13PlaneAngleDeg.toFixed(3)}°`
                      : '—'}
                    )
                  </div>
                  <div className="text-[11px] text-[#737373]">
                    {orbit?.specolaMethod || 'SGP4 60s→1s'}
                    {orbit?.specolaSuspectEpochUtc ? ` · OMM ${orbit.specolaSuspectEpochUtc.slice(0, 16)}Z` : ''}
                  </div>
                </div>

                <div className="border border-[#262626] bg-[#0A0A0A] p-3 font-mono-tabular text-xs space-y-1">
                  <div className="text-[10px] uppercase text-[#737373]">
                    SGP4 72h Screening Runs (Aiven PG)
                  </div>
                  <div className="text-white font-semibold">
                    {scan?.pairsScreened ?? 0} pairs · {scan?.lastJobDurationMs ?? 0} ms
                  </div>
                  <div className="text-[11px] text-[#A3A3A3]">
                    Screened: {scan?.workersCount ?? 0} EU · Data age:{' '}
                    <span className="text-white font-semibold">
                      {scan?.dataAgeHours !== null && scan?.dataAgeHours !== undefined
                        ? `${scan.dataAgeHours.toFixed(1)}h median`
                        : '—'}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#737373]">
                    Refresh: {scan?.scheduleLabel || 'Automatic on load (>2h stale)'}
                  </div>
                </div>

                <div className="border border-[#262626] bg-[#0A0A0A] p-3 font-mono-tabular text-xs space-y-1">
                  <div className="text-[10px] uppercase text-[#737373]">
                    Aiven PostgreSQL Table Counts
                  </div>
                  <div className="text-white font-semibold">
                    {db?.engine === 'aiven-postgresql' ? 'Connected (EU TLS)' : 'Local SQLite Mirror'}
                  </div>
                  {db?.tableStats && (
                    <div className="text-[11px] text-[#A3A3A3]">
                      {db.tableStats.events} events · {db.tableStats.claims} claims ·{' '}
                      {db.tableStats.briefs} briefs · {db.tableStats.contextCalls} calls ·{' '}
                      {db.tableStats.screeningRuns} runs
                    </div>
                  )}
                  <div className="text-[11px] text-[#737373] truncate">{db?.hostHint}</div>
                </div>
              </div>
            )}
          </section>

          {/* 3. Blind Chronological Backtest */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                03 · Blind Chronological Backtest (Zero Look-Ahead · CREATION_DATE Order)
              </h3>
              {onRunBacktest && (
                <button
                  type="button"
                  onClick={() => void onRunBacktest()}
                  disabled={runningBacktest}
                  className="border border-white bg-black px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white hover:text-black disabled:opacity-50 whitespace-nowrap"
                >
                  {runningBacktest ? 'Running Backtest...' : 'Re-run backtest'}
                </button>
              )}
            </div>
            <div className="border border-[#262626] bg-[#0A0A0A] p-3 font-mono-tabular text-xs space-y-1">
              {!bt ? (
                <div className="text-[#737373]">
                  Backtest not yet persisted in database. Click &quot;Re-run backtest&quot; to compute.
                </div>
              ) : (
                <>
                  <div className="text-white font-semibold">{bt.cosmosIceye.headline}</div>
                  <div className="text-[11px] text-[#A3A3A3]">
                    WATCH: {bt.cosmosIceye.firstWatch?.creationDateUtc.slice(0, 19).replace('T', ' ') ?? '—'}Z · WARNING:{' '}
                    {bt.cosmosIceye.firstWarning?.creationDateUtc.slice(0, 19).replace('T', ' ') ?? '—'}Z · ALERT:{' '}
                    {bt.cosmosIceye.firstAlert?.creationDateUtc.slice(0, 19).replace('T', ' ') ?? '—'}Z
                  </div>
                  <div className="text-[11px] text-[#737373]">
                    Sep–Oct Unmatched Alerts: {bt.falseAlarmSweepSepOct.unmatchedAlertPairs} · May 2026 Soyuz Sibling Warnings/Alerts:{' '}
                    {bt.falseAlarmSweepMay2026.totalAlert + bt.falseAlarmSweepMay2026.totalWarning} · Ran:{' '}
                    {bt.ranAtUtc.slice(0, 19).replace('T', ' ')}Z
                  </div>
                </>
              )}
            </div>
          </section>

          {/* 4. Context.dev Call Log */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#A3A3A3]">
                04 · Context.dev Call Log ({ctx?.callsToday ?? 0} today ·{' '}
                {ctx?.totalCalls ?? 0} recorded · {ctx?.liveCalls ?? 0} live ·{' '}
                {ctx?.totalCreditsUsed ?? 0} credits · {ctx?.irrelevantSkippedCount ?? 0} skipped)
              </h3>
              <span className="font-mono-tabular text-[11px] text-[#737373]">
                Avg {ctx?.averageLatencyMs ?? 0} ms
                {ctx?.lastPullUtc ? ` · Pull ${ctx.lastPullUtc.slice(11, 16)}Z` : ''}
              </span>
            </div>

            <div className="max-h-[340px] overflow-auto border border-[#262626] bg-[#0A0A0A]">
              {!ctx || ctx.recentCalls.length === 0 ? (
                <div className="p-3 text-xs text-[#737373]">
                  No Context.dev calls logged in database yet.
                </div>
              ) : (
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="border-b border-[#262626] bg-black text-[#737373]">
                      <th className="px-2.5 py-1.5 font-medium">UTC</th>
                      <th className="px-2.5 py-1.5 font-medium">Endpoint</th>
                      <th className="px-2.5 py-1.5 font-medium">Target / Query</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">HTTP</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1F1F1F] font-mono-tabular">
                    {ctx.recentCalls.map((call) => (
                      <tr key={call.id}>
                        <td className="px-2.5 py-1.5 text-[#737373] whitespace-nowrap">
                          {call.timestampUtc.slice(11, 19)}Z
                        </td>
                        <td className="px-2.5 py-1.5 text-white whitespace-nowrap">
                          {call.endpoint}
                        </td>
                        <td className="px-2.5 py-1.5 font-sans text-[#D4D4D4] max-w-[260px] truncate">
                          {call.queryOrTarget}
                        </td>
                        <td className="px-2.5 py-1.5 text-right text-[#A3A3A3] whitespace-nowrap">
                          {call.httpStatus}
                        </td>
                        <td className="px-2.5 py-1.5 text-right text-white whitespace-nowrap">
                          {call.latencyMs} ms {call.cached ? '(cache)' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
