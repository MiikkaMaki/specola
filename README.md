# Specola — European Orbital Intelligence & Verification Console

> **"Europe, eyes on orbit."**
> Live bidirectional verification between multi-source web intelligence and public SGP4 orbital mechanics.

Specola fuses real-time web intelligence with orbital mechanics to turn unverified space claims and unreported proximity maneuvers into sourced, auditable decision briefs for European satellite operators (`ICEYE`, `Kuva Space`, `Eutelsat`, `SES`, `ESA Copernicus`), space underwriters, and national Space Situational Awareness (SSA) centers.

---

## Contributors

The git history has been cleared, but the contributors are:

* Miikka Mäki
* Jaakko Lilja
* Jon Antoniac
* Ta Anh Kiet

---

## Architecture

```
+-----------------------------+        +-----------------------------------+
| 18th SDS Space-Track.org    |        | Context.dev Web Intelligence      |
| & CelesTrak GP JSON (>2h)   |        | MCP (/mcp) + REST (/v1) + Monitors|
+--------------+--------------+        +-----------------+-----------------+
               |                                         | (webhook / sweep)
               v                                         v
+--------------------------------------------------------------------------+
| Specola Fusion Engine (Stateless Express + SGP4 Runtime on Cloud Run)    |
| 1. SGP4 72h TCA screening & J2/drag Δv burn detector (36 watched sats)   |
| 2. Gemini 4 Carbon structured claim extractor & grounded brief synthesis |
| 3. Refresh orbit data on page load if >2h stale + manual "Scan now"      |
+--------------+-----------------------------------------+-----------------+
               |                                         |
               v                                         v
+-----------------------------+        +-----------------------------------+
| Aiven for PostgreSQL (SSL)  |        | Monochrome CAD Console (React/3D) |
| Hosting is stateless;       |        | Live Feed · Globe · Selected Event|
| Aiven holds all state       |        | Replay · Event Page · Watch Fleet |
+-----------------------------+        +-----------------------------------+
```

---

## Tech Stack Integrations

### How Specola uses Context.dev
Context.dev (`https://mcp.context.dev/mcp` Streamable HTTP MCP + `https://api.context.dev/v1` REST, implemented in `src/web/contextClient.ts`) provides Specola's multi-source web intelligence across four steps in the core flow:
1. **Orbit-Triggered Multi-Source Search (`web-search` / `POST /v1/web/search`)**: When SGP4 screening spots a close approach or coplanar drift between Russian/Chinese RPO payloads (`COSMOS 2612`, `LUCH 2`, `SHIJIAN-17/26`) and European spacecraft, Specola queries amateur tracking blogs (*SatTrackCam*), conjunction portals (*Orbital Radar*, *LeoLabs*), operator bulletins, and defense news.
2. **Dynamic Markdown Scraping (`web-scrape` / `POST /v1/web/scrape`)**: Converts advisory URLs into clean Markdown without per-site HTML scrapers.
3. **Continuous Monitors & Live Webhook (`list-monitors`, `create-monitor` → `POST /api/webhooks/context`)**: Registers recurring 2-hour monitors on *SatTrackCam*, *KeepTrack*, and CelesTrak RPO news queries, streaming live changes straight into Specola's `/api/feed` SSE stream, Gemini verification, and outbound alerts.
4. **European Operator Profiles (`get-brand` / `POST /v1/brand/retrieve`)**: Enriches European operators (`iceye.com`, `kuvaspace.com`, `eutelsat.com`, `ses.com`) while recording every call's endpoint, latency (`ms`), credits, and cache status in the Trust Panel ledger.

### How Specola uses Gemini
Gemini (`@google/genai`) powers three grounded reasoning workflows in `src/analyst/llmAnalyst.ts`:
1. **Structured Claim Extraction (`gemini-4-hydrogen`, `ThinkingLevel.LOW`)**: Fast-tier extraction parsing incoming web Markdown into typed JSON (`satellite_names`, `norad_ids`, `claim_type`, `claimed_distance_km`, `event_time`, `source_url`) before SGP4 verification.
2. **Sourced Decision Brief Synthesis (`gemini-4-carbon`, streaming SSE & cached JSON)**: Cross-checks verified/contradicted/caveated web claims against SGP4 conjunction geometry and Δv burn detections into auditable operator briefs—enforcing source URLs or orbit calculations on every claim and mandatory sub-km public-TLE caveats (`[LIVE GEMINI]` vs `[SEEDED ARCHIVE]` badges shown in UI).
3. **Ask Specola Fleet Analyst (`gemini-4-carbon` via `POST /api/ask`)**: Answers operator questions (*"Why HIGH?"*, *"Is anything approaching our fleet this week?"*) strictly grounded in database events, claims, maneuvers, and clickable citations.

---

## Blind Chronological Backtest Rules

To measure *"Would Specola have caught it first?"* with **zero look-ahead bias**, `src/orbit/backtest.ts` replays cached Space-Track `gp_history` records sorted strictly by Space-Track **`CREATION_DATE`** (the UTC timestamp when each element set was first published to Space-Track, falling back to `EPOCH` only if `CREATION_DATE` is absent). At every simulated step `t = CREATION_DATE`, the engine can inspect **only** element sets with `CREATION_DATE <= t`.

Pairs are formed across watched `suspects` and `protected` assets sharing the same orbital regime (`LEO` with `LEO` where `MEAN_MOTION > 10.0`, or `GEO` with `GEO` where `MEAN_MOTION < 2.0`). Fixed alert thresholds (locked prior to running):

1. **`WATCH`**: Our J2- and drag-compensated maneuver detector (`detectManeuversFromHistory`: `|Δa_res| >= 0.35 km` or `|Δi| >= 0.012°` or `|ΔΩ_res| >= 0.03°` with total `Δv >= 0.18 m/s`) triggers between the suspect's previously known OMM and the newly published OMM **AND** the new OMM reduces either the 3D orbital plane angle `Δθ` (to `< 0.25°` or by `>= 0.010°`) **OR** the instantaneous/24h range to the protected satellite (by `>= 5%` or below `550 km` while decreasing).
2. **`WARNING`**: Orbital plane angle `Δθ < 0.05°` **AND** the suspect is actively closing on the protected satellite (`currentRange < previousKnownRange` or negative range-rate / shrinking 72h minimum range).
3. **`ALERT`**: SGP4 72-hour forward Time of Closest Approach predicts `tca72h < 50 km` **OR** instantaneous separation `< 50 km`.

---

### How Specola uses Aiven
**Hosting is stateless; Aiven holds all state.** The Cloud Run container root filesystem is an ephemeral `overlay` mount that resets whenever an instance scales to zero or redeploys. **Aiven for PostgreSQL** (`AIVEN_DATABASE_URL` / `DATABASE_URL`) provides persistent EU database storage (`src/server/db.ts`):
- Persists `specola_events`, `specola_claims`, `specola_briefs`, `specola_fleet_subscriptions`, `specola_context_calls`, `specola_feed_items`, `specola_screening_runs`, `specola_alert_deliveries`, `specola_api_keys`, and `specola_e2e_metrics` across container restarts and redeploys.
- Hydrates ephemeral local cache on startup so historical briefs, fleet watches, Context.dev call telemetry, and screening timestamps survive cold starts cleanly.
- Because the stateless container sleeps when idle rather than running guaranteed 24/7 background crons, Specola automatically refreshes orbital GP data from Space-Track/CelesTrak on page load whenever the latest screening run stored in Aiven is older than 2 hours, alongside the manual **`Scan now`** button.
- **Backups**: Production deployments rely on Aiven's automated daily PostgreSQL backups with point-in-time recovery (PITR).

---

## Core Product Features

- **Fleet Watch (`/watch`)**: Search Space-Track/CelesTrak active satellites by NORAD ID or name, create monitored customer fleets, scope the entire console (`Globe`, `Events`, `Briefs`, `Ask Specola`) to your fleet, and generate **Weekly Fleet Digests**.
- **Outbound Alerts & Deduplication**: Automated dispatch to Slack Block Kit, Discord embeds, or generic HTTPS webhooks (email channel logs honestly without silent fake sends unless `SMTP_WEBHOOK_URL` is set) with brief summary, clickable sources, shareable `?event=<id>` deep link, exponential-backoff retries, and a 6-hour deduplication window per `(subscription, event, threatLevel)`.
- **Shareable Event Pages (`/?event=<id>`)**: Standalone dossier combining 3D orbital track, 72h/campaign separation chart, web verification timeline, grounded Gemini brief, and export tools.
- **CAD 3D Orbital Viewport (`CesiumJS`)**: Monochrome CAD Earth with closed 360° orbits, camera follow selector, event closeup selector, group filters (`Stations`, `Active`, `Starlink`, `Weather`, `GPS`), `1× / 15× / 60× / 300×` time acceleration, live Altitude/Velocity/Sub-point telemetry, collision/proximity alerts, and Δv burn early warnings.
- **Oct 2026 Replay**: Inspects `COSMOS 2612 (#68762) ↔ ICEYE-X36 (#59103)` from Sep 25 to Oct 25, 2026—showing Specola's **Oct 12** autonomous plane-match warning 5 days before the **Oct 17** press report and replicating **Oct 16** closest approach (**4.54 km vs 4.58 km Orbital Radar benchmark**).
- **Trust Panel & Public Read API (`/benchmarks`)**: Displays measured brief latency (`p50` / worst), E2E webhook-to-alert latency, orbital element age, Context.dev call log, and SHA-256 `x-api-key` token management for `/api/v1/events`, `/api/v1/briefs`, and `/api/v1/fleet`.
- **Markdown & PDF Export**: One-click Markdown copy, `.md` download, and print-ready monochrome PDF export (`@media print`).

---

## Indicative Pricing (Commercial Tiers)

| Tier | Indicative Price | Target Customer | Highlights |
| --- | --- | --- | --- |
| **Observer** | `€0` | Researchers, OSINT trackers, journalists | Public 36-sat watchlist, `?event=` pages, 24h delayed alerts |
| **Operator** | `[€__]` / sat / mo | Commercial EO/SAR & satcom operators | Custom fleets, real-time Slack/Discord/webhook alerts, Ask Specola, PDF/MD export, Read API |
| **Insurer** | `[€__]` / portfolio / mo | Space underwriters & Lloyd's syndicates | Multi-operator portfolio view, Δv risk history, claim verification, bulk API, weekly digest |
| **Agency** | `[€__]` / year | National SSA centers & EU ministries | EU-only hosting (Aiven EU region) or on-prem, custom suspect catalogs, SLA |

> **Business Model**: Specola sells B2B and sovereign SaaS subscriptions (`Operator`, `Insurer`, `Agency`) backed by an open `Observer` tier for community verification, creating a natural upgrade path toward commercial phased-array radar and owner-operator ephemeris feeds for sub-kilometer RPO tracking.

---

## Roadmap & Known Limits

- **Roadmap**: (1) Commercial radar & optical tracking upgrade for sub-kilometer precision, (2) Expanded GEO belt surveillance (`Luch/Olymp`, `Shijian`), behavioral **Suspect Inspector Profiles**, and RF interference correlation, (3) Automated **Weekly Digest** email campaigns & EU SST / owner-operator CDM ingestion, (4) SOC 2 / ISO 27001 certification + multi-language briefs (`FI / FR / DE / EN`).
- **Accounts & UI Focus**: To keep the live mission console uncluttered (`Globe`, `Live Feed`, `Selected Event`, plus `Under the hood` diagnostics drawer and 1-click-deep `Replay`, `Event Page`, `Watch Fleet`), Commercial Pricing, About/Business Model, Accounts/SSO, API Keys management, Weekly Digest UI, and Suspect Profile dossiers are documented here rather than crowded into the UI. Read API keys (`spc_live_...`) remain accessible via `POST /api/keys` and `/api/v1/*`.
- **Orbital Physics Limits & Disclaimer**: Public GP/TLE element sets carry **~1 km epoch uncertainty** growing **+1–3 km/day** along-track. **Specola provides screening-grade orbital and web intelligence analysis—it is NOT an operational collision warning service or maneuver authority.**

---

## Quick Start & Public API

```bash
cp .env.example .env
npm install

# Run SGP4, fusion verification & alert deduplication tests
npm test

# Typecheck and build production assets
npm run lint
npm run build

# Start full-stack server on http://localhost:3000
npm run dev
```

### Public Read API (`/api/v1/*`)
Generate an API key from **Benchmarks → Public Read API** (or `POST /api/keys`), then pass `x-api-key: spc_live_...`:
- `GET /api/v1/events` — Verified orbital events & threat levels
- `GET /api/v1/briefs` — Grounded Gemini & archived decision briefs
- `GET /api/v1/fleet` — Protected/suspect catalog & subscribed customer fleets
- `GET /api/health` — Live service, Aiven PostgreSQL, external API, and rate-limiter status

### Data Source Attributions
Orbital elements sourced via **18th Space Defense Squadron (Space-Track.org)** and **CelesTrak** public GP feeds under their respective terms of use; live web articles retrieved and cited via **Context.dev** with clickable source links.
