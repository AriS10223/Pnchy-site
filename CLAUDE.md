# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Pnchy marketing site — static HTML, no build step, no framework, no package.json at the repo root. Deployed via GitHub Pages (repo `AriS10223/Pnchy-site`) at `www.pnchy.app` (see `CNAME`). There is no dev server or build/test/lint command for the site itself; "running" it means opening an `.html` file directly in a browser or serving the directory statically.

GitHub Pages resolves extensionless URLs to their `.html` file automatically with a direct `200` (no redirect) — confirmed live: `/privacy` serves `privacy.html`'s exact content at that URL. So internal links use bare paths (`/privacy`, `/404`, no `.html`) rather than requiring `privacy/index.html`-style folder restructuring — don't reintroduce `.html` extensions in `href`s, and don't restructure a page into a subfolder to "fix" its URL, it's unnecessary. This does **not** apply when opening files directly (`file://`) or serving locally with a plain static server (no extension-fallback logic) — only real GitHub Pages resolves it. The one exception is `404.html`, which must keep that exact filename/extension at the root — GitHub Pages requires it verbatim to recognize it as the site's custom error page — but it's still fine to *link* to it as `/404`, since GitHub resolves that as a normal `200` extensionless request.

This repo is nested one level deep: the git root is `Pnchy-site-main/Pnchy-site-main/` inside the outer `Pnchy-site-main/` folder.

## Source of truth: edit via Framer, not by hand

`index.html` is exported from Framer, not hand-authored. `framer_raw.html` is the original Framer export kept for reference/diffing. **The intended workflow is: make changes in Framer, then re-export** — hand-editing `index.html` directly works but will be overwritten/diverge on the next Framer export. Small surgical edits (cookie consent banner, structured data, favicon, the CHatbot widget mount below) have been hand-added directly to `index.html` in past commits when a Framer round-trip wasn't practical — if you do this, note it clearly so a future re-export doesn't silently clobber it.

`framer_source.html` is currently empty — not a real reference.

## Pages

- `index.html` — main landing page. Contains Google Consent Mode default state + gtag GA4 (`G-7YKFWY8D4Z`), a hand-rolled cookie consent banner (`CONSENT_KEY = 'pnchy_cookie_consent'` in localStorage, gates `analytics_storage`), AEO/SEO JSON-LD (`@graph` of `SoftwareApplication`, `Organization`, `FAQPage`) describing product, pricing tiers, and founders, and the CHatbot business-finder widget mount (`.widget-section` → `#pnchy-widget-root`, loaded via `js/pnchy-widget.bundle.js`, see below).
- `petition.html` — standalone "find the local business, sign the petition" hero page built around the same live widget (`#pnchy-widget-root` / `js/pnchy-widget.bundle.js`, not a copy). Illustrated doodle images (`images/Bar_Logo.png`, `Barber_Shop.png`, `Bowling_Alley_Logo.png`, `Cafe_Logo.png`, `Comic_Shop_Logo.png`) are scattered around the hero with a CSS float animation; sizing/position differs by breakpoint (`@media max-width: 680px`) and is deliberately anchored (fixed px from the hero's top edge, or in-flow after the widget) rather than percentage-based, because percentage anchoring drifted doodles into the headline/widget whenever the widget's panel height changed (idle vs. results vs. an error card) — don't revert to `top/bottom: %` positioning for these. Also carries its own copy of the nav/footer/cookie-banner markup (see below) and reuses `window.pnchyShowCookieBanner`.
- `privacy.html`, `thank-you.html`, `404.html` — standalone pages, same static/no-build pattern.
- `structured-data.json` — JSON-LD kept as a standalone file (in addition to the inline `<script type="application/ld+json">` in `index.html`).
- `llms.txt` / `llms-full.txt` — AI/LLM-readable entity definitions for crawlers and answer engines (concise vs. extended with FAQs). `robots.txt` explicitly allowlists AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) and points them at these files.
- `images/` — static assets (logo, wordmark, app screenshots).
- `js/pnchy-widget.bundle.js` — the built/bundled output of `CHatbot/`, checked in and served directly (no build happens on GitHub Pages). Regenerate it locally after editing `CHatbot/PnchyBusinessFinder.tsx`; the deployed site only ever reads this bundle, never the TSX source.

All external links to "Early Access" / sign-up point off-site to `https://pnchy.framer.website/early-access` — there is no signup form or backend for the main site itself.

## CHatbot/ — the local-business-finder widget (built, then embedded in `index.html` and `petition.html`)

`CHatbot/` is a separate React project whose only deployed artifact is the bundle at `js/pnchy-widget.bundle.js`, embedded live in both `index.html` (`#pnchy-widget-root` / `.widget-section`, added in commit `3e809fe`) and `petition.html` (same `#pnchy-widget-root` id, same script). It has its own stack, config, and deployment surface, decoupled from the rest of the static site:

- `PnchyBusinessFinder.tsx` — the widget component (React). States: `idle → typing → checking → (unverified | petition → signed)`, plus `location-blocked` and `cookie-required` side states — read the state-machine comment at the top of the file before changing flow logic.
- `build/entry.tsx` — the actual bundle entrypoint; mounts `PnchyBusinessFinder` into `#pnchy-widget-root` with hardcoded `checkEndpoint`/`supabaseUrl`/`supabaseAnonKey`/`earlyAccessUrl` props.
- Build: `cd CHatbot && npm install && npm run build` — runs `esbuild build/entry.tsx --bundle --minify --format=iife --outfile=../js/pnchy-widget.bundle.js`. Run this and commit the regenerated bundle any time `PnchyBusinessFinder.tsx` or `build/entry.tsx` changes; nothing rebuilds it automatically. Both `index.html` and `petition.html` load the same bundle, so a rebuild affects both pages at once.
- `pnchy-business-check-worker.js` + `wrangler.jsonc` — a Cloudflare Worker (`pnchy-business-check`) that verifies a business via Nominatim (OpenStreetMap geocoding, no API key) with 24h caching. Deploy with `wrangler deploy` from `CHatbot/`; set the allowed CORS origin with `wrangler secret put ALLOWED_ORIGIN`.
  - **The Worker only ever sends one `Access-Control-Allow-Origin` value** (`env.ALLOWED_ORIGIN`, the production domain) — it does not reflect the requesting origin. This means the widget's search/city-lookup calls silently fail with a generic `TypeError: Failed to fetch` (caught and swallowed as `unverified`/no-op) from *any* non-production origin: `localhost`, a `file://`-opened HTML file, a preview deploy, all of it. Don't chase this as a code bug — it only proves out end-to-end once deployed to the real domain. `curl` won't show the problem either, since CORS is enforced by the browser, not the server.
- `supabase-schema.sql` — schema for a separate Supabase project (petition/signup storage) backing the widget.
- `pnchy-widget-preview.html` — a static, no-backend mock of all 4 widget states; open directly in a browser to preview visuals only (does not reflect the live bundle).
- `INTEGRATION.md` — setup steps and design-decision notes (why Nominatim over DuckDuckGo, the "unverified business" flow routes to `earlyAccessUrl` rather than allowing self-reported petitions, OpenStreetMap attribution requirement, iOS touch-target/tap-highlight fixes). Read it before touching this widget.

`CHatbot/node_modules/` and `CHatbot/.wrangler/` are gitignored.

When testing widget flows locally (any page), mock `navigator.geolocation.getCurrentPosition` and `window.fetch` (for the Worker + Supabase URLs) rather than relying on real network calls — besides the CORS wall above, completing a real "press & hold to sign" writes a real row to production Supabase (`petitions` / `petition_signatures`), so mock that call rather than letting a local test actually submit it.

## Content facts worth knowing when editing copy

- Pricing tiers: Free ($0.00), Standard ($29.99/mo), Pro ($79.99/mo) — kept in sync in three places: `README.md`, the JSON-LD `offers` in `index.html`, and (if edited) the Framer source.
- Product mechanics referenced across copy/structured data: Digital Punch Cards (QR, 60s expiry), Density Drops (geo-fenced group rewards), Owner of the Block (leaderboard).
- Pilot market: downtown State College, PA.
