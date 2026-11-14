import { X } from 'lucide-react';

interface WhatIsSpecolaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenIceyeIncident: () => void;
  onOpenWatchFleet: () => void;
}

export function WhatIsSpecolaModal({
  isOpen,
  onClose,
  onOpenIceyeIncident,
  onOpenWatchFleet,
}: WhatIsSpecolaModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-label="What is Specola overview, detection methodology, and product model"
    >
      <div className="flex max-h-[88vh] w-full max-w-[740px] flex-col border border-white bg-black text-white">
        <div className="flex items-center justify-between border-b border-[#262626] px-5 py-3.5">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">
              What is Specola
            </h2>
            <p className="mt-0.5 font-mono-tabular text-[11px] text-[#737373]">
              Real-Time Orbital Threat Detection &amp; Web-Verified Space Domain Awareness
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 border border-[#262626] bg-[#0A0A0A] px-2.5 py-1 text-xs text-white hover:border-white"
          >
            <X className="h-3.5 w-3.5" />
            <span>Close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs leading-relaxed text-[#D4D4D4]">
          {/* 1. Core Purpose */}
          <section className="space-y-1.5">
            <h3 className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-white">
              01 · What Specola Does
            </h3>
            <p>
              Specola is an orbital intelligence and conjunction early-warning console built for
              European commercial &amp; defense satellite operators like <strong className="text-white">ICEYE</strong>.
              It fuses live <strong className="text-white">Space-Track General Perturbations (GP)</strong> telemetry
              propagated via <strong className="text-white">SGP4</strong> with live{' '}
              <strong className="text-white">Context.dev</strong> web intelligence and{' '}
              <strong className="text-white">Gemini</strong> structured extraction.
            </p>
            <p className="text-[#A3A3A3]">
              Orbit physics alone only tells you two dots are getting close. The moment two satellites
              converge, <strong className="text-white">Context.dev</strong> automatically finds out whose
              satellite is approaching yours, who built it, when it launched, what its mission is,
              and whether the event is public info yet.
            </p>
            <p className="border-l-2 border-white pl-3 text-[#D4D4D4]">
              <strong className="text-white">Why Context.dev is our edge:</strong> It is an entirely
              different decision if the approaching object is a Russian defense inspector versus another
              European commercial smallsat. Context.dev automatically gives ICEYE and European operators
              both <strong className="text-white">who it is</strong> (owner, builder, launch date) and{' '}
              <strong className="text-white">whether anyone publicly knows yet</strong>—before a media story breaks.
            </p>
          </section>

          {/* 2. Why Small Burns Matter + Honest Uncertainty */}
          <section className="space-y-2 border border-[#262626] bg-[#0A0A0A] p-3.5">
            <h3 className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-white">
              02 · Why Tiny Maneuvers Signal Rendezvous Setup (And Their Limits)
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 font-mono-tabular text-[11px]">
              <div className="border border-[#262626] bg-black p-2.5 space-y-1">
                <div className="font-semibold text-white">WATCH · Burn + Plane Trim</div>
                <p className="font-sans text-[11px] text-[#A3A3A3]">
                  A small +46.5 km altitude step changes Earth&apos;s <strong className="text-white">J2 nodal drift</strong> so
                  RAAN walks into another plane; a 0.03° inclination burn shifts cross-track geometry by ~3.6 km.{' '}
                  <span className="text-white">Does not prove hostile intent yet</span>—flags the pair for active tracking.
                </p>
              </div>
              <div className="border border-[#262626] bg-black p-2.5 space-y-1">
                <div className="font-semibold text-white">WARNING · Coplanar Lock</div>
                <p className="font-sans text-[11px] text-[#A3A3A3]">
                  When two satellites lock planes within <strong className="text-white">Δθ &lt; 0.05°</strong> (~6 km in LEO)
                  while closing in range, it is a textbook rendezvous setup—though arrival still depends on a later braking burn.
                </p>
              </div>
              <div className="border border-[#262626] bg-black p-2.5 space-y-1">
                <div className="font-semibold text-white">ALERT · 72h TCA &lt; 50 km</div>
                <p className="font-sans text-[11px] text-[#A3A3A3]">
                  After the braking burn matches orbital period, SGP4 predicts physical flyby range inside 50 km over 24h
                  before closest approach.
                </p>
              </div>
            </div>
          </section>

          {/* 3. Product & Monetization */}
          <section className="space-y-2">
            <h3 className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-white">
              03 · Product &amp; Commercial Model
            </h3>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="border border-[#262626] bg-[#0A0A0A] p-3 space-y-1">
                <div className="font-semibold text-white">Fleet Watch Subscriptions</div>
                <p className="text-[11px] text-[#A3A3A3]">
                  Satellite operators subscribe by NORAD constellation (e.g. ICEYE SAR, Sentinel, commercial LEO/GEO fleets) for
                  automated 72h TCA, coplanar-lock, and maneuver alerts before routine &lt;5 km safety CDMs trigger.
                </p>
              </div>
              <div className="border border-[#262626] bg-[#0A0A0A] p-3 space-y-1">
                <div className="font-semibold text-white">Context.dev + SGP4 Verification API</div>
                <p className="text-[11px] text-[#A3A3A3]">
                  Metered REST/Webhook access (<span className="font-mono-tabular text-white">/api/v1/*</span>) for insurers,
                  defense analysts, and newsrooms to verify unconfirmed space-threat reports against orbital telemetry.
                </p>
              </div>
            </div>
          </section>

          {/* 4. Quick Navigation */}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#262626] pt-3">
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenWatchFleet();
              }}
              className="border border-[#262626] bg-black px-3 py-1.5 text-xs font-medium text-white hover:border-white"
            >
              Configure Fleet Alerts
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenIceyeIncident();
              }}
              className="border border-white bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-[#E5E5E5]"
            >
              Launch Demo →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
