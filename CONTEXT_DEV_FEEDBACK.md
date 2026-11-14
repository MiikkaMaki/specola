# Context.dev Technical & Developer Feedback Note — Team Specola (Junction 2026)

## How Specola Uses Context.dev as Its Web Intelligence Backbone

Specola fuses multi-source open web intelligence with SGP4 satellite orbital mechanics so European satellite operators can verify proximity rumors and catch unreported orbital maneuvers early. Rather than relying on a brittle single-site scraper, Specola chains four distinct **Context.dev REST API v1** primitives into one real-time verification pipeline:

1. **Multi-Source Search (`POST /v1/web/search`)**: Continuously sweeps domain-filtered space situational awareness (SSA) analysts (`sattrackcam.blogspot.com`, `leolabs.space`, `orbitalradar.com`), defense reporting (`twz.com`, `spacenews.com`), and European operator newsrooms (`iceye.com`, `kuvaspace.com`, `eutelsat.com`, `ses.com`) for watched NORAD IDs and RPO designations (`"Cosmos 2612"`, `"68762"`, `"ICEYE-X36"`, `"Luch"`).
2. **Clean Markdown Scraping (`POST /v1/web/scrape`)**: Converts JavaScript-heavy operator advisories and conjunction dashboards into clean Markdown ready for **Gemini 4 Carbon** structured schema extraction (`satellite_names[]`, `norad_ids[]`, `claim_type`, `claimed_distance_km`, `event_time`).
3. **Persistent Change Monitors & Webhooks (`POST /v1/monitors` → `POST /api/webhooks/context`)**: Subscribes to orbital analyst feeds and watched satellite pairs so Specola reacts asynchronously the moment a new blog post or conjunction update drops—pushing verified updates straight to operators via Server-Sent Events (`/api/feed`).
4. **European Operator Enrichment (`POST /v1/brand/retrieve`)**: Resolves operator domains (`iceye.com`, `kuvaspace.com`, `eutelsat.com`, `ses.com`) into verified corporate metadata and routing profiles for decision brief notifications.

---

## Actionable Developer Note for the Context.dev Engineering Team

1. **What Worked Exceptionally Well**:
   - Unifying `/web/search`, `/web/scrape`, `/monitors`, and `/brand/retrieve` behind a single Bearer key (`https://api.context.dev/v1`) eliminated three separate third-party SDKs (SERP API + headless scraper + cron diffing worker) from our architecture.
   - Delivery replay and structured webhook events (`run.completed`) make testing real-time event pipelines in a hackathon environment remarkably clean.

2. **High-Impact Technical Suggestion (Numeric & Temporal Diff Triggers on `/v1/monitors`)**:
   - In aerospace, financial, and cybersecurity monitoring, target pages (like Orbital Radar conjunction pages or CelesTrak status tables) update continuously with minor clock ticks or orbital rev counters, which can cause noisy text-diff webhook triggers.
   - Adding an optional **JSON Schema / Semantic Threshold Filter** directly on `POST /v1/monitors` (e.g., *"only fire webhook when extracted `distance_km < 25` or when a new `NORAD_ID` appears in the page markdown"*) would turn Context.dev Monitors into a zero-false-positive event bus for physical-world telemetry apps.
