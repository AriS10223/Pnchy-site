/**
 * pnchy-business-check-worker.js
 * ------------------------------------------------------------------
 * Cloudflare Worker that checks whether a business is a real
 * brick-and-mortar place, using OpenStreetMap's free Nominatim API.
 *
 * SWITCHED FROM BRAVE TO NOMINATIM, PER YOUR REQUEST — worth knowing
 * what that trade actually costs you:
 *  - No API key, no card, genuinely free. Nominatim has no paid tier
 *    to hit a wall on either.
 *  - OpenStreetMap's business/POI data is crowdsourced, so coverage
 *    is noticeably patchier than Google's or Brave's commercial data
 *    — expect more "unverified" results for small or newer
 *    businesses that just haven't been mapped yet. That's not a
 *    dead end though: the widget's "is this a brick and mortar? yes,
 *    continue anyway" state exists exactly for this.
 *  - Nominatim's usage policy (nominatim.org/release-docs/latest/api/Search)
 *    asks for: a real, descriptive User-Agent (set USER_AGENT below —
 *    replace the placeholder contact), a max of 1 request/second, and
 *    "appropriate caching of results" since the public instance runs
 *    on donated servers. This Worker caches each unique (name, lat,
 *    lng) check for 24h via the Cache API so repeat searches don't
 *    keep hitting Nominatim. User-triggered one-off searches (this is
 *    exactly that) are explicitly called out as fine in their policy,
 *    as long as your traffic stays moderate.
 *  - Their policy also asks you to visibly attribute OpenStreetMap
 *    wherever you show data sourced from them. I added a small
 *    attribution line to the widget for this — see PnchyBusinessFinder.tsx.
 *
 * Deploy:
 *   wrangler deploy
 *   wrangler secret put ALLOWED_ORIGIN   # e.g. https://www.pnchy.app
 *
 * Two endpoints on the same Worker, routed by pathname:
 *   POST /       { name: string, lat?: number, lng?: number }
 *                -> { verified: boolean, place?: { name, address } }
 *   POST /city   { lat: number, lng: number }
 *                -> { city: string | null }
 *   /city reverse-geocodes to just a city/town name, for the widget's
 *   idle-state "Find local business in <city>" prompt. Deliberately NOT
 *   listing real nearby business names here (an earlier version did,
 *   via Overpass) — showing actual chain names like "TJ Maxx" or
 *   "Stop & Shop" as examples implied Pnchy already serves them, which
 *   undercuts the whole point of an independent-local-business platform.
 *   This has to go through the Worker rather than being called directly
 *   from the browser (like the old Overpass call was) because browsers
 *   refuse to let JS set a custom User-Agent header — and Nominatim's
 *   usage policy requires one, blocking generic/default ones.
 * ------------------------------------------------------------------
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

// REQUIRED by Nominatim's usage policy: identify your app with a real
// contact, not a placeholder — they will block generic/default user agents.
const USER_AGENT = "PnchyApp/1.0 (https://www.pnchy.app; hello@pnchy.app)";

const SOFT_BIAS_DEGREES = 0.08; // ~9km box used to bias (not restrict) results
const MAX_DISTANCE_KM = 15; // hard cutoff applied to results after they come back
const CACHE_SECONDS = 60 * 60 * 24; // 24h — keeps us well within "moderate use"
const CITY_CACHE_SECONDS = 60 * 60 * 24; // a coordinate's city doesn't change

// Nominatim's `class` field for a result — only these represent an
// actual business/POI rather than a road, admin boundary, etc.
const BUSINESS_CLASSES = new Set([
  "shop",
  "amenity",
  "tourism",
  "office",
  "craft",
  "leisure",
  "healthcare",
]);

export default {
  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, corsHeaders);
    }

    if (new URL(request.url).pathname === "/city") {
      return handleCity(request, env, ctx, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, corsHeaders);
    }

    const name = (body.name || "").trim();
    const lat = typeof body.lat === "number" ? body.lat : null;
    const lng = typeof body.lng === "number" ? body.lng : null;
    if (!name) return json({ error: "Missing name" }, 400, corsHeaders);

    // Cache repeat checks (same business, same rough area) for 24h so
    // we don't re-hit Nominatim on every identical search.
    const cache = caches.default;
    const cacheKey = new Request(
      `https://cache.pnchy-worker.internal/check?name=${encodeURIComponent(
        name.toLowerCase()
      )}&lat=${lat ?? "x"}&lng=${lng ?? "x"}`
    );
    const cached = await cache.match(cacheKey);
    if (cached) return withCorsHeaders(cached, corsHeaders);

    try {
      const result = await checkBusiness(name, lat, lng);
      const response = json(result, 200, corsHeaders, CACHE_SECONDS);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      // Fail closed to "unverified" rather than a 500 — the widget
      // treats this the same as "couldn't confirm it".
      return json({ verified: false, error: String(err) }, 200, corsHeaders);
    }
  },
};

async function handleCity(request, env, ctx, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ city: null }, 400, corsHeaders);
  }

  const lat = typeof body.lat === "number" ? body.lat : null;
  const lng = typeof body.lng === "number" ? body.lng : null;
  if (lat == null || lng == null) return json({ city: null }, 400, corsHeaders);

  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.pnchy-worker.internal/city?lat=${lat.toFixed(2)}&lng=${lng.toFixed(2)}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) return withCorsHeaders(cached, corsHeaders);

  try {
    const city = await reverseGeocodeCity(lat, lng);
    const response = json({ city }, 200, corsHeaders, CITY_CACHE_SECONDS);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch {
    return json({ city: null }, 200, corsHeaders);
  }
}

async function reverseGeocodeCity(lat, lng) {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "10"); // city/town level, not street-level
  url.searchParams.set("addressdetails", "1");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) return null;

  const data = await res.json();
  return getLocality(data.address) || null;
}

function json(data, status, headers, cacheSeconds) {
  const h = { "Content-Type": "application/json", ...headers };
  if (cacheSeconds) h["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(data), { status, headers: h });
}

// Cloudflare's Cache API stores the whole Response, headers included —
// so a cache entry written while ALLOWED_ORIGIN was still pointed at a
// dev/localhost value keeps replaying that stale CORS header for up to
// 24h even after the secret is corrected, silently breaking the site
// for real visitors (their browser gets back a mismatched
// Access-Control-Allow-Origin and refuses to expose the response to
// JS, with no error surfaced anywhere). Re-applying the *current*
// corsHeaders on every cache hit makes a config change take effect
// immediately, while still avoiding a live Nominatim call.
function withCorsHeaders(response, corsHeaders) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

async function checkBusiness(name, lat, lng) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", name);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("limit", "8");

  if (lat != null && lng != null) {
    // Soft bias toward the user's area. Deliberately NOT using
    // `bounded=1` — that would hard-exclude a real match just outside
    // the box. We bias here, then filter/rank by real distance below.
    const box = [
      lng - SOFT_BIAS_DEGREES,
      lat + SOFT_BIAS_DEGREES,
      lng + SOFT_BIAS_DEGREES,
      lat - SOFT_BIAS_DEGREES,
    ].join(",");
    url.searchParams.set("viewbox", box);
  }

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) return { verified: false };

  const results = await res.json();
  const best = pickBestMatch(name, results, lat, lng);
  if (!best) return { verified: false };

  const rawName = best.namedetails?.name || firstToken(best.display_name) || name;
  const locality = getLocality(best.address);
  // Qualify with the city so a generic/chain name (e.g. "Shake Shack") is
  // unambiguous wherever it later shows up — the widget headline, and the
  // business_name stored on the petition row for anyone reviewing signups.
  const displayName = locality ? `${rawName}, ${locality}` : rawName;

  return {
    verified: true,
    place: {
      name: displayName,
      address: formatAddress(best.address),
    },
  };
}

function pickBestMatch(query, results, lat, lng) {
  const q = query.toLowerCase();

  const candidates = (results || [])
    .filter((r) => BUSINESS_CLASSES.has(r.category))
    .map((r) => ({
      ...r,
      distanceKm:
        lat != null && lng != null ? haversineKm(lat, lng, parseFloat(r.lat), parseFloat(r.lon)) : null,
    }));

  // A specific name match is trusted regardless of distance — someone
  // searching a uniquely-named business by name (including while
  // traveling, away from that business's actual location) almost
  // certainly means that exact place. The distance cutoff below exists
  // to disambiguate generic/chain names ("Target"), not to reject a
  // genuine match just because the user isn't standing next to it.
  const nameMatch = candidates.find((r) => {
    const n = (r.namedetails?.name || firstToken(r.display_name) || "").toLowerCase();
    return n && (n.includes(q) || q.includes(n));
  });
  if (nameMatch) return nameMatch;

  const nearby = candidates.filter((r) => r.distanceKm == null || r.distanceKm <= MAX_DISTANCE_KM);
  if (nearby.length) {
    nearby.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    return nearby[0];
  }
  return null;
}

function firstToken(displayName) {
  return (displayName || "").split(",")[0].trim();
}

function getLocality(address) {
  if (!address) return "";
  return address.city || address.town || address.village || "";
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => Number.isNaN(v))) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatAddress(address) {
  if (!address) return "";
  const { house_number, road, city, town, village, state, postcode } = address;
  const locality = city || town || village || "";
  const street = house_number && road ? `${house_number} ${road}` : road;
  return [street, locality, state, postcode].filter(Boolean).join(", ");
}
