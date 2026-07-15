// ---------------------------------------------------------------------------
// src/cli/registry.ts — npm registry helpers for `omd`.
//
// Fetches the latest published version of `opencode-rules-md` from the npm
// registry. Uses the native `fetch()` API (Node 20+) — no extra dependencies.
// ---------------------------------------------------------------------------

const REGISTRY_URL = "https://registry.npmjs.org/opencode-rules-md/latest";

/**
 * Fetch the latest version string from the npm registry.
 * Returns `null` when the registry is unreachable or the response is
 * malformed — callers treat `null` as "can't determine, don't block".
 */
export const fetchLatestVersion = async (): Promise<string | null> => {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
};

/**
 * Return whether the installed version is older than the latest.
 * Unknown versions (null on either side) are never treated as stale.
 */
export const isStale = (
  installed: string | null,
  latest: string | null,
): boolean => {
  if (!installed || !latest) return false;
  return installed !== latest;
};
