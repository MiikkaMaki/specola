# Specola — 3-Minute Demo Script (`DEMO.md`)

> **"Europe, eyes on orbit."**
> Live verification between multi-source web intelligence and public SGP4 orbital mechanics.

## Pre-Demo Verification (10s)
- Verify `GET /api/health` returns `ok: true` and `aivenConfigured: true`.
- Footer displays **`State: Aiven PostgreSQL, EU`** reading live shared state directly from PostgreSQL.

---

## 0:00 – 0:45 · Focused Main Console (`Console`)
- **Action**: Open `/`. Point out that the main console shows strictly three elements: **Live Feed**, **3D CAD Globe**, and **Selected Event** (plus the thin 72h Orbit Scan strip at the top).
- **Orbit Refresh**: Point out `Last scan / Stale refresh / Pairs screened / Duration` (read from Aiven PostgreSQL; auto-refreshes on load when >2 hours stale) and press **`Scan now`** to trigger an immediate 72h screening pass.
- **Globe**: Rotate the monochrome CesiumJS viewport (`MMB Orbit · Shift+MMB Tilt`), toggle Constellation Groups (`Stations`, `Starlink`, `Weather`, `GPS`), and switch speed (`1× / 15× / 60× / 300×`).
- **Gemini**: On **Selected Event**, point out the inline Gemini provenance (`gemini-4-carbon`, measured `ms` latency or archived baseline), press **Synthesize Brief** for a live Gemini run, and click any sentence in the brief summary to highlight its backing source URL or SGP4 orbit computation.

---

## 0:45 – 1:35 · Event Page & Bidirectional Verification (`Event Page →`)
- **Action**: Click **Event Page →** (`/?event=evt-cosmos2612-iceyex36`).
- **Aiven Separation History**: Scrub the Sep 25 → Oct 25 campaign timeline showing **Oct 12** autonomous plane-match warning (`~475 km`, `0.003°`) **5 days before the Oct 17 press report**, plus **Oct 16** TCA (`4.54 km vs 4.58 km` public benchmark).
- **Context.dev Sources Timeline & URL Verifier**:
  1. Show each source link, extracted claim, and inline **`monitor / scrape / extract`** timestamp & latency tags.
  2. Paste any satellite report URL into **"Check this report"** to scrape via Context.dev, extract with Gemini, verify against SGP4 orbits, and inspect the live `VERIFIED / CONTRADICTED / UNVERIFIABLE` verdict with measured latency (`ms`).

---

## 1:35 – 2:20 · Live Feed, Watch Fleet & Alerts
- **Action**: Click **Simulate Webhook** in the **Live Feed** (`Aiven`) to watch `monitor_fired → claim_extracted → claim_verified → brief_generated → alert_dispatched` arrive via SSE without refreshing.
- **Watch Fleet**: Navigate 1 click deep to **Watch Fleet**, search any spacecraft by name/NORAD ID, register a Slack/Discord/HTTPS webhook watch, and click **Scope Dashboard** to isolate threats strictly to that operator's fleet.

---

## 2:20 – 3:00 · Under the Hood Drawer (`Under the hood`)
- **Action**: Click **Under the hood** in the top-right header (closed by default).
- **Show**:
  1. Stateless verification architecture diagram (**Context.dev**, **SGP4 Engine**, **Gemini**, **Aiven PostgreSQL**).
  2. Real database-backed Gemini p50/worst latency, SGP4 accuracy metrics (`—` shown honestly until measured), and Aiven table row counts.
  3. Live **Context.dev Call Log** showing endpoint, target query, HTTP status, and measured `ms` latency.
