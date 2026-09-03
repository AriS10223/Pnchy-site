# Pnchy Business Finder — integration notes

## What's here
- `PnchyBusinessFinder.tsx` — the widget itself
- `pnchy-business-check-worker.js` — Cloudflare Worker, checks a business via Nominatim (OpenStreetMap) with 24h caching
- `supabase-schema.sql` — run once in the Supabase SQL editor
- `pnchy-widget-preview.html` — a mocked, no-backend visual preview of all 4 states (open directly in a browser)

## Setup

1. **Nominatim (OpenStreetMap)** — no signup, no key, no card. Just replace the
   placeholder contact in `USER_AGENT` at the top of the Worker with a real one —
   Nominatim's usage policy requires a genuine identifying User-Agent and will
   block generic ones.

2. **Cloudflare Worker** — `wrangler deploy` on `pnchy-business-check-worker.js`, then:
   ```
   wrangler secret put ALLOWED_ORIGIN   # e.g. https://www.pnchy.app
   ```
   (No BRAVE_API_KEY needed anymore — Nominatim doesn't use one.)

3. **Supabase** — new project (free tier: no card, unlimited API requests; the only
   catch is it pauses after 7 days with zero traffic — a scheduled GitHub Action
   pinging it weekly is a one-line fix if that ever matters). Run `supabase-schema.sql`
   in the SQL editor. Grab your project URL + anon key from Settings > API.

4. `npm install @supabase/supabase-js`

5. Render it:
   ```tsx
   <PnchyBusinessFinder
     checkEndpoint="https://your-worker.workers.dev"
     supabaseUrl="https://xxxx.supabase.co"
     supabaseAnonKey="..."
     earlyAccessUrl="https://your-framer-waitlist-page"
   />
   ```

## Why Nominatim instead of DuckDuckGo

You asked for DuckDuckGo specifically because it's free, so worth being upfront:
DuckDuckGo doesn't actually have a search or local-business API to switch to. Their
only official, free endpoint is the Instant Answer API, which returns Wikipedia-style
summaries for encyclopedia-type queries ("what is..."), not web results and
definitely not business/address data — it can't tell you whether "Joe's Cafe" is a
real place with a location. Everything calling itself a "DuckDuckGo Search API" that
you'll find online is an unofficial scraper of their HTML results pages: against
their terms of service, no commercial path if it breaks, and liable to get
rate-limited or CAPTCHA'd without warning. Not something to put under a feature
you're relying on.

Nominatim (OpenStreetMap's free geocoder) actually does what you need for free: no
key, no card, real address/POI data. The trade-off is coverage — it's crowdsourced,
so it knows fewer small/newer businesses than Google or Brave's commercial data.
Expect more "unverified" outcomes for real places that just haven't been mapped yet.
When that happens, the widget now points people to get in touch with Pnchy directly
(see below) rather than dead-ending — so a coverage gap costs you a manual follow-up,
not a lost petition.

One requirement that comes with using Nominatim: their usage policy asks you to
visibly attribute OpenStreetMap wherever you show data sourced from them. I added a
small "Place data © OpenStreetMap contributors" line under the widget for this —
it's easy to restyle but shouldn't be removed entirely while you're using their data.
The Worker also caches each unique search for 24h so repeat lookups don't hit
Nominatim again, keeping you comfortably within their "moderate use" ask.

## The "unverified" state

When Nominatim can't confirm a business, the widget no longer offers a one-click
"continue anyway" into the petition system — that path let anyone self-report any
name with zero verification, which undercut the whole point of checking in the first
place. Instead it links to `earlyAccessUrl` (your Framer page) with the button text
"Get in Touch," framed as reaching out to Pnchy to get the business registered, plus
a "try a different search" option in case they just mistyped. Puts a real person in
the loop before anything enters the petition system, instead of trusting a self-report.

## Changelog

- **Unverified flow replaced**: "yes it's real, continue anyway" (which let anyone
  self-report straight into the petition system with zero verification) is gone.
  Unverified businesses now link to "Get in Touch" (`earlyAccessUrl`) instead, so a
  person reviews it before it becomes a petition. The now-unused `verified` column,
  self-report path, and outline-button styling were removed along with it.
- **Readability pass**: the long status-bar sentence now shows a short bold
  lead ("Oops.") with the rest as smaller supporting text; the signup count
  is now a big number + label instead of buried in a sentence; the early
  access blurb is now visibly secondary. Wording is unchanged, only hierarchy.
- **Real bug fix**: the "unverified" panel's body text was rendering in
  egg-white on an egg-white background (basically invisible) — now dark ink,
  as intended.
- **iOS/all-screens pass**: `-webkit-touch-callout: none` on the hold button
  so iOS doesn't pop its copy/lookup menu mid-hold; `-webkit-tap-highlight-
  color: transparent` everywhere so taps don't flash gray; `touch-action:
  manipulation` on ordinary buttons/links so there's no double-tap-to-zoom
  delay; `-webkit-appearance: none` on both inputs so iOS doesn't apply its
  own input chrome; every tappable element is now at least 44px tall (Apple's
  minimum touch target); email input now hints the right iOS keyboard and
  turns off autocapitalize/autocorrect on it.

## Defaults I chose without asking again — flag anything you want changed

- **Text color on colored panels is egg white (FAF7F2)**, not the warm tan in your
  mockups — a contrast/accessibility call, since tan-on-blue and tan-on-purple both
  read as fairly low contrast at body-text sizes. Yellow (F2B476) is used for the
  Early Access / Get in Touch button fill and small accents instead.
- **The "Get in Touch" button is shorter than your exact wording** ("get in touch
  with Pnchy to get it registered on Pnchy") — I put your full phrasing as the
  smaller caption text above the button and kept the button itself to two words,
  matching every other button in the widget (Sign Here, Early Access, Search again).
  A full sentence stretched across the pill would've broken the same glanceable
  hierarchy from the last round of edits. Easy to put verbatim on the button instead
  if you'd rather.
- **Petition/dedup key is a slug of name + address** — stable and derived from the
  Worker's own response, not tied to any one search provider's internal IDs.
- **Verification bias radius defaults to ~9km** (`SOFT_BIAS_DEGREES` in the Worker)
  with a ~15km hard cutoff (`MAX_DISTANCE_KM`) — it's a soft bias, not a strict box,
  so a real match just outside it still comes back rather than getting excluded.
- **Only certain Nominatim result classes count as a "business"** (shop, amenity,
  tourism, office, craft, leisure, healthcare) — this filters out roads, admin
  boundaries, and other non-POI results Nominatim can return for a name-like query.
  Add/remove classes in `BUSINESS_CLASSES` in the Worker if it's too strict or loose.
- **Font loading**: the component self-injects the Instrument Serif `@import` so it
  works as a true drop-in. For production, move that into a `<link>` tag in your
  document `<head>` instead — it's faster and avoids a flash of fallback font.
