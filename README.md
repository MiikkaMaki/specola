# Specola

## **Europe, it's time for eyes on orbit.**

*Specola* is the Italian word for an astronomical observatory — from the Latin *specula*, a watchtower: a high place kept so that someone is always looking.

Specola watches public orbital data, notices when an object starts behaving like it is following a satellite, works out from the live web what that object is and who operates it, and hands the operator a sourced brief plus a draft notification to approve.

---

## Why

On 12 October 2026 the Russian military satellite Kosmos-2612 fired its engines and moved into the orbit of ICEYE-X36, a Finnish-built radar satellite. The tracking company LeoLabs made the approach public on 17 October.

The signal was in open catalogue data well before that. Large operators can buy a commercial watch service. Europe's small operators — startups, CubeSat teams, university programmes — mostly cannot, so nobody is watching their satellites at all.

Specola does that watch from open data, automatically, for free at the small end.

---

## How it works

### Context.dev in the core flow

Every alert is enriched through Context.dev. Without
it an alert reads `object 68762 is approaching object 59103`, which tells an
operator nothing actionable. With it, the alert names the object, its operator,
what has been reported about it, and links every claim to a source.


### Detection rules

## Business model

| Tier | Who | What |
|---|---|---|
| Free | CubeSat teams, universities | One satellite, basic alerts |
| Subscription | Small and mid-size operators | Per tracked satellite: whole constellation, enriched alerts, reports |
| Risk data | Insurers, public agencies | Who is being approached, and how often |

---

## Team

| | |
|---|---|
| **Miikka Mäki** | Gemini agent, 3D visualisation |
| **Jon Antoniac** | Space-Track pipeline, 3D visualisation |
| **Kiet Ta** | Product, pitch and presentation |
| **Jaakko Lilja** | Product, pitch and presentation  |

Satellite hardware on Aalto-3 at Aalto University; ground-station automation at Metsähovi Radio Observatory. Specola itself runs on public catalogue data and uses neither. The team builds satellite hardware at Aalto University (Aalto-3) and automates a tracking ground station at Metsähovi Radio Observatory. Specola itself runs on public catalogue data and uses neither.

## Stack

Context.dev · Gemini · Space-Track


Built at Junction 2026 for the Context.dev challenge.