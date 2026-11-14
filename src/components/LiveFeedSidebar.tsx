import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, PanelLeftClose } from 'lucide-react';
import type { LiveFeedItem } from '../shared/types';

interface LiveFeedSidebarProps {
  feedItems: LiveFeedItem[];
  onSelectPair?: (pairKey: string) => void;
  onSimulateWebhook: () => Promise<void>;
  simulatingWebhook: boolean;
  sseConnected: boolean;
  activeFleetLabel?: string | null;
  onCollapse?: () => void;
}

type FeedFilter = 'all' | 'web' | 'orbit' | 'briefs';

export function LiveFeedSidebar({
  feedItems,
  onSelectPair,
  onSimulateWebhook,
  simulatingWebhook,
  sseConnected,
  activeFleetLabel = null,
  onCollapse,
}: LiveFeedSidebarProps) {
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('all');
  const [expandedFeedId, setExpandedFeedId] = useState<string | null>(null);

  const filteredFeed = feedItems.filter((item) => {
    if (feedFilter === 'all') return true;
    if (feedFilter === 'web') {
      return (
        item.kind === 'monitor_fired' ||
        item.kind === 'claim_extracted' ||
        item.kind === 'claim_verified'
      );
    }
    if (feedFilter === 'orbit') {
      return item.kind === 'elements_ingested' || item.kind === 'maneuver_detected';
    }
    return item.kind === 'brief_generated' || item.kind === 'alert_dispatched';
  });

  const formatKindTag = (kind: LiveFeedItem['kind']): string => {
    switch (kind) {
      case 'elements_ingested':
        return 'ORBIT';
      case 'maneuver_detected':
        return 'BURN';
      case 'monitor_fired':
        return 'WEB';
      case 'claim_extracted':
        return 'CLAIM';
      case 'claim_verified':
        return 'SGP4';
      case 'brief_generated':
        return 'BRIEF';
      case 'alert_dispatched':
        return 'NOTIFY';
    }
  };

  return (
    <aside className="flex flex-col border border-[#262626] bg-[#0A0A0A] text-white lg:h-[760px]">
      <div className="border-b border-[#262626] p-2.5">
        <div className="flex items-center justify-between gap-1.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white">
                Live Feed
              </h2>
              <span className="font-mono-tabular text-[10px] text-[#737373]">
                {sseConnected ? 'SSE' : 'SYNC'}
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono-tabular text-[10px] text-[#737373]">
              Aiven · {feedItems.length}
              {activeFleetLabel ? ` · ${activeFleetLabel}` : ''}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onSimulateWebhook}
              disabled={simulatingWebhook}
              className="border border-[#262626] bg-black px-2 py-1 text-[10px] font-medium text-white transition-colors hover:border-white disabled:opacity-50 whitespace-nowrap"
              title="Trigger Context.dev webhook → Gemini extraction → SGP4 verification → Alert pipeline"
            >
              {simulatingWebhook ? 'Running...' : 'Sim Webhook'}
            </button>
            {onCollapse && (
              <button
                type="button"
                onClick={onCollapse}
                title="Collapse Live Feed sidebar"
                aria-label="Collapse Live Feed sidebar"
                className="border border-[#262626] bg-black p-1 text-[#A3A3A3] transition-colors hover:border-white hover:text-white"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="mt-2 grid grid-cols-4 border border-[#262626] bg-black">
          {(
            [
              ['all', 'All'],
              ['web', 'Web'],
              ['orbit', 'Orbit'],
              ['briefs', 'Briefs'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFeedFilter(key)}
              className={`py-1 text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                feedFilter === key
                  ? 'bg-white text-black font-semibold'
                  : 'text-[#A3A3A3] hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 max-h-[520px] lg:max-h-none divide-y divide-[#1F1F1F] overflow-y-auto bg-black">
        {filteredFeed.length === 0 ? (
          <div className="p-3.5 text-xs text-[#737373]">
            No events recorded in this filter yet.
          </div>
        ) : (
          filteredFeed.map((item) => {
            const expanded = expandedFeedId === item.id;
            return (
              <div key={item.id} className="bg-black">
                <button
                  type="button"
                  onClick={() => {
                    setExpandedFeedId((prev) => (prev === item.id ? null : item.id));
                    if (item.pairKey && onSelectPair) {
                      onSelectPair(item.pairKey);
                    }
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-[#141414]"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {expanded ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-white" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-[#737373]" />
                    )}
                    <span className="font-mono-tabular text-[10px] text-[#737373] shrink-0">
                      {formatKindTag(item.kind)}
                    </span>
                    <span className="truncate text-xs text-[#E5E5E5]">{item.headline}</span>
                  </div>
                  <time className="font-mono-tabular text-[10px] text-[#737373] whitespace-nowrap shrink-0">
                    {item.timestampUtc.slice(11, 16)}Z
                  </time>
                </button>

                {expanded && (
                  <div className="border-t border-[#1F1F1F] bg-[#0A0A0A] px-3 py-2.5 text-xs text-[#A3A3A3] space-y-2">
                    <div className="font-mono-tabular text-[10px] text-[#737373]">
                      {item.timestampUtc.slice(0, 19).replace('T', ' ')}Z
                      {item.pairKey ? ` · Pair #${item.pairKey}` : ''}
                    </div>
                    <p className="leading-relaxed text-white">{item.detail}</p>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px]">
                      {item.sourceOrCalc ? (
                        item.sourceOrCalc.startsWith('http') ? (
                          <a
                            href={item.sourceOrCalc}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-white underline hover:text-[#A3A3A3]"
                          >
                            <span className="truncate max-w-[220px]">{item.sourceOrCalc}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        ) : (
                          <span className="font-mono-tabular text-[#A3A3A3]">
                            {item.sourceOrCalc}
                          </span>
                        )
                      ) : (
                        <span />
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
