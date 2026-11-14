import { useState } from 'react';
import type { FormEvent } from 'react';
import { ChevronDown, ChevronRight, Search, Trash2 } from 'lucide-react';
import type {
  AlertDeliveryRecord,
  FleetSubscription,
  WatchedSatellite,
} from '../shared/types';

interface WatchMyFleetViewProps {
  satellites: WatchedSatellite[];
  subscriptions: FleetSubscription[];
  alertDeliveries: AlertDeliveryRecord[];
  activeFleetId: string | null;
  onSelectActiveFleet: (fleetId: string | null) => void;
  onOpenEvent: (eventId: string) => void;
  onRegisterWatch: (payload: {
    label: string;
    noradIds: string;
    notifyChannel: string;
  }) => Promise<void>;
  onDeleteWatch: (id: string) => Promise<void>;
  submitting: boolean;
  errorMsg: string | null;
}

interface SearchHit {
  noradId: number;
  name: string;
  objectId: string;
  orbitRegime: string;
  epochUtc: string;
  source: 'spacetrack-live' | 'local-catalog';
}

type FleetFilter = 'all' | 'EU' | 'RU' | 'CN';

export function WatchMyFleetView({
  satellites,
  subscriptions,
  alertDeliveries,
  activeFleetId,
  onSelectActiveFleet,
  onOpenEvent,
  onRegisterWatch,
  onDeleteWatch,
  submitting,
  errorMsg,
}: WatchMyFleetViewProps) {
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [expandedNorad, setExpandedNorad] = useState<number | null>(null);
  const [showEnrollDrawer, setShowEnrollDrawer] = useState(true);
  const [expandedSubId, setExpandedSubId] = useState<string | null>(null);
  const [showAlertsSection, setShowAlertsSection] = useState(true);

  const [label, setLabel] = useState('');
  const [noradIds, setNoradIds] = useState('');
  const [notifyChannel, setNotifyChannel] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Satellite Name / NORAD Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const classifyGroup = (sat: WatchedSatellite): 'EU' | 'RU' | 'CN' => {
    if (sat.role === 'protected') return 'EU';
    const c = (sat.country || '').toUpperCase();
    if (c.includes('CN') || c.includes('PRC') || sat.name.toUpperCase().includes('SHIJIAN')) {
      return 'CN';
    }
    return 'RU';
  };

  const visibleSats = satellites.filter((s) => {
    if (filter === 'all') return true;
    return classifyGroup(s) === filter;
  });

  const handleCatalogSearch = async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/satellites/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results ?? []);
      }
    } finally {
      setSearching(false);
    }
  };

  const appendNoradToForm = (hit: SearchHit) => {
    const tokens = noradIds
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const idStr = String(hit.noradId);
    if (!tokens.includes(idStr)) {
      setNoradIds([...tokens, idStr].join(', '));
    }
    if (!label.trim()) {
      setLabel(`${hit.name} Fleet Watch`);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!noradIds.trim()) {
      setLocalError('Provide one or more NORAD IDs or spacecraft names.');
      return;
    }
    if (!notifyChannel.trim() || (!notifyChannel.includes('@') && !notifyChannel.startsWith('http'))) {
      setLocalError('Provide a duty email or Slack / Discord / HTTPS webhook URL.');
      return;
    }
    setLocalError(null);
    await onRegisterWatch({
      label: label.trim() || 'European Operator Watch',
      noradIds: noradIds.trim(),
      notifyChannel: notifyChannel.trim(),
    });
    setLabel('');
    setNoradIds('');
    setNotifyChannel('');
  };

  return (
    <div className="space-y-4 text-white">
      {/* Section 1: Fleet Enrollment, Catalog Name/NORAD Search, Subscriptions & Scoping */}
      <section className="border border-[#262626] bg-[#0A0A0A] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#262626] pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
              Fleet Watch &amp; Alert Routing ({subscriptions.length})
            </h2>
            {activeFleetId && (
              <button
                type="button"
                onClick={() => onSelectActiveFleet(null)}
                className="border border-white bg-white px-2 py-0.5 font-mono-tabular text-[10px] font-semibold text-black hover:bg-[#E5E5E5]"
              >
                Dashboard Scoped · Reset Filter ×
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowEnrollDrawer((v) => !v)}
            className="border border-white bg-white px-3 py-1 text-xs font-semibold text-black hover:bg-[#E5E5E5] whitespace-nowrap shrink-0"
          >
            {showEnrollDrawer ? '− Hide Fleet Form' : `+ Add Satellites / Fleet`}
          </button>
        </div>

        {showEnrollDrawer && (
          <div className="mt-3 grid grid-cols-1 gap-4 border border-[#262626] bg-black p-4 lg:grid-cols-12">
            {/* Left: Enrollment + Space-Track Search */}
            <div className="lg:col-span-6 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-white">
                  Add by NORAD ID or Spacecraft Name
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setLabel('ICEYE SAR Fleet');
                      setNoradIds('59103, ICEYE-X38');
                      setNotifyChannel('ops@iceye-example.eu');
                      setLocalError(null);
                    }}
                    className="border border-[#262626] px-2 py-0.5 text-[11px] text-[#A3A3A3] hover:border-white hover:text-white"
                  >
                    ICEYE
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLabel('Kuva Space Hyperspectral');
                      setNoradIds('60562, 64552');
                      setNotifyChannel('ops-duty@kuvaspace.com');
                      setLocalError(null);
                    }}
                    className="border border-[#262626] px-2 py-0.5 text-[11px] text-[#A3A3A3] hover:border-white hover:text-white"
                  >
                    Kuva Space
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLabel('ESA Copernicus Sentinels');
                      setNoradIds('39634, 40697');
                      setNotifyChannel('https://hooks.slack.com/services/EXAMPLE/WEBHOOK');
                      setLocalError(null);
                    }}
                    className="border border-[#262626] px-2 py-0.5 text-[11px] text-[#A3A3A3] hover:border-white hover:text-white"
                  >
                    ESA Sentinels
                  </button>
                </div>
              </div>

              {/* Space-Track Name / NORAD Lookup */}
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleCatalogSearch();
                    }
                  }}
                  placeholder="Search Space-Track catalog (e.g. ICEYE, SENTINEL, 59103)..."
                  className="flex-1 border border-[#262626] bg-[#0A0A0A] px-2.5 py-1.5 text-xs text-white placeholder:text-[#525252] focus:border-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleCatalogSearch()}
                  disabled={searching}
                  className="inline-flex items-center gap-1 border border-[#262626] bg-[#0A0A0A] px-3 py-1.5 text-xs text-white hover:border-white disabled:opacity-50"
                >
                  <Search className="h-3 w-3" />
                  <span>{searching ? 'Searching...' : 'Find'}</span>
                </button>
              </div>

              {searchResults.length > 0 && (
                <div className="max-h-[140px] overflow-y-auto divide-y divide-[#1F1F1F] border border-[#262626] bg-[#0A0A0A]">
                  {searchResults.map((hit) => (
                    <div
                      key={hit.noradId}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]"
                    >
                      <div className="min-w-0 truncate">
                        <span className="font-semibold text-white">{hit.name}</span>{' '}
                        <span className="font-mono-tabular text-[#737373]">
                          #{hit.noradId} · {hit.orbitRegime} ({hit.source})
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => appendNoradToForm(hit)}
                        className="border border-white bg-black px-2 py-0.5 font-mono-tabular text-[10px] text-white hover:bg-white hover:text-black shrink-0"
                      >
                        + Add
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-2.5">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Customer / Fleet label"
                  className="w-full border border-[#262626] bg-[#0A0A0A] px-2.5 py-1.5 text-xs text-white placeholder:text-[#525252] focus:border-white focus:outline-none"
                />
                <input
                  type="text"
                  value={noradIds}
                  onChange={(e) => setNoradIds(e.target.value)}
                  placeholder="NORAD IDs or Spacecraft Names (e.g. 59103, ICEYE-X36)"
                  className="w-full border border-[#262626] bg-[#0A0A0A] px-2.5 py-1.5 font-mono-tabular text-xs text-white placeholder:text-[#525252] focus:border-white focus:outline-none"
                />
                <input
                  type="text"
                  value={notifyChannel}
                  onChange={(e) => setNotifyChannel(e.target.value)}
                  placeholder="Slack/Discord webhook URL, HTTPS webhook, or operator email"
                  className="w-full border border-[#262626] bg-[#0A0A0A] px-2.5 py-1.5 font-mono-tabular text-xs text-white placeholder:text-[#525252] focus:border-white focus:outline-none"
                />
                {(localError || errorMsg) && (
                  <div className="border border-white bg-[#0A0A0A] p-2 text-xs text-white">
                    {localError || errorMsg}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full border border-white bg-white py-1.5 text-xs font-semibold text-black hover:bg-[#E5E5E5] disabled:opacity-50"
                >
                  {submitting ? 'Resolving & Screening 72h Orbits...' : 'Watch Fleet & Enable Alerts'}
                </button>
              </form>
            </div>

            {/* Right: Registered Fleets & Scoping + Digest */}
            <div className="lg:col-span-6 space-y-2.5">
              <div className="flex items-center justify-between text-xs font-semibold text-white">
                <span>Active Customer Fleets ({subscriptions.length})</span>
                <span className="font-mono-tabular text-[10px] font-normal text-[#737373]">
                  Select &ldquo;Scope Dashboard&rdquo; to show only threats to that fleet
                </span>
              </div>
              {subscriptions.length === 0 ? (
                <div className="border border-[#262626] bg-[#0A0A0A] p-3 text-xs text-[#737373]">
                  No custom fleets enrolled yet. Enter a NORAD ID or spacecraft name on the left.
                </div>
              ) : (
                <div className="divide-y divide-[#1F1F1F] border border-[#262626] bg-[#0A0A0A]">
                  {subscriptions.map((sub) => {
                    const open = expandedSubId === sub.id;
                    const isScoped = activeFleetId === sub.id;
                    return (
                      <div key={sub.id} className={isScoped ? 'bg-[#141414]' : 'bg-[#0A0A0A]'}>
                        <div className="flex items-center justify-between gap-2 px-3 py-2">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedSubId((prev) => (prev === sub.id ? null : sub.id))
                            }
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs hover:text-white"
                          >
                            {open ? (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#737373]" />
                            )}
                            <span className="truncate font-medium text-white">{sub.label}</span>
                            <span className="font-mono-tabular text-[10px] text-[#737373] shrink-0">
                              ({sub.noradIds.length} sats)
                            </span>
                          </button>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="font-mono-tabular text-xs text-white">
                              {sub.min72hDistanceKm.toFixed(1)} km
                            </span>
                            <button
                              type="button"
                              onClick={() => onSelectActiveFleet(isScoped ? null : sub.id)}
                              className={`border px-2 py-0.5 text-[10px] font-mono-tabular whitespace-nowrap ${
                                isScoped
                                  ? 'border-white bg-white text-black font-semibold'
                                  : 'border-[#262626] bg-black text-white hover:border-white'
                              }`}
                            >
                              {isScoped ? 'Scoped ✓' : 'Scope Dashboard'}
                            </button>
                          </div>
                        </div>

                        {open && (
                          <div className="border-t border-[#1F1F1F] bg-black px-3 py-2.5 font-mono-tabular text-[11px] text-[#A3A3A3] space-y-1.5">
                            <div>NORAD IDs: {sub.noradIds.join(', ')}</div>
                            <div className="truncate">Notify: {sub.notifyChannel}</div>
                            <div className="text-white">{sub.closestSuspectSummary}</div>
                            <div className="flex flex-wrap items-center gap-2 pt-1 font-sans">
                              <button
                                type="button"
                                onClick={() => void onDeleteWatch(sub.id)}
                                className="inline-flex items-center gap-1 border border-[#262626] bg-[#0A0A0A] px-2.5 py-1 text-[11px] text-[#A3A3A3] hover:border-white hover:text-white"
                              >
                                <Trash2 className="h-3 w-3" />
                                <span>Remove</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Section 2: Alert Delivery & Deduplication Ledger */}
      <section className="border border-[#262626] bg-[#0A0A0A] p-4">
        <button
          type="button"
          onClick={() => setShowAlertsSection((v) => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2">
            {showAlertsSection ? (
              <ChevronDown className="h-3.5 w-3.5 text-white" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-[#737373]" />
            )}
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
              Alert Delivery &amp; 6h Deduplication Log ({alertDeliveries.length})
            </h2>
          </div>
          <span className="font-mono-tabular text-[10px] text-[#737373]">
            Slack · Discord · Webhooks · Email
          </span>
        </button>

        {showAlertsSection && (
          <div className="mt-3 overflow-x-auto border border-[#262626] bg-black">
            {alertDeliveries.length === 0 ? (
              <div className="p-3 text-xs text-[#737373]">
                No fleet alerts dispatched yet. Enroll a fleet matching an active event or run Simulate Webhook.
              </div>
            ) : (
              <table className="w-full border-collapse text-left text-[11px]">
                <thead>
                  <tr className="border-b border-[#1F1F1F] text-[#737373]">
                    <th className="px-3 py-2 font-medium">UTC</th>
                    <th className="px-3 py-2 font-medium">Channel</th>
                    <th className="px-3 py-2 font-medium">Threat</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Target / Summary</th>
                    <th className="px-3 py-2 text-right font-medium">Dossier</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1F1F1F] font-mono-tabular">
                  {alertDeliveries.slice(0, 15).map((al) => (
                    <tr key={al.id}>
                      <td className="px-3 py-2 text-[#737373] whitespace-nowrap">
                        {al.sentAtUtc.slice(11, 19)}Z
                      </td>
                      <td className="px-3 py-2 uppercase text-white whitespace-nowrap">
                        {al.channelType}
                      </td>
                      <td className="px-3 py-2 text-white whitespace-nowrap">{al.threatLevel}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="border border-[#262626] px-1.5 py-0.5 text-[10px] uppercase text-white">
                          {al.deliveryStatus}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-sans text-[#D4D4D4] max-w-[320px] truncate">
                        {al.summary}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onOpenEvent(al.eventId)}
                          className="font-sans text-white underline hover:text-[#A3A3A3]"
                        >
                          Event →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* Section 3: Full Tracked Spacecraft Catalog */}
      <section className="border border-[#262626] bg-[#0A0A0A] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#262626] pb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
            Tracked Spacecraft Catalog ({visibleSats.length})
          </h2>
          <div className="flex items-center border border-[#262626] bg-black">
            {(['all', 'EU', 'RU', 'CN'] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setFilter(code)}
                className={`px-2.5 py-1 font-mono-tabular text-xs transition-colors whitespace-nowrap shrink-0 ${
                  filter === code
                    ? 'bg-white text-black font-semibold'
                    : 'text-[#A3A3A3] hover:text-white'
                }`}
              >
                {code === 'all' ? 'All' : code}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 divide-y divide-[#1F1F1F] border border-[#262626] bg-black">
          {visibleSats.map((sat) => {
            const isOpen = expandedNorad === sat.noradId;
            const grp = classifyGroup(sat);
            return (
              <div key={sat.noradId} className={isOpen ? 'bg-[#141414]' : 'bg-black'}>
                <button
                  type="button"
                  onClick={() =>
                    setExpandedNorad((prev) => (prev === sat.noradId ? null : sat.noradId))
                  }
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[#141414]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#737373]" />
                    )}
                    <span className="font-mono-tabular text-[11px] text-[#A3A3A3] shrink-0">
                      [{grp}]
                    </span>
                    <span className="truncate text-xs font-medium text-white">{sat.name}</span>
                    <span className="font-mono-tabular text-[11px] text-[#737373] shrink-0">
                      #{sat.noradId}
                    </span>
                  </div>

                  <div className="flex items-center gap-4 font-mono-tabular text-xs text-[#A3A3A3] whitespace-nowrap shrink-0">
                    <span className="hidden sm:inline">{sat.orbitRegime}</span>
                    <span className="text-white">{sat.positionGeodetic.altKm.toFixed(1)} km</span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-[#1F1F1F] bg-[#0A0A0A] px-4 py-3 font-mono-tabular text-[11px] text-[#A3A3A3] grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <div className="text-[#737373]">Operator / Country</div>
                      <div className="text-white font-sans text-xs">
                        {sat.operator} ({sat.country})
                      </div>
                    </div>
                    <div>
                      <div className="text-[#737373]">OMM Epoch &amp; Source</div>
                      <div className="text-white">
                        {String(sat.omm.EPOCH).slice(0, 19).replace('T', ' ')}Z
                      </div>
                      <div className="text-[10px] text-[#737373]">
                        {sat.provenance} ({sat.epochAgeHours.toFixed(1)}h age)
                      </div>
                    </div>
                    <div>
                      <div className="text-[#737373]">Keplerian Plane</div>
                      <div className="text-white">
                        Inc {Number(sat.omm.INCLINATION).toFixed(3)}° · RAAN{' '}
                        {Number(sat.omm.RA_OF_ASC_NODE).toFixed(3)}°
                      </div>
                      <div className="text-[10px] text-[#737373]">
                        e={Number(sat.omm.ECCENTRICITY).toFixed(6)} · n=
                        {Number(sat.omm.MEAN_MOTION).toFixed(5)} rev/d
                      </div>
                    </div>
                    <div>
                      <div className="text-[#737373]">Sub-Satellite Geodetic</div>
                      <div className="text-white">
                        {sat.positionGeodetic.latDeg.toFixed(2)}°,{' '}
                        {sat.positionGeodetic.lonDeg.toFixed(2)}°
                      </div>
                      <div className="text-[10px] text-[#737373]">
                        Speed {sat.positionGeodetic.speedKms.toFixed(2)} km/s
                      </div>
                    </div>
                    {(sat.mission || sat.notes) && (
                      <div className="sm:col-span-2 lg:col-span-4 border-t border-[#1F1F1F] pt-2 font-sans text-xs text-[#D4D4D4]">
                        {sat.mission ? `${sat.mission} — ` : ''}
                        {sat.notes}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
