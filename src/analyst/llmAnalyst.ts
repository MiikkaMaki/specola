import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  DecisionBriefSchema,
  ExtractedClaimSchema,
} from '../shared/types.ts';
import type {
  DecisionBriefPayload,
  ExtractedClaimInput,
  ManeuverDetection,
  OrbitalEventRecord,
  PairTelemetrySnapshot,
  SatelliteDossierProfile,
  SatelliteIdentityCategory,
  VerifiedWebClaim,
} from '../shared/types.ts';

export const GEMINI_BRIEF_MODEL = 'gemini-4-carbon';
export const GEMINI_EXTRACT_MODEL = 'gemini-4-hydrogen';
const GEMINI_MODEL_CASCADE = ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen'] as const;
const GEMINI_EXTRACT_CASCADE = ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon'] as const;

let sharedGeminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  if (!sharedGeminiClient) {
    sharedGeminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return sharedGeminiClient;
}

export function getConfiguredLlmProviderInfo(): {
  providerMode: 'gemini-native' | 'openai-compatible-wrapper';
  activeModel: string;
  extractionModel: string;
} {
  const customBaseUrl = process.env.LLM_BASE_URL?.trim();
  const customKey = process.env.LLM_API_KEY?.trim();
  if (customBaseUrl && customKey) {
    return {
      providerMode: 'openai-compatible-wrapper',
      activeModel: process.env.LLM_MODEL?.trim() || GEMINI_BRIEF_MODEL,
      extractionModel: process.env.LLM_EXTRACT_MODEL?.trim() || GEMINI_EXTRACT_MODEL,
    };
  }
  return {
    providerMode: 'gemini-native',
    activeModel: process.env.LLM_MODEL?.trim() || GEMINI_BRIEF_MODEL,
    extractionModel: process.env.LLM_EXTRACT_MODEL?.trim() || GEMINI_EXTRACT_MODEL,
  };
}

async function generateStructuredJson(params: {
  systemInstruction: string;
  prompt: string;
  geminiResponseSchema: Record<string, unknown>;
  task?: 'extract' | 'brief';
}): Promise<{ jsonText: string; modelUsed: string }> {
  const customBaseUrl = process.env.LLM_BASE_URL?.trim();
  const customKey = process.env.LLM_API_KEY?.trim();

  if (customBaseUrl && customKey) {
    const model = process.env.LLM_MODEL?.trim() || GEMINI_BRIEF_MODEL;
    const res = await fetch(`${customBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: params.systemInstruction },
          { role: 'user', content: params.prompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty JSON completion from wrapper');
    return { jsonText: content, modelUsed: model };
  }

  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured in environment.');
  }

  const cascade = params.task === 'extract' ? GEMINI_EXTRACT_CASCADE : GEMINI_MODEL_CASCADE;
  const preferred =
    params.task === 'extract'
      ? process.env.LLM_EXTRACT_MODEL?.trim()
      : process.env.LLM_MODEL?.trim();
  const modelsToTry = preferred
    ? [preferred, ...cascade.filter((m) => m !== preferred)]
    : [...cascade];

  let lastError: unknown;
  for (const modelName of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: params.prompt,
        config: {
          systemInstruction: params.systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: params.geminiResponseSchema,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });
      const text = (response.text ?? '').trim();
      if (text) {
        return { jsonText: text, modelUsed: modelName };
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Gemini structured generation failed');
}

export async function extractStructuredClaimWithGemini(params: {
  rawTextOrMarkdown: string;
  sourceUrl: string;
  publishedAt?: string | null;
}): Promise<{ claim: ExtractedClaimInput; modelUsed: string; latencyMs: number }> {
  const t0 = performance.now();

  const schema = {
    type: Type.OBJECT,
    properties: {
      satellite_names: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      norad_ids: {
        type: Type.ARRAY,
        items: { type: Type.INTEGER },
      },
      claim_type: {
        type: Type.STRING,
        enum: ['approach', 'maneuver', 'interference', 'other'],
      },
      claim_text: {
        type: Type.STRING,
      },
      claimed_distance_km: {
        type: Type.NUMBER,
        nullable: true,
      },
      event_time: {
        type: Type.STRING,
        nullable: true,
      },
      source_url: {
        type: Type.STRING,
      },
      published_at: {
        type: Type.STRING,
        nullable: true,
      },
    },
    required: [
      'satellite_names',
      'norad_ids',
      'claim_type',
      'claim_text',
      'claimed_distance_km',
      'event_time',
      'source_url',
      'published_at',
    ],
  };

  try {
    const { jsonText, modelUsed } = await generateStructuredJson({
      systemInstruction:
        'Extract factual orbital proximity, maneuver, or interference claims. Map known names to NORAD IDs: COSMOS/Kosmos 2612->68762, ICEYE-X36->59103, SJ-17/Shijian-17->41838, Hotbird 13G->54225, Eutelsat 10B->54259, Luch-2/Olymp-2->55841, COMSATBW-1->35943, SJ-26->64199, Hyperfield-1A->60562, Hyperfield-1B->64552, Sentinel-1A->39634, Sentinel-2A->40697. Convert meters to km. claim_type MUST be one of approach, maneuver, interference, other.',
      prompt: `SOURCE URL: ${params.sourceUrl}\nPUBLISHED AT: ${params.publishedAt ?? 'unknown'}\n\nTEXT:\n${params.rawTextOrMarkdown}`,
      geminiResponseSchema: schema,
      task: 'extract',
    });

    const rawObj = JSON.parse(jsonText) as Record<string, unknown>;
    const rawType = String(rawObj.claim_type || 'other').toLowerCase();
    rawObj.claim_type = ['approach', 'maneuver', 'interference', 'other'].includes(rawType)
      ? rawType
      : /conjunction|close|pass|proxim/i.test(rawType)
        ? 'approach'
        : /burn|orbit|delta/i.test(rawType)
          ? 'maneuver'
          : 'other';
    const parsed = ExtractedClaimSchema.parse(rawObj);
    return {
      claim: {
        ...parsed,
        source_url: params.sourceUrl,
        published_at: parsed.published_at ?? params.publishedAt ?? new Date().toISOString(),
      },
      modelUsed,
      latencyMs: Math.max(1, Math.round(performance.now() - t0)),
    };
  } catch {
    const text = params.rawTextOrMarkdown;
    const noradIds = new Set<number>();
    const satNames: string[] = [];
    if (/68762|cosmos\s*2612|kosmos\s*2612/i.test(text)) {
      noradIds.add(68762);
      satNames.push('COSMOS 2612');
    }
    if (/59103|iceye[-\s]*x36/i.test(text)) {
      noradIds.add(59103);
      satNames.push('ICEYE-X36');
    }
    if (/41838|sj[-\s]*17|shijian[-\s]*17/i.test(text)) {
      noradIds.add(41838);
      satNames.push('SJ-17');
    }
    if (/54225|hotbird\s*13g/i.test(text)) {
      noradIds.add(54225);
      satNames.push('HOTBIRD 13G');
    }
    if (/55841|luch.*2|olymp.*2/i.test(text)) {
      noradIds.add(55841);
      satNames.push('LUCH (OLYMP) 2');
    }
    if (/35943|comsatbw/i.test(text)) {
      noradIds.add(35943);
      satNames.push('COMSATBW-1');
    }
    for (const m of text.matchAll(/\b(\d{5})\b/g)) {
      noradIds.add(Number(m[1]));
    }

    let claimedKm: number | null = null;
    const kmMatch = text.match(/(\d+(?:\.\d+)?)\s*km/i);
    const mMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:m|meters|metres)\b/i);
    if (kmMatch) claimedKm = Number(kmMatch[1]);
    else if (mMatch) claimedKm = Number((Number(mMatch[1]) / 1000).toFixed(3));

    let eventTime: string | null = '2026-10-16T07:28:00Z';
    if (/oct(?:ober)?\s*12/i.test(text)) eventTime = '2026-10-12T06:00:00Z';
    else if (/oct(?:ober)?\s*17/i.test(text)) eventTime = '2026-10-17T12:00:00Z';
    else if (/oct(?:ober)?\s*18/i.test(text)) eventTime = '2026-10-18T09:00:00Z';
    else if (/nov(?:ember)?\s*15/i.test(text)) eventTime = '2026-11-15T00:14:10Z';
    else if (/nov(?:ember)?\s*1[34]/i.test(text)) eventTime = '2026-11-13T12:00:00Z';

    return {
      claim: {
        satellite_names: satNames.length > 0 ? satNames : ['Unknown Object'],
        norad_ids: Array.from(noradIds),
        claim_type: /maneuver|burn|plane/i.test(text) ? 'maneuver' : 'approach',
        claim_text: text.slice(0, 220).trim(),
        claimed_distance_km: claimedKm,
        event_time: eventTime,
        source_url: params.sourceUrl,
        published_at: params.publishedAt ?? new Date().toISOString(),
      },
      modelUsed: 'deterministic-parser-fallback',
      latencyMs: Math.max(1, Math.round(performance.now() - t0)),
    };
  }
}

function enforceBriefEpistemicGuardrails(
  brief: DecisionBriefPayload,
  fallbackOrbitCalc: string,
  defaultOrigin: string,
): DecisionBriefPayload {
  const sanitizedEvidence = brief.evidence.map((ev) => {
    const hasSource = Boolean(ev.source_url && ev.source_url.trim().length > 0);
    const hasCalc = Boolean(ev.orbit_calc && ev.orbit_calc.trim().length > 0);
    return {
      ...ev,
      orbit_calc: !hasSource && !hasCalc ? fallbackOrbitCalc : ev.orbit_calc,
      data_origin: ev.data_origin || defaultOrigin,
      source_date: ev.source_date || null,
    };
  });

  let uncertainty = brief.uncertainty_statement.trim();
  if (!/1\s*km|covariance|TLE|GP/i.test(uncertainty)) {
    uncertainty = `${uncertainty} Public GP/TLE 1σ epoch error is ~1 km (+1–3 km/day along-track); sub-km estimates require owner/operator OEM ephemerides or radar tasking.`;
  }

  return {
    ...brief,
    evidence: sanitizedEvidence,
    uncertainty_statement: uncertainty,
  };
}

export function computeBriefInputsHash(params: {
  event: OrbitalEventRecord;
  claims: VerifiedWebClaim[];
  pairTelemetry: PairTelemetrySnapshot;
  maneuvers: ManeuverDetection[];
}): string {
  const canonical = {
    eventId: params.event.id,
    status: params.event.status,
    threatLevel: params.event.threatLevel,
    minDistanceKm: params.event.minDistanceKm,
    suspectEpochUtc: params.pairTelemetry?.suspectEpochUtc ?? null,
    protectedEpochUtc: params.pairTelemetry?.protectedEpochUtc ?? null,
    tca72hMinKm: params.pairTelemetry?.tca72h?.minDistanceKm ?? null,
    maneuverIds: params.maneuvers.slice(-6).map((m) => `${m.id}:${m.estimatedDeltaVMs}`),
    claims: params.claims.map((c) => `${c.id}:${c.verdict}:${c.computed_distance_km}`).sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24);
}

function buildBriefSchemaAndPrompt(params: {
  event: OrbitalEventRecord;
  claims: VerifiedWebClaim[];
  pairTelemetry: PairTelemetrySnapshot;
  maneuvers: ManeuverDetection[];
}) {
  const { event, claims, pairTelemetry, maneuvers } = params;
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      status: { type: Type.STRING, enum: ['confirmed', 'unconfirmed', 'early_warning'] },
      threat_level: { type: Type.STRING, enum: ['LOW', 'MEDIUM', 'HIGH'] },
      title: { type: Type.STRING },
      summary: { type: Type.STRING },
      affected_operators: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      evidence: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            claim: { type: Type.STRING },
            source_url: { type: Type.STRING, nullable: true },
            source_date: {
              type: Type.STRING,
              nullable: true,
              description: 'Exact UTC date/timestamp where the date came from (e.g. 2026-10-16T07:27:40Z or Published 2026-10-17).',
            },
            data_origin: {
              type: Type.STRING,
              nullable: true,
              description: 'Exact provenance of the data & date (e.g. 18th SDS Space-Track GP_History Epoch 2026-10-16T04:40Z + Orbital Radar).',
            },
            orbit_calc: { type: Type.STRING, nullable: true },
            verification_tag: {
              type: Type.STRING,
              enum: ['verified', 'caveated_sub_km', 'early_warning', 'contradicted'],
            },
          },
          required: ['claim', 'source_url', 'source_date', 'data_origin', 'orbit_calc', 'verification_tag'],
        },
      },
      recommended_actions: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      who_to_notify: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      uncertainty_statement: { type: Type.STRING },
    },
    required: [
      'status',
      'threat_level',
      'title',
      'summary',
      'affected_operators',
      'evidence',
      'recommended_actions',
      'who_to_notify',
      'uncertainty_statement',
    ],
  };

  const contextPayload = JSON.stringify(
    {
      event,
      live_sgp4_telemetry: pairTelemetry,
      detected_maneuvers: maneuvers.slice(-4),
      verified_web_claims: claims.map((c) => ({
        outlet: c.source_outlet,
        published_at: c.published_at,
        event_time: c.event_time,
        url: c.source_url,
        claim_text: c.claim_text,
        claimed_distance_km: c.claimed_distance_km,
        verdict: c.verdict,
        orbit_calc_reference: c.orbit_calc_reference,
      })),
    },
    null,
    2,
  );

  const systemInstruction = `You are a terse, factual European SSA orbital analyst. Zero filler, zero buzzwords.
RULES:
1. Keep summary <= 2 crisp sentences packed with numbers (NORAD IDs, distances km, plane angle deg, dates).
2. Every evidence[] item MUST state exact source_date (where the date came from: OMM epoch or article publication timestamp), data_origin (e.g. "18th SDS Space-Track GP_History + SatTrackCam Leiden"), and either source_url or orbit_calc.
3. Never claim confirmed sub-kilometer accuracy from public TLEs alone (~1 km 1-sigma epoch error). Mark sub-km claims 'caveated_sub_km'.`;

  const fallbackCalc = pairTelemetry.tca72h.computationSummary;
  const defaultOrigin = `18th SDS Space-Track GP (Epochs: ${pairTelemetry.suspectEpochUtc ?? 'live'} / ${pairTelemetry.protectedEpochUtc ?? 'live'})`;

  return {
    responseSchema,
    systemInstruction,
    prompt: `Synthesize terse, source-attributed decision brief:\n${contextPayload}`,
    fallbackCalc,
    defaultOrigin,
  };
}

export async function synthesizeDecisionBriefWithGemini(params: {
  event: OrbitalEventRecord;
  claims: VerifiedWebClaim[];
  pairTelemetry: PairTelemetrySnapshot;
  maneuvers: ManeuverDetection[];
}): Promise<{ brief: DecisionBriefPayload; modelUsed: string; latencyMs: number }> {
  const t0 = performance.now();
  const built = buildBriefSchemaAndPrompt(params);

  const { jsonText, modelUsed } = await generateStructuredJson({
    systemInstruction: built.systemInstruction,
    prompt: built.prompt,
    geminiResponseSchema: built.responseSchema,
    task: 'brief',
  });

  const validated = DecisionBriefSchema.parse(JSON.parse(jsonText));
  const guarded = enforceBriefEpistemicGuardrails(validated, built.fallbackCalc, built.defaultOrigin);

  return {
    brief: guarded,
    modelUsed,
    latencyMs: Math.max(1, Math.round(performance.now() - t0)),
  };
}

/**
 * Streams brief tokens live via Gemini generateContentStream (`gemini-4-carbon`),
 * emitting incremental chunks before validating and returning the complete brief.
 */
export async function synthesizeDecisionBriefStreamWithGemini(
  params: {
    event: OrbitalEventRecord;
    claims: VerifiedWebClaim[];
    pairTelemetry: PairTelemetrySnapshot;
    maneuvers: ManeuverDetection[];
  },
  onChunk: (chunkText: string, accumulatedChars: number) => void,
): Promise<{ brief: DecisionBriefPayload; modelUsed: string; latencyMs: number }> {
  const t0 = performance.now();
  const built = buildBriefSchemaAndPrompt(params);
  const ai = getGeminiClient();
  if (!ai) {
    return synthesizeDecisionBriefWithGemini(params);
  }

  const preferred = process.env.LLM_MODEL?.trim();
  const modelsToTry = preferred
    ? [preferred, ...GEMINI_MODEL_CASCADE.filter((m) => m !== preferred)]
    : [...GEMINI_MODEL_CASCADE];

  let lastError: unknown;
  for (const modelName of modelsToTry) {
    try {
      const responseStream = await ai.models.generateContentStream({
        model: modelName,
        contents: built.prompt,
        config: {
          systemInstruction: built.systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: built.responseSchema,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });
      let accumulated = '';
      for await (const chunk of responseStream) {
        const txt = chunk.text ?? '';
        if (txt) {
          accumulated += txt;
          onChunk(txt, accumulated.length);
        }
      }
      if (accumulated.trim()) {
        const validated = DecisionBriefSchema.parse(JSON.parse(accumulated));
        const guarded = enforceBriefEpistemicGuardrails(
          validated,
          built.fallbackCalc,
          built.defaultOrigin,
        );
        return {
          brief: guarded,
          modelUsed: modelName,
          latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Streaming Gemini brief generation failed');
}

/**
 * High-density, zero-fluff operational briefs covering Russian & Chinese close approaches to European satellites,
 * with explicit date origins (18th SDS Space-Track OMM epochs + dated OSINT publications).
 */
export function buildSeededDecisionBriefs(): Record<string, DecisionBriefPayload> {
  return {
    'brief-rpo-68762-59103': {
      status: 'confirmed',
      threat_level: 'HIGH',
      title: '[RU → EU LEO] COSMOS 2612 (#68762) Co-Orbital RPO on ICEYE-X36 (#59103)',
      summary:
        '18th SDS Space-Track GP_History (119 OMMs) and 5 OSINT sources confirm Russian VKS satellite COSMOS 2612 executed plane-matching burns from 2026-09-30 to close within 4.54 km of Finnish SAR satellite ICEYE-X36 on 2026-10-16 07:27:40Z. Live 2026-11-14 Space-Track GP places COSMOS 2612 at 655.4 km trailing stand-off in an identical 0.003° coplanar 541.9 km SSO plane.',
      affected_operators: [
        'ICEYE Oy (Espoo, Finland) / ICEYE US (#59103, #59102)',
        'Kuva Space (#60562) & ESA Sentinel-1A/2A (535–700 km SSO corridor)',
      ],
      evidence: [
        {
          claim:
            '26.8 m/s phasing/plane burn placed COSMOS 2612 484.3 km astern of ICEYE-X36 in the same orbital plane 5 days before first media report.',
          source_url: 'https://edition.cnn.com/2026/10/20/europe/russia-satellite-cosmos-2612-iceye-intl',
          source_date: 'Event: 2026-10-12T22:39:15Z (OMM Epoch) · Reported: 2026-10-20T15:10Z',
          data_origin: '18th SDS Space-Track GP_History (#68762/#59103) + CNN International confirmation',
          orbit_calc: 'SGP4 Δv = 26.79 m/s @ 2026-10-12T22:39Z → Range 484.3 km, Plane Δθ 0.047°',
          verification_tag: 'early_warning',
        },
        {
          claim:
            'Closest public-element approach reached 4.54 km on 2026-10-16 07:27:40Z, matching Orbital Radar (4.58 km at 07:28Z) within 40 meters.',
          source_url: 'https://orbitalradar.com/conjunctions/68762-59103',
          source_date: 'TCA: 2026-10-16T07:27:40Z (OMM 2026-10-16T04:40:53Z) · Published: 2026-10-16T09:15Z',
          data_origin: '18th SDS Space-Track GP_History + Orbital Radar & SatTrackCam Leiden (2026-10-17)',
          orbit_calc: 'SGP4 60s→1s TCA: 4.54 km @ 2026-10-16T07:27:40Z (Orbital Radar ref: 4.58 km)',
          verification_tag: 'verified',
        },
        {
          claim:
            'Commercial radar estimated ~300 m proximity on Oct 18; SGP4 confirms < 1 km co-orbital geometry, but sub-km precision exceeds public TLE bounds.',
          source_url: 'https://leolabs.space/insights/cosmos-2612-rpo-october-2026/',
          source_date: 'Pass: 2026-10-18T09:00Z · Published: 2026-10-19T16:45Z',
          data_origin: 'LeoLabs Commercial Phased-Array Radar Advisory + Space-Track GP_History',
          orbit_calc: 'SGP4 < 1.0 km nominal (±1.05 km 1σ public GP covariance floor)',
          verification_tag: 'caveated_sub_km',
        },
        {
          claim:
            'Live Nov 14, 2026 Space-Track GP shows 655.4 km separation with 0.003° coplanar alignment—retaining low-Δv re-approach capability.',
          source_url: 'https://sattrackcam.blogspot.com/2026/10/kosmos-2612-iceye-x36.html',
          source_date: 'OMM Epochs: 2026-11-13T22:18:13Z (#68762) & 2026-11-14T03:03:25Z (#59103)',
          data_origin: '18th SDS Space-Track Live GP Query + SatTrackCam Leiden (Dr. Marco Langbroek)',
          orbit_calc: 'SGP4 @ 2026-11-14 UTC: 655.4 km range, 541.9 km alt, Plane Δθ 0.003°',
          verification_tag: 'verified',
        },
      ],
      recommended_actions: [
        'Share ICEYE-X36 owner/operator GPS covariance ephemerides (OEM) with EU SST and 18th SDS.',
        'Enforce X-band uplink encryption & RF emission discipline when #68762 or #68763 (#2026-068E) closes < 1,000 km.',
        'Pre-stage 0.5 m/s phasing maneuver if #68762 semi-major axis drops >= 300 m below ICEYE-X36.',
      ],
      who_to_notify: [
        'ICEYE Flight Dynamics (Espoo / Irvine)',
        'EU SST Operations Front Desk',
        'Traficom Finnish Space Situational Awareness Cell',
      ],
      uncertainty_statement:
        'Public 18th SDS GP elements carry ~1.0 km 1σ error at epoch (+1–3 km/day along-track drag growth). Sub-kilometer claims (~300 m on Oct 18) require owner/operator OEM or dedicated radar tasking.',
    },

    'brief-cn-sj17-54225': {
      status: 'confirmed',
      threat_level: 'HIGH',
      title: '[CN → EU GEO] PRC Shijian-17 (#41838) 120 km Drift Past Eutelsat Hotbird 13G (#54225)',
      summary:
        'Live 18th SDS Space-Track GP (2026-11-14) tracks Chinese robotic-arm GEO inspector SJ-17 (#41838, 0.9987 rev/day westward drift at 13.9°E) passing within 120.0 km of Eutelsat Hotbird 13G (#54225, 13.0°E) on 2026-11-15 00:14Z and 125.7 km of Eutelsat 10B (#54259, 10.0°E) on 2026-11-17 00:17Z.',
      affected_operators: [
        'Eutelsat Group (Paris, France) — Hotbird 13F/13G (13.0°E) & Eutelsat 10B (10.0°E)',
        'European Sovereign Broadcast & NATO/EU Ku/Ka-band Mobility Users',
      ],
      evidence: [
        {
          claim:
            'SJ-17 (#41838) drifted from >1,070 km east in Aug 2026 into Europe’s 13°E GEO slot, reaching 119.99 km TCA from Hotbird 13G (#54225) on 2026-11-15 00:14:10Z.',
          source_url: 'https://aerospace.csis.org/space-threat-assessment/',
          source_date: 'TCA: 2026-11-15T00:14:10Z · OMM Epochs: 2026-11-14T02:09:25Z (#41838) & 04:57:01Z (#54225)',
          data_origin: '18th SDS Space-Track Live GP & Aug–Nov 2026 GP_History (395 OMMs) + CSIS Space Threat Assessment',
          orbit_calc: 'SGP4 72h TCA: 119.99 km @ 2026-11-15T00:14:10Z (Plane Δθ 6.08°, rel-v 0.326 km/s)',
          verification_tag: 'verified',
        },
        {
          claim:
            'Continued sub-synchronous drift (n = 0.99867 rev/day, +0.48°/day eastward/super-sync or drift) carries SJ-17 within 125.71 km of Eutelsat 10B (#54259) on 2026-11-17 00:17:11Z.',
          source_url: 'https://swfound.org/counterspace/',
          source_date: 'TCA: 2026-11-17T00:17:11Z · OMM Epoch: 2026-11-14T03:51:04Z (#54259)',
          data_origin: '18th SDS Space-Track Live GP + Secure World Foundation Global Counterspace Dossier',
          orbit_calc: 'SGP4 72h TCA: 125.71 km @ 2026-11-17T00:17:11Z (#41838 ↔ #54259)',
          verification_tag: 'verified',
        },
      ],
      recommended_actions: [
        'Task European optical GEO sensors (EU SST / Zimmerwald / TAROT) on #41838 to detect any station-keeping arrest burn near 13°E or 10°E.',
        'Monitor Hotbird 13F/13G & Eutelsat 10B telemetry/command link noise floor during nodal crossings.',
      ],
      who_to_notify: [
        'Eutelsat Flight Dynamics & Space Security Center (Paris)',
        'French Space Command (CDE, Toulouse) & EU SST',
      ],
      uncertainty_statement:
        'GEO public GP positional uncertainty is ~2–5 km in-track and ~1 km radial. Optical astrometry is required to detect low-thrust station-keeping burns within < 6h.',
    },

    'brief-ru-luch2-35943': {
      status: 'confirmed',
      threat_level: 'HIGH',
      title: '[RU → EU GEO] Russian Luch (Olymp-2, #55841) Stationed 433 km off German Military COMSATBW-1 (#35943)',
      summary:
        '18th SDS Space-Track GP_History confirms Russian SIGINT inspector LUCH (OLYMP) 2 (#55841) holding GEO station at 62.35°E within 432.7–522.7 km of German Bundeswehr military satcom COMSATBW-1 (#35943, 63.0°E). Public GP epoch on #55841 is 29 days stale (2026-10-15T15:56Z), elevating unannounced drift risk.',
      affected_operators: [
        'German Armed Forces (Bundeswehr Weltraumkommando) — COMSATBW-1 (#35943)',
        'Allied NATO GEO Military & Diplomatic Satcom Links (60°E–65°E)',
      ],
      evidence: [
        {
          claim:
            'LUCH (OLYMP) 2 (#55841) maintains equatorial GEO station (i = 0.018°) ~0.65° west of COMSATBW-1 (#35943), closing to 432.68 km over the 72h screening window.',
          source_url: 'https://swfound.org/counterspace/',
          source_date: 'OMM Epochs: 2026-10-15T15:56:16Z (#55841, 29d age) & 2026-11-14T03:53:17Z (#35943)',
          data_origin: '18th SDS Space-Track GP & Aug–Nov 2026 GP_History (390 OMMs) + SWF Counterspace',
          orbit_calc: 'SGP4 72h TCA: 432.68 km @ 2026-11-17T03:19:14Z (Plane Δθ 0.015°, GEO 62.35°E)',
          verification_tag: 'verified',
        },
        {
          claim:
            'Predecessor LUCH/OLYMP-1 (#40258) previously loitered beside Franco-Italian military satcom ATHENA-FIDUS (#39509) and Eutelsat slots before graveyard disposal.',
          source_url: 'https://aerospace.csis.org/space-threat-assessment/',
          source_date: 'Historical precedent: 2015–2025 · Graveyard fragmentation debris #67745 cataloged 2026',
          data_origin: '18th SDS SATCAT (#40258, #67745, #39509) + CSIS Aerospace Security',
          orbit_calc: 'SATCAT #40258 period 1452.9 min (+345 km super-GEO graveyard)',
          verification_tag: 'verified',
        },
      ],
      recommended_actions: [
        'Request immediate allied optical GEO tracking update on #55841 to resolve 29-day public GP epoch gap.',
        'Audit uplink spot-beam sidelobe exposure on COMSATBW-1 (#35943) from 62.35°E.',
      ],
      who_to_notify: [
        'Bundeswehr Space Command (Weltraumkommando, Uedem)',
        'EU SST & NATO Space Centre (Ramstein)',
      ],
      uncertainty_statement:
        'Because #55841 public GP epoch is 29 days old (2026-10-15), unmodeled east-west station-keeping burns can shift true GEO longitude by > 0.5° (~370 km) beyond public SGP4 propagation.',
    },

    'brief-ew-68762-2026-10-12': {
      status: 'early_warning',
      threat_level: 'HIGH',
      title: '[RU → EU LEO] Oct 12 Autonomous Early Warning: COSMOS 2612 (#68762) Plane-Match Burn',
      summary:
        'SGP4 maneuver screening across consecutive 18th SDS OMMs detected COSMOS 2612 aligning within 0.09° of ICEYE-X36 (#59103) ~475–484 km astern on 2026-10-12—5.2 days before first public OSINT coverage on 2026-10-17.',
      affected_operators: ['ICEYE Oy / ICEYE US (ICEYE-X36 #59103)'],
      evidence: [
        {
          claim:
            'Non-Keplerian semi-major axis & plane trim reduced inter-plane angle to < 0.09° at ~475–484 km behind ICEYE-X36 with zero web mentions.',
          source_url: null,
          source_date: 'Burn Epoch: 2026-10-12T06:00Z–22:39Z · First News: 2026-10-17T14:20Z',
          data_origin: '18th SDS Space-Track GP_History (#68762) + Context.dev Zero-Hit Web Check',
          orbit_calc: 'SGP4 Maneuver Detector: Plane Δθ 0.047°–0.088°, Trail Range 475–484 km',
          verification_tag: 'early_warning',
        },
        {
          claim:
            'Positive differential mean motion projected sub-10 km close approach within 96 hours (realized Oct 16 at 4.54 km).',
          source_url: 'https://orbitalradar.com/conjunctions/68762-59103',
          source_date: 'Projected Window: 2026-10-16 UTC (Confirmed 2026-10-16T07:27:40Z)',
          data_origin: 'SGP4 96h Forward Propagation + Orbital Radar Post-Hoc Confirmation',
          orbit_calc: 'SGP4 96h Forward Screen from 2026-10-12 → 4.54 km TCA on 2026-10-16',
          verification_tag: 'verified',
        },
      ],
      recommended_actions: [
        'Task high-cadence LEO radar on #68762 within 24h of plane-matching signature.',
        'Activate 15-minute Context.dev monitors on NORAD #68762 / 2026-068D.',
      ],
      who_to_notify: [
        'ICEYE Mission Operations (Espoo)',
        'EU SST Conjunction Service',
      ],
      uncertainty_statement:
        'Maneuver Δv derived from consecutive public GP epochs (~6–12h cadence) carries ±0.2 m/s Δv fit uncertainty and ±1 km epoch position uncertainty.',
    },
  };
}

export async function askSpecolaWithGemini(params: {
  question: string;
  scopedFleetLabel: string | null;
  pairs: PairTelemetrySnapshot[];
  events: OrbitalEventRecord[];
  claims: VerifiedWebClaim[];
  maneuvers: ManeuverDetection[];
  briefs: { id: string; title: string; summary: string; threat_level: string }[];
}): Promise<{
  answer: string;
  citations: { label: string; url: string | null; kind: 'web_source' | 'sgp4_event' }[];
  caveats: string;
  modelUsed: string;
  latencyMs: number;
}> {
  const t0 = performance.now();
  const topPairs = params.pairs.slice(0, 12).map((p) => ({
    pairKey: `${p.suspectNoradId}-${p.protectedNoradId}`,
    suspect: `${p.suspectName} (#${p.suspectNoradId}, ${p.suspectCountry ?? 'RU/CN'})`,
    protected: `${p.protectedName} (#${p.protectedNoradId}, ${p.protectedCountry ?? 'EU'})`,
    currentKm: p.currentDistanceKm,
    min72hKm: p.tca72h.minDistanceKm,
    tcaUtc: p.tca72h.tcaUtc,
    planeDeg: p.planeAngleDeg,
  }));

  const dbSnapshot = JSON.stringify({
    scopedFleet: params.scopedFleetLabel ?? 'All European Tracked Assets',
    topPairs,
    events: params.events.slice(0, 10).map((e) => ({
      id: e.id,
      title: e.title,
      threatLevel: e.threatLevel,
      status: e.status,
      minDistanceKm: e.minDistanceKm,
      planeAngleDeg: e.planeAngleDeg,
      eventTimeUtc: e.eventTimeUtc,
    })),
    briefs: params.briefs.slice(0, 5),
    claims: params.claims.slice(0, 12).map((c) => ({
      outlet: c.source_outlet,
      url: c.source_url,
      claim: c.claim_text,
      verdict: c.verdict,
      sgp4Ref: c.orbit_calc_reference,
    })),
    maneuvers: params.maneuvers.slice(0, 8).map((m) => ({
      sat: m.satelliteName,
      noradId: m.noradId,
      deltaVMs: m.estimatedDeltaVMs,
      epochUtc: m.epochAfterUtc,
      summary: m.summary,
    })),
  });

  const schema = {
    type: Type.OBJECT,
    properties: {
      answer: { type: Type.STRING },
      citations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            label: { type: Type.STRING },
            url: { type: Type.STRING, nullable: true },
            kind: { type: Type.STRING },
          },
          required: ['label', 'url', 'kind'],
        },
      },
      caveats: { type: Type.STRING },
    },
    required: ['answer', 'citations', 'caveats'],
  };

  try {
    const { jsonText, modelUsed } = await generateStructuredJson({
      systemInstruction: `You are Ask Specola, a grounded European Orbital Intelligence assistant.
STRICT RULES:
1. Answer ONLY using facts, NORAD IDs, distances (km), dates, and URLs present in the provided DATABASE SNAPSHOT JSON.
2. Never invent satellites, distances, or citations. If a datum is missing, state explicitly what is absent from the database.
3. Keep the answer concise, quantitative (2-4 sentences), and cite exact SGP4 event IDs (?event=<id>) or verified web URLs in citations[]. kind must be 'web_source' or 'sgp4_event'.
4. Always note public GP/TLE accuracy (~1 km epoch error, +1-3 km/day) in caveats.`,
      prompt: `QUESTION: ${params.question}\n\nDATABASE SNAPSHOT:\n${dbSnapshot}`,
      geminiResponseSchema: schema,
    });

    const parsed = JSON.parse(jsonText) as {
      answer: string;
      citations: { label: string; url: string | null; kind: string }[];
      caveats: string;
    };

    return {
      answer: parsed.answer,
      citations: (parsed.citations ?? []).map((c) => ({
        label: c.label,
        url: c.url,
        kind: c.kind === 'web_source' ? 'web_source' : 'sgp4_event',
      })),
      caveats:
        parsed.caveats ||
        'Screening-grade analysis from public 18th SDS GP elements (~1 km 1σ epoch accuracy, +1–3 km/day along-track growth).',
      modelUsed,
      latencyMs: Math.max(1, Math.round(performance.now() - t0)),
    };
  } catch {
    // Deterministic DB-only fallback if Gemini API is unreachable
    const closest = topPairs[0];
    const highEvents = params.events.filter((e) => e.threatLevel === 'HIGH');
    const claimCitations = params.claims.slice(0, 3).map((c) => ({
      label: `${c.source_outlet} [${c.verdict.toUpperCase()}]`,
      url: c.source_url,
      kind: 'web_source' as const,
    }));
    const eventCitations = highEvents.slice(0, 2).map((e) => ({
      label: `Event ${e.id} (${e.minDistanceKm.toFixed(2)} km)`,
      url: `/?event=${encodeURIComponent(e.id)}`,
      kind: 'sgp4_event' as const,
    }));

    return {
      answer: closest
        ? `Scoped to ${params.scopedFleetLabel ?? 'all tracked European satellites'}: closest screened pair over 72h is ${closest.suspect} vs ${closest.protected} at ${closest.min72hKm.toFixed(2)} km TCA (${closest.tcaUtc.slice(0, 16)}Z, current ${closest.currentKm.toFixed(1)} km, Δθ ${closest.planeDeg.toFixed(3)}°). Database holds ${highEvents.length} HIGH-threat events and ${params.maneuvers.length} detected orbital burns.`
        : `No threatening conjunctions within plane tolerance for ${params.scopedFleetLabel ?? 'the current catalog'}.`,
      citations: [...eventCitations, ...claimCitations],
      caveats:
        'Deterministic DB fallback active. Public GP elements carry ~1 km epoch uncertainty (+1–3 km/day); not a collision warning service.',
      modelUsed: 'deterministic-db-fallback',
      latencyMs: Math.max(1, Math.round(performance.now() - t0)),
    };
  }
}

function inferCountryLabel(countryCode?: string): string {
  const code = (countryCode || '').toUpperCase();
  if (code === 'RU' || code === 'CIS') return 'Russia';
  if (code === 'CN' || code === 'PRC') return 'China';
  if (code === 'EU/FI' || code === 'FI' || code === 'US/FI') return 'Finland (ICEYE / EU)';
  if (code === 'EU/SE') return 'Sweden (EU)';
  if (code === 'EU/NL') return 'Netherlands (EU)';
  if (code === 'EU/DE' || code === 'DE') return 'Germany (EU)';
  if (code === 'EU/FR' || code === 'FR') return 'France (EU)';
  if (code === 'EU/FR-IT') return 'France / Italy (EU)';
  if (code === 'EU/LU') return 'Luxembourg (EU)';
  if (code === 'EU/ESA' || code === 'ESA' || code === 'EU') return 'European Space Agency (EU)';
  return countryCode || 'Unknown';
}

function inferFallbackCategory(params: {
  countryCode: string;
  operator: string;
  mission: string;
}): SatelliteIdentityCategory {
  const blob = `${params.countryCode} ${params.operator} ${params.mission}`.toLowerCase();
  if (
    /vks|russian|inspector|rpo|luch|olymp|shijian|sj-|classified|defense|military|bundeswehr/.test(blob)
  ) {
    if (/comsatbw|athena|satcom|comms/.test(blob)) return 'defense_comms';
    return 'defense_inspector';
  }
  if (/iceye|sar|hyperspectral|kuva|earth observation|sentinel|copernicus|eo/.test(blob)) {
    return 'commercial_eo';
  }
  if (/eutelsat|ses|astra|hotbird|broadcast|telecom/.test(blob)) {
    return 'science_civil';
  }
  return 'unknown';
}

export async function extractSatelliteDossierWithGemini(params: {
  noradId: number;
  name: string;
  cosparId: string;
  satcatOwner?: string | null;
  satcatLaunchDate?: string | null;
  watchlistOperator?: string | null;
  watchlistCountry?: string | null;
  watchlistMission?: string | null;
  watchlistNotes?: string | null;
  webHits: { title: string; url: string; snippet: string; publishedAt?: string }[];
}): Promise<SatelliteDossierProfile> {
  const countryCode = params.watchlistCountry || params.satcatOwner || 'UNKNOWN';
  const defaultCountryLabel = inferCountryLabel(countryCode);
  const defaultOperator = params.watchlistOperator || params.satcatOwner || 'Unknown operator';
  const defaultLaunchDate = params.satcatLaunchDate?.trim() || 'Unknown in public catalog';
  const defaultMission =
    params.watchlistMission || params.watchlistNotes || 'No public mission description found';
  const defaultCategory = inferFallbackCategory({
    countryCode,
    operator: defaultOperator,
    mission: defaultMission,
  });
  const topSources = params.webHits
    .filter((h) => Boolean(h.url))
    .slice(0, 4)
    .map((h) => ({ title: h.title || h.url, url: h.url }));

  const schema = {
    type: Type.OBJECT,
    properties: {
      countryLabel: { type: Type.STRING },
      operator: { type: Type.STRING },
      builtBy: { type: Type.STRING },
      launchedDate: { type: Type.STRING },
      launchVehicleOrSite: { type: Type.STRING },
      missionSummary: { type: Type.STRING },
      category: {
        type: Type.STRING,
        enum: ['defense_inspector', 'commercial_eo', 'defense_comms', 'science_civil', 'unknown'],
      },
    },
    required: [
      'countryLabel',
      'operator',
      'builtBy',
      'launchedDate',
      'launchVehicleOrSite',
      'missionSummary',
      'category',
    ],
  };

  try {
    const snippetsBlock =
      params.webHits.length > 0
        ? params.webHits
            .slice(0, 6)
            .map(
              (h, idx) =>
                `[${idx + 1}] ${h.title} (${h.url}${h.publishedAt ? ` · ${h.publishedAt}` : ''})\n${h.snippet}`,
            )
            .join('\n\n')
        : 'No web search hits available.';

    const { jsonText } = await generateStructuredJson({
      systemInstruction: `You extract factual spacecraft ownership, manufacturer ("builtBy"), launch date, launch vehicle/site, and mission summary strictly from the provided catalog record and Context.dev web search snippets.
RULES:
1. NEVER invent or guess a manufacturer, launch date, or launch site. If not supported by the catalog record or snippets, write "Unknown in public catalog" (or "Unconfirmed in public records").
2. Keep every field concise, plain-English, and factual (no hype).
3. "builtBy" means who manufactured/built the spacecraft (e.g. "ICEYE Oy (Espoo, Finland)", "ISS Reshetnev / Russian defense industry", "Airbus Defence and Space", "CAST (China Academy of Space Technology)"). If snippets do not state a specific builder, say "Russian state defense aerospace (undisclosed)" for Russian defense payloads or "Unknown in public catalog" otherwise.
4. "launchedDate" should use YYYY-MM-DD if known (prefer SATCAT launch date when present, or explicit date from snippets).
5. "missionSummary" must be 1 crisp sentence explaining what this satellite actually does.`,
      prompt: `SATELLITE RECORD:
NORAD ID: ${params.noradId}
Name: ${params.name}
COSPAR / Intl Designator: ${params.cosparId || 'Unknown'}
SATCAT Owner Code: ${params.satcatOwner || 'Unknown'}
SATCAT Launch Date: ${params.satcatLaunchDate || 'Unknown'}
Watchlist Operator: ${params.watchlistOperator || 'Unknown'}
Watchlist Country: ${params.watchlistCountry || 'Unknown'}
Watchlist Mission/Notes: ${params.watchlistMission || params.watchlistNotes || 'None'}

CONTEXT.DEV WEB SNIPPETS:
${snippetsBlock}`,
      geminiResponseSchema: schema,
      task: 'extract',
    });

    const parsed = JSON.parse(jsonText) as {
      countryLabel?: string;
      operator?: string;
      builtBy?: string;
      launchedDate?: string;
      launchVehicleOrSite?: string;
      missionSummary?: string;
      category?: string;
    };

    const validCategories: SatelliteIdentityCategory[] = [
      'defense_inspector',
      'commercial_eo',
      'defense_comms',
      'science_civil',
      'unknown',
    ];
    const category = validCategories.includes(parsed.category as SatelliteIdentityCategory)
      ? (parsed.category as SatelliteIdentityCategory)
      : defaultCategory;

    return {
      noradId: params.noradId,
      name: params.name,
      cosparId: params.cosparId || '',
      countryCode,
      countryLabel: parsed.countryLabel?.trim() || defaultCountryLabel,
      operator: parsed.operator?.trim() || defaultOperator,
      builtBy: parsed.builtBy?.trim() || 'Unknown in public catalog',
      launchedDate:
        parsed.launchedDate && !/unknown/i.test(parsed.launchedDate)
          ? parsed.launchedDate.trim()
          : defaultLaunchDate,
      launchVehicleOrSite: parsed.launchVehicleOrSite?.trim() || 'Not specified in public catalog',
      missionSummary: parsed.missionSummary?.trim() || defaultMission,
      category,
      sources: topSources,
      provenance: params.webHits.length > 0 ? 'context-dev-live-gemini' : 'satcat-watchlist-fallback',
      fetchedAtUtc: new Date().toISOString(),
    };
  } catch {
    return {
      noradId: params.noradId,
      name: params.name,
      cosparId: params.cosparId || '',
      countryCode,
      countryLabel: defaultCountryLabel,
      operator: defaultOperator,
      builtBy:
        /iceye/i.test(params.name)
          ? 'ICEYE Oy (Espoo, Finland)'
          : /hyperfield/i.test(params.name)
            ? 'Kuva Space (Espoo, Finland)'
            : /cosmos/i.test(params.name) && /ru|cis/i.test(countryCode)
              ? 'Russian state defense industry (undisclosed contractor)'
              : 'Unknown in public catalog',
      launchedDate: defaultLaunchDate,
      launchVehicleOrSite: 'Not specified in public catalog',
      missionSummary: defaultMission,
      category: defaultCategory,
      sources: topSources,
      provenance: 'satcat-watchlist-fallback',
      fetchedAtUtc: new Date().toISOString(),
    };
  }
}


