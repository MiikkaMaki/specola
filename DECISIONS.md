# Specola — Architectural Decisions & Physical Limits (`DECISIONS.md`)

## 1. Key Engineering Choices

1. **Unified TypeScript Full-Stack Runtime (`Express` + `satellite.js` v7 + `node:sqlite` + `React` + `CesiumJS`)**
   - **Choice**: Run SGP4 orbital propagation, maneuver physics, Context.dev v1 REST integration, Gemini 4 Carbon structured decision brief synthesis, SSE streaming (`/api/feed`), and the CesiumJS 3D globe in a single TypeScript deployment on port 3000.
   - **Rationale**: Zero cross-language serialization overhead, sub-25ms 72-hour closest-approach screening across watched pairs, native `node:test` verification, and one-click Cloud Run hosting.

2. **Two-Stage Coarse-to-Fine Conjunction Search**
   - **Choice**: Screen 72-hour conjunction windows on a vectorized 60-second SGP4 ECI grid first, then refine every local distance minimum down to 1-second resolution (golden-section / dense local neighborhood) around Time of Closest Approach (TCA).
   - **Rationale**: Captures high-relative-velocity LEO passes (~14 km/s closing speeds can traverse 840 km in 60 seconds!) without missing sub-5 km conjunctions, reproducing Orbital Radar's October 16, 2026 `4.58 km` (`07:28 UTC`) closest approach between `COSMOS 2612 (68762)` and `ICEYE-X36 (59103)`.

3. **Analytical Secular $J_2$ Filtering + Vis-Viva $\Delta v$ Maneuver Detection**
   - **Choice**: Compare consecutive GP/OMM element sets by computing expected secular nodal precession ($\dot{\Omega}_{J_2}$) and atmospheric drag decay, flagging maneuvers only when semi-major axis ($\Delta a$), inclination ($\Delta i$), or residual RAAN ($\Delta \Omega - \dot{\Omega}_{J_2}\Delta t$) exceed physical thresholds, and estimating burn magnitude via vis-viva + plane-change $\Delta v = \sqrt{\Delta v_a^2 + (2 v \sin(\Delta \theta / 2))^2}$.
   - **Rationale**: Prevents normal LEO atmospheric drag or oblateness precession from raising false-positive maneuver alerts.

4. **Token-Free, On-Demand CesiumJS Rendering**
   - **Choice**: Configure CesiumJS with `requestRenderMode: true` and a procedural high-contrast astronomical graticule/continental base map (plus optional OpenStreetMap dark imagery toggle and optional Cesium Ion token support).
   - **Rationale**: Works completely offline without paid map keys and avoids 60Hz idle GPU/CPU drain.

5. **Resilient External Data Hierarchy (Never Fabricate Telemetry)**
   - **Choice**: Live CelesTrak GP/SATCAT queries enforce a strict 2-hour local disk/SQLite fair-use cache (`data/cache/`) and fast timeout backoff (cloud datacenter egress IPs are frequently rate-limited or dropped by `celestrak.org`). When live CelesTrak, Space-Track, or Context.dev keys are unreachable or unconfigured, Specola falls back to provenance-labeled snapshots (`seeded-celestrak-snapshot`, `published-historical-tle-archive`, `verified-oct2026-corpus`) and surfaces explicit connection statuses in `/api/metrics`.

---

## 2. Known Physical & Operational Limits

- **Public GP / TLE Covariance & Sub-Kilometer Claims**:
  - Public NORAD General Perturbations (GP / TLE) element sets carry inherent 1-sigma positional uncertainties of **~0.8–1.5 km at epoch**, growing by **+1 to 3 km per day** along-track due to unmodeled thermospheric density fluctuations and SGP4 analytical approximations.
  - **Hard Specola Rule**: Specola **never** asserts Confirmed sub-kilometer miss distances from public TLE data alone. When media or commercial radar providers (e.g., LeoLabs / Vantor reports on Oct 18, 2026) claim "hundreds of meters", Specola classifies the co-orbital RPO regime as **Verified** (< 5 km coplanar shadowing) while explicitly annotating the sub-kilometer figure with a mandatory covariance uncertainty statement recommending owner/operator ephemeris or commercial phased-array radar tasking.
- **Element Set Publication Latency**:
  - Public 18th SDS / CelesTrak updates typically lag maneuver execution by **4 to 18 hours** depending on ground-station pass geometry. Specola displays element epoch age alongside every satellite and highlights that autonomous maneuver detection triggers immediately upon element ingestion—still **4 to 5 days earlier** than mainstream press reporting in the October 2026 `COSMOS 2612` / `ICEYE-X36` campaign.
