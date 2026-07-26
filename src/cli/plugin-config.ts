/**
 * src/cli/plugin-config.ts
 *
 * Plugin field normalization and matching.
 * Exports: PLUGIN_NAME, normalizePlugin, readInstalledPlugins,
 * matchesPlugin, findInstalledPlugin, dedupePlugins, buildSpecifier.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const PLUGIN_NAME = 'opencode-rules-md' as const;

// ─────────────────────────────────────────────────────────────────────────────
// normalizePlugin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a plugin value (undefined, null, string[], or legacy object)
 * to a flat string[].
 */
export function normalizePlugin(raw: unknown): string[] {
  if (raw == null) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return Object.keys(obj).filter(k => obj[k] != null && obj[k] !== false);
  }

  if (typeof raw === 'string') {
    return [raw];
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// readInstalledPlugins
// ─────────────────────────────────────────────────────────────────────────────

/** Structurally-typed parameter to avoid circular type import with config.ts. */
interface PluginConfigReader {
  data: Record<string, unknown>;
}

/**
 * Read the installed plugin list from a loaded config, honoring both the
 * modern `plugin` field (singular — what OpenCode actually uses) and the
 * legacy `plugins` field (plural — written by older versions of `omd`).
 *
 * The modern field wins when both are present, matching OpenCode's own
 * resolution order.
 */
export function readInstalledPlugins(config: PluginConfigReader): string[] {
  const modern = config.data['plugin'];
  if (modern !== undefined) {
    return normalizePlugin(modern);
  }
  return normalizePlugin(config.data['plugins']);
}

// ─────────────────────────────────────────────────────────────────────────────
// matchesPlugin
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true if entry is the plugin named name (with optional @version).
 */
export function matchesPlugin(
  entry: string,
  name: string = PLUGIN_NAME
): boolean {
  if (!entry || typeof entry !== 'string') return false;
  if (entry === name) return true;
  const pattern = new RegExp('^' + escapeRegex(name) + '@');
  return pattern.test(entry);
}

/**
 * Find the first plugin entry in `plugins` that matches `PLUGIN_NAME` (with
 * optional @version). Returns the matching specifier, or undefined if none.
 */
export function findInstalledPlugin(
  plugins: readonly string[]
): string | undefined {
  return plugins.find(p => matchesPlugin(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// dedupePlugins
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deduplicate plugin list: remove all entries matching PLUGIN_NAME,
 * then re-append the freshest entry (last occurrence). Other plugins preserved.
 */
export function dedupePlugins(
  plugins: string[],
  name: string = PLUGIN_NAME
): string[] {
  const others: string[] = [];
  let lastFresh: string | undefined;

  for (const p of plugins) {
    if (matchesPlugin(p, name)) {
      lastFresh = p;
    } else {
      others.push(p);
    }
  }

  const result = [...others];
  if (lastFresh !== undefined) {
    result.push(lastFresh);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSpecifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an npm version specifier.
 * '' | undefined -> '@latest'; explicit -> '@<version>'
 */
export function buildSpecifier(version?: string): string {
  if (!version || version.trim() === '') {
    return '@latest';
  }
  return '@' + version;
}
