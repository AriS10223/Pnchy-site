# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Pnchy marketing site — static HTML, no build step, no framework, no package.json. Deployed via GitHub Pages (repo `AriS10223/Pnchy-site`) at `www.pnchy.app` (see `CNAME`). There is no dev server or build/test/lint command; "running" the site means opening an `.html` file directly in a browser or serving the directory statically.

This repo is nested one level deep: the git root is `Pnchy-site-main/Pnchy-site-main/` inside the outer `Pnchy-site-main/` folder.

## Source of truth: edit via Framer, not by hand

`index.html` is exported from Framer, not hand-authored. `framer_raw.html` is the original Framer export kept for reference/diffing. **The intended workflow is: make changes in Framer, then re-export** — hand-editing `index.html` directly works but will be overwritten/diverge on the next Framer export. Small surgical edits (e.g. the cookie consent banner, structured data, favicon) have been hand-added directly to `index.html` in past commits when a Framer round-trip wasn't practical — if you do this, note it clearly so a future re-export doesn't silently clobber it.

`framer_source.html` is currently empty — not a real reference.

## Pages

- `index.html` — main landing page. Contains Google Consent Mode default state + gtag GA4 (`G-7YKFWY8D4Z`), a hand-rolled cookie consent banner (`CONSENT_KEY = 'pnchy_cookie_consent'` in localStorage, gates `analytics_storage`), and AEO/SEO JSON-LD (`@graph` of `SoftwareApplication`, `Organization`, `FAQPage`) describing product, pricing tiers, and founders.
- `privacy.html`, `thank-you.html`, `404.html` — standalone pages, same static/no-build pattern.
- `structured-data.json` — JSON-LD kept as a standalone file (in addition to the inline `<script type="application/ld+json">` in `index.html`).
- `llms.txt` / `llms-full.txt` — AI/LLM-readable entity definitions for crawlers and answer engines (concise vs. extended with FAQs). `robots.txt` explicitly allowlists AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) and points them at these files.
- `images/` — static assets (logo, wordmark, app screenshots).

All external links to "Early Access" / sign-up point off-site to `https://pnchy.framer.website/early-access` — there is no signup form or backend in this repo itself.

## CHatbot/ — new, not yet wired into the site

`CHatbot/` (plus the untracked `CHatbot.zip`) is a separate, self-contained React widget ("Pnchy Business Finder") staged in this repo but **not referenced by `index.html` and not part of the deployed static site**. It has its own stack and deployment surface:

- `PnchyBusinessFinder.tsx` — the widget component (requires a React app to host it; this repo has no React tooling).
- `pnchy-business-check-worker.js` — a Cloudflare Worker that verifies a business via Nominatim (OpenStreetMap geocoding, no API key) with 24h caching.
- `supabase-schema.sql` — schema for a separate Supabase project (petition/signup storage).
- `pnchy-widget-preview.html` — a static, no-backend mock of all 4 widget states; open directly in a browser to preview visuals only.
- `INTEGRATION.md` — setup steps (`wrangler deploy` + `wrangler secret put ALLOWED_ORIGIN`, Supabase project creation, `npm install @supabase/supabase-js`) and design-decision notes (why Nominatim over DuckDuckGo, the "unverified business" flow routes to `earlyAccessUrl` rather than allowing self-reported petitions, OpenStreetMap attribution requirement, iOS touch-target/tap-highlight fixes). Read it before touching this widget.

Treat `CHatbot/` as a separate mini-project with its own integration path (Cloudflare Worker + Supabase), not as site source to be merged into `index.html` without a deliberate integration step.

## Content facts worth knowing when editing copy

- Pricing tiers: Starter (free), Pro ($29/mo), Pro+ ($79/mo) — kept in sync in three places: `README.md`, the JSON-LD `offers` in `index.html`, and (if edited) the Framer source.
- Product mechanics referenced across copy/structured data: Digital Punch Cards (QR, 60s expiry), Density Drops (geo-fenced group rewards), Owner of the Block (leaderboard).
- Pilot market: downtown State College, PA.
