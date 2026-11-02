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

import { credentialKey, isCredentialKeySegment, isCredentialRefName } from '@deepseek-ai/dsh-credentials';

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

/** Scope the signing adapters store a sign-in grant under. */
const SIGN_IN_SCOPE = 'llm-pi-ai';

/**
 * Stringify a thrown value without trusting it.
 * @param error - whatever was thrown, including a null-prototype object.
 * @returns a printable message.
 */
export function safeMessage(error) {
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
 * @param budgetMs - budget to name in the message; defaults to the deadline, so a
 *   row that starts late still reports the call budget instead of the leftover.
 * @returns the task result, or a rejection naming the reason.
 */
async function withDeadline(task, timeoutMs, signal, budgetMs = timeoutMs) {
  if (signal?.aborted === true) throw new Error('aborted before the probe');
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      task,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${budgetMs} ms`)), timeoutMs);
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
 * Ask the store whether a sign-in grant is stored for one route.
 *
 * A grant answers presence on its own: an owner who signed in confirms
 * authentication, so no variable has to be set. Anything unaddressable or
 * thrown is reported as no answer, never as a negative.
 *
 * @param credentials - credential service.
 * @param providerId - provider route.
 * @returns whether a grant is stored, plus an error when the store failed.
 */
async function describeSignIn(credentials, providerId) {
  if (typeof credentials.describeRecord !== 'function') return { configured: false };
  if (!isCredentialKeySegment(SIGN_IN_SCOPE) || !isCredentialKeySegment(providerId)) return { configured: false };
  try {
    const info = await credentials.describeRecord(credentialKey(SIGN_IN_SCOPE, providerId));
    return { configured: info?.configured === true };
  } catch (error) {
    return { configured: false, error: safeMessage(error) };
  }
}

/**
 * Read the credential state of one route.
 *
 * Precedence follows the adapter. A profile `apiKeyEnv` wins outright, even
 * when it is malformed or unset, because the adapter resolves it before asking
 * anything else. Without one, a stored sign-in grant is authoritative, then the
 * environment names the adapter declares in `nativeAuth.env` are probed. A
 * route that names no reference at all has nothing to miss: `not-applicable`.
 *
 * @param ctx - host context.
 * @param providerId - provider route being probed.
 * @param entry - directory entry naming the namespace, path, and native auth.
 * @param namespaces - settings namespaces already read for this call.
 * @returns the state plus an error message when the store could not answer.
 */
export async function credentialState(ctx, providerId, entry, namespaces) {
  if (OAUTH_PROVIDERS.has(providerId)) return { state: CREDENTIALS.NOT_APPLICABLE };
  if (entry === undefined) return { state: CREDENTIALS.UNKNOWN };
  const credentials = ctx.get?.('credentials');
  if (namespaces === undefined || credentials === undefined) return { state: CREDENTIALS.UNKNOWN };
  try {
    const profile = walk(namespaces.find((namespace) => namespace.ns === entry.settingsNs)?.value, entry.settingsPath);
    const declared = typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'apiKeyEnv') : undefined;
    if (typeof declared === 'string' && declared !== '') {
      // The adapter resolves an apiKeyEnv before anything else, so it wins even
      // when it is malformed or unset. A reference it cannot address is unknown.
      return {
        state: isCredentialRefName(declared) ? await describeState(credentials, declared) : CREDENTIALS.UNKNOWN,
      };
    }
    const signIn = await describeSignIn(credentials, providerId);
    if (signIn.configured) return { state: CREDENTIALS.CONFIGURED };
    const declaredEnv = Array.isArray(entry.nativeAuth?.env) ? entry.nativeAuth.env : [];
    const env = declaredEnv.filter((name) => typeof name === 'string' && isCredentialRefName(name));
    if (env.length === 0) {
      if (signIn.error !== undefined) return { state: CREDENTIALS.UNKNOWN, error: signIn.error };
      // Names were declared but none can be addressed, so nothing may be claimed.
      if (declaredEnv.length > 0) return { state: CREDENTIALS.UNKNOWN };
      // An OAuth-only route is signed in through its record, not a variable.
      return { state: entry.nativeAuth?.oauth === true ? CREDENTIALS.MISSING : CREDENTIALS.NOT_APPLICABLE };
    }
    const states = await Promise.all(env.map((ref) => describeState(credentials, ref)));
    // The variable answered, but a failed store read still deserves a voice: the
    // adapter treats that read as decisive, so the row is not simply healthy.
    if (states.includes(CREDENTIALS.CONFIGURED)) {
      return { state: CREDENTIALS.CONFIGURED, ...(signIn.error === undefined ? {} : { error: signIn.error }) };
    }
    if (states.includes(CREDENTIALS.UNKNOWN) || signIn.error !== undefined) {
      return { state: CREDENTIALS.UNKNOWN, ...(signIn.error === undefined ? {} : { error: signIn.error }) };
    }
    return { state: CREDENTIALS.MISSING };
  } catch (error) {
    return { state: CREDENTIALS.UNKNOWN, error: safeMessage(error) };
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
async function probeModels(llm, provider, timeLeft, signal, budgetMs) {
  let raw;
  try {
    raw = await withDeadline(llm.listModels(provider), timeLeft(), signal, budgetMs);
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
 * @param budgetMs - the call budget, named in a timeout message.
 * @returns the state and an optional error message.
 */
async function credentialStep(ctx, providerId, entry, namespaces, timeLeft, signal, budgetMs) {
  try {
    if (signal?.aborted === true) throw new Error('aborted before the probe');
    const result = await withDeadline(
      credentialState(ctx, providerId, entry, namespaces),
      timeLeft(),
      signal,
      budgetMs,
    );
    return result.error === undefined ? result : { state: result.state, error: `credential: ${result.error}` };
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
 * @param timeLeft - remaining call budget in milliseconds, evaluated at call time.
 * @param signal - caller abort signal.
 * @param budgetMs - the call budget, named in a timeout message.
 * @returns the row.
 */
async function activeRow(ctx, llm, provider, entry, namespaces, wantedProbe, timeLeft, signal, budgetMs) {
  const name = typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id;
  try {
    if (signal?.aborted === true) throw new Error('aborted before the probe');
    const [credential, probed] = await Promise.all([
      credentialStep(ctx, provider.id, entry, namespaces, timeLeft, signal, budgetMs),
      wantedProbe ? probeModels(llm, provider.id, timeLeft, signal, budgetMs) : { models: [], truncated: false },
    ]);
    // Both stages can fail; neither message may mask the other.
    const error = [probed.error, credential.error].filter((message) => message !== undefined).join('; ');
    const emptyCatalog = wantedProbe && probed.error === undefined && probed.models.length === 0;
    return {
      provider: provider.id,
      name,
      kind: KINDS.ACTIVE,
      credential: credential.state,
      ...(error === '' ? {} : { error }),
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

  // One budget covers the whole call, not each row: a hanging credential
  // backend must not let the dormant phase double the elapsed time.
  const deadlineAt = Date.now() + timeoutMs;
  const timeLeft = () => Math.max(1, deadlineAt - Date.now());

  const rows = await Promise.all(
    kept.map((provider) =>
      activeRow(ctx, llm, provider, byProvider.get(provider.id), namespaces, wantedProbe, timeLeft, signal, timeoutMs),
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
        const step = await credentialStep(ctx, entry.provider, entry, namespaces, timeLeft, signal, timeoutMs);
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
