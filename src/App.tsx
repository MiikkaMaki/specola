/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { OrbitalGlobe } from './components/OrbitalGlobe';
import { ReplayTimeline } from './components/ReplayTimeline';
import { WatchMyFleetView } from './components/WatchMyFleetView';
import { EventDetailView } from './components/EventDetailView';
import { UnderTheHoodDrawer } from './components/UnderTheHoodDrawer';
import { WhatIsSpecolaModal } from './components/WhatIsSpecolaModal';
import { AlertContextView } from './components/AlertContextView';
import type {
  AlertDeliveryRecord,
  FleetSubscription,
  HistoricalAlarmItem,
  LiveFeedItem,
  ManeuverDetection,
  OrbitalEventRecord,
  PairTelemetrySnapshot,
  ReplayDataset,
  SatelliteGroupId,
  StoredDecisionBrief,
  SystemMetricsPayload,
  VerifiedWebClaim,
  WatchedSatellite,
} from './shared/types';

type ActiveWorkspaceTab = 'console' | 'history' | 'event' | 'fleet' | 'alert_context';

function formatShortUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${iso.slice(0, 16).replace('T', ' ')}Z`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>(() => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('event')) return 'event';
      const hash = window.location.hash.replace('#', '').toLowerCase();
      if (hash === 'history' || hash === 'fleet' || hash === 'event') {
        return hash as ActiveWorkspaceTab;
      }
    }
    return 'console';
  });

  const [showWhatIsSpecola, setShowWhatIsSpecola] = useState(false);
  const [showUnderTheHood, setShowUnderTheHood] = useState(false);
  const [demoTrigger, setDemoTrigger] = useState<{
    seq: number;
    timestampUtc: string;
    speed: number;
  } | null>(null);
  const [landingResetSeq, setLandingResetSeq] = useState(0);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

const CONSOLE_GROUP_OPTIONS: { id: SatelliteGroupId | 'pair'; label: string }[] = [
  { id: 'pair', label: 'Pair' },
  { id: 'watched', label: 'All Watched' },
  { id: 'stations', label: 'Stations' },
  { id: 'active', label: 'Active' },
  { id: 'starlink', label: 'Starlink' },
  { id: 'weather', label: 'Weather' },
  { id: 'gps-ops', label: 'GPS' },
];

  const [satellites, setSatellites] = useState<WatchedSatellite[]>([]);
  const [activeGroup, setActiveGroup] = useState<SatelliteGroupId>('watched');
  const [globeViewMode, setGlobeViewMode] = useState<'pair' | 'group'>('group');
  const [regimeFilter, setRegimeFilter] = useState<'ALL' | 'LEO' | 'GEO'>('ALL');
  const [groupSatellites, setGroupSatellites] = useState<Record<string, WatchedSatellite[]>>({});
  const [loadingGroup, setLoadingGroup] = useState(false);

  const [pairs, setPairs] = useState<PairTelemetrySnapshot[]>([]);
  const [selectedPairKey, setSelectedPairKey] = useState<string | null>(null);
  const [maneuvers, setManeuvers] = useState<ManeuverDetection[]>([]);

  const [events, setEvents] = useState<OrbitalEventRecord[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<HistoricalAlarmItem | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('event')) return String(sp.get('event'));
    }
    return 'evt-rpo-68762-59103';
  });
  const [claims, setClaims] = useState<VerifiedWebClaim[]>([]);
  const [briefs, setBriefs] = useState<StoredDecisionBrief[]>([]);
  const [feed, setFeed] = useState<LiveFeedItem[]>([]);
  const [fleetSubscriptions, setFleetSubscriptions] = useState<FleetSubscription[]>([]);
  const [activeFleetId, setActiveFleetId] = useState<string | null>(null);
  const [alertDeliveries, setAlertDeliveries] = useState<AlertDeliveryRecord[]>([]);
  const [metrics, setMetrics] = useState<SystemMetricsPayload | null>(null);

  const [replayDataset, setReplayDataset] = useState<ReplayDataset | null>(null);
  const [replayIndex, setReplayIndex] = useState<number>(0);
  const [loadingReplay, setLoadingReplay] = useState(false);

  const [regeneratingBrief, setRegeneratingBrief] = useState(false);
  const [streamPreview, setStreamPreview] = useState<string | null>(null);
  const [runningBacktest, setRunningBacktest] = useState(false);
  const [submittingFleet, setSubmittingFleet] = useState(false);
  const [sweepingNorad, setSweepingNorad] = useState<number | null>(null);

  const [briefError, setBriefError] = useState<string | null>(null);
  const [fleetError, setFleetError] = useState<string | null>(null);

  const loadWorkspaceState = useCallback(async () => {
    try {
      const [stateRes, replayRes] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/replay?pair=68762,59103&from=2026-09-25T00:00:00Z&to=2026-10-25T00:00:00Z'),
      ]);
      if (!stateRes.ok) {
        throw new Error(`Server returned HTTP ${stateRes.status}`);
      }
      const data = await stateRes.json();
      setSatellites(data.satellites ?? []);
      setPairs(data.pairs ?? []);
      setManeuvers(data.maneuvers ?? []);
      setEvents(data.events ?? []);
      setClaims(data.claims ?? []);
      setBriefs(data.briefs ?? []);
      setFeed(data.feed ?? []);
      setFleetSubscriptions(data.fleetSubscriptions ?? []);
      setAlertDeliveries(data.alertDeliveries ?? []);
      setMetrics(data.metrics ?? null);

      if (replayRes.ok) {
        const rep: ReplayDataset = await replayRes.json();
        setReplayDataset(rep);
        const oct16Idx = rep.points.findIndex((p) => p.timestampUtc.startsWith('2026-10-16T07'));
        setReplayIndex(oct16Idx >= 0 ? oct16Idx : Math.floor(rep.points.length * 0.7));
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to connect to Specola backend');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaceState();
  }, [loadWorkspaceState]);

  useEffect(() => {
    const es = new EventSource('/api/feed');

    es.addEventListener('init', (event: MessageEvent) => {
      try {
        const initialItems = JSON.parse(event.data) as LiveFeedItem[];
        setFeed((prev) => {
          const map = new Map<string, LiveFeedItem>();
          for (const item of [...initialItems, ...prev]) {
            map.set(item.id, item);
          }
          return Array.from(map.values()).sort((a, b) =>
            b.timestampUtc.localeCompare(a.timestampUtc),
          );
        });
      } catch {
        // Ignore malformed init frame
      }
    });

    es.onmessage = (event: MessageEvent) => {
      try {
        const incoming = JSON.parse(event.data) as LiveFeedItem;
        setFeed((prev) => {
          if (prev.some((x) => x.id === incoming.id)) return prev;
          return [incoming, ...prev].slice(0, 60);
        });
      } catch {
        // Ignore heartbeat comments
      }
    };

    return () => {
      es.close();
    };
  }, []);

  const activeFleet = useMemo(
    () => fleetSubscriptions.find((f) => f.id === activeFleetId) ?? null,
    [fleetSubscriptions, activeFleetId],
  );

  const visiblePairs = useMemo(() => {
    if (!activeFleet) return pairs;
    const set = new Set(activeFleet.noradIds);
    return pairs.filter((p) => set.has(p.protectedNoradId) || set.has(p.suspectNoradId));
  }, [pairs, activeFleet]);

  const visibleEvents = useMemo(() => {
    if (!activeFleet) return events;
    const set = new Set(activeFleet.noradIds);
    return events.filter((e) => set.has(e.protectedNoradId) || set.has(e.suspectNoradId));
  }, [events, activeFleet]);

  const selectedPair = useMemo(() => {
    if (!selectedPairKey) return null;
    return (
      visiblePairs.find((p) => `${p.suspectNoradId}-${p.protectedNoradId}` === selectedPairKey) ??
      pairs.find((p) => `${p.suspectNoradId}-${p.protectedNoradId}` === selectedPairKey) ??
      null
    );
  }, [visiblePairs, pairs, selectedPairKey]);

  const navigateToTab = useCallback((tab: ActiveWorkspaceTab) => {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      if (tab === 'event') {
        return;
      }
      window.history.replaceState({}, '', tab === 'console' ? '/' : `/#${tab}`);
    }
  }, []);

  const openShareableEventPage = useCallback(
    (eventIdOrPairKey: string) => {
      const byId = events.find((e) => e.id === eventIdOrPairKey);
      const byPair = events.find((e) => e.pairKey === eventIdOrPairKey);
      const targetId = byId?.id ?? byPair?.id ?? eventIdOrPairKey;
      setSelectedEventId(targetId);
      if (byPair) setSelectedPairKey(byPair.pairKey);
      if (byId) setSelectedPairKey(byId.pairKey);
      setActiveTab('event');
      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', `/?event=${encodeURIComponent(targetId)}`);
      }
    },
    [events],
  );

  const handleOpenAlertContext = useCallback((alarm: HistoricalAlarmItem) => {
    setSelectedAlert(alarm);
    setActiveTab('alert_context');
  }, []);

  const handleLaunchDemo = useCallback(() => {
    setActiveFleetId(null);
    setSelectedPairKey('68762-59103');
    setSelectedEventId('evt-rpo-68762-59103');
    setGlobeViewMode('pair');
    setActiveTab('console');
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', '/');
    }
    setDemoTrigger((prev) => ({
      seq: (prev?.seq ?? 0) + 1,
      timestampUtc: '2026-05-16T03:55:00Z',
      speed: 1800,
    }));
  }, []);

  const handleReturnToLanding = useCallback(() => {
    setActiveFleetId(null);
    setSelectedPairKey(null);
    setGlobeViewMode('group');
    setActiveGroup('watched');
    setRegimeFilter('ALL');
    setDemoTrigger(null);
    setLandingResetSeq((s) => s + 1);
    navigateToTab('console');
  }, [navigateToTab]);

  const handleSelectPairKey = useCallback(
    (pairKey: string) => {
      setSelectedPairKey(pairKey);
      const matchingEvt =
        events.find((e) => e.pairKey === pairKey && e.status === 'confirmed') ??
        events.find((e) => e.pairKey === pairKey);
      if (matchingEvt) {
        setSelectedEventId(matchingEvt.id);
      }
    },
    [events],
  );

  const handleSelectSatelliteOnGlobe = useCallback(
    (noradId: number) => {
      const matching = visiblePairs.find(
        (p) => p.suspectNoradId === noradId || p.protectedNoradId === noradId,
      );
      if (matching) {
        handleSelectPairKey(`${matching.suspectNoradId}-${matching.protectedNoradId}`);
      }
    },
    [visiblePairs, handleSelectPairKey],
  );

  const handleSelectGroup = useCallback(
    async (group: SatelliteGroupId) => {
      setActiveGroup(group);
      if (group === 'watched') return;
      if (groupSatellites[group]?.length) return;
      setLoadingGroup(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/groups/${encodeURIComponent(group)}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} loading orbital group`);
        }
        const data = await res.json();
        setGroupSatellites((prev) => ({
          ...prev,
          [group]: data.satellites ?? [],
        }));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to load satellite group');
      } finally {
        setLoadingGroup(false);
      }
    },
    [groupSatellites],
  );

  const handleSelectReplayCampaign = useCallback(
    async (suspectId: number, protectedId: number, fromIso: string, toIso: string) => {
      setLoadingReplay(true);
      setActionError(null);
      const pairKey = `${suspectId}-${protectedId}`;
      handleSelectPairKey(pairKey);
      try {
        const url = `/api/replay?pair=${suspectId},${protectedId}&from=${encodeURIComponent(
          fromIso,
        )}&to=${encodeURIComponent(toIso)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} loading historical replay`);
        const rep: ReplayDataset = await res.json();
        setReplayDataset(rep);
        let minIdx = 0;
        let minDist = Infinity;
        rep.points.forEach((pt, idx) => {
          if (pt.distanceKm < minDist) {
            minDist = pt.distanceKm;
            minIdx = idx;
          }
        });
        setReplayIndex(minIdx);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Replay load error');
      } finally {
        setLoadingReplay(false);
      }
    },
    [handleSelectPairKey],
  );

  const handleSweepSatellite = async (noradId: number) => {
    setSweepingNorad(noradId);
    setActionError(null);
    try {
      const res = await fetch('/api/context/sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noradId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status} during sweep`);
      if (data.claims) setClaims(data.claims);
      if (data.metrics) setMetrics(data.metrics);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Satellite Context.dev sweep failed');
    } finally {
      setSweepingNorad(null);
    }
  };

  const handleRegenerateBrief = async (eventId: string, force = false) => {
    setRegeneratingBrief(true);
    setBriefError(null);
    setStreamPreview(null);
    try {
      const res = await fetch('/api/briefs/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, force }),
      });
      if (!res.ok || !res.body) {
        const payload = await res.json().catch(() => ({}));
        setBriefError(payload.error || `HTTP ${res.status} Gemini brief stream failed`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let previewAcc = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const eventMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!dataMatch) continue;
          const evtName = eventMatch?.[1]?.trim() || 'message';
          try {
            const payload = JSON.parse(dataMatch[1]);
            if (evtName === 'chunk' && typeof payload.delta === 'string') {
              previewAcc += payload.delta;
              setStreamPreview(previewAcc);
            } else if (evtName === 'done') {
              if (payload.brief) {
                setBriefs((prev) => [
                  payload.brief,
                  ...prev.filter((b) => b.id !== payload.brief.id),
                ]);
              }
              if (payload.claims) {
                setClaims(payload.claims);
              }
            } else if (evtName === 'error') {
              setBriefError(payload.error || 'Streaming Gemini brief generation failed');
            }
          } catch {
            // Ignore malformed SSE frame
          }
        }
      }

      const mRes = await fetch('/api/metrics');
      if (mRes.ok) setMetrics(await mRes.json());
    } catch (err) {
      setBriefError(err instanceof Error ? err.message : 'Network error during brief synthesis');
    } finally {
      setRegeneratingBrief(false);
      setStreamPreview(null);
    }
  };

  const handleRunBacktest = async () => {
    setRunningBacktest(true);
    setActionError(null);
    try {
      const res = await fetch('/api/backtest/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status} running backtest`);
      if (data.metrics) setMetrics(data.metrics);
      const repRes = await fetch(
        '/api/replay?pair=68762,59103&from=2026-09-25T00:00:00Z&to=2026-10-25T00:00:00Z',
      );
      if (repRes.ok) {
        setReplayDataset(await repRes.json());
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to run backtest');
    } finally {
      setRunningBacktest(false);
    }
  };

  const handleClaimChecked = useCallback((newClaim: VerifiedWebClaim) => {
    setClaims((prev) => [newClaim, ...prev.filter((c) => c.id !== newClaim.id)]);
    void fetch('/api/metrics')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (m) setMetrics(m);
      });
  }, []);

  const handleRegisterWatch = async (input: {
    label: string;
    noradIds: string;
    notifyChannel: string;
  }) => {
    setSubmittingFleet(true);
    setFleetError(null);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const payload = await res.json();
      if (!res.ok) {
        setFleetError(payload.error || 'Failed to register fleet watch');
        return;
      }
      if (payload.subscription) {
        setFleetSubscriptions((prev) => [payload.subscription, ...prev]);
      }
      if (payload.satellites) setSatellites(payload.satellites);
      if (payload.pairs) setPairs(payload.pairs);
      if (payload.alertDeliveries?.length) {
        setAlertDeliveries((prev) => [...payload.alertDeliveries, ...prev]);
      }
    } catch (err) {
      setFleetError(err instanceof Error ? err.message : 'Network error registering fleet');
    } finally {
      setSubmittingFleet(false);
    }
  };

  const handleDeleteWatch = async (id: string) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to delete fleet subscription');
      }
      setFleetSubscriptions((prev) => prev.filter((s) => s.id !== id));
      if (activeFleetId === id) setActiveFleetId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove fleet subscription');
    }
  };

  const navItems: { id: ActiveWorkspaceTab; label: string }[] = [
    { id: 'console', label: 'Console' },
    { id: 'history', label: 'Replay' },
    { id: 'fleet', label: 'Watch Fleet' },
  ];

  const orbitScan = metrics?.orbitScan;
  const dbEngineLabel =
    metrics?.database.engine === 'aiven-postgresql'
      ? 'State: Aiven PostgreSQL, EU'
      : 'State: Local SQLite Fallback';

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      {/* 3-Zone Top Bar: [Wordmark] — [Focused Nav Links] — [Under the hood Drawer Trigger] */}
      <header className="flex items-center justify-between gap-6 border-b border-[#262626] bg-black px-5 py-3 no-print">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            handleReturnToLanding();
          }}
          className="text-base font-semibold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          Specola
        </a>

        <nav
          aria-label="Primary Workspace Views"
          className="hidden md:flex items-center gap-6 text-xs font-medium text-[#737373]"
        >
          {navItems.map((item) => {
            const isCurrent = activeTab === item.id;
            return (
              <a
                key={item.id}
                href={item.id === 'console' ? '/' : `#${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigateToTab(item.id);
                }}
                aria-current={isCurrent ? 'page' : undefined}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b ${
                  isCurrent
                    ? 'border-white text-white font-semibold'
                    : 'border-transparent hover:text-white'
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowWhatIsSpecola(true)}
            className="border border-[#262626] bg-black px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#D4D4D4] transition-colors hover:border-white hover:text-white whitespace-nowrap shrink-0"
          >
            What is Specola?
          </button>
          <button
            type="button"
            onClick={handleLaunchDemo}
            className="border border-white bg-black px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white hover:text-black whitespace-nowrap shrink-0"
            title="Jump to Oct 16 COSMOS 2612 ↔ ICEYE-X36 close approach closeup demo"
          >
            Demo
          </button>
          <button
            type="button"
            onClick={() => setShowUnderTheHood(true)}
            className="border border-[#262626] bg-black px-3 py-1.5 text-xs font-medium text-[#D4D4D4] transition-colors hover:border-white hover:text-white whitespace-nowrap shrink-0"
          >
            Under the hood
          </button>
        </div>
      </header>

      {/* Mobile Navigation Bar (<md only) */}
      <div className="flex md:hidden items-center gap-1 overflow-x-auto border-b border-[#262626] bg-[#0A0A0A] px-3 py-1.5 no-print">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => navigateToTab(item.id)}
            className={`px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 ${
              activeTab === item.id ? 'bg-white text-black font-semibold' : 'text-[#A3A3A3]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Main Workspace */}
      <main className="mx-auto w-full max-w-[1840px] flex-1 px-3 py-3 lg:px-4 space-y-3">
        {actionError && (
          <div className="flex items-center justify-between gap-3 border border-white bg-[#0A0A0A] px-3.5 py-2 text-xs text-white no-print">
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="border border-[#262626] px-2 py-0.5 font-mono-tabular text-[10px] hover:border-white"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeFleet && activeTab === 'console' && (
          <div className="flex flex-wrap items-center justify-between gap-2 border border-white bg-[#0A0A0A] px-3.5 py-2 text-xs text-white no-print">
            <span>
              Scoped to Customer Fleet: <strong>{activeFleet.label}</strong> (
              {visiblePairs.length} threats shown · {activeFleet.noradIds.join(', ')})
            </span>
            <button
              type="button"
              onClick={() => setActiveFleetId(null)}
              className="border border-[#262626] bg-black px-2.5 py-0.5 text-[11px] hover:border-white"
            >
              Show All Watchlist Satellites
            </button>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="h-[520px] border border-[#262626] bg-[#0A0A0A] lg:col-span-4 animate-pulse" />
            <div className="h-[520px] border border-[#262626] bg-[#0A0A0A] lg:col-span-8 animate-pulse" />
          </div>
        ) : loadError ? (
          <div className="border border-white bg-[#0A0A0A] p-5">
            <h2 className="text-sm font-semibold text-white">Backend Telemetry Unavailable</h2>
            <p className="mt-1 text-xs text-[#A3A3A3]">{loadError}</p>
            <button
              type="button"
              onClick={() => void loadWorkspaceState()}
              className="mt-3 border border-white bg-white px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-[#E5E5E5]"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* CONSOLE: Strictly 72h Orbit Scan Strip + Live Feed + Globe + Selected Event */}
            {activeTab === 'console' && (
              <div className="space-y-3">
                {/* Unified Console Toolbar: Moved Constellation/Regime Selector + 72h Scan Control */}
                <div className="flex flex-wrap items-center justify-between gap-2 border border-[#262626] bg-[#0A0A0A] px-2.5 py-1.5 font-mono-tabular text-[11px] text-[#A3A3A3] no-print">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <div className="flex items-center overflow-x-auto border border-[#262626] bg-black p-0.5 max-w-full">
                      {CONSOLE_GROUP_OPTIONS.filter((opt) => opt.id !== 'pair' || selectedPair !== null).map((opt) => {
                        const isSelected =
                          (opt.id === 'pair' && globeViewMode === 'pair') ||
                          (opt.id !== 'pair' && globeViewMode === 'group' && activeGroup === opt.id);
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            disabled={loadingGroup}
                            onClick={() => {
                              if (opt.id === 'pair') {
                                setGlobeViewMode('pair');
                              } else {
                                setGlobeViewMode('group');
                                void handleSelectGroup(opt.id);
                              }
                            }}
                            className={`px-2 py-0.5 text-[10px] transition-colors whitespace-nowrap shrink-0 ${
                              isSelected
                                ? 'bg-white text-black font-semibold'
                                : 'text-[#A3A3A3] hover:text-white'
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>

                    {globeViewMode === 'group' && (
                      <div className="flex items-center border border-[#262626] bg-black p-0.5">
                        {(['ALL', 'LEO', 'GEO'] as const).map((reg) => (
                          <button
                            key={reg}
                            type="button"
                            onClick={() => setRegimeFilter(reg)}
                            className={`px-1.5 py-0.5 text-[10px] transition-colors ${
                              regimeFilter === reg
                                ? 'bg-white text-black font-semibold'
                                : 'text-[#737373] hover:text-white'
                            }`}
                          >
                            {reg}
                          </button>
                        ))}
                      </div>
                    )}

                    {loadingGroup && (
                      <span className="text-[10px] text-white">Loading catalog...</span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 text-[10px]">
                    <span className="hidden sm:inline">
                      72h Scan:{' '}
                      <strong className="text-white">{formatShortUtc(orbitScan?.lastScanUtc)}</strong>
                      {' · '}
                      <strong className="text-white">{orbitScan?.pairsScreened ?? '—'}</strong> pairs
                    </span>
                  </div>
                </div>

                {/* Full-Width Hero Globe Console (Both sidebars removed for uncluttered view) */}
                <OrbitalGlobe
                  satellites={satellites}
                  groupSatellites={groupSatellites[activeGroup]}
                  activeGroup={activeGroup}
                  viewMode={globeViewMode}
                  regimeFilter={regimeFilter}
                  selectedPair={selectedPair}
                  onSelectSatellite={handleSelectSatelliteOnGlobe}
                  onSweepSatellite={handleSweepSatellite}
                  sweepingNorad={sweepingNorad}
                  events={events}
                  maneuvers={maneuvers}
                  feed={feed}
                  onOpenAlertContext={handleOpenAlertContext}
                  onClearPair={() => {
                    setSelectedPairKey(null);
                    setGlobeViewMode('group');
                  }}
                  demoTrigger={demoTrigger}
                  landingResetSeq={landingResetSeq}
                  onDemoComplete={handleReturnToLanding}
                />
              </div>
            )}

            {/* DEDICATED ALERT CONTEXT PAGE (Only reachable via More info on an alert) */}
            {activeTab === 'alert_context' && selectedAlert && (() => {
              const matchedPair =
                (selectedAlert.pairKey
                  ? pairs.find(
                      (p) => `${p.suspectNoradId}-${p.protectedNoradId}` === selectedAlert.pairKey,
                    )
                  : undefined) ??
                (selectedAlert.noradId
                  ? pairs.find(
                      (p) =>
                        p.suspectNoradId === selectedAlert.noradId ||
                        p.protectedNoradId === selectedAlert.noradId,
                    )
                  : undefined) ??
                null;
              const matchedEvent =
                (selectedAlert.eventId
                  ? events.find((e) => e.id === selectedAlert.eventId)
                  : undefined) ??
                (selectedAlert.pairKey
                  ? events.find((e) => e.pairKey === selectedAlert.pairKey)
                  : undefined) ??
                (selectedAlert.noradId
                  ? events.find(
                      (e) =>
                        e.suspectNoradId === selectedAlert.noradId ||
                        e.protectedNoradId === selectedAlert.noradId,
                    )
                  : undefined) ??
                null;
              const matchedBrief = matchedEvent
                ? briefs.find((b) => b.eventId === matchedEvent.id || b.id === matchedEvent.briefId) ??
                  null
                : null;
              return (
                <div className="mx-auto max-w-[1100px]">
                  <AlertContextView
                    alarm={selectedAlert}
                    satellites={satellites}
                    matchedPair={matchedPair}
                    matchedEvent={matchedEvent}
                    matchedBrief={matchedBrief}
                    onBack={() => navigateToTab('console')}
                    onFocusOnGlobe={(pairKey) => {
                      if (pairKey) {
                        handleSelectPairKey(pairKey);
                        setGlobeViewMode('pair');
                      }
                      navigateToTab('console');
                    }}
                    onOpenEventDossier={(eventId) => openShareableEventPage(eventId)}
                    onContextSynced={(nextClaims, nextMetrics) => {
                      setClaims(nextClaims);
                      if (nextMetrics) setMetrics(nextMetrics);
                    }}
                  />
                </div>
              );
            })()}

            {/* ONE CLICK DEEP: Minimalistic Replay (Separation Chart + Milestones Only, No Globe) */}
            {activeTab === 'history' && (
              <div className="mx-auto max-w-[1280px]">
                <ReplayTimeline
                  dataset={replayDataset}
                  activeIndex={replayIndex}
                  onChangeIndex={setReplayIndex}
                  selectedPairKey={selectedPairKey ?? '68762-59103'}
                  loadingReplay={loadingReplay}
                  onSelectCampaign={handleSelectReplayCampaign}
                />
              </div>
            )}

            {/* ONE CLICK DEEP: Event Page (Clean Dossier — 3D Approach, Brief & Sources) */}
            {activeTab === 'event' && (
              <div className="mx-auto max-w-[1360px]">
                <EventDetailView
                  eventId={selectedEventId}
                  satellites={satellites}
                  events={events}
                  pairs={pairs}
                  briefs={briefs}
                  claims={claims}
                  metrics={metrics}
                  onBack={() => navigateToTab('console')}
                  onRegenerateBrief={handleRegenerateBrief}
                  regeneratingBrief={regeneratingBrief}
                  streamPreview={streamPreview}
                  briefError={briefError}
                  onClaimChecked={handleClaimChecked}
                />
              </div>
            )}

            {/* ONE CLICK DEEP: Watch Fleet */}
            {activeTab === 'fleet' && (
              <WatchMyFleetView
                satellites={satellites}
                subscriptions={fleetSubscriptions}
                alertDeliveries={alertDeliveries}
                activeFleetId={activeFleetId}
                onSelectActiveFleet={(id) => {
                  setActiveFleetId(id);
                  if (id) navigateToTab('console');
                }}
                onOpenEvent={openShareableEventPage}
                onRegisterWatch={handleRegisterWatch}
                onDeleteWatch={handleDeleteWatch}
                submitting={submittingFleet}
                errorMsg={fleetError}
              />
            )}
          </>
        )}
      </main>

      <footer className="border-t border-[#262626] bg-black px-5 py-2.5 text-[11px] text-[#737373] no-print">
        <div className="mx-auto flex max-w-[1520px] flex-wrap items-center justify-between gap-2">
          <span>
            Specola — Screening-grade analysis (public GP ~1 km, +1–3 km/day). Not a collision warning service.
          </span>
          <span className="font-mono-tabular text-[#D4D4D4]">{dbEngineLabel}</span>
        </div>
      </footer>

      {/* Closed-by-default What is Specola & Under the Hood Drawers */}
      <WhatIsSpecolaModal
        isOpen={showWhatIsSpecola}
        onClose={() => setShowWhatIsSpecola(false)}
        onOpenIceyeIncident={handleLaunchDemo}
        onOpenWatchFleet={() => navigateToTab('fleet')}
      />

      <UnderTheHoodDrawer
        isOpen={showUnderTheHood}
        onClose={() => setShowUnderTheHood(false)}
        metrics={metrics}
        onRunBacktest={handleRunBacktest}
        runningBacktest={runningBacktest}
      />
    </div>
  );
}
