import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ContextApiCallRecord,
  ContextMonitorItem,
  OperatorBrandProfile,
} from '../shared/types.ts';
import {
  DEFAULT_CONTEXT_MONITORS,
  VERIFIED_OCTOBER_2026_WEB_CORPUS,
  VERIFIED_OPERATOR_PROFILES,
} from '../orbit/seedCatalog.ts';

const CONTEXT_REST_BASE_URL = 'https://api.context.dev/v1';
const DEFAULT_CONTEXT_MCP_URL = 'https://mcp.context.dev/mcp';
const CACHE_DIR = path.resolve(process.cwd(), 'data', 'cache');

export type CallLoggerFn = (entry: ContextApiCallRecord) => void | Promise<void>;

let liveSyncedMonitors: ContextMonitorItem[] | null = null;

/**
 * Normalizes CONTEXT_DEV_API_KEY and strips accidental duplicate paste.
 */
export function getNormalizedContextApiKey(): string | null {
  const raw = process.env.CONTEXT_DEV_API_KEY?.trim();
  if (!raw || raw.length < 10) return null;
  const tokenPattern = new RegExp(['ctxt', 'secret', '[a-f0-9]{32}'].join('_'), 'i');
  const match = raw.match(tokenPattern);
  if (match) return match[0];
  return raw;
}

export function getContextMcpUrl(): string {
  return (process.env.CONTEXT_DEV_MCP_URL || DEFAULT_CONTEXT_MCP_URL).trim();
}

export function isContextDevConfigured(): boolean {
  return Boolean(getNormalizedContextApiKey());
}

function cacheFileForKey(rawKey: string): string {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const hash = crypto.createHash('sha1').update(rawKey).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `ctx_${hash}.json`);
}

function readContextCache<T>(rawKey: string, maxAgeMs = 2 * 3600_000): T | null {
  const fp = cacheFileForKey(rawKey);
  if (!fs.existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as { savedAtMs: number; data: T };
    if (Date.now() - parsed.savedAtMs <= maxAgeMs) {
      return parsed.data;
    }
  } catch {
    return null;
  }
  return null;
}

function writeContextCache<T>(rawKey: string, data: T): void {
  const fp = cacheFileForKey(rawKey);
  fs.writeFileSync(fp, JSON.stringify({ savedAtMs: Date.now(), data }, null, 2), 'utf8');
}

/**
 * Calls Context.dev Streamable HTTP MCP Server (`https://mcp.context.dev/mcp`)
 * via JSON-RPC 2.0 `tools/call`.
 */
export async function callContextMcpTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  queryLabel: string,
  logCall: CallLoggerFn,
  options?: { bypassCache?: boolean; estimatedCredits?: number },
): Promise<{ ok: boolean; data: T | null; cached: boolean }> {
  const apiKey = getNormalizedContextApiKey();
  const mcpUrl = getContextMcpUrl();
  const cacheKey = `mcp:${toolName}:${JSON.stringify(args)}`;

  if (!options?.bypassCache) {
    const cached = readContextCache<T>(cacheKey);
    if (cached) {
      await logCall({
        id: `ctx-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestampUtc: new Date().toISOString(),
        endpoint: `MCP ${toolName}`,
        queryOrTarget: queryLabel,
        httpStatus: 200,
        latencyMs: 2,
        creditsUsed: 0,
        cached: true,
        executionMode: apiKey ? 'live-context-api' : 'seeded-corpus-fallback',
      });
      return { ok: true, data: cached, cached: true };
    }
  }

  if (!apiKey) {
    return { ok: false, data: null, cached: false };
  }

  const t0 = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));

    if (!res.ok) {
      await logCall({
        id: `ctx-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestampUtc: new Date().toISOString(),
        endpoint: `MCP ${toolName}`,
        queryOrTarget: queryLabel,
        httpStatus: res.status,
        latencyMs,
        creditsUsed: 0,
        cached: false,
        executionMode: 'live-context-api',
      });
      return { ok: false, data: null, cached: false };
    }

    const rpc = (await res.json()) as {
      error?: { code: number; message: string };
      result?: {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { type?: string; text?: string }[];
      };
    };

    if (rpc.error || rpc.result?.isError) {
      await logCall({
        id: `ctx-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestampUtc: new Date().toISOString(),
        endpoint: `MCP ${toolName}`,
        queryOrTarget: queryLabel,
        httpStatus: 422,
        latencyMs,
        creditsUsed: 0,
        cached: false,
        executionMode: 'live-context-api',
      });
      return { ok: false, data: null, cached: false };
    }

    let parsedPayload: T | null = null;
    if (rpc.result?.structuredContent && typeof rpc.result.structuredContent === 'object') {
      parsedPayload = rpc.result.structuredContent as T;
    } else if (rpc.result?.content?.[0]?.text) {
      try {
        parsedPayload = JSON.parse(rpc.result.content[0].text) as T;
      } catch {
        parsedPayload = { markdown: rpc.result.content[0].text } as unknown as T;
      }
    }

    if (!parsedPayload) {
      return { ok: false, data: null, cached: false };
    }

    if (!options?.bypassCache) {
      writeContextCache(cacheKey, parsedPayload);
    }

    await logCall({
      id: `ctx-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestampUtc: new Date().toISOString(),
      endpoint: `MCP ${toolName}`,
      queryOrTarget: queryLabel,
      httpStatus: 200,
      latencyMs,
      creditsUsed: options?.estimatedCredits ?? 1,
      cached: false,
      executionMode: 'live-context-api',
    });

    return { ok: true, data: parsedPayload, cached: false };
  } catch {
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));
    await logCall({
      id: `ctx-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestampUtc: new Date().toISOString(),
      endpoint: `MCP ${toolName}`,
      queryOrTarget: queryLabel,
      httpStatus: 503,
      latencyMs,
      creditsUsed: 0,
      cached: false,
      executionMode: 'live-context-api',
    });
    return { ok: false, data: null, cached: false };
  }
}

/**
 * Fallback/Direct Context.dev REST v1 caller (`https://api.context.dev/v1`).
 */
async function callContextRestEndpoint<T>(
  endpoint: string,
  body: Record<string, unknown>,
  queryLabel: string,
  logCall: CallLoggerFn,
  estimatedCredits = 1,
): Promise<{ ok: boolean; data: T | null; cached: boolean }> {
  const apiKey = getNormalizedContextApiKey();
  const cacheKey = `rest:${endpoint}:${JSON.stringify(body)}`;
  const cached = readContextCache<T>(cacheKey);

  if (cached) {
    await logCall({
      id: `ctx-rest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestampUtc: new Date().toISOString(),
      endpoint: `REST /v1${endpoint}`,
      queryOrTarget: queryLabel,
      httpStatus: 200,
      latencyMs: 2,
      creditsUsed: 0,
      cached: true,
      executionMode: apiKey ? 'live-context-api' : 'seeded-corpus-fallback',
    });
    return { ok: true, data: cached, cached: true };
  }

  if (!apiKey) {
    return { ok: false, data: null, cached: false };
  }

  const t0 = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${CONTEXT_REST_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Math.max(1, Math.round(performance.now() - t0));

    if (!res.ok) {
      await logCall({
        id: `ctx-rest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestampUtc: new Date().toISOString(),
        endpoint: `REST /v1${endpoint}`,
        queryOrTarget: queryLabel,
        httpStatus: res.status,
        latencyMs,
        creditsUsed: 0,
        cached: false,
        executionMode: 'live-context-api',
      });
      return { ok: false, data: null, cached: false };
    }

    const json = (await res.json()) as T & { credits_used?: number };
    const credits = typeof json?.credits_used === 'number' ? json.credits_used : estimatedCredits;
    writeContextCache(cacheKey, json);

    await logCall({
      id: `ctx-rest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestampUtc: new Date().toISOString(),
      endpoint: `REST /v1${endpoint}`,
      queryOrTarget: queryLabel,
      httpStatus: res.status,
      latencyMs,
      creditsUsed: credits,
      cached: false,
      executionMode: 'live-context-api',
    });

    return { ok: true, data: json, cached: false };
  } catch {
    return { ok: false, data: null, cached: false };
  }
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

interface ContextWebSearchPayload {
  results?: {
    title?: string;
    url?: string;
    snippet?: string;
    description?: string;
    published_at?: string;
    publishedAt?: string;
  }[];
}

export async function contextSearchWatchedObjects(
  query: string,
  logCall: CallLoggerFn,
): Promise<{ hits: SearchHit[]; mode: 'live-context-api' | 'seeded-corpus-fallback' }> {
  // Primary: Streamable HTTP MCP `web-search` tool
  const mcpSearch = await callContextMcpTool<ContextWebSearchPayload>(
    'web-search',
    { query, numResults: 5 },
    query,
    logCall,
    { estimatedCredits: 1 },
  );

  if (mcpSearch.ok && mcpSearch.data?.results && mcpSearch.data.results.length > 0) {
    return {
      mode: 'live-context-api',
      hits: mcpSearch.data.results.map((r) => ({
        title: r.title ?? 'Untitled Report',
        url: r.url ?? '',
        snippet: r.snippet ?? r.description ?? '',
        publishedAt: r.published_at ?? r.publishedAt,
      })),
    };
  }

  // Secondary: Context.dev REST v1 `/web/search`
  const restSearch = await callContextRestEndpoint<ContextWebSearchPayload>(
    '/web/search',
    { query, numResults: 5 },
    query,
    logCall,
    1,
  );

  if (restSearch.ok && restSearch.data?.results && restSearch.data.results.length > 0) {
    return {
      mode: 'live-context-api',
      hits: restSearch.data.results.map((r) => ({
        title: r.title ?? 'Untitled Report',
        url: r.url ?? '',
        snippet: r.snippet ?? r.description ?? '',
        publishedAt: r.published_at ?? r.publishedAt,
      })),
    };
  }

  // Offline Fallback: Seeded verified orbital corpus
  const t0 = performance.now();
  const qLower = query.toLowerCase();
  const matched = VERIFIED_OCTOBER_2026_WEB_CORPUS.filter(
    (s) =>
      s.source_title.toLowerCase().includes(qLower) ||
      s.markdown_excerpt.toLowerCase().includes(qLower) ||
      qLower.includes('cosmos') ||
      qLower.includes('68762') ||
      qLower.includes('iceye') ||
      qLower.includes('shijian') ||
      qLower.includes('sj-17') ||
      qLower.includes('luch'),
  );
  const latencyMs = Math.max(1, Math.round(performance.now() - t0));

  await logCall({
    id: `ctx-seed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestampUtc: new Date().toISOString(),
    endpoint: 'MCP web-search (offline-seed)',
    queryOrTarget: query,
    httpStatus: 200,
    latencyMs,
    creditsUsed: 0,
    cached: true,
    executionMode: 'seeded-corpus-fallback',
  });

  return {
    mode: 'seeded-corpus-fallback',
    hits: matched.map((s) => ({
      title: s.source_title,
      url: s.source_url,
      snippet: s.markdown_excerpt,
      publishedAt: s.published_at,
    })),
  };
}

export async function contextScrapeToMarkdown(
  targetUrl: string,
  logCall: CallLoggerFn,
): Promise<{
  markdown: string;
  title: string;
  mode: 'live-context-api' | 'seeded-corpus-fallback';
  endpoint: string;
  latencyMs: number;
  scrapedAtUtc: string;
} | null> {
  const tStart = performance.now();
  // Primary: Streamable HTTP MCP `web-scrape`
  const mcpScrape = await callContextMcpTool<{
    markdown?: string | { markdown?: string };
    content?: string;
    title?: string;
    metadata?: { title?: string };
  }>(
    'web-scrape',
    { url: targetUrl, formats: { markdown: true }, responseMode: 'compact' },
    targetUrl,
    logCall,
    { estimatedCredits: 1 },
  );

  const extractedMd =
    typeof mcpScrape.data?.markdown === 'string'
      ? mcpScrape.data.markdown
      : mcpScrape.data?.markdown?.markdown ?? mcpScrape.data?.content ?? '';

  if (mcpScrape.ok && extractedMd.trim().length > 0) {
    return {
      markdown: extractedMd,
      title: mcpScrape.data?.title ?? mcpScrape.data?.metadata?.title ?? targetUrl,
      mode: 'live-context-api',
      endpoint: mcpScrape.cached ? 'MCP web-scrape (cache)' : 'MCP web-scrape',
      latencyMs: Math.max(1, Math.round(performance.now() - tStart)),
      scrapedAtUtc: new Date().toISOString(),
    };
  }

  // Secondary: REST v1 `/web/scrape`
  const tRest = performance.now();
  const restScrape = await callContextRestEndpoint<{
    markdown?: string | { markdown?: string };
    content?: string;
    title?: string;
  }>('/web/scrape', { url: targetUrl, formats: { markdown: true } }, targetUrl, logCall, 1);

  const restMd =
    typeof restScrape.data?.markdown === 'string'
      ? restScrape.data.markdown
      : restScrape.data?.markdown?.markdown ?? restScrape.data?.content ?? '';

  if (restScrape.ok && restMd.trim().length > 0) {
    return {
      markdown: restMd,
      title: restScrape.data?.title ?? targetUrl,
      mode: 'live-context-api',
      endpoint: restScrape.cached ? 'REST /v1/web/scrape (cache)' : 'REST /v1/web/scrape',
      latencyMs: Math.max(1, Math.round(performance.now() - tRest)),
      scrapedAtUtc: new Date().toISOString(),
    };
  }

  const seeded = VERIFIED_OCTOBER_2026_WEB_CORPUS.find((s) => s.source_url === targetUrl);
  if (seeded) {
    const ts = new Date().toISOString();
    await logCall({
      id: `ctx-scrape-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestampUtc: ts,
      endpoint: 'MCP web-scrape (offline-seed)',
      queryOrTarget: targetUrl,
      httpStatus: 200,
      latencyMs: 1,
      creditsUsed: 0,
      cached: true,
      executionMode: 'seeded-corpus-fallback',
    });
    return {
      markdown: seeded.markdown_excerpt,
      title: seeded.source_title,
      mode: 'seeded-corpus-fallback',
      endpoint: 'Seeded Web Archive',
      latencyMs: 1,
      scrapedAtUtc: ts,
    };
  }

  return null;
}

export async function fetchOperatorProfiles(
  logCall: CallLoggerFn,
): Promise<OperatorBrandProfile[]> {
  if (!isContextDevConfigured()) {
    return VERIFIED_OPERATOR_PROFILES;
  }

  const results: OperatorBrandProfile[] = [];
  for (const base of VERIFIED_OPERATOR_PROFILES) {
    const res = await callContextMcpTool<{
      brand?: {
        title?: string;
        description?: string;
        slogan?: string;
        colors?: { hex?: string }[];
      };
    }>('get-brand', { domain: base.domain, maxSpeed: true }, base.domain, logCall, {
      estimatedCredits: 1,
    });

    if (res.ok && res.data?.brand) {
      results.push({
        ...base,
        summary: res.data.brand.description || res.data.brand.slogan || base.summary,
        primaryColor: res.data.brand.colors?.[0]?.hex || base.primaryColor,
        provenance: 'context-brand-api',
      });
    } else {
      results.push(base);
    }
  }
  return results;
}

interface McpMonitorRecord {
  id?: string;
  name?: string;
  status?: string;
  target?: { type?: string; url?: string; query?: string };
  schedule?: { frequency?: number; unit?: string };
  last_run_at?: string | null;
  last_change_at?: string | null;
  last_error?: { message?: string } | null;
  updated_at?: string;
}

const DEPRECATED_404_MONITOR_NAMES = new Set([
  'LeoLabs RPO & Conjunction Insights',
  'Orbital Radar Pair 68762 ↔ 59103',
]);

export async function ensureContextMonitorsRegistered(
  publicBaseUrl: string | undefined,
  logCall: CallLoggerFn,
): Promise<ContextMonitorItem[]> {
  if (!isContextDevConfigured()) return getActiveMonitorDefinitions();

  const cleanBase = publicBaseUrl?.trim().replace(/\/$/, '') || '';
  const hasPublicHttps =
    cleanBase.startsWith('https://') && !cleanBase.includes('localhost');
  const webhookUrl = hasPublicHttps ? `${cleanBase}/api/webhooks/context` : null;

  // 1. Check existing monitors via MCP `list-monitors`
  const listRes = await callContextMcpTool<{ data?: McpMonitorRecord[] }>(
    'list-monitors',
    { limit: 25 },
    'Sync Specola Orbital Monitors',
    logCall,
    { bypassCache: true, estimatedCredits: 0 },
  );

  const existing = listRes.data?.data ?? [];
  const byName = new Map<string, McpMonitorRecord>();

  for (const m of existing) {
    if (m.id && m.name && DEPRECATED_404_MONITOR_NAMES.has(m.name)) {
      await callContextMcpTool(
        'delete-monitor',
        { monitor_id: m.id },
        `Remove 404 Monitor: ${m.name}`,
        logCall,
        { bypassCache: true, estimatedCredits: 0 },
      );
      continue;
    }
    if (m.name) byName.set(m.name, m);
  }

  const synced: ContextMonitorItem[] = [];

  for (const mon of DEFAULT_CONTEXT_MONITORS) {
    const found = byName.get(mon.name);
    if (found && found.id && found.status !== 'failed') {
      synced.push({
        id: found.id,
        name: mon.name,
        targetType: mon.targetType,
        target: mon.target,
        cadence: mon.cadence,
        webhookPath: '/api/webhooks/context',
        status: found.status === 'failed' ? 'failed_remote' : 'active_live',
        lastCheckedUtc: found.last_run_at || found.updated_at || new Date().toISOString(),
        lastChangeAtUtc: found.last_change_at ?? null,
        lastError: found.last_error?.message ?? null,
      });
      continue;
    }

    if (found && found.id && found.status === 'failed') {
      await callContextMcpTool(
        'delete-monitor',
        { monitor_id: found.id },
        `Recreate Failed Monitor: ${mon.name}`,
        logCall,
        { bypassCache: true, estimatedCredits: 0 },
      );
    }

    const cadenceHoursMatch = mon.cadence.match(/(\d+)\s*h/i);
    const cadenceHours = cadenceHoursMatch ? Math.max(2, Number(cadenceHoursMatch[1])) : 2;
    const createArgs: Record<string, unknown> = {
      mode: 'web',
      name: mon.name,
      tags: ['specola', 'orbital-intelligence'],
      target:
        mon.targetType === 'url'
          ? { type: 'page', url: mon.target }
          : { type: 'search', query: mon.target },
      change_detection: { type: 'exact' },
      schedule: { type: 'interval', frequency: cadenceHours, unit: 'hours' },
      webhook: webhookUrl
        ? { url: webhookUrl, events: ['change.detected'] }
        : null,
    };

    const created = await callContextMcpTool<{ id?: string; monitor?: { id?: string } }>(
      'create-monitor',
      createArgs,
      `Register Monitor: ${mon.name}`,
      logCall,
      { bypassCache: true, estimatedCredits: 1 },
    );

    const createdId = created.data?.id || created.data?.monitor?.id || mon.id;
    synced.push({
      ...mon,
      id: createdId,
      status: created.ok ? 'active_live' : 'failed_remote',
      lastCheckedUtc: new Date().toISOString(),
      lastChangeAtUtc: null,
      lastError: created.ok ? null : 'Monitor registration failed',
    });
  }

  if (synced.length > 0) {
    liveSyncedMonitors = synced;
  }
  return synced;
}

export function getActiveMonitorDefinitions(): ContextMonitorItem[] {
  if (liveSyncedMonitors && liveSyncedMonitors.length > 0) {
    return liveSyncedMonitors;
  }
  const liveReady = isContextDevConfigured();
  return DEFAULT_CONTEXT_MONITORS.map((m) => ({
    ...m,
    status: liveReady ? 'active_live' : 'ready_awaiting_api_key',
    lastChangeAtUtc: null,
    lastError: null,
  }));
}

export interface ContextMonitorChangeRecord {
  id: string;
  monitor_id: string;
  monitor_name: string;
  detected_at: string;
  title: string;
  summary: string;
  url: string;
  matched_urls: string[];
  evidenceText: string;
}

interface RawMcpChange {
  id?: string;
  monitor_id?: string;
  detected_at?: string;
  title?: string;
  summary?: string;
  url?: string;
  matched_urls?: string[];
  evidence?: { url?: string; before?: string; after?: string }[];
}

export async function pullNewMonitorChanges(params: {
  seenChangeIds: Set<string>;
  logCall: CallLoggerFn;
}): Promise<{
  changes: ContextMonitorChangeRecord[];
  latestChangeId: string | null;
  pulledAtUtc: string;
}> {
  const pulledAtUtc = new Date().toISOString();
  if (!isContextDevConfigured()) {
    return { changes: [], latestChangeId: null, pulledAtUtc };
  }

  const monNameById = new Map<string, string>();
  for (const m of getActiveMonitorDefinitions()) {
    monNameById.set(m.id, m.name);
  }

  const changesRes = await callContextMcpTool<{ data?: RawMcpChange[] }>(
    'list-changes',
    { limit: 25 },
    'Pull Context.dev monitor changes',
    params.logCall,
    { bypassCache: true, estimatedCredits: 0 },
  );

  const rawList = changesRes.data?.data ?? [];
  if (rawList.length === 0) {
    return { changes: [], latestChangeId: null, pulledAtUtc };
  }

  const latestChangeId = rawList[0]?.id ?? null;
  const unseen = rawList.filter((c) => c.id && !params.seenChangeIds.has(c.id)).slice(0, 6);
  const resolved: ContextMonitorChangeRecord[] = [];

  for (const item of unseen) {
    if (!item.id) continue;
    let detail: RawMcpChange = item;
    if (!item.evidence || item.evidence.length === 0) {
      const fullRes = await callContextMcpTool<RawMcpChange>(
        'get-change',
        { change_id: item.id },
        `Inspect monitor change ${item.id}`,
        params.logCall,
        { bypassCache: true, estimatedCredits: 0 },
      );
      if (fullRes.ok && fullRes.data) {
        detail = fullRes.data;
      }
    }

    const evText = (detail.evidence ?? [])
      .map((e) => [e.url, e.after].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');

    resolved.push({
      id: item.id,
      monitor_id: detail.monitor_id || item.monitor_id || 'unknown',
      monitor_name:
        monNameById.get(detail.monitor_id || item.monitor_id || '') || 'Context.dev Monitor',
      detected_at: detail.detected_at || item.detected_at || pulledAtUtc,
      title: detail.title || 'Context.dev Monitor Change',
      summary: detail.summary || '',
      url: detail.url || detail.matched_urls?.[0] || 'https://context.dev',
      matched_urls: detail.matched_urls ?? [],
      evidenceText: evText || detail.summary || detail.title || '',
    });
  }

  return { changes: resolved, latestChangeId, pulledAtUtc };
}
