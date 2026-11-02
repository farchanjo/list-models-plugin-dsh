/**
 * Pure inventory projection over the live `llm` registry.
 *
 * Nothing here writes, resolves a model call, or mutates the registry. Every
 * provider is isolated: one adapter that throws, one that never settles, or a
 * missing `settings`/`credentials` service degrades its own row instead of the
 * whole answer. Each probe runs under its own deadline and off the caller's
 * abort signal, and all rows are built concurrently.
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
 * The credential probe mirrors the guarded lookup in
 * `dsh-api-session-controller/lib/types/catalog.js`: `not-applicable` means the
 * route declares no API-key reference at all, which is not the same as a key
 * that is merely unset.
 *
 * @module list-models-plugin-dsh/collect
 */

import { isCredentialRefName } from '@deepseek-ai/dsh-credentials';

/** Whether a route currently dispatches, or is only declared. */
export const KINDS = Object.freeze({
  ACTIVE: 'active',
  DORMANT: 'dormant',
});

/** What the credential probe found. */
export const CREDENTIALS = Object.freeze({
  CONFIGURED: 'configured',
  MISSING: 'missing',
  /** The route declares no API-key reference, so there is nothing to be missing. */
  NOT_APPLICABLE: 'not-applicable',
  /** The probe could not run or could not answer; never a claim that the key is absent. */
  UNKNOWN: 'unknown',
});

/** Bound on one provider's model list, so a runaway catalog cannot flood the tool result. */
export const MAX_MODELS_PER_PROVIDER = 500;

/** Bound on the whole provider list, ditto. */
export const MAX_PROVIDERS = 200;

/** Default deadline for one provider probe. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** OAuth route that carries no API-key reference. */
const OAUTH_PROVIDERS = new Set(['deepseek-account']);

/**
 * Stringify a thrown value without trusting it.
 * @param error - whatever was thrown, including a null-prototype object.
 * @returns a printable message.
 */
function safeMessage(error) {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return typeof message === 'string' ? message : String(message);
  } catch {
    return Object.prototype.toString.call(error);
  }
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
 * Race one probe against a deadline and the caller's signal.
 * @param task - the work to bound.
 * @param timeoutMs - deadline in milliseconds.
 * @param signal - caller abort signal, when present.
 * @returns the task result, or a rejection naming the reason.
 */
async function withDeadline(task, timeoutMs, signal) {
  if (signal?.aborted === true) throw new Error('aborted before the probe');
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      task,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
      new Promise((_resolve, reject) => {
        if (signal === undefined) return;
        onAbort = () => reject(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Read every settings namespace once for the whole call.
 *
 * `describe` is not a pure getter: it stringifies each plugin schema and
 * updates revision bookkeeping, so it runs once per call, as the catalog does.
 *
 * @param ctx - host context.
 * @returns the namespaces, or undefined when the service is absent or throws.
 */
function loadNamespaces(ctx) {
  try {
    const settings = ctx.get?.('settings');
    if (settings === undefined) return undefined;
    const namespaces = settings.describe({ redactSecrets: true });
    return Array.isArray(namespaces) ? namespaces : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the credential store about one reference.
 * @param credentials - credential service.
 * @param ref - credential reference name.
 * @returns the resolved state.
 */
async function describeState(credentials, ref) {
  const info = await credentials.describe(ref);
  if (info?.configured === true) return CREDENTIALS.CONFIGURED;
  if (info?.configured === false) return CREDENTIALS.MISSING;
  return CREDENTIALS.UNKNOWN;
}

/**
 * Read the credential state of one route.
 *
 * A profile `apiKeyEnv` wins. Without one, the route may authenticate natively:
 * an adapter that reads environment variables names them in `nativeAuth.env`,
 * so any reference that is set makes the route configured. An OAuth-capable
 * adapter that declares no environment reference needs no key at all, which is
 * `not-applicable` — the capability alone is not decisive, because a route may
 * be OAuth-capable and still be keyed.
 *
 * @param ctx - host context.
 * @param providerId - provider route being probed.
 * @param entry - directory entry naming the namespace, path, and native auth.
 * @param namespaces - settings namespaces already read for this call.
 * @returns one credential state.
 */
export async function credentialState(ctx, providerId, entry, namespaces) {
  if (OAUTH_PROVIDERS.has(providerId)) return CREDENTIALS.NOT_APPLICABLE;
  if (entry === undefined) return CREDENTIALS.UNKNOWN;
  const credentials = ctx.get?.('credentials');
  if (namespaces === undefined || credentials === undefined) return CREDENTIALS.UNKNOWN;
  try {
    const profile = walk(namespaces.find((namespace) => namespace.ns === entry.settingsNs)?.value, entry.settingsPath);
    const declared = typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'apiKeyEnv') : undefined;
    if (typeof declared === 'string' && declared !== '') {
      // A reference the store cannot address is unknown, not absent.
      return isCredentialRefName(declared) ? describeState(credentials, declared) : CREDENTIALS.UNKNOWN;
    }
    const env = Array.isArray(entry.nativeAuth?.env)
      ? entry.nativeAuth.env.filter((name) => typeof name === 'string' && isCredentialRefName(name))
      : [];
    if (env.length === 0) return CREDENTIALS.NOT_APPLICABLE;
    const states = await Promise.all(env.map((ref) => describeState(credentials, ref)));
    if (states.includes(CREDENTIALS.CONFIGURED)) return CREDENTIALS.CONFIGURED;
    // An OAuth-capable route with none of its variables set still works by
    // signing in, so an unset variable is no claim that it cannot run.
    if (entry.nativeAuth?.oauth === true) return CREDENTIALS.NOT_APPLICABLE;
    if (states.includes(CREDENTIALS.UNKNOWN)) return CREDENTIALS.UNKNOWN;
    return CREDENTIALS.MISSING;
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
  const modalities = Array.isArray(model.inputModalities)
    ? model.inputModalities.filter((modality) => typeof modality === 'string')
    : [];
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
    ...(typeof model.description === 'string' ? { description: model.description } : {}),
    ...(modalities.length === 0 ? {} : { inputModalities: modalities }),
  };
}

/**
 * Probe one active route's catalog under the remaining row budget.
 * @param llm - live llm service.
 * @param provider - provider route to probe.
 * @param timeLeft - remaining budget in milliseconds, evaluated at call time.
 * @param signal - caller abort signal.
 * @returns models plus a truncation flag and an optional error message.
 */
async function probeModels(llm, provider, timeLeft, signal) {
  let raw;
  try {
    raw = await withDeadline(llm.listModels(provider), timeLeft(), signal);
  } catch (error) {
    return { models: [], truncated: false, error: `catalog: ${safeMessage(error)}` };
  }
  const list = Array.isArray(raw) ? raw.filter((model) => typeof model?.id === 'string' && model.id !== '') : [];
  return {
    models: list.slice(0, MAX_MODELS_PER_PROVIDER).map(modelRow),
    truncated: list.length > MAX_MODELS_PER_PROVIDER,
  };
}

/**
 * Resolve the credential state of one route under the remaining row budget.
 *
 * A failure here must not cost the row its catalog, so this resolves a state
 * plus an optional error instead of rejecting.
 *
 * @param ctx - host context.
 * @param providerId - provider route being probed.
 * @param entry - directory entry, when one exists.
 * @param namespaces - settings namespaces already read for this call.
 * @param timeLeft - remaining budget in milliseconds, evaluated at call time.
 * @param signal - caller abort signal.
 * @returns the state and an optional error message.
 */
async function credentialStep(ctx, providerId, entry, namespaces, timeLeft, signal) {
  try {
    return { state: await withDeadline(credentialState(ctx, providerId, entry, namespaces), timeLeft(), signal) };
  } catch (error) {
    return { state: CREDENTIALS.UNKNOWN, error: `credential: ${safeMessage(error)}` };
  }
}

/**
 * Build one active row, so a broken route cannot reject the batch.
 *
 * Both stages share one row budget and run together: a slow credential lookup
 * therefore cannot eat the time the catalog needs, and the first stage to fail
 * leaves the other one's answer intact.
 *
 * @param ctx - host context.
 * @param llm - live llm service.
 * @param provider - registry entry.
 * @param entry - matching directory entry, when one exists.
 * @param namespaces - settings namespaces already read for this call.
 * @param wantedProbe - whether adapters should be asked for their catalog.
 * @param timeoutMs - the row budget.
 * @param signal - caller abort signal.
 * @returns the row.
 */
async function activeRow(ctx, llm, provider, entry, namespaces, wantedProbe, timeoutMs, signal) {
  const name = typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id;
  const started = Date.now();
  const timeLeft = () => Math.max(1, timeoutMs - (Date.now() - started));
  try {
    if (signal?.aborted === true) throw new Error('aborted before the probe');
    const [credential, probed] = await Promise.all([
      credentialStep(ctx, provider.id, entry, namespaces, timeLeft, signal),
      wantedProbe ? probeModels(llm, provider.id, timeLeft, signal) : { models: [], truncated: false },
    ]);
    const error = probed.error ?? credential.error;
    const emptyCatalog = wantedProbe && probed.error === undefined && probed.models.length === 0;
    return {
      provider: provider.id,
      name,
      kind: KINDS.ACTIVE,
      credential: credential.state,
      ...(error === undefined ? {} : { error }),
      ...(emptyCatalog && credential.state === CREDENTIALS.MISSING
        ? { note: 'no credential; the adapter advertises nothing' }
        : {}),
      models: probed.models,
      ...(probed.truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    return {
      provider: provider.id,
      name,
      kind: KINDS.ACTIVE,
      credential: CREDENTIALS.UNKNOWN,
      error: safeMessage(error),
      models: [],
    };
  }
}

/**
 * Build the full inventory.
 * @param ctx - host context carrying `llm`.
 * @param options - filter, probe, deadline, and abort switches.
 * @returns detached inventory with per-row isolation.
 */
export async function collectModels(ctx, options = {}) {
  const llm = ctx.llm ?? ctx.get?.('llm');
  if (llm === undefined) throw new Error('the llm service is not mounted; no provider can be listed');

  const wanted = typeof options.provider === 'string' && options.provider !== '' ? options.provider : undefined;
  const includeDormant = options.includeDormant !== false;
  const wantedProbe = options.probeModels !== false;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS;
  const signal = options.signal;

  // Each registry half is read once: a listing is not free, and the pair feeds
  // every row below.
  let directory = [];
  try {
    const listed = llm.listConfigurableProviders();
    if (Array.isArray(listed)) directory = listed;
  } catch {
    directory = [];
  }
  const byProvider = new Map();
  for (const entry of directory) {
    if (typeof entry?.provider === 'string') byProvider.set(entry.provider, entry);
  }

  let active = [];
  try {
    const listed = llm.listProviders();
    if (Array.isArray(listed)) active = listed;
  } catch (error) {
    throw new Error(`the provider registry could not be listed: ${safeMessage(error)}`);
  }
  // A malformed entry must not fail the whole call, so it is dropped upstream.
  active = active.filter((provider) => typeof provider?.id === 'string' && provider.id !== '');
  directory = directory.filter((entry) => typeof entry?.provider === 'string' && entry.provider !== '');

  const activeIds = new Set(active.map((provider) => provider.id));
  const selected = wanted === undefined ? active : active.filter((provider) => provider.id === wanted);
  const kept = selected.slice(0, MAX_PROVIDERS);
  const namespaces = loadNamespaces(ctx);

  const rows = await Promise.all(
    kept.map((provider) =>
      activeRow(ctx, llm, provider, byProvider.get(provider.id), namespaces, wantedProbe, timeoutMs, signal),
    ),
  );

  let dropped = selected.length - kept.length;

  if (includeDormant) {
    const pending = [];
    for (const entry of directory) {
      if (activeIds.has(entry.provider)) continue;
      if (wanted !== undefined && entry.provider !== wanted) continue;
      if (rows.length + pending.length >= MAX_PROVIDERS) {
        dropped += 1;
        continue;
      }
      pending.push(entry);
    }
    const dormantRows = await Promise.all(
      pending.map(async (entry) => {
        const name =
          typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : entry.provider;
        const started = Date.now();
        const step = await credentialStep(
          ctx,
          entry.provider,
          entry,
          namespaces,
          () => Math.max(1, timeoutMs - (Date.now() - started)),
          signal,
        );
        return {
          provider: entry.provider,
          name,
          kind: KINDS.DORMANT,
          credential: step.state,
          ...(step.error === undefined ? {} : { error: step.error }),
          note: 'declared, not activated; it has no adapter and no models',
          models: [],
        };
      }),
    );
    rows.push(...dormantRows);
  }

  // Active first, then a fixed code-unit order, so every host agrees on it.
  rows.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === KINDS.ACTIVE ? -1 : 1;
    if (left.provider === right.provider) return 0;
    return left.provider < right.provider ? -1 : 1;
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
    truncated: dropped > 0,
  };
}
