/**
 * Pure inventory projection over the live `llm` registry.
 *
 * Nothing here writes, resolves a model call, or mutates the registry. Every
 * provider is isolated: one adapter that throws, hangs the credential lookup,
 * or lost its `settings`/`credentials` service degrades its own row instead of
 * the whole answer.
 *
 * Two sources feed the list, and both are needed to show what was registered:
 *
 * - `llm.listProviders()` — routes with a live adapter, key or no key. An
 *   adapter with a missing credential answers `listModels()` with `[]`, so the
 *   route would vanish from a catalog-only read.
 * - `llm.listConfigurableProviders()` — routes a plugin declared and the user
 *   has not activated. They have no adapter, so they carry no models; they are
 *   still registered, and `dormant` says so.
 *
 * @module list-models-plugin-dsh/collect
 */

/** Whether a route currently dispatches, or is only declared. */
export const KINDS = Object.freeze({
  ACTIVE: 'active',
  DORMANT: 'dormant',
});

/** What the credential probe found. `unknown` is a degraded, not a negative, answer. */
export const CREDENTIALS = Object.freeze({
  CONFIGURED: 'configured',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
});

/** Bound on one provider's model list, so a runaway catalog cannot flood the tool result. */
export const MAX_MODELS_PER_PROVIDER = 500;

/** Bound on the whole provider list, ditto. */
export const MAX_PROVIDERS = 200;

/**
 * Detach one credential reference, keeping only a reference that may be probed.
 * @param value - raw `apiKeyEnv` profile value.
 * @returns the reference name, or undefined when nothing can be probed.
 */
function referenceName(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : undefined;
}

/**
 * Walk a settings value by the declared path segments.
 * @param value - settings namespace value.
 * @param path - segments declared by the directory entry.
 * @returns the value at the path, or undefined.
 */
function walk(value, path) {
  let current = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

/**
 * Read the credential state of one declared route.
 *
 * The probe mirrors the guarded lookup the session controller already uses:
 * the directory names the settings namespace and the path to `apiKeyEnv`, and
 * the credentials service answers configured/missing for that reference. Any
 * absent service or thrown lookup is `unknown`, never a false `missing`.
 *
 * @param ctx - host context.
 * @param entry - directory entry naming the namespace and path.
 * @returns one credential state.
 */
export async function credentialState(ctx, entry) {
  if (entry === undefined) return CREDENTIALS.UNKNOWN;
  const settings = ctx.get?.('settings');
  const credentials = ctx.get?.('credentials');
  if (settings === undefined || credentials === undefined) return CREDENTIALS.UNKNOWN;
  try {
    const namespaces = settings.describe({ redactSecrets: true });
    const profile = walk(namespaces.find((namespace) => namespace.ns === entry.settingsNs)?.value, entry.settingsPath);
    if (typeof profile !== 'object' || profile === null) return CREDENTIALS.UNKNOWN;
    const ref = referenceName(Reflect.get(profile, 'apiKeyEnv'));
    if (ref === undefined) return CREDENTIALS.UNKNOWN;
    const info = await credentials.describe(ref);
    return info?.configured === true ? CREDENTIALS.CONFIGURED : CREDENTIALS.MISSING;
  } catch {
    return CREDENTIALS.UNKNOWN;
  }
}

/**
 * Detach the default selection, when the service is mounted.
 * @param ctx - host context.
 * @returns the default route, or undefined.
 */
function currentDefault(ctx) {
  try {
    const service = ctx.get?.('agentDefaultModel');
    if (service === undefined) return undefined;
    const selection = service.currentSelection();
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return undefined;
    return {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Detach one model row, keeping the fields the tool reports.
 * @param model - adapter-returned model.
 * @returns the detached row.
 */
function modelRow(model) {
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
    ...(typeof model.description === 'string' ? { description: model.description } : {}),
    ...(Array.isArray(model.inputModalities) ? { inputModalities: [...model.inputModalities] } : {}),
  };
}

/**
 * Probe one active route's catalog, isolated from every other route.
 * @param llm - live llm service.
 * @param provider - provider route to probe.
 * @returns models plus a truncation flag and an optional error message.
 */
async function probeModels(llm, provider) {
  let raw;
  try {
    raw = await llm.listModels(provider);
  } catch (error) {
    return { models: [], truncated: false, error: error instanceof Error ? error.message : String(error) };
  }
  const list = Array.isArray(raw) ? raw.filter((model) => typeof model?.id === 'string' && model.id !== '') : [];
  return {
    models: list.slice(0, MAX_MODELS_PER_PROVIDER).map(modelRow),
    truncated: list.length > MAX_MODELS_PER_PROVIDER,
  };
}

/**
 * Build the full inventory.
 * @param ctx - host context carrying `llm`.
 * @param options - filter and probe switches.
 * @returns detached inventory with per-row isolation.
 */
export async function collectModels(ctx, options = {}) {
  const llm = ctx.llm ?? ctx.get?.('llm');
  if (llm === undefined) throw new Error('the llm service is not mounted; no provider can be listed');

  const wanted = typeof options.provider === 'string' && options.provider !== '' ? options.provider : undefined;
  const includeDormant = options.includeDormant !== false;
  const probe = options.probeModels !== false;

  // The directory is read first: an active route uses the same entry for its
  // credential probe, and a route only declared here is the dormant half.
  let directory = [];
  try {
    directory = Array.isArray(llm.listConfigurableProviders()) ? llm.listConfigurableProviders() : [];
  } catch {
    directory = [];
  }
  const byProvider = new Map();
  for (const entry of directory) {
    if (typeof entry?.provider === 'string') byProvider.set(entry.provider, entry);
  }

  let active = [];
  try {
    active = Array.isArray(llm.listProviders()) ? llm.listProviders() : [];
  } catch (error) {
    throw new Error(`the provider registry could not be listed: ${error instanceof Error ? error.message : error}`);
  }

  const activeIds = new Set(active.map((provider) => provider.id));
  const rows = [];

  const selected = wanted === undefined ? active : active.filter((provider) => provider.id === wanted);
  for (const provider of selected.slice(0, MAX_PROVIDERS)) {
    const entry = byProvider.get(provider.id);
    const credential = await credentialState(ctx, entry);
    const probed = probe ? await probeModels(llm, provider.id) : { models: [], truncated: false };
    rows.push({
      provider: provider.id,
      name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
      kind: KINDS.ACTIVE,
      credential,
      ...(probed.error === undefined ? {} : { error: probed.error }),
      ...(probed.models.length === 0 && credential === CREDENTIALS.MISSING
        ? { note: 'no credential; the adapter advertises nothing' }
        : {}),
      models: probed.models,
      ...(probed.truncated ? { truncated: true } : {}),
    });
  }

  if (includeDormant) {
    for (const entry of directory) {
      if (activeIds.has(entry.provider)) continue;
      if (wanted !== undefined && entry.provider !== wanted) continue;
      if (rows.length >= MAX_PROVIDERS) break;
      rows.push({
        provider: entry.provider,
        name: typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : entry.provider,
        kind: KINDS.DORMANT,
        credential: await credentialState(ctx, entry),
        note: 'declared, not activated; it has no adapter and no models',
        models: [],
      });
    }
  }

  // Active first, then by provider id, so the dispatchable half leads.
  rows.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === KINDS.ACTIVE ? -1 : 1;
    return left.provider.localeCompare(right.provider);
  });

  const fallback = currentDefault(ctx);
  return {
    generatedAt: new Date().toISOString(),
    ...(fallback === undefined ? {} : { default: fallback }),
    providers: rows,
    failures: rows
      .filter((row) => row.error !== undefined)
      .map((row) => ({ provider: row.provider, message: row.error })),
    counts: {
      providers: rows.length,
      active: rows.filter((row) => row.kind === KINDS.ACTIVE).length,
      dormant: rows.filter((row) => row.kind === KINDS.DORMANT).length,
      models: rows.reduce((sum, row) => sum + row.models.length, 0),
      failures: rows.filter((row) => row.error !== undefined).length,
    },
    truncated: selected.length > MAX_PROVIDERS,
  };
}
