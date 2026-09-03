// ---------------------------------------------------------------------------
// Browser telemetry policy — the single answer to "may this profile be
// measured?", shared by every transport and by canary enrolment.
//
// This exists because the answer was previously duplicated and the copies had
// drifted: `telemetry/client.ts` enforced five controls, the older
// `utils/studioTelemetry.ts` transport enforced one (its own localStorage
// key), and canary evaluation enforced a different one. So a profile with
// `navigator.doNotTrack` set, or a Vite dev build, still emitted `studio:*`
// events AND could be bucketed into a rollout — under controls the public
// docs say disable both.
//
// Deliberately imports only `./config` (localStorage helpers). Nothing here
// may import a transport or the canary module: both of those import this, and
// the whole point is one definition with no cycle.
// ---------------------------------------------------------------------------

import { isOptedOut } from "./config";
import { configuredTelemetryEndpoint } from "./endpoint";

/** Legacy opt-out key predating `telemetry/config.ts`. Still honoured so
 *  anyone already opted out is never quietly re-enabled. */
const LEGACY_OPT_OUT_KEY = "hf-studio-telemetry-opt-out";

function isLegacyOptedOut(): boolean {
  try {
    return localStorage.getItem(LEGACY_OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function isDoNotTrackOn(): boolean {
  return typeof navigator !== "undefined" && navigator.doNotTrack === "1";
}

// VITE_MPVFX_NO_TELEMETRY is the build-time analytics opt-out.
// opt-out so MpVFX dev/CI builds can suppress telemetry from the editor
// bundle the same way. Vite injects it at build time. Match the CLI's
// affirmative privacy-control spellings.
// `import.meta.env` may be undefined in non-Vite bundlers (Next.js Turbopack).
function isBuildTimeOptOut(): boolean {
  try {
    const v = import.meta.env.VITE_MPVFX_NO_TELEMETRY as string | undefined;
    return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  } catch {
    return false;
  }
}

// `import.meta.env.DEV` is true under `vite dev` / `vite preview`. Auto-suppress
// so developers running a local preview don't pollute production telemetry.
function isViteDevMode(): boolean {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

/**
 * May this browser profile be measured at all?
 *
 * Governs BOTH sending events and canary enrolment. Enrolment is part of
 * measurement, not separate from it: a profile that reports nothing cannot be
 * compared against anyone, so bucketing it changes that user's code path for
 * no signal. The one documented exception is an explicit `HF_CANARY_*` /
 * `?hf_canary_*=` override, which callers apply before consulting this.
 *
 * Not memoized — `isOptedOut()` reads localStorage, which a user can flip in
 * DevTools mid-session, and the per-call cost is a couple of property reads.
 * Callers that must stay stable within a session memoize their own result
 * (canary decisions do; the transports intentionally do not).
 */
export function browserTelemetryAllowed(): boolean {
  try {
    return allowed();
  } catch {
    // Fail CLOSED. A storage read that throws must not enrol anyone, and must
    // not propagate: callers include a post-commit catch block where a throw
    // reports a committed edit as failed.
    return false;
  }
}

function allowed(): boolean {
  return (
    configuredTelemetryEndpoint() !== null &&
    !isBuildTimeOptOut() &&
    !isViteDevMode() &&
    !isOptedOut() &&
    !isLegacyOptedOut() &&
    !isDoNotTrackOn()
  );
}
