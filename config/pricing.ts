/**
 * Editable indicative pricing tiers, roadmap items, and business copy (Tier 3 present-only).
 * Keep placeholder prices as "[€__]" until commercial pricing is finalized.
 */

export interface PricingTierConfig {
  id: 'observer' | 'operator' | 'insurer' | 'agency';
  name: string;
  indicativePrice: string;
  unit: string;
  audience: string;
  alertDelay: string;
  features: string[];
  statusLabel: string;
}

export const INDICATIVE_PRICING_STATUS = 'INDICATIVE — EDITABLE PLACEHOLDERS';

export const PRICING_TIERS: PricingTierConfig[] = [
  {
    id: 'observer',
    name: 'Observer',
    indicativePrice: '€0',
    unit: 'Free · Public Access',
    audience: 'Researchers, OSINT analysts, and space journalists',
    alertDelay: '24h delayed public alerts',
    statusLabel: 'FREE TIER',
    features: [
      'Public European watchlist & historical campaign replay',
      'Shareable public Event Pages (?event=...) with SGP4 verdicts',
      '24-hour delayed conjunction & burn notifications',
      'Public GP/TLE ~1 km covariance methodology visibility',
    ],
  },
  {
    id: 'operator',
    name: 'Operator',
    indicativePrice: '[€__]',
    unit: 'per protected satellite / month',
    audience: 'Commercial SAR, EO, hyperspectral, and satcom operators (ICEYE, Kuva Space, Eutelsat)',
    alertDelay: 'Real-time webhooks, Slack/Discord & email',
    statusLabel: 'INDICATIVE',
    features: [
      'Custom Fleet Watch by NORAD ID or spacecraft name',
      'Real-time alerts on threat-level escalation with deduplication',
      'Ask Specola grounded analyst chat scoped to your fleet',
      'Markdown / PDF management & authority export + Read API',
    ],
  },
  {
    id: 'insurer',
    name: 'Insurer',
    indicativePrice: '[€__]',
    unit: 'per portfolio / month',
    audience: 'Space underwriters, Lloyd’s syndicates, and reinsurance risk desks',
    alertDelay: 'Real-time portfolio risk & claims triage',
    statusLabel: 'INDICATIVE',
    features: [
      'Multi-operator portfolio view across insured spacecraft',
      'Historical proximity-risk & unreported Δv burn ledger per satellite',
      'Auditable web-claim contradiction checks against public TLE bounds',
      'Bulk REST API & weekly underwriter risk digest',
    ],
  },
  {
    id: 'agency',
    name: 'Agency',
    indicativePrice: '[€__]',
    unit: 'annual sovereign contract',
    audience: 'National Space Situational Awareness (SSA) centers, defense ministries, EU SST',
    alertDelay: 'Real-time dedicated queues + SLA',
    statusLabel: 'INDICATIVE',
    features: [
      'National or regional watchlists + custom suspect orbital catalogs',
      'EU-only sovereign hosting (Aiven EU region) or on-premise deployment',
      'Custom SGP4/OEM ingestion hooks & dedicated Modal worker pools',
      'SLA, audit logs, and custom authority brief templates',
    ],
  },
];

export const PRODUCT_ROADMAP_ITEMS: { phase: string; title: string; detail: string }[] = [
  {
    phase: 'Phase 1 · Precision Data',
    title: 'Commercial Radar & Optical Tracking Upgrade',
    detail:
      'Optional paid precision ephemerides (LeoLabs / commercial phased-array radar & European optical networks) to break below the ~1 km public TLE covariance floor for sub-kilometer RPO passes.',
  },
  {
    phase: 'Phase 2 · Deep GEO & RF',
    title: 'Continuous GEO Co-Location & RF Interference Attribution',
    detail:
      'Expand Luch/Olymp & Shijian GEO station-keeping surveillance and cross-correlate operator Ku/Ka/X-band uplink interference logs with Web RF bulletins.',
  },
  {
    phase: 'Phase 3 · European Integration',
    title: 'EU SST & Operator CDM Integration',
    detail:
      'Ingest authenticated owner-operator OEMs and EU SST Conjunction Data Messages (CDMs) alongside public Space-Track GP sets.',
  },
  {
    phase: 'Phase 4 · Enterprise Trust',
    title: 'SOC 2 / ISO 27001 & Multi-Language Briefs',
    detail:
      'Formal security compliance certification and native brief generation in Finnish, French, German, and English for European ministries and operators.',
  },
];

export const SPECOLA_BUSINESS_MODEL_PARAGRAPH =
  'Specola is a B2B and sovereign SaaS orbital verification platform sold to European satellite operators (per protected satellite/month), space insurers underwriting on-orbit policies (per portfolio/month), and national defense/SSA agencies (annual EU-sovereign contracts), while offering a free Observer tier to attract open-source trackers and establish public credibility. By unifying zero-parser Context.dev web monitoring, public Space-Track/CelesTrak orbital physics, Gemini 4 Carbon synthesis, and EU-anchored Aiven PostgreSQL persistence, Specola replaces hours of manual flight-dynamics triage with auditable, sub-minute decision briefs—and creates an immediate paid upgrade path to integrate commercial radar data whenever sub-kilometer precision is required.';
