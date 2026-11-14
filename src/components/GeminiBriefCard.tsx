import { useMemo, useState } from 'react';
import { Copy, Download, ExternalLink, Printer, RefreshCw } from 'lucide-react';
import type {
  OrbitalEventRecord,
  StoredDecisionBrief,
} from '../shared/types';

interface GeminiBriefCardProps {
  event: OrbitalEventRecord | null;
  brief: StoredDecisionBrief | null;
  onRegenerateBrief: (eventId: string, force?: boolean) => Promise<void>;
  regeneratingBrief: boolean;
  streamPreview?: string | null;
  briefError: string | null;
}

export function buildBriefMarkdown(
  brief: StoredDecisionBrief,
  event: OrbitalEventRecord | null,
): string {
  return [
    `# ${brief.title}`,
    `**Event ID:** ${brief.eventId} | **Threat:** ${brief.threat_level} | **Status:** ${brief.status.toUpperCase()}`,
    `**Model:** ${brief.modelUsed} | **Origin:** ${brief.isSeeded ? 'SEEDED ARCHIVE' : 'LIVE GEMINI'} | **Generation Time:** ${brief.latencyMs > 0 ? `${brief.latencyMs} ms` : 'Archived baseline'} | **Generated:** ${brief.generatedAtUtc}`,
    event
      ? `**Pair:** ${event.suspectName} (#${event.suspectNoradId}) ↔ ${event.protectedName} (#${event.protectedNoradId}) | **Min Range:** ${event.minDistanceKm.toFixed(2)} km | **Plane Δθ:** ${event.planeAngleDeg.toFixed(3)}°`
      : '',
    '',
    '## Executive Summary',
    brief.summary,
    '',
    '## Grounded Evidence & Orbit Computations',
    ...brief.evidence.map(
      (ev, i) =>
        `${i + 1}. **[${ev.verification_tag.toUpperCase()}]** ${ev.claim}\n   - Date Provenance: ${ev.source_date || event?.eventTimeUtc || 'N/A'}\n   - Origin: ${ev.data_origin || '18th SDS Space-Track GP + SGP4'}\n   - Orbit Check: ${ev.orbit_calc || 'N/A'}${ev.source_url ? `\n   - Source URL: ${ev.source_url}` : ''}`,
    ),
    '',
    '## Recommended Operator Actions',
    ...brief.recommended_actions.map((a, i) => `${i + 1}. ${a}`),
    '',
    '## Who to Notify',
    ...brief.who_to_notify.map((n, i) => `${i + 1}. ${n}`),
    '',
    '## Screening Uncertainty Notice',
    brief.uncertainty_statement,
    '',
    '_Screening-grade analysis from Space-Track/CelesTrak public GP (~1 km epoch error, +1–3 km/day). Not a collision warning service._',
  ]
    .filter(Boolean)
    .join('\n');
}

function splitIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter(Boolean);
}

function matchSentenceToEvidenceIndex(
  sentence: string,
  sentenceIndex: number,
  evidence: StoredDecisionBrief['evidence'],
): number {
  if (evidence.length === 0) return -1;
  const sLower = sentence.toLowerCase();
  const sNums = sentence.match(/\d+(?:\.\d+)?/g) ?? [];

  let bestIdx = sentenceIndex % evidence.length;
  let bestScore = -1;

  evidence.forEach((ev, idx) => {
    let score = 0;
    const evText = `${ev.claim} ${ev.orbit_calc ?? ''} ${ev.source_url ?? ''}`.toLowerCase();
    for (const n of sNums) {
      if (n.length >= 2 && evText.includes(n)) score += 5;
    }
    const words = sLower.split(/\W+/).filter((w) => w.length >= 4);
    for (const w of words) {
      if (evText.includes(w)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  return bestIdx;
}

export function GeminiBriefCard({
  event,
  brief,
  onRegenerateBrief,
  regeneratingBrief,
  streamPreview,
  briefError,
}: GeminiBriefCardProps) {
  const [selectedSentenceIdx, setSelectedSentenceIdx] = useState<number | null>(0);
  const [selectedEvidenceIdx, setSelectedEvidenceIdx] = useState<number | null>(0);
  const [copiedMd, setCopiedMd] = useState(false);

  const sentences = useMemo(
    () => (brief ? splitIntoSentences(brief.summary) : []),
    [brief],
  );

  const sentenceLinks = useMemo(() => {
    if (!brief) return [];
    return sentences.map((s, idx) => matchSentenceToEvidenceIndex(s, idx, brief.evidence));
  }, [sentences, brief]);

  if (!event || !brief) {
    return (
      <section className="border border-[#262626] bg-[#0A0A0A] p-4 text-xs text-[#737373]">
        Select an orbital event or close-approach pair to inspect the Gemini decision brief.
      </section>
    );
  }

  const activeEvidenceIdx =
    selectedEvidenceIdx !== null && brief.evidence[selectedEvidenceIdx]
      ? selectedEvidenceIdx
      : 0;
  const highlightedEvidence = brief.evidence[activeEvidenceIdx] ?? null;

  const handleClickSentence = (sIdx: number) => {
    setSelectedSentenceIdx(sIdx);
    const linkedIdx = sentenceLinks[sIdx];
    if (linkedIdx !== undefined && linkedIdx >= 0) {
      setSelectedEvidenceIdx(linkedIdx);
    }
  };

  const handleCopyMd = () => {
    void navigator.clipboard?.writeText(buildBriefMarkdown(brief, event)).then(() => {
      setCopiedMd(true);
      window.setTimeout(() => setCopiedMd(false), 1800);
    });
  };

  const handleDownloadMd = () => {
    const md = buildBriefMarkdown(brief, event);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `specola-${event.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="border border-[#262626] bg-[#0A0A0A] p-4 text-white space-y-3">
      {/* Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#262626] pb-3">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono-tabular text-[11px] text-[#A3A3A3]">
            <span className="border border-white bg-white px-1.5 py-0.5 font-semibold text-black">
              {brief.threat_level}
            </span>
            <span className="uppercase text-white">{brief.status.replace('_', ' ')}</span>
            <span>· TCA {event.minDistanceKm.toFixed(2)} km</span>
            <span>· Δθ {event.planeAngleDeg.toFixed(3)}°</span>
          </div>
          <h2 className="text-sm font-semibold tracking-tight text-white">
            {brief.title}
          </h2>
          <div className="font-mono-tabular text-[10px] text-[#737373]">
            {brief.modelUsed}
            {brief.latencyMs > 0 ? ` · ${brief.latencyMs} ms` : ' · archived baseline'}
            {brief.cached ? ' [CACHED]' : ''} · {brief.generatedAtUtc.slice(0, 16).replace('T', ' ')}Z
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0 no-print">
          <button
            type="button"
            onClick={handleCopyMd}
            className="inline-flex items-center gap-1 border border-[#262626] bg-black px-2 py-1 text-[11px] text-[#A3A3A3] hover:border-white hover:text-white"
            title="Copy Markdown brief"
          >
            <Copy className="h-3 w-3" />
            <span>{copiedMd ? 'Copied' : 'MD'}</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadMd}
            className="inline-flex items-center gap-1 border border-[#262626] bg-black px-2 py-1 text-[11px] text-[#A3A3A3] hover:border-white hover:text-white"
            title="Download .md"
          >
            <Download className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 border border-[#262626] bg-black px-2 py-1 text-[11px] text-[#A3A3A3] hover:border-white hover:text-white"
            title="Print / Export PDF"
          >
            <Printer className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void onRegenerateBrief(event.id, !brief.isSeeded)}
            disabled={regeneratingBrief}
            className="inline-flex items-center gap-1.5 border border-white bg-white px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-[#E5E5E5] disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw className={`h-3 w-3 ${regeneratingBrief ? 'animate-spin' : ''}`} />
            <span>{regeneratingBrief ? 'Streaming...' : 'Synthesize Brief'}</span>
          </button>
        </div>
      </div>

      {regeneratingBrief && streamPreview && (
        <div className="border border-[#262626] bg-black p-2.5 font-mono-tabular text-[11px] text-[#A3A3A3] space-y-1">
          <div className="text-white font-semibold">
            Streaming Gemini output ({streamPreview.length} chars received)...
          </div>
          <div className="max-h-20 overflow-hidden text-[10px] text-[#737373] break-all">
            {streamPreview.slice(-260)}
          </div>
        </div>
      )}

      {briefError && (
        <div className="border border-white bg-black p-2.5 text-xs text-white">{briefError}</div>
      )}

      {/* Interactive Sentence-Level Grounding */}
      <div className="space-y-1.5">
        <p className="text-xs leading-relaxed text-[#E5E5E5]">
          {sentences.map((sentence, idx) => {
            const isSelected = selectedSentenceIdx === idx;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => handleClickSentence(idx)}
                className={`mr-1.5 inline text-left transition-colors ${
                  isSelected
                    ? 'bg-white text-black px-1 py-0.5 font-medium'
                    : 'hover:bg-[#1A1A1A] hover:text-white underline decoration-[#404040] underline-offset-4'
                }`}
              >
                {sentence}
              </button>
            );
          })}
        </p>
      </div>

      {/* Highlighted Source / Orbit Computation Trace */}
      {highlightedEvidence && (
        <div className="border border-white bg-black p-3 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-[10px]">
            <span className="uppercase font-semibold text-white">
              Grounded Evidence #{activeEvidenceIdx + 1} ·{' '}
              {highlightedEvidence.verification_tag.replace(/_/g, ' ')}
            </span>
            <span className="text-[#A3A3A3]">
              {highlightedEvidence.source_date || event.eventTimeUtc.slice(0, 10)} ·{' '}
              {highlightedEvidence.data_origin || 'Space-Track + SGP4'}
            </span>
          </div>
          <p className="text-xs text-white leading-snug">{highlightedEvidence.claim}</p>
          {highlightedEvidence.orbit_calc && (
            <div className="font-mono-tabular text-[11px] text-[#D4D4D4]">
              Orbit Computation: <span className="text-white">{highlightedEvidence.orbit_calc}</span>
            </div>
          )}
          {highlightedEvidence.source_url && (
            <div>
              <a
                href={highlightedEvidence.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono-tabular text-[11px] text-white underline hover:text-[#A3A3A3]"
              >
                <span>{highlightedEvidence.source_url}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          )}
        </div>
      )}

      {/* Evidence Selector */}
      {brief.evidence.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {brief.evidence.map((ev, idx) => {
            const active = activeEvidenceIdx === idx;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  setSelectedEvidenceIdx(idx);
                  const matchingSent = sentenceLinks.findIndex((link) => link === idx);
                  setSelectedSentenceIdx(matchingSent >= 0 ? matchingSent : null);
                }}
                className={`border px-2 py-0.5 font-mono-tabular text-[10px] transition-colors ${
                  active
                    ? 'border-white bg-white text-black font-semibold'
                    : 'border-[#262626] bg-black text-[#A3A3A3] hover:border-white hover:text-white'
                }`}
              >
                #{idx + 1} {ev.verification_tag.replace(/_/g, ' ').toUpperCase()}
              </button>
            );
          })}
        </div>
      )}

      {/* Recommended Actions + Who to Notify */}
      {(brief.recommended_actions.length > 0 || brief.who_to_notify.length > 0) && (
        <div className="grid grid-cols-1 gap-3 border-t border-[#1F1F1F] pt-3 sm:grid-cols-2">
          <div>
            <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-[#737373]">
              Recommended Actions
            </div>
            <ul className="mt-1 space-y-1 text-xs text-[#E5E5E5]">
              {brief.recommended_actions.map((action, idx) => (
                <li key={idx} className="leading-snug">
                  · {action}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-[#737373]">
              Who to Notify
            </div>
            <ul className="mt-1 space-y-1 text-xs text-[#E5E5E5]">
              {brief.who_to_notify.map((target, idx) => (
                <li key={idx} className="leading-snug">
                  · {target}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="font-mono-tabular text-[10px] text-[#737373] border-t border-[#1F1F1F] pt-2">
        {brief.uncertainty_statement}
      </div>
    </section>
  );
}
