import React, { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * PnchyBusinessFinder
 * ------------------------------------------------------------------
 * Scrappy 4-state "find the local business" widget for pnchy.app.
 *
 * States:
 *   idle      -> auto-playing typewriter cycling example prompts (blue)
 *   typing    -> user's real query, box turns green
 *   checking  -> calls your Cloudflare Worker, which checks whether the
 *                business is a real brick-and-mortar place via
 *                Nominatim/OpenStreetMap (purple + sketch map)
 *   unverified-> couldn't confirm it's a real physical business — sends
 *                people to get in touch with Pnchy directly rather than
 *                letting them self-report into the petition system
 *   petition  -> "not on Pnchy yet" — press-and-hold 5s + email to
 *                sign; count lives in Supabase (red + green)
 *   signed    -> confirmation after signing
 *
 * Everything is self-contained: inline styles + one injected <style>
 * block for keyframes and the Instrument Serif import, so this drops
 * into pretty much any React setup with no CSS pipeline required.
 * Swap the inline styles for your own CSS/Tailwind if you'd rather.
 *
 * DEFAULTS I CHOSE WITHOUT ASKING AGAIN (flagged, easy to change):
 *  - Primary text on colored panels is egg white (FAF7F2) rather than
 *    the warm tan seen in your mockups — a contrast/accessibility
 *    call, since tan-on-blue and tan-on-purple both read as fairly
 *    low contrast at body-text sizes. Yellow (F2B476) is used for the
 *    Early Access / Get in Touch button fill and small accents instead.
 *  - The petition/dedup key is a slug of name+address, not tied to any
 *    one search provider's internal ids (those can be ephemeral).
 *  - Verification bias radius defaults to ~9km; change SOFT_BIAS_DEGREES
 *    in the Worker if you want tighter/looser matching.
 * ------------------------------------------------------------------
 */

// ---------------------------------------------------------------
// Brand tokens
// ---------------------------------------------------------------
const COLORS = {
  eggWhite: "#FAF7F2",
  green: "#689581",
  yellow: "#F2B476",
  red: "#BB5A52",
  blue: "#3A85A6",
  purple: "#6D4886",
  ink: "#2B2420",
} as const;

const FONT_FAMILY = `"Instrument Serif", Georgia, serif`;

const HOLD_MS = 5000;
const GOAL_SIGNATURES = 1000;

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------
type WidgetState =
  | "idle"
  | "typing"
  | "checking"
  | "unverified"
  | "petition"
  | "signed"
  | "location-blocked"
  | "cookie-required";

interface VerifiedPlace {
  name: string;
  address: string;
}

export interface PnchyBusinessFinderProps {
  /** Your Cloudflare Worker endpoint that proxies the Brave Search check */
  checkEndpoint: string;
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase anon (public) key — safe to expose client-side */
  supabaseAnonKey: string;
  /** Where the "Early Access" button sends people (your Framer waitlist page) */
  earlyAccessUrl: string;
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const slugify = (input: string) =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Auto-growing pill: measures the actual rendered width of the typed
// text (via a scratch canvas, using the input's own computed font so
// clamp()-based responsive sizing is already resolved to real px) so
// the bar can hug short queries and grow toward the wrap's own
// max-width (set by the host page to match its headline) as you type.
let measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidth(text: string, font: string): number {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function useGeolocation() {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "granted" | "denied" | "unsupported">("idle");

  const request = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setStatus("unsupported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setStatus("granted");
      },
      () => setStatus("denied"),
      { timeout: 6000, maximumAge: 5 * 60 * 1000 }
    );
  }, []);

  return { coords, status, request };
}

// One-shot transition: shows `placeholder` ("...") until `target` (the
// resolved city name) arrives, then backspaces the placeholder out and
// types the target in, character by character. Unlike the old cycling
// typewriter, this runs once and stops — there's only one real answer
// to land on, not several examples to keep rotating through.
function useBackspaceType(target: string | null, placeholder: string) {
  const [text, setText] = useState(placeholder);
  useEffect(() => {
    if (!target) {
      setText(placeholder);
      return;
    }
    let cancelled = false;
    let current = placeholder;
    const BACKSPACE_MS = 45;
    const TYPE_MS = 55;

    const typeStep = (i: number) => {
      if (cancelled) return;
      current = target.slice(0, i);
      setText(current);
      if (i < target.length) setTimeout(() => typeStep(i + 1), TYPE_MS);
    };

    const backspaceStep = () => {
      if (cancelled) return;
      current = current.slice(0, -1);
      setText(current);
      if (current.length > 0) {
        setTimeout(backspaceStep, BACKSPACE_MS);
      } else {
        setTimeout(() => typeStep(1), 150);
      }
    };

    backspaceStep();
    return () => {
      cancelled = true;
    };
  }, [target, placeholder]);
  return text;
}

// ---------------------------------------------------------------
// Decorative sketch map (purely decorative — no real geography)
// ---------------------------------------------------------------
function SketchMap() {
  return (
    <svg
      className="pnchy-sketch-map"
      viewBox="0 0 240 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g stroke={COLORS.eggWhite} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85">
        <path d="M42 12 L38 138" />
        <path d="M92 10 L88 140" />
        <path d="M142 14 L146 136" />
        <path d="M190 18 L196 132" />
        <path d="M14 42 L212 36" />
        <path d="M10 80 L216 86" />
        <path d="M18 116 L206 110" />
        <path d="M90 34 L144 30 L148 82 L86 86 Z" opacity="0.6" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------
// Main component
// ---------------------------------------------------------------
export default function PnchyBusinessFinder({
  checkEndpoint,
  supabaseUrl,
  supabaseAnonKey,
  earlyAccessUrl,
}: PnchyBusinessFinderProps) {
  const [state, setState] = useState<WidgetState>("idle");
  const [query, setQuery] = useState("");
  const [place, setPlace] = useState<VerifiedPlace | null>(null);
  const [email, setEmail] = useState("");
  const [signatureCount, setSignatureCount] = useState<number | null>(null);
  const [holding, setHolding] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [pillWidth, setPillWidth] = useState<number | null>(null);
  const [cityName, setCityName] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const { coords, status: locationStatus, request: requestLocation } = useGeolocation();
  const citySuffix = useBackspaceType(cityName, "...");

  useEffect(() => {
    supabaseRef.current = createClient(supabaseUrl, supabaseAnonKey);
  }, [supabaseUrl, supabaseAnonKey]);

  // City name for the idle-state "Find local business in <city>" prompt
  // — see the Worker's /city handler for why this goes through it
  // rather than being called directly (browsers can't set the custom
  // User-Agent Nominatim's usage policy requires).
  useEffect(() => {
    if (!coords) return;
    let cancelled = false;
    fetch(`${checkEndpoint}/city`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: coords.lat, lng: coords.lng }),
    })
      .then((res) => (res.ok ? res.json() : { city: null }))
      .then((data) => {
        if (!cancelled && data?.city) setCityName(data.city);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [coords, checkEndpoint]);

  useEffect(() => {
    // Ask early so it's ready by the time someone actually searches.
    // Denying it now blocks search entirely — see "location-blocked" state.
    requestLocation();
  }, [requestLocation]);

  useEffect(() => {
    // If they grant location after being blocked (e.g. changed the
    // browser's site permission and hit "Try Again"), let them back in.
    if (state === "location-blocked" && locationStatus === "granted") {
      setState("idle");
    }
  }, [locationStatus, state]);

  useEffect(() => {
    if (state === "typing") inputRef.current?.focus();
  }, [state]);

  // Grow/shrink the pill to hug the typed query, capped at the wrap's
  // own max-width (the host page sets that to match its headline).
  // Every other state uses the full width, same as before.
  useEffect(() => {
    if (state !== "typing") {
      setPillWidth(null);
      return;
    }
    const el = inputRef.current;
    if (!el) return;
    const font = window.getComputedStyle(el).font;
    const text = query || el.placeholder || "";
    const textWidth = measureTextWidth(text, font);
    const EXTRA = 72; // status-bar's own 28px side padding + caret/measurement slack
    const MIN_WIDTH = 220;
    const wrapEl = el.closest(".pnchy-widget-wrap") as HTMLElement | null;
    const maxWidth = wrapEl ? wrapEl.getBoundingClientRect().width : Infinity;
    setPillWidth(Math.min(Math.max(textWidth + EXTRA, MIN_WIDTH), maxWidth));
  }, [query, state]);

  // Once the pill has been resized to its new width (above), grow the
  // textarea's height to fit however many lines the query now wraps to
  // — so text that no longer fits on one line is never hidden/scrolled,
  // it just makes the pill taller instead.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || state !== "typing") return;
    if (!query) {
      el.style.height = ""; // back to the natural single-row resting height
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [pillWidth, query, state]);

  const reset = () => {
    setState("idle");
    setQuery("");
    setPlace(null);
    setEmail("");
    setSignatureCount(null);
    setSignError(null);
  };

  const loadSignatureCount = async (p: { name: string; address: string }) => {
    if (!supabaseRef.current) return;
    const key = slugify(`${p.name}-${p.address}`);
    const { data } = await supabaseRef.current
      .from("petitions")
      .select("signature_count")
      .eq("place_key", key)
      .maybeSingle();
    setSignatureCount(data?.signature_count ?? 0);
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    if (locationStatus !== "granted") {
      // Not just "denied"/"unsupported" — a still-pending permission
      // prompt ("idle") is just as unusable here: searching without
      // coords means Nominatim has nothing to disambiguate a name like
      // "Shake Shack" against, and can return a match on the other
      // side of the planet. Block until we actually have coordinates.
      setState("location-blocked");
      return;
    }
    setState("checking");
    try {
      const res = await fetch(checkEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: query.trim(),
          lat: coords?.lat,
          lng: coords?.lng,
        }),
      });
      const data = await res.json();
      if (data?.verified && data?.place) {
        setPlace(data.place);
        setState("petition");
        loadSignatureCount(data.place);
      } else {
        setState("unverified");
      }
    } catch {
      setState("unverified");
    }
  };

  // --- press-and-hold to sign ---
  const startHold = () => {
    if (!place) return;
    if (!isValidEmail(email)) {
      setSignError("Enter a valid email first.");
      return;
    }
    setSignError(null);
    setHolding(true);
    holdTimer.current = setTimeout(submitSignature, HOLD_MS);
  };

  const cancelHold = () => {
    setHolding(false);
    if (holdTimer.current) clearTimeout(holdTimer.current);
  };

  const submitSignature = async () => {
    if (!supabaseRef.current || !place) return;

    // Never store an email without cookie consent — that's the whole
    // point of this gate, so it has to run before any Supabase call,
    // not after. If consent isn't explicitly "granted", nothing here
    // touches Supabase at all.
    let cookieConsent: string | null = null;
    try {
      cookieConsent = localStorage.getItem("pnchy_cookie_consent");
    } catch {
      // Storage inaccessible (private mode, blocked) — treat as no consent.
    }
    if (cookieConsent !== "granted") {
      setHolding(false);
      setState("cookie-required");
      return;
    }

    const key = slugify(`${place.name}-${place.address}`);
    try {
      const { data: petition, error: upsertError } = await supabaseRef.current
        .from("petitions")
        .upsert(
          {
            place_key: key,
            business_name: place.name,
            business_address: place.address,
          },
          { onConflict: "place_key" }
        )
        .select()
        .single();
      if (upsertError) throw upsertError;

      const { error: insertError } = await supabaseRef.current
        .from("petition_signatures")
        .insert({ petition_id: petition.id, email: email.trim().toLowerCase() });

      if (insertError) {
        if (insertError.code === "23505") {
          // Already signed — treat as success, not an error.
          setState("signed");
          setHolding(false);
          return;
        }
        throw insertError;
      }

      setSignatureCount((c) => (c ?? 0) + 1);
      setState("signed");
    } catch {
      setSignError("Something went wrong — try again.");
    } finally {
      setHolding(false);
    }
  };

  const handleIdleClick = () => {
    if (locationStatus !== "granted") {
      // Not just "denied"/"unsupported" — a still-pending permission
      // prompt ("idle") is just as unusable here: searching without
      // coords means Nominatim has nothing to disambiguate a name like
      // "Shake Shack" against, and can return a match on the other
      // side of the planet. Block until we actually have coordinates.
      setState("location-blocked");
      return;
    }
    setState("typing");
  };

  const hasPanel = state !== "idle" && state !== "typing";
  const barColor =
    state === "idle"
      ? COLORS.blue
      : state === "typing"
      ? COLORS.green
      : state === "checking"
      ? COLORS.purple
      : state === "unverified"
      ? COLORS.red
      : state === "location-blocked"
      ? COLORS.red
      : state === "cookie-required"
      ? COLORS.red
      : COLORS.red; // petition / signed keep the "oops" red header

  return (
    <div className="pnchy-widget-wrap">
      <style>{WIDGET_CSS}</style>

      <div
        className="pnchy-status-bar"
        style={{
          background: barColor,
          borderRadius: hasPanel ? "28px 28px 0 0" : "999px",
          ...(pillWidth != null ? { width: `${pillWidth}px` } : {}),
        }}
      >
        {state === "idle" && (
          <button className="pnchy-status-btn" onClick={handleIdleClick} aria-label="Search for a local business">
            <span className="pnchy-status-text">
              {`Find local business in ${citySuffix}`}
              <span className="pnchy-cursor">|</span>
            </span>
          </button>
        )}

        {state === "typing" && (
          <textarea
            ref={inputRef}
            className="pnchy-input"
            rows={1}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault(); // search on Enter, never insert a line break
                handleSearch();
              }
            }}
            placeholder="What are you looking for?"
          />
        )}

        {state === "checking" && (
          <span className="pnchy-status-text">
            Searching<span className="pnchy-loading-dots">...</span>
          </span>
        )}

        {state === "unverified" && (
          <span className="pnchy-status-text">Is this a brick and mortar?</span>
        )}

        {(state === "petition" || state === "signed") && (
          <span className="pnchy-status-text">
            <span className="pnchy-status-lead">Oops.</span>
            <span className="pnchy-status-detail">
              This business is not in our system. Sign the petition below so we can get this business on Pnchy.
              Thanks.
            </span>
          </span>
        )}

        {state === "location-blocked" && (
          <span className="pnchy-status-text">
            <span className="pnchy-status-lead">Uh-oh.</span>
            <span className="pnchy-status-detail">Your location wasn't allowed.</span>
          </span>
        )}

        {state === "cookie-required" && (
          <span className="pnchy-status-text">
            <span className="pnchy-status-lead">Uh-oh.</span>
            <span className="pnchy-status-detail">We need your OK on cookies first.</span>
          </span>
        )}
      </div>

      {state === "checking" && (
        <div className="pnchy-panel pnchy-skeleton-panel" style={{ background: COLORS.green }}>
          <SketchMap />
        </div>
      )}

      {state === "location-blocked" && (
        <div className="pnchy-panel" style={{ background: COLORS.eggWhite, color: COLORS.ink }}>
          <p className="pnchy-body" style={{ color: COLORS.ink }}>
            Looks like your location wasn't allowed — we can't help you find local businesses without it.
          </p>
          <p className="pnchy-caption" style={{ color: COLORS.ink }}>
            Please turn on your location. We only use it to help you find local businesses on Pnchy.
          </p>
          <button className="pnchy-cta-yellow" onClick={requestLocation}>
            Try Again
          </button>
        </div>
      )}

      {state === "cookie-required" && (
        <div className="pnchy-panel" style={{ background: COLORS.eggWhite, color: COLORS.ink }}>
          <p className="pnchy-body" style={{ color: COLORS.ink }}>
            We can't save your email to sign this without your OK on cookies — that's how we stick to our
            privacy policy.
          </p>
          <p className="pnchy-caption" style={{ color: COLORS.ink }}>
            Please accept cookies, then search again to sign the petition.
          </p>
          <button
            className="pnchy-cta-yellow"
            onClick={() => (window as any).pnchyShowCookieBanner?.()}
          >
            Update Cookie Preferences
          </button>
          <div className="pnchy-btn-row">
            <button className="pnchy-btn-text" onClick={reset}>
              Search again
            </button>
          </div>
        </div>
      )}

      {state === "unverified" && (
        <div className="pnchy-panel" style={{ background: COLORS.eggWhite, color: COLORS.ink }}>
          <p className="pnchy-body" style={{ color: COLORS.ink }}>
            We might be mistaken — Pnchy currently only serves businesses with physical locations.
          </p>
          <p className="pnchy-caption" style={{ color: COLORS.ink }}>
            Get in touch with Pnchy to help get {query.trim() || "this business"} registered.
          </p>
          <a href={earlyAccessUrl} target="_blank" rel="noreferrer" className="pnchy-cta-yellow">
            Get in Touch
          </a>
          <div className="pnchy-btn-row">
            <button className="pnchy-btn-text" onClick={() => setState("typing")}>
              Try a different search
            </button>
          </div>
        </div>
      )}

      {(state === "petition" || state === "signed") && place && (
        <div className="pnchy-panel" style={{ background: COLORS.green }}>
          {state === "petition" ? (
            <>
              <p className="pnchy-headline">Get {place.name} on Pnchy</p>

              <div className="pnchy-stat-row">
                <span className="pnchy-stat-number">{signatureCount ?? "…"}</span>
                <span className="pnchy-stat-label">of {GOAL_SIGNATURES} signed</span>
              </div>
              <p className="pnchy-caption">
                Reach {GOAL_SIGNATURES} and we help convince this business to get on Pnchy.
              </p>

              <input
                type="email"
                className="pnchy-email-input"
                placeholder="you@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />

              <button
                className="pnchy-hold-btn"
                onPointerDown={startHold}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
                onPointerCancel={cancelHold}
              >
                <span
                  className="pnchy-hold-fill"
                  style={{
                    width: holding ? "100%" : "0%",
                    transitionDuration: holding ? `${HOLD_MS}ms` : "150ms",
                  }}
                />
                <span className="pnchy-hold-label">Press &amp; hold to sign</span>
              </button>

              {signError && <p className="pnchy-error">{signError}</p>}

              <p className="pnchy-caption pnchy-caption-muted">
                While you are at it sign up for Pnchy early access so you get first experience of the future of
                finding local gems.
              </p>

              <a href={earlyAccessUrl} target="_blank" rel="noreferrer" className="pnchy-cta-yellow">
                Early Access
              </a>

              <button className="pnchy-btn-text" onClick={reset}>
                Search again
              </button>
            </>
          ) : (
            <>
              <p className="pnchy-headline">You're signed up.</p>
              <p className="pnchy-caption">We'll email you when {place.name} joins Pnchy.</p>

              <div className="pnchy-stat-row">
                <span className="pnchy-stat-number">{signatureCount ?? 0}</span>
                <span className="pnchy-stat-label">of {GOAL_SIGNATURES} signed</span>
              </div>

              <a href={earlyAccessUrl} target="_blank" rel="noreferrer" className="pnchy-cta-yellow">
                Early Access
              </a>
              <button className="pnchy-btn-text" onClick={reset}>
                Search again
              </button>
            </>
          )}
        </div>
      )}

      {state !== "idle" && state !== "typing" && (
        <p className="pnchy-attribution">
          Place data ©{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap
          </a>{" "}
          contributors
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Styles — one injected block, kept out of the JSX for readability.
// Swap for your own CSS/Tailwind pipeline if you'd rather not inject.
// ---------------------------------------------------------------
const WIDGET_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap');
/* Prefer a <link> tag in your document <head> instead of this @import
   for performance — this is just here so the component works as a
   true drop-in with zero setup. */

.pnchy-widget-wrap {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  font-family: ${FONT_FAMILY};
  box-sizing: border-box;
}
.pnchy-widget-wrap * {
  box-sizing: border-box;
}

.pnchy-status-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 64px;
  width: 100%;
  margin: 0 auto;
  padding: 14px 28px;
  transition: background-color 350ms ease, border-radius 250ms ease, width 200ms ease;
  text-align: center;
}

.pnchy-status-btn {
  all: unset;
  cursor: pointer;
  width: 100%;
  text-align: center;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

.pnchy-status-text {
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: clamp(16px, 4vw, 20px);
  color: ${COLORS.eggWhite};
  line-height: 1.4;
  text-wrap: balance;
}
.pnchy-status-lead {
  display: block;
  font-size: clamp(18px, 5.5vw, 24px);
}
.pnchy-status-detail {
  display: block;
  font-style: normal;
  font-size: clamp(13px, 3.4vw, 15px);
  opacity: 0.85;
  margin-top: 4px;
  line-height: 1.45;
}

.pnchy-cursor {
  display: inline-block;
  margin-left: 2px;
  animation: pnchy-blink 1s steps(1) infinite;
}

.pnchy-input {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  text-align: center;
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: clamp(16px, 4vw, 20px);
  line-height: 1.35;
  color: ${COLORS.eggWhite};
  -webkit-appearance: none;
  appearance: none;
}
/* font-size floors at 16px above (never dips below via clamp) — Safari
   on iOS zooms the whole page on focus for any input under 16px. */
.pnchy-input::placeholder {
  color: rgba(250, 247, 242, 0.7);
}

.pnchy-loading-dots {
  display: inline-block;
  width: 1.2em;
  overflow: hidden;
  white-space: nowrap;
  vertical-align: bottom;
  animation: pnchy-dots 1.2s steps(4) infinite;
}

.pnchy-panel {
  border-radius: 0 0 28px 28px;
  padding: 24px 28px 28px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pnchy-skeleton-panel {
  align-items: center;
  padding: 20px;
}
.pnchy-sketch-map {
  width: 100%;
  max-width: 320px;
  height: auto;
  animation: pnchy-pulse 1.8s ease-in-out infinite;
}

.pnchy-body {
  font-family: ${FONT_FAMILY};
  font-size: 17px;
  line-height: 1.5;
  color: ${COLORS.eggWhite};
  margin: 0;
  text-align: center;
  text-wrap: balance;
}
.pnchy-body-strong {
  font-size: 20px;
  font-style: italic;
}
.pnchy-body-small {
  font-size: 15px;
  opacity: 0.9;
}

/* Glanceable hierarchy: a headline, a big live number, then a small
   caption — instead of one long sentence you have to read end to end. */
.pnchy-headline {
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-weight: 500;
  font-size: clamp(20px, 5.5vw, 26px);
  color: ${COLORS.eggWhite};
  margin: 0;
  text-align: center;
  text-wrap: balance;
}
.pnchy-stat-row {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
}
.pnchy-stat-number {
  font-family: ${FONT_FAMILY};
  font-style: normal;
  font-weight: 600;
  font-size: clamp(34px, 10vw, 46px);
  line-height: 1;
  color: ${COLORS.eggWhite};
  font-variant-numeric: tabular-nums;
}
.pnchy-stat-label {
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: 15px;
  color: ${COLORS.eggWhite};
  opacity: 0.85;
}
.pnchy-caption {
  font-family: ${FONT_FAMILY};
  font-size: 14px;
  line-height: 1.45;
  color: ${COLORS.eggWhite};
  text-align: center;
  margin: 0;
  max-width: 34ch;
  margin-left: auto;
  margin-right: auto;
  text-wrap: balance;
}
.pnchy-caption-muted {
  opacity: 0.72;
  font-size: 13px;
}

.pnchy-email-input {
  width: 100%;
  padding: 12px 16px;
  border-radius: 999px;
  border: 1px solid rgba(250, 247, 242, 0.5);
  background: rgba(250, 247, 242, 0.12);
  color: ${COLORS.eggWhite};
  font-family: ${FONT_FAMILY};
  font-size: 16px;
  outline: none;
  text-align: center;
  -webkit-appearance: none;
  appearance: none;
}
.pnchy-email-input::placeholder {
  color: rgba(250, 247, 242, 0.65);
}

.pnchy-hold-btn {
  position: relative;
  overflow: hidden;
  border: none;
  border-radius: 999px;
  padding: 16px 30px;
  background: ${COLORS.purple};
  color: ${COLORS.eggWhite};
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: 18px;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
  align-self: center;
  min-height: 44px;
}
.pnchy-hold-fill {
  position: absolute;
  inset: 0;
  background: rgba(250, 247, 242, 0.3);
  transform-origin: left;
  transition-property: width;
  transition-timing-function: linear;
}
.pnchy-hold-label {
  position: relative;
  z-index: 1;
}

.pnchy-cta-yellow {
  align-self: center;
  padding: 12px 26px;
  border: none;
  border-radius: 999px;
  background: ${COLORS.yellow};
  color: ${COLORS.purple};
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: 17px;
  text-decoration: none;
  font-weight: 500;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
}

.pnchy-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}
.pnchy-btn-text {
  align-self: center;
  background: none;
  border: none;
  color: ${COLORS.eggWhite};
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: 15px;
  text-decoration: underline;
  cursor: pointer;
  opacity: 0.85;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  padding: 10px 6px;
  min-height: 44px;
}
.pnchy-btn-row .pnchy-btn-text {
  color: ${COLORS.ink};
}

.pnchy-error {
  margin: 0;
  text-align: center;
  color: ${COLORS.eggWhite};
  background: rgba(0,0,0,0.15);
  border-radius: 12px;
  padding: 6px 10px;
  font-size: 14px;
}

.pnchy-attribution {
  margin: 8px 0 0;
  text-align: center;
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  color: ${COLORS.ink};
  opacity: 0.5;
}
.pnchy-attribution a {
  color: inherit;
}

@keyframes pnchy-blink {
  0%, 45% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@keyframes pnchy-dots {
  0% { width: 0; }
  100% { width: 1.2em; }
}
@keyframes pnchy-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .pnchy-cursor { animation: none; opacity: 1; }
  .pnchy-sketch-map { animation: none; opacity: 0.85; }
  .pnchy-loading-dots { animation: none; width: 1.2em; }
}

@media (max-width: 420px) {
  .pnchy-status-bar { padding: 12px 18px; min-height: 56px; }
  .pnchy-panel { padding: 18px 18px 22px; }
}
`;
