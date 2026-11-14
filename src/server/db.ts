import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import type {
  AlertDeliveryRecord,
  ApiKeyRecord,
  BacktestResultPayload,
  ContextApiCallRecord,
  FleetSubscription,
  LiveFeedItem,
  OrbitalEventRecord,
  ScreeningRunRecord,
  StoredDecisionBrief,
  VerifiedWebClaim,
} from '../shared/types.ts';
import { logWarn } from './logger.ts';

const { Pool } = pg;

export class SpecolaStore {
  private sqlite: DatabaseSync;
  private pgPool: pg.Pool | null = null;
  private pgConnected = false;
  private pgHostHint = 'local-sqlite';

  constructor() {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.sqlite = new DatabaseSync(path.join(dataDir, 'specola.db'));
    this.initSqliteSchema();
  }

  private initSqliteSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pair_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_pair ON events(pair_key);

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at);

      CREATE TABLE IF NOT EXISTS briefs (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_briefs_event ON briefs(event_id);

      CREATE TABLE IF NOT EXISTS context_calls (
        id TEXT PRIMARY KEY,
        timestamp_utc TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_calls_ts ON context_calls(timestamp_utc);

      CREATE TABLE IF NOT EXISTS feed_items (
        id TEXT PRIMARY KEY,
        timestamp_utc TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feed_ts ON feed_items(timestamp_utc);

      CREATE TABLE IF NOT EXISTS fleet_subscriptions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS screening_runs (
        id TEXT PRIMARY KEY,
        executed_at TEXT NOT NULL,
        workers_count INTEGER NOT NULL,
        pairs_screened INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_deliveries (
        id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL,
        sent_at_utc TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alert_dedup ON alert_deliveries(dedup_key, sent_at_utc);

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS e2e_metrics (
        id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        e2e_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backtest_results (
        id TEXT PRIMARY KEY,
        ran_at_utc TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backtest_ran ON backtest_results(ran_at_utc DESC);
    `);
  }

  private normalizePgConnectionString(connStr: string): string {
    try {
      const url = new URL(connStr);
      // Avoid pg@8 sslmode=require override that forces verify-full over explicit ssl options
      url.searchParams.delete('sslmode');
      url.searchParams.delete('uselibpqcompat');
      return url.toString();
    } catch {
      return connStr;
    }
  }

  public async connectAivenIfConfigured(): Promise<void> {
    const rawConnStr = (process.env.AIVEN_DATABASE_URL || process.env.DATABASE_URL || '').trim();
    if (!rawConnStr) {
      this.pgConnected = false;
      this.pgHostHint = 'Embedded SQLite (set AIVEN_DATABASE_URL for Aiven PostgreSQL)';
      return;
    }

    try {
      const parsedUrl = new URL(rawConnStr);
      this.pgHostHint = parsedUrl.hostname;
    } catch {
      this.pgHostHint = 'aiven-postgres';
    }

    const cleanConnStr = this.normalizePgConnectionString(rawConnStr);

    try {
      this.pgPool = new Pool({
        connectionString: cleanConnStr,
        ssl: cleanConnStr.includes('localhost') ? undefined : { rejectUnauthorized: false },
        connectionTimeoutMillis: 6000,
        max: 6,
      });

      await this.pgPool.query(`
        CREATE TABLE IF NOT EXISTS specola_events (
          id TEXT PRIMARY KEY,
          pair_key TEXT NOT NULL,
          payload_json JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sp_events_pair ON specola_events(pair_key);

        CREATE TABLE IF NOT EXISTS specola_claims (
          id TEXT PRIMARY KEY,
          source_url TEXT NOT NULL,
          payload_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sp_claims_created ON specola_claims(created_at DESC);

        CREATE TABLE IF NOT EXISTS specola_briefs (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          payload_json JSONB NOT NULL,
          latency_ms INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sp_briefs_event ON specola_briefs(event_id);

        CREATE TABLE IF NOT EXISTS specola_context_calls (
          id TEXT PRIMARY KEY,
          timestamp_utc TIMESTAMPTZ NOT NULL,
          payload_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sp_ctx_ts ON specola_context_calls(timestamp_utc DESC);

        CREATE TABLE IF NOT EXISTS specola_fleet_subscriptions (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL,
          payload_json JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS specola_feed_items (
          id TEXT PRIMARY KEY,
          timestamp_utc TIMESTAMPTZ NOT NULL,
          payload_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sp_feed_ts ON specola_feed_items(timestamp_utc DESC);

        CREATE TABLE IF NOT EXISTS specola_screening_runs (
          id TEXT PRIMARY KEY,
          executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          workers_count INTEGER NOT NULL,
          pairs_screened INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          approaches_json JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS specola_tle_elements (
          norad_id INTEGER NOT NULL,
          epoch TIMESTAMPTZ NOT NULL,
          omm_json JSONB NOT NULL,
          ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (norad_id, epoch)
        );

        CREATE TABLE IF NOT EXISTS specola_alert_deliveries (
          id TEXT PRIMARY KEY,
          dedup_key TEXT NOT NULL,
          sent_at_utc TIMESTAMPTZ NOT NULL,
          delivery_status TEXT NOT NULL,
          payload_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sp_alert_dedup ON specola_alert_deliveries(dedup_key, sent_at_utc DESC);

        CREATE TABLE IF NOT EXISTS specola_api_keys (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          last_used_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS specola_kv_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS specola_backtest_results (
          id TEXT PRIMARY KEY,
          ran_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          payload_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sp_backtest_ran ON specola_backtest_results(ran_at_utc DESC);
      `);
      this.pgConnected = true;

      // 1. Read-through hydration Aiven PostgreSQL -> SQLite
      const [evRows, clRows, brRows, subRows, feedRows, ctxRows, runRows, alertRows, keyRows, kvRows, btRows] =
        await Promise.all([
          this.pgPool.query(`SELECT id, pair_key, payload_json, updated_at FROM specola_events`),
          this.pgPool.query(`SELECT id, source_url, payload_json, created_at FROM specola_claims`),
          this.pgPool.query(`SELECT id, event_id, payload_json, latency_ms, created_at FROM specola_briefs`),
          this.pgPool.query(`SELECT id, created_at, payload_json FROM specola_fleet_subscriptions`),
          this.pgPool.query(
            `SELECT id, timestamp_utc, payload_json FROM specola_feed_items ORDER BY timestamp_utc DESC LIMIT 60`,
          ),
          this.pgPool.query(
            `SELECT id, timestamp_utc, payload_json FROM specola_context_calls ORDER BY timestamp_utc DESC LIMIT 60`,
          ),
          this.pgPool.query(
            `SELECT id, executed_at, workers_count, pairs_screened, duration_ms FROM specola_screening_runs ORDER BY executed_at DESC LIMIT 30`,
          ),
          this.pgPool.query(
            `SELECT id, dedup_key, sent_at_utc, delivery_status, payload_json FROM specola_alert_deliveries ORDER BY sent_at_utc DESC LIMIT 80`,
          ),
          this.pgPool.query(
            `SELECT id, label, key_hash, key_prefix, created_at, last_used_at FROM specola_api_keys`,
          ),
          this.pgPool.query(`SELECT key, value, updated_at FROM specola_kv_state`),
          this.pgPool.query(
            `SELECT id, ran_at_utc, payload_json FROM specola_backtest_results ORDER BY ran_at_utc DESC LIMIT 5`,
          ),
        ]);

      for (const r of evRows.rows) {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO events (id, pair_key, payload_json, updated_at) VALUES (?, ?, ?, ?)`,
          )
          .run(r.id, r.pair_key, JSON.stringify(r.payload_json), new Date(r.updated_at).toISOString());
      }
      for (const r of clRows.rows) {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO claims (id, source_url, payload_json, created_at) VALUES (?, ?, ?, ?)`,
          )
          .run(r.id, r.source_url, JSON.stringify(r.payload_json), new Date(r.created_at).toISOString());
      }
      for (const r of brRows.rows) {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO briefs (id, event_id, payload_json, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            r.id,
            r.event_id,
            JSON.stringify(r.payload_json),
            Number(r.latency_ms) || 0,
            new Date(r.created_at).toISOString(),
          );
      }
      for (const r of subRows.rows) {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO fleet_subscriptions (id, created_at, payload_json) VALUES (?, ?, ?)`,
          )
          .run(r.id, new Date(r.created_at).toISOString(), JSON.stringify(r.payload_json));
      }
      for (const r of feedRows.rows) {
        this.sqlite
          .prepare(`INSERT OR REPLACE INTO feed_items (id, timestamp_utc, payload_json) VALUES (?, ?, ?)`)
          .run(r.id, new Date(r.timestamp_utc).toISOString(), JSON.stringify(r.payload_json));
      }
      for (const r of ctxRows.rows) {
        this.sqlite
          .prepare(`INSERT OR REPLACE INTO context_calls (id, timestamp_utc, payload_json) VALUES (?, ?, ?)`)
          .run(r.id, new Date(r.timestamp_utc).toISOString(), JSON.stringify(r.payload_json));
      }
      for (const r of runRows.rows) {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO screening_runs (id, executed_at, workers_count, pairs_screened, duration_ms) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            r.id,
            new Date(r.executed_at).toISOString(),
            Number(r.workers_count) || 0,
            Number(r.pairs_screened) || 0,
            Number(r.duration_ms) || 0,
          );
      }
      for (const r of alertRows.rows) {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO alert_deliveries (id, dedup_key, sent_at_utc, delivery_status, payload_json) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            r.id,
            r.dedup_key,
            new Date(r.sent_at_utc).toISOString(),
            r.delivery_status,
            JSON.stringify(r.payload_json),
          );
      }
      for (const r of keyRows.rows) {
        this.sqlite
          .prepare(
            `INSERT OR REPLACE INTO api_keys (id, label, key_hash, key_prefix, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            r.id,
            r.label,
            r.key_hash,
            r.key_prefix,
            new Date(r.created_at).toISOString(),
            r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
          );
      }
      for (const r of kvRows.rows) {
        this.sqlite
          .prepare(`INSERT OR REPLACE INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)`)
          .run(r.key, r.value, new Date(r.updated_at).toISOString());
      }
      for (const r of btRows.rows) {
        this.sqlite
          .prepare(`INSERT OR REPLACE INTO backtest_results (id, ran_at_utc, payload_json) VALUES (?, ?, ?)`)
          .run(r.id, new Date(r.ran_at_utc).toISOString(), JSON.stringify(r.payload_json));
      }

      // 2. Bidirectional backfill SQLite -> Aiven PG so pre-Aiven local records are never missing in cloud PG
      await this.backfillLocalToAiven();
    } catch (err) {
      logWarn('aiven_postgres_connect_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.pgConnected = false;
      if (this.pgPool) {
        await this.pgPool.end().catch(() => {});
        this.pgPool = null;
      }
    }
  }

  private async backfillLocalToAiven(): Promise<void> {
    if (!this.pgConnected || !this.pgPool) return;
    const pool = this.pgPool;

    const claims = this.listClaims();
    for (const c of claims) {
      await pool
        .query(
          `INSERT INTO specola_claims (id, source_url, payload_json, created_at)
           VALUES ($1, $2, $3::jsonb, $4::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.source_url, JSON.stringify(c), c.published_at ?? new Date().toISOString()],
        )
        .catch((err) => logWarn('pg_backfill_claim_err', { error: String(err) }));
    }

    const events = this.listEvents();
    for (const e of events) {
      await pool
        .query(
          `INSERT INTO specola_events (id, pair_key, payload_json, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [e.id, e.pairKey, JSON.stringify(e)],
        )
        .catch((err) => logWarn('pg_backfill_event_err', { error: String(err) }));
    }

    const briefs = this.listBriefs();
    for (const b of briefs) {
      await pool
        .query(
          `INSERT INTO specola_briefs (id, event_id, payload_json, latency_ms, created_at)
           VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [b.id, b.eventId, JSON.stringify(b), b.latencyMs, b.generatedAtUtc],
        )
        .catch((err) => logWarn('pg_backfill_brief_err', { error: String(err) }));
    }

    const ctxCalls = this.listContextCalls(100);
    for (const cc of ctxCalls) {
      await pool
        .query(
          `INSERT INTO specola_context_calls (id, timestamp_utc, payload_json)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [cc.id, cc.timestampUtc, JSON.stringify(cc)],
        )
        .catch(() => {});
    }

    const feedItems = this.listFeedItems(100);
    for (const fi of feedItems) {
      await pool
        .query(
          `INSERT INTO specola_feed_items (id, timestamp_utc, payload_json)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [fi.id, fi.timestampUtc, JSON.stringify(fi)],
        )
        .catch(() => {});
    }
  }

  public getDatabaseStatus(): {
    engine: 'aiven-postgresql' | 'sqlite-embedded-fallback';
    connected: boolean;
    hostHint: string;
    aivenConfigured: boolean;
    tableStats: {
      events: number;
      claims: number;
      briefs: number;
      contextCalls: number;
      screeningRuns: number;
      alertDeliveries: number;
    };
  } {
    const aivenConfigured = Boolean((process.env.AIVEN_DATABASE_URL || process.env.DATABASE_URL || '').trim());
    const countOf = (table: string) => {
      const row = this.sqlite.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number } | undefined;
      return Number(row?.c ?? 0);
    };
    return {
      engine: this.pgConnected ? 'aiven-postgresql' : 'sqlite-embedded-fallback',
      connected: true,
      hostHint: this.pgConnected ? this.pgHostHint : 'data/specola.db (local offline-safe mirror)',
      aivenConfigured,
      tableStats: {
        events: countOf('events'),
        claims: countOf('claims'),
        briefs: countOf('briefs'),
        contextCalls: countOf('context_calls'),
        screeningRuns: countOf('screening_runs'),
        alertDeliveries: countOf('alert_deliveries'),
      },
    };
  }

  public async upsertEvent(evt: OrbitalEventRecord): Promise<void> {
    const json = JSON.stringify(evt);
    this.sqlite
      .prepare(
        `INSERT INTO events (id, pair_key, payload_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET pair_key=excluded.pair_key, payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
      )
      .run(evt.id, evt.pairKey, json, new Date().toISOString());

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_events (id, pair_key, payload_json, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET pair_key=EXCLUDED.pair_key, payload_json=EXCLUDED.payload_json, updated_at=NOW()`,
          [evt.id, evt.pairKey, json],
        )
        .catch((err) => logWarn('pg_upsert_event_err', { error: String(err) }));
    }
  }

  public listEvents(): OrbitalEventRecord[] {
    const rows = this.sqlite
      .prepare(`SELECT payload_json FROM events ORDER BY updated_at DESC`)
      .all() as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as OrbitalEventRecord);
  }

  public getEventById(id: string): OrbitalEventRecord | null {
    const row = this.sqlite
      .prepare(`SELECT payload_json FROM events WHERE id = ?`)
      .get(id) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as OrbitalEventRecord) : null;
  }

  public async upsertClaim(claim: VerifiedWebClaim): Promise<void> {
    const json = JSON.stringify(claim);
    this.sqlite
      .prepare(
        `INSERT INTO claims (id, source_url, payload_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source_url=excluded.source_url, payload_json=excluded.payload_json`,
      )
      .run(claim.id, claim.source_url, json, claim.published_at ?? new Date().toISOString());

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_claims (id, source_url, payload_json, created_at)
           VALUES ($1, $2, $3::jsonb, $4::timestamptz)
           ON CONFLICT (id) DO UPDATE SET payload_json=EXCLUDED.payload_json`,
          [claim.id, claim.source_url, json, claim.published_at ?? new Date().toISOString()],
        )
        .catch((err) => logWarn('pg_upsert_claim_err', { error: String(err) }));
    }
  }

  public listClaims(): VerifiedWebClaim[] {
    const rows = this.sqlite
      .prepare(`SELECT payload_json FROM claims ORDER BY created_at DESC`)
      .all() as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as VerifiedWebClaim);
  }

  public async upsertBrief(brief: StoredDecisionBrief): Promise<void> {
    const json = JSON.stringify(brief);
    this.sqlite
      .prepare(
        `INSERT INTO briefs (id, event_id, payload_json, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, latency_ms=excluded.latency_ms, created_at=excluded.created_at`,
      )
      .run(brief.id, brief.eventId, json, brief.latencyMs, brief.generatedAtUtc);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_briefs (id, event_id, payload_json, latency_ms, created_at)
           VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)
           ON CONFLICT (id) DO UPDATE SET payload_json=EXCLUDED.payload_json, latency_ms=EXCLUDED.latency_ms, created_at=EXCLUDED.created_at`,
          [brief.id, brief.eventId, json, brief.latencyMs, brief.generatedAtUtc],
        )
        .catch((err) => logWarn('pg_upsert_brief_err', { error: String(err) }));
    }
  }

  public getBriefById(id: string): StoredDecisionBrief | null {
    const row = this.sqlite
      .prepare(`SELECT payload_json FROM briefs WHERE id = ?`)
      .get(id) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as StoredDecisionBrief) : null;
  }

  public listBriefs(): StoredDecisionBrief[] {
    const rows = this.sqlite
      .prepare(`SELECT payload_json FROM briefs ORDER BY created_at DESC`)
      .all() as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as StoredDecisionBrief);
  }

  public async logContextCall(entry: ContextApiCallRecord): Promise<void> {
    const json = JSON.stringify(entry);
    this.sqlite
      .prepare(`INSERT OR REPLACE INTO context_calls (id, timestamp_utc, payload_json) VALUES (?, ?, ?)`)
      .run(entry.id, entry.timestampUtc, json);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_context_calls (id, timestamp_utc, payload_json)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [entry.id, entry.timestampUtc, json],
        )
        .catch((err) => logWarn('pg_log_context_err', { error: String(err) }));
    }
  }

  public listContextCalls(limit = 50): ContextApiCallRecord[] {
    const rows = this.sqlite
      .prepare(`SELECT payload_json FROM context_calls ORDER BY timestamp_utc DESC LIMIT ?`)
      .all(limit) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as ContextApiCallRecord);
  }

  public countContextCallsTodayUtc(): number {
    const todayPrefix = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) as c FROM context_calls WHERE timestamp_utc >= ?`)
      .get(todayPrefix) as { c: number } | undefined;
    return Number(row?.c ?? 0);
  }

  public getKv(key: string): string | null {
    const row = this.sqlite
      .prepare(`SELECT value FROM kv_state WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  public async setKv(key: string, value: string): Promise<void> {
    const nowIso = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(key, value, nowIso);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_kv_state (key, value, updated_at) VALUES ($1, $2, $3::timestamptz)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
          [key, value, nowIso],
        )
        .catch(() => {});
    }
  }

  public saveFeedItem(item: LiveFeedItem): void {
    const json = JSON.stringify(item);
    this.sqlite
      .prepare(`INSERT OR REPLACE INTO feed_items (id, timestamp_utc, payload_json) VALUES (?, ?, ?)`)
      .run(item.id, item.timestampUtc, json);

    if (this.pgConnected && this.pgPool) {
      void this.pgPool
        .query(
          `INSERT INTO specola_feed_items (id, timestamp_utc, payload_json)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [item.id, item.timestampUtc, json],
        )
        .catch(() => {});
    }
  }

  public listFeedItems(limit = 50): LiveFeedItem[] {
    const rows = this.sqlite
      .prepare(`SELECT payload_json FROM feed_items ORDER BY timestamp_utc DESC LIMIT ?`)
      .all(limit) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as LiveFeedItem);
  }

  public async recordScreeningRun(run: {
    id: string;
    workersCount: number;
    pairsScreened: number;
    durationMs: number;
    topPairsSummary: unknown[];
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO screening_runs (id, executed_at, workers_count, pairs_screened, duration_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(run.id, nowIso, run.workersCount, run.pairsScreened, run.durationMs);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_screening_runs (id, executed_at, workers_count, pairs_screened, duration_ms, approaches_json)
           VALUES ($1, $2::timestamptz, $3, $4, $5, $6::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [run.id, nowIso, run.workersCount, run.pairsScreened, run.durationMs, JSON.stringify(run.topPairsSummary)],
        )
        .catch(() => {});
    }
  }

  public listScreeningRuns(limit = 5): ScreeningRunRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, executed_at, workers_count, pairs_screened, duration_ms
         FROM screening_runs ORDER BY executed_at DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      executed_at: string;
      workers_count: number;
      pairs_screened: number;
      duration_ms: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      executedAtUtc: r.executed_at,
      workersCount: Number(r.workers_count) || 0,
      pairsScreened: Number(r.pairs_screened) || 0,
      durationMs: Number(r.duration_ms) || 0,
    }));
  }

  public async saveOmmElements(omms: { NORAD_CAT_ID: number; EPOCH: string; [k: string]: unknown }[]): Promise<void> {
    if (!this.pgConnected || !this.pgPool || omms.length === 0) return;
    for (const omm of omms) {
      const noradId = Number(omm.NORAD_CAT_ID);
      const epochStr = String(omm.EPOCH);
      if (!Number.isFinite(noradId) || !epochStr) continue;
      await this.pgPool
        .query(
          `INSERT INTO specola_tle_elements (norad_id, epoch, omm_json)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT (norad_id, epoch) DO NOTHING`,
          [noradId, epochStr, JSON.stringify(omm)],
        )
        .catch(() => {});
    }
  }

  public async saveFleetSubscription(sub: FleetSubscription): Promise<void> {
    const json = JSON.stringify(sub);
    this.sqlite
      .prepare(`INSERT OR REPLACE INTO fleet_subscriptions (id, created_at, payload_json) VALUES (?, ?, ?)`)
      .run(sub.id, sub.createdAtUtc, json);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_fleet_subscriptions (id, created_at, payload_json)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT (id) DO UPDATE SET payload_json=EXCLUDED.payload_json`,
          [sub.id, sub.createdAtUtc, json],
        )
        .catch(() => {});
    }
  }

  public async deleteFleetSubscription(id: string): Promise<boolean> {
    const result = this.sqlite.prepare(`DELETE FROM fleet_subscriptions WHERE id = ?`).run(id);
    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(`DELETE FROM specola_fleet_subscriptions WHERE id = $1`, [id])
        .catch(() => {});
    }
    return Number(result.changes ?? 0) > 0;
  }

  public listFleetSubscriptions(): FleetSubscription[] {
    const rows = this.sqlite
      .prepare(`SELECT payload_json FROM fleet_subscriptions ORDER BY created_at DESC`)
      .all() as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as FleetSubscription);
  }

  public hasRecentAlert(dedupKey: string, windowMs = 6 * 3600_000): boolean {
    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) as c FROM alert_deliveries
         WHERE dedup_key = ? AND sent_at_utc >= ? AND delivery_status != 'failed'`,
      )
      .get(dedupKey, cutoffIso) as { c: number } | undefined;
    return Number(row?.c ?? 0) > 0;
  }

  public async recordAlertDelivery(record: AlertDeliveryRecord): Promise<void> {
    const json = JSON.stringify(record);
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO alert_deliveries (id, dedup_key, sent_at_utc, delivery_status, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.dedupKey, record.sentAtUtc, record.deliveryStatus, json);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_alert_deliveries (id, dedup_key, sent_at_utc, delivery_status, payload_json)
           VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [record.id, record.dedupKey, record.sentAtUtc, record.deliveryStatus, json],
        )
        .catch(() => {});
    }
  }

  public listAlertDeliveries(limit = 40): AlertDeliveryRecord[] {
    const rows = this.sqlite
      .prepare(`SELECT payload_json FROM alert_deliveries ORDER BY sent_at_utc DESC LIMIT ?`)
      .all(limit) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as AlertDeliveryRecord);
  }

  public recordE2eLatency(e2eMs: number): void {
    const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    this.sqlite
      .prepare(`INSERT INTO e2e_metrics (id, recorded_at, e2e_ms) VALUES (?, ?, ?)`)
      .run(id, new Date().toISOString(), Math.max(1, Math.round(e2eMs)));
  }

  public listE2eLatencies(limit = 50): number[] {
    const rows = this.sqlite
      .prepare(`SELECT e2e_ms FROM e2e_metrics ORDER BY recorded_at DESC LIMIT ?`)
      .all(limit) as { e2e_ms: number }[];
    return rows.map((r) => Number(r.e2e_ms)).filter((n) => n > 0);
  }

  public async createApiKey(label: string): Promise<{ record: ApiKeyRecord; rawKey: string }> {
    const rawKey = `spc_live_${crypto.randomBytes(18).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const id = `key-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const keyPrefix = `${rawKey.slice(0, 14)}...`;
    const createdAtUtc = new Date().toISOString();

    this.sqlite
      .prepare(
        `INSERT INTO api_keys (id, label, key_hash, key_prefix, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, label, keyHash, keyPrefix, createdAtUtc);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_api_keys (id, label, key_hash, key_prefix, created_at, last_used_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, NULL)`,
          [id, label, keyHash, keyPrefix, createdAtUtc],
        )
        .catch(() => {});
    }

    return {
      record: { id, label, keyPrefix, createdAtUtc, lastUsedUtc: null },
      rawKey,
    };
  }

  public listApiKeys(): ApiKeyRecord[] {
    const rows = this.sqlite
      .prepare(`SELECT id, label, key_prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC`)
      .all() as {
      id: string;
      label: string;
      key_prefix: string;
      created_at: string;
      last_used_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      keyPrefix: r.key_prefix,
      createdAtUtc: r.created_at,
      lastUsedUtc: r.last_used_at,
    }));
  }

  public validateApiKey(rawKey: string): boolean {
    if (!rawKey || rawKey.length < 16) return false;
    const keyHash = crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
    const row = this.sqlite
      .prepare(`SELECT id FROM api_keys WHERE key_hash = ?`)
      .get(keyHash) as { id: string } | undefined;
    if (!row) return false;
    const nowIso = new Date().toISOString();
    this.sqlite.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(nowIso, row.id);
    if (this.pgConnected && this.pgPool) {
      void this.pgPool
        .query(`UPDATE specola_api_keys SET last_used_at = $1::timestamptz WHERE id = $2`, [nowIso, row.id])
        .catch(() => {});
    }
    return true;
  }

  public async saveBacktestResult(result: BacktestResultPayload): Promise<void> {
    const json = JSON.stringify(result);
    this.sqlite
      .prepare(`INSERT OR REPLACE INTO backtest_results (id, ran_at_utc, payload_json) VALUES (?, ?, ?)`)
      .run(result.id, result.ranAtUtc, json);

    if (this.pgConnected && this.pgPool) {
      await this.pgPool
        .query(
          `INSERT INTO specola_backtest_results (id, ran_at_utc, payload_json)
           VALUES ($1, $2::timestamptz, $3::jsonb)
           ON CONFLICT (id) DO UPDATE SET ran_at_utc=EXCLUDED.ran_at_utc, payload_json=EXCLUDED.payload_json`,
          [result.id, result.ranAtUtc, json],
        )
        .catch((err) => logWarn('pg_save_backtest_err', { error: String(err) }));
    }
  }

  public getLatestBacktestResult(): BacktestResultPayload | null {
    const row = this.sqlite
      .prepare(`SELECT payload_json FROM backtest_results ORDER BY ran_at_utc DESC LIMIT 1`)
      .get() as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as BacktestResultPayload) : null;
  }
}
