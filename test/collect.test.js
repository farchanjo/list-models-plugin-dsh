/**
 * Collector contract: both registry halves are reported, one broken provider
 * never sinks the answer, a hang is bounded, and a missing service degrades.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CREDENTIALS,
  collectModels,
  credentialState,
  KINDS,
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
  safeMessage,
} from '../lib/collect.js';

/**
 * Build a host context over a fake registry.
 * @param overrides - registry and service overrides.
 * @returns the fake context.
 */
function host(overrides = {}) {
  const services = {
    llm: {
      listProviders: () => [
        { id: 'zeta', name: 'Zeta' },
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ],
      listModels: async (provider) => {
        if (provider === 'beta') throw new Error('catalog unavailable');
        return [
          { provider, id: `${provider}-large`, name: 'Large', inputModalities: ['text', 'image'] },
          { provider, id: `${provider}-small`, name: 'Small' },
        ];
      },
      listConfigurableProviders: () => [
        { provider: 'alpha', displayName: 'Alpha', settingsNs: 'llm-alpha', settingsPath: ['profile'] },
        { provider: 'gamma', displayName: 'Gamma', settingsNs: 'llm-gamma', settingsPath: ['profile'] },
      ],
    },
    settings: {
      describe: () => [
        { ns: 'llm-alpha', value: { profile: { apiKeyEnv: 'ALPHA_KEY' } } },
        { ns: 'llm-gamma', value: { profile: {} } },
      ],
    },
    credentials: {
      describe: async (ref) => ({ configured: ref === 'ALPHA_KEY', writable: true }),
      describeRecord: async () => ({ configured: false, writable: true }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'alpha', model: 'alpha-large' }) },
    ...overrides,
  };
  return { get: (name) => services[name] };
}

test('reports active and dormant routes, sorted, with credential state', async () => {
  const value = await collectModels(host());
  assert.deepEqual(
    value.providers.map((row) => [row.provider, row.kind, row.credential]),
    [
      ['alpha', KINDS.ACTIVE, CREDENTIALS.CONFIGURED],
      ['beta', KINDS.ACTIVE, CREDENTIALS.UNKNOWN],
      ['zeta', KINDS.ACTIVE, CREDENTIALS.UNKNOWN],
      ['gamma', KINDS.DORMANT, CREDENTIALS.NOT_APPLICABLE],
    ],
  );
  assert.deepEqual(value.default, { provider: 'alpha', model: 'alpha-large' });
  assert.deepEqual(
    value.providers[0].models.map((model) => model.id),
    ['alpha-large', 'alpha-small'],
  );
  assert.deepEqual(value.providers[0].models[0].inputModalities, ['text', 'image']);
});

test('one throwing adapter degrades its own row only', async () => {
  const value = await collectModels(host());
  const beta = value.providers.find((row) => row.provider === 'beta');
  assert.equal(beta.error, 'catalog: catalog unavailable');
  assert.deepEqual(beta.models, []);
  assert.deepEqual(value.failures, [{ provider: 'beta', message: 'catalog: catalog unavailable' }]);
  assert.equal(value.counts.failures, 1);
  assert.equal(value.providers[0].error, undefined);
});

test('a hanging adapter is bounded by the deadline', async () => {
  const base = host();
  const value = await collectModels(
    {
      get: (name) =>
        name === 'llm' ? { ...base.get('llm'), listModels: () => new Promise(() => {}) } : base.get(name),
    },
    { timeoutMs: 25 },
  );
  assert.equal(value.providers.length, 4);
  assert.match(value.providers[0].error, /catalog: timed out after 25 ms/);
  assert.equal(value.counts.failures, 3);
});

test('probes run concurrently, not in series', async () => {
  const base = host();
  const started = Date.now();
  await collectModels(
    {
      get: (name) =>
        name === 'llm'
          ? {
              ...base.get('llm'),
              listModels: () => new Promise((resolve) => setTimeout(() => resolve([]), 60)),
            }
          : base.get(name),
    },
    { includeDormant: false },
  );
  assert.ok(Date.now() - started < 150, 'three 60 ms probes should overlap');
});

test('an aborted signal fails the probes instead of waiting', async () => {
  const base = host();
  const controller = new AbortController();
  controller.abort();
  const value = await collectModels(
    { get: (name) => (name === 'llm' ? base.get('llm') : base.get(name)) },
    { signal: controller.signal },
  );
  assert.ok(
    value.providers.filter((row) => row.kind === KINDS.ACTIVE).every((row) => row.error === 'aborted before the probe'),
  );
});

test('a missing credential marks the row and notes the empty catalog only when probed', async () => {
  const base = host();
  const missingHost = {
    get: (name) =>
      name === 'credentials'
        ? { describe: async () => ({ configured: false, writable: true }) }
        : name === 'llm'
          ? { ...base.get('llm'), listModels: async () => [] }
          : base.get(name),
  };
  const missing = await collectModels(missingHost);
  const row = missing.providers.find((entry) => entry.provider === 'alpha');
  assert.equal(row.credential, CREDENTIALS.MISSING);
  assert.equal(row.note, 'no credential; the adapter advertises nothing');

  const unprobed = await collectModels(missingHost, { probeModels: false });
  const unprobedRow = unprobed.providers.find((entry) => entry.provider === 'alpha');
  assert.equal(unprobedRow.credential, CREDENTIALS.MISSING);
  assert.equal(unprobedRow.note, undefined, 'the adapter was never asked');

  const failing = await collectModels({
    get: (name) =>
      name === 'credentials'
        ? { describe: async () => ({ configured: false, writable: true }) }
        : name === 'llm'
          ? {
              ...base.get('llm'),
              listConfigurableProviders: () => [
                { provider: 'beta', displayName: 'Beta', settingsNs: 'llm-beta', settingsPath: ['profile'] },
              ],
            }
          : name === 'settings'
            ? { describe: () => [{ ns: 'llm-beta', value: { profile: { apiKeyEnv: 'BETA_KEY' } } }] }
            : base.get(name),
  });
  const failingRow = failing.providers.find((entry) => entry.provider === 'beta');
  assert.equal(failingRow.credential, CREDENTIALS.MISSING);
  assert.equal(failingRow.error, 'catalog: catalog unavailable');
  assert.equal(failingRow.note, undefined, 'an error is not an empty catalog');
});

test('unknown services degrade to unknown instead of throwing', async () => {
  const value = await collectModels(host({ settings: undefined, credentials: undefined }));
  const declared = value.providers.filter((row) => row.provider === 'alpha' || row.provider === 'gamma');
  assert.equal(declared.length, 2);
  assert.ok(declared.every((row) => row.credential === CREDENTIALS.UNKNOWN));
  const undeclared = value.providers.filter((row) => row.provider === 'beta' || row.provider === 'zeta');
  assert.ok(undeclared.every((row) => row.credential === CREDENTIALS.UNKNOWN));
});

test('a malformed credential answer is unknown, not missing', async () => {
  const value = await collectModels(host({ credentials: { describe: async () => undefined } }));
  const alpha = value.providers.find((row) => row.provider === 'alpha');
  assert.equal(alpha.credential, CREDENTIALS.UNKNOWN);
});

test('an OAuth route with no key reference is not-applicable', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? { ...base.get('llm'), listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }] }
        : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.NOT_APPLICABLE);
});

test('filters to one provider and can exclude dormant routes', async () => {
  const only = await collectModels(host(), { provider: 'gamma' });
  assert.deepEqual(
    only.providers.map((row) => row.provider),
    ['gamma'],
  );
  const activeOnly = await collectModels(host(), { includeDormant: false });
  assert.deepEqual(
    activeOnly.providers.map((row) => row.provider),
    ['alpha', 'beta', 'zeta'],
  );
});

test('probeModels false never calls the adapter', async () => {
  let calls = 0;
  const base = host();
  const value = await collectModels(
    {
      get: (name) =>
        name === 'llm'
          ? {
              ...base.get('llm'),
              listModels: async () => {
                calls += 1;
                return [];
              },
            }
          : base.get(name),
    },
    { probeModels: false },
  );
  assert.equal(calls, 0);
  assert.equal(value.counts.models, 0);
});

test('the model cap truncates one provider and flags that row', async () => {
  const base = host();
  const value = await collectModels(
    {
      get: (name) =>
        name === 'llm'
          ? {
              ...base.get('llm'),
              listModels: async () =>
                Array.from({ length: MAX_MODELS_PER_PROVIDER + 7 }, (_unused, index) => ({ id: `m${index}` })),
            }
          : base.get(name),
    },
    { includeDormant: false },
  );
  assert.equal(value.providers[0].models.length, MAX_MODELS_PER_PROVIDER);
  assert.equal(value.providers[0].truncated, true);
  assert.equal(value.truncated, false);
});

test('the provider cap truncates the call and flags it', async () => {
  const base = host();
  const many = Array.from({ length: MAX_PROVIDERS + 10 }, (_unused, index) => ({
    id: `p${String(index).padStart(3, '0')}`,
    name: `P${index}`,
  }));
  const value = await collectModels(
    {
      get: (name) =>
        name === 'llm' ? { ...base.get('llm'), listProviders: () => many, listModels: async () => [] } : base.get(name),
    },
    { includeDormant: false },
  );
  assert.equal(value.providers.length, MAX_PROVIDERS);
  assert.equal(value.truncated, true);
});

test('a non-Error throw is reported without crashing the call', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listModels: (provider) => {
              if (provider === 'beta') throw Object.create(null);
              return Promise.resolve([]);
            },
          }
        : base.get(name),
  });
  const beta = value.providers.find((row) => row.provider === 'beta');
  assert.equal(beta.error, 'catalog: [object Object]');
});

test('non-array registry answers are treated as empty', async () => {
  const value = await collectModels({
    get: (name) => (name === 'llm' ? { listProviders: () => null, listConfigurableProviders: () => 7 } : undefined),
  });
  assert.deepEqual(value.providers, []);
  assert.equal(value.counts.providers, 0);
});

test('a malformed apiKeyEnv is unknown, not not-applicable', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'settings'
        ? { describe: () => [{ ns: 'llm-alpha', value: { profile: { apiKeyEnv: 'bad name' } } }] }
        : base.get(name),
  });
  assert.equal(value.providers.find((row) => row.provider === 'alpha').credential, CREDENTIALS.UNKNOWN);
});

test('declared but unaddressable native env names are unknown', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'beta', name: 'Beta' }],
            listConfigurableProviders: () => [
              {
                provider: 'beta',
                displayName: 'Beta',
                settingsNs: 'llm-beta',
                settingsPath: ['profile'],
                nativeAuth: { env: ['9bad'], oauth: true },
              },
            ],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-beta', value: {} }] }
          : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.UNKNOWN);
});

test('an unset variable on an OAuth-capable route is missing, not not-applicable', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'beta', name: 'Beta' }],
            listConfigurableProviders: () => [
              {
                provider: 'beta',
                displayName: 'Beta',
                settingsNs: 'llm-beta',
                settingsPath: ['profile'],
                nativeAuth: { env: ['BETA_KEY'], oauth: true },
              },
            ],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-beta', value: {} }] }
          : name === 'credentials'
            ? { describe: async () => ({ configured: false, writable: true }) }
            : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.MISSING);
});

test('one call budget covers both phases, so a hang cannot double the time', async () => {
  const base = host();
  const started = Date.now();
  await collectModels(
    {
      get: (name) =>
        name === 'credentials'
          ? {
              describe: () => new Promise(() => {}),
              describeRecord: async () => ({ configured: false, writable: true }),
            }
          : name === 'llm'
            ? {
                ...base.get('llm'),
                listModels: async () => [],
                // both phases must wait, or a per-phase budget passes
                listConfigurableProviders: () => [
                  {
                    provider: 'alpha',
                    displayName: 'Alpha',
                    settingsNs: 'llm-alpha',
                    settingsPath: ['profile'],
                    nativeAuth: { env: ['ALPHA_KEY'], oauth: false },
                  },
                  {
                    provider: 'delta',
                    displayName: 'Delta',
                    settingsNs: 'llm-delta',
                    settingsPath: ['profile'],
                    nativeAuth: { env: ['DELTA_KEY'], oauth: false },
                  },
                ],
              }
            : name === 'settings'
              ? {
                  describe: () => [
                    { ns: 'llm-alpha', value: { profile: { apiKeyEnv: 'ALPHA_KEY' } } },
                    { ns: 'llm-delta', value: {} },
                  ],
                }
              : base.get(name),
    },
    { timeoutMs: 40 },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 75, `one budget, not two: settled in ${elapsed} ms`);
});

test('the credential lookup and the catalog probe overlap', async () => {
  const base = host();
  const started = Date.now();
  await collectModels(
    {
      get: (name) =>
        name === 'credentials'
          ? { describe: () => new Promise((resolve) => setTimeout(() => resolve({ configured: true }), 60)) }
          : name === 'llm'
            ? { ...base.get('llm'), listModels: () => new Promise((resolve) => setTimeout(() => resolve([]), 60)) }
            : base.get(name),
    },
    { includeDormant: false },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 110, `stages run together: settled in ${elapsed} ms`);
});

test('a settled call leaves no timer behind', async () => {
  await collectModels(host(), { timeoutMs: 600_000 });
  const handles = process.getActiveResourcesInfo();
  assert.equal(handles.filter((handle) => handle === 'Timeout').length, 0);
});

test('a context without the llm service fails loudly', async () => {
  await assert.rejects(() => collectModels({ get: () => undefined }), /llm service is not mounted/);
});

test('credentialState answers unknown for an undeclared route and missing for an unsigned OAuth route', async () => {
  const ctx = host();
  const namespaces = ctx.get('settings').describe();
  assert.equal((await credentialState(ctx, 'beta', undefined, namespaces)).state, CREDENTIALS.UNKNOWN);
  assert.equal(
    (await credentialState(ctx, 'gamma', { settingsNs: 'llm-gamma', settingsPath: ['profile'] }, namespaces)).state,
    CREDENTIALS.NOT_APPLICABLE,
  );
  assert.equal(
    (
      await credentialState(
        ctx,
        'oauth',
        { provider: 'oauth', settingsNs: 'llm-gamma', settingsPath: ['profile'], nativeAuth: { env: [], oauth: true } },
        namespaces,
      )
    ).state,
    CREDENTIALS.MISSING,
  );
  assert.equal(
    (await credentialState(ctx, 'alpha', { settingsNs: 'llm-alpha', settingsPath: ['profile'] }, undefined)).state,
    CREDENTIALS.UNKNOWN,
  );
});

test('a hanging credential lookup still returns the healthy catalog', async () => {
  const base = host();
  const value = await collectModels(
    {
      get: (name) =>
        name === 'credentials'
          ? { describe: () => new Promise(() => {}) }
          : name === 'llm'
            ? { ...base.get('llm'), listModels: async (provider) => [{ id: `${provider}-one` }] }
            : base.get(name),
    },
    { includeDormant: false, timeoutMs: 25 },
  );
  const alpha = value.providers.find((row) => row.provider === 'alpha');
  assert.equal(alpha.credential, CREDENTIALS.UNKNOWN);
  assert.match(alpha.error, /^credential: timed out after \d+ ms$/);
  assert.deepEqual(
    alpha.models.map((model) => model.id),
    ['alpha-one'],
  );
});

test('a hanging credential lookup settles a dormant row too', async () => {
  const base = host();
  const value = await collectModels(
    {
      get: (name) =>
        name === 'credentials'
          ? { describe: () => new Promise(() => {}) }
          : name === 'llm'
            ? {
                ...base.get('llm'),
                listProviders: () => [],
                listConfigurableProviders: () => [
                  {
                    provider: 'gamma',
                    displayName: 'Gamma',
                    settingsNs: 'llm-gamma',
                    settingsPath: ['profile'],
                    nativeAuth: { env: ['GAMMA_KEY'], oauth: false },
                  },
                ],
              }
            : name === 'settings'
              ? { describe: () => [{ ns: 'llm-gamma', value: { profile: {} } }] }
              : base.get(name),
    },
    { timeoutMs: 25 },
  );
  assert.equal(value.providers[0].credential, CREDENTIALS.UNKNOWN);
  assert.match(value.providers[0].error, /timed out/);
});

test('an abort after the probes start fails them and releases the listeners', async () => {
  const base = host();
  const controller = new AbortController();
  let listeners = 0;
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    listeners += 1;
    add(...args);
  };
  signal.removeEventListener = (...args) => {
    listeners -= 1;
    remove(...args);
  };
  const pending = collectModels(
    {
      get: (name) =>
        name === 'llm'
          ? { ...base.get('llm'), listModels: () => new Promise(() => {}), listConfigurableProviders: () => [] }
          : name === 'credentials'
            ? { describe: () => new Promise(() => {}) }
            : base.get(name),
    },
    { signal, timeoutMs: 5_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const value = await pending;
  assert.ok(value.providers.every((row) => /aborted/.test(row.error)));
  assert.equal(listeners, 0);
});

test('native auth env references drive the state when the profile declares none', async () => {
  const base = host();
  const entry = (env) => ({
    provider: 'beta',
    displayName: 'Beta',
    settingsNs: 'llm-beta',
    settingsPath: ['profile'],
    nativeAuth: { env, oauth: false },
  });
  const run = (apiKeyConfigured) =>
    collectModels({
      get: (name) =>
        name === 'llm'
          ? {
              ...base.get('llm'),
              listProviders: () => [{ id: 'beta', name: 'Beta' }],
              listConfigurableProviders: () => [entry(['BETA_KEY', 'BETA_KEY_ALT'])],
            }
          : name === 'settings'
            ? { describe: () => [{ ns: 'llm-beta', value: { profile: {} } }] }
            : name === 'credentials'
              ? { describe: async (ref) => ({ configured: apiKeyConfigured.includes(ref), writable: true }) }
              : base.get(name),
    });
  assert.equal((await run([])).providers[0].credential, CREDENTIALS.MISSING);
  assert.equal((await run(['BETA_KEY_ALT'])).providers[0].credential, CREDENTIALS.CONFIGURED);
});

test('the provider cap can drop dormant rows and still flags it', async () => {
  const base = host();
  const manyActive = Array.from({ length: MAX_PROVIDERS - 1 }, (_unused, index) => ({
    id: `p${String(index).padStart(3, '0')}`,
    name: `P${index}`,
  }));
  const manyDormant = Array.from({ length: 5 }, (_unused, index) => ({
    provider: `d${index}`,
    displayName: `D${index}`,
    settingsNs: 'llm-gamma',
    settingsPath: ['profile'],
  }));
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => manyActive,
            listConfigurableProviders: () => manyDormant,
            listModels: async () => [],
          }
        : base.get(name),
  });
  assert.equal(value.providers.length, MAX_PROVIDERS);
  assert.equal(value.counts.dormant, 1);
  assert.equal(value.truncated, true);
});

test('a malformed registry entry does not sink the call', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'alpha', name: 'Alpha' }, null, { name: 'NoId' }],
            listConfigurableProviders: () => [null, { provider: 'gamma', displayName: 'Gamma' }],
          }
        : base.get(name),
  });
  assert.deepEqual(
    value.providers.map((row) => row.provider),
    ['alpha', 'gamma'],
  );
});

test('a stored sign-in record marks the route configured despite unset variables', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'beta', name: 'Beta' }],
            listConfigurableProviders: () => [
              {
                provider: 'beta',
                displayName: 'Beta',
                settingsNs: 'llm-beta',
                settingsPath: ['profile'],
                nativeAuth: { env: ['BETA_KEY'], oauth: true },
              },
            ],
            listModels: async () => [{ id: 'beta-one' }],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-beta', value: {} }] }
          : name === 'credentials'
            ? {
                describe: async () => ({ configured: false, writable: true }),
                describeRecord: async () => ({ configured: true, kind: 'oauth', writable: true }),
              }
            : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.CONFIGURED);
  assert.equal(value.providers[0].error, undefined);
});

test('a rejecting credential store is reported next to a failed catalog', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'credentials'
        ? {
            describe: async () => {
              throw new Error('store down');
            },
            describeRecord: async () => {
              throw new Error('store down');
            },
          }
        : name === 'llm'
          ? {
              ...base.get('llm'),
              listProviders: () => [{ id: 'beta', name: 'Beta' }],
              listConfigurableProviders: () => [
                {
                  provider: 'beta',
                  displayName: 'Beta',
                  settingsNs: 'llm-beta',
                  settingsPath: ['profile'],
                  nativeAuth: { env: ['BETA_KEY'], oauth: true },
                },
              ],
              listModels: async () => {
                throw new Error('catalog boom');
              },
            }
          : base.get(name),
  });
  const row = value.providers[0];
  assert.equal(row.credential, CREDENTIALS.UNKNOWN);
  assert.match(row.error, /catalog: catalog boom/);
  assert.match(row.error, /credential: store down/);
  assert.equal(value.counts.failures, 1);
});

test('one unknown env reference outranks a missing sibling', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'beta', name: 'Beta' }],
            listConfigurableProviders: () => [
              {
                provider: 'beta',
                displayName: 'Beta',
                settingsNs: 'llm-beta',
                settingsPath: ['profile'],
                nativeAuth: { env: ['BETA_KEY', 'BETA_ALT'], oauth: false },
              },
            ],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-beta', value: {} }] }
          : name === 'credentials'
            ? {
                describe: async (ref) => (ref === 'BETA_ALT' ? undefined : { configured: false, writable: true }),
                describeRecord: async () => ({ configured: false, writable: true }),
              }
            : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.UNKNOWN);
});

test('a dormant row is aborted without touching the store', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const value = await collectModels(
    {
      get: (name) =>
        name === 'llm'
          ? {
              listProviders: () => [],
              listConfigurableProviders: () => [
                {
                  provider: 'gamma',
                  displayName: 'Gamma',
                  settingsNs: 'llm-gamma',
                  settingsPath: ['profile'],
                  nativeAuth: { env: ['GAMMA_KEY'], oauth: false },
                },
              ],
              listModels: async () => [],
            }
          : name === 'settings'
            ? { describe: () => [{ ns: 'llm-gamma', value: {} }] }
            : name === 'credentials'
              ? {
                  describe: async () => {
                    calls += 1;
                    return { configured: false, writable: true };
                  },
                  describeRecord: async () => ({ configured: false, writable: true }),
                }
              : undefined,
    },
    { signal: controller.signal },
  );
  assert.equal(calls, 0);
  assert.equal(value.providers[0].error, 'credential: aborted before the probe');
});

test('a late dormant row names the call budget, not the leftover', async () => {
  const base = host();
  const value = await collectModels(
    {
      get: (name) =>
        name === 'credentials'
          ? {
              describe: () => new Promise(() => {}),
              describeRecord: async () => ({ configured: false, writable: true }),
            }
          : name === 'llm'
            ? {
                ...base.get('llm'),
                listModels: async () => [],
                listConfigurableProviders: () => [
                  {
                    provider: 'alpha',
                    displayName: 'Alpha',
                    settingsNs: 'llm-alpha',
                    settingsPath: ['profile'],
                    nativeAuth: { env: ['ALPHA_KEY'], oauth: false },
                  },
                  {
                    provider: 'delta',
                    displayName: 'Delta',
                    settingsNs: 'llm-delta',
                    settingsPath: ['profile'],
                    nativeAuth: { env: ['DELTA_KEY'], oauth: false },
                  },
                ],
              }
            : name === 'settings'
              ? {
                  describe: () => [
                    { ns: 'llm-alpha', value: { profile: { apiKeyEnv: 'ALPHA_KEY' } } },
                    { ns: 'llm-delta', value: {} },
                  ],
                }
              : base.get(name),
    },
    { timeoutMs: 40 },
  );
  const dormant = value.providers.find((row) => row.provider === 'delta');
  assert.equal(dormant.error, 'credential: timed out after 40 ms');
});

test('an Error whose message is not a string is still printable', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listModels: (provider) => {
              if (provider !== 'beta') return Promise.resolve([]);
              const error = new Error('x');
              Object.assign(error, { message: { toString: () => 'obj message' } });
              throw error;
            },
          }
        : base.get(name),
  });
  const beta = value.providers.find((row) => row.provider === 'beta');
  assert.equal(beta.error, 'catalog: obj message');
});

test('settings.describe runs once per call', async () => {
  let calls = 0;
  const base = host();
  await collectModels({
    get: (name) =>
      name === 'settings'
        ? {
            describe: () => {
              calls += 1;
              return base.get('settings').describe();
            },
          }
        : base.get(name),
  });
  assert.equal(calls, 1);
});

test('the default reasoning effort is reported', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'alpha', model: 'alpha-large', reasoningEffort: 'high' }) }
        : base.get(name),
  });
  assert.deepEqual(value.default, { provider: 'alpha', model: 'alpha-large', reasoningEffort: 'high' });
});

test('the collector does not trim the filter itself', async () => {
  const value = await collectModels(host(), { provider: '  alpha  ' });
  assert.deepEqual(value.providers, []);
});

test('safeMessage always yields a string', () => {
  assert.equal(safeMessage(Object.create(null)), '[object Object]');
  assert.equal(safeMessage({ toString: () => 'plain object' }), 'plain object');
  assert.equal(safeMessage({ toString: () => undefined }), 'undefined');
  const error = new Error('x');
  Object.assign(error, { message: 42 });
  assert.equal(safeMessage(error), '42');
});

test('the sign-in record is read under the fixed adapter scope', async () => {
  const base = host();
  const keys = [];
  await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'alpha', name: 'Alpha' }],
            listConfigurableProviders: () => [
              {
                provider: 'alpha',
                displayName: 'Alpha',
                settingsNs: 'llm-something-else',
                settingsPath: ['profile'],
                nativeAuth: { env: [], oauth: true },
              },
            ],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-something-else', value: {} }] }
          : name === 'credentials'
            ? {
                describe: async () => ({ configured: false, writable: true }),
                describeRecord: async (key) => {
                  keys.push(key);
                  return { configured: false, writable: true };
                },
              }
            : base.get(name),
  });
  assert.deepEqual(keys, ['llm-pi-ai/alpha']);
});

test('a failed record read is reported even when a variable answers', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'beta', name: 'Beta' }],
            listConfigurableProviders: () => [
              {
                provider: 'beta',
                displayName: 'Beta',
                settingsNs: 'llm-pi-ai',
                settingsPath: ['providers', 'beta'],
                nativeAuth: { env: ['BETA_KEY'], oauth: true },
              },
            ],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { beta: {} } } }] }
          : name === 'credentials'
            ? {
                describe: async () => ({ configured: true, writable: true }),
                describeRecord: async () => {
                  throw new Error('record store down');
                },
              }
            : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.CONFIGURED);
  assert.match(value.providers[0].error, /credential: record store down/);
});

test('a provider id outside the key grammar falls back to the variables', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'Bad_ID', name: 'Bad' }],
            listConfigurableProviders: () => [
              {
                provider: 'Bad_ID',
                displayName: 'Bad',
                settingsNs: 'llm-pi-ai',
                settingsPath: ['providers', 'Bad_ID'],
                nativeAuth: { env: ['BAD_KEY'], oauth: true },
              },
            ],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { Bad_ID: {} } } }] }
          : name === 'credentials'
            ? {
                describe: async () => ({ configured: false, writable: true }),
                describeRecord: async () => {
                  throw new TypeError('credential key segment "Bad_ID" must match the grammar');
                },
              }
            : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.MISSING);
  assert.equal(value.providers[0].error, undefined);
});

test('the provider filter also applies to dormant rows', async () => {
  const value = await collectModels(host(), { provider: 'zeta' });
  assert.deepEqual(
    value.providers.map((row) => row.provider),
    ['zeta'],
  );
  assert.equal(value.providers[0].credential, CREDENTIALS.UNKNOWN);
});

test('a malformed apiKeyEnv outranks a stored sign-in record', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'settings'
        ? { describe: () => [{ ns: 'llm-alpha', value: { profile: { apiKeyEnv: 'bad name' } } }] }
        : name === 'credentials'
          ? {
              describe: async () => ({ configured: false, writable: true }),
              describeRecord: async () => ({ configured: true, writable: true }),
            }
          : base.get(name),
  });
  assert.equal(value.providers.find((row) => row.provider === 'alpha').credential, CREDENTIALS.UNKNOWN);
});

test('an unset apiKeyEnv is missing even with a stored sign-in record', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'settings'
        ? { describe: () => [{ ns: 'llm-alpha', value: { profile: { apiKeyEnv: 'ALPHA_KEY' } } }] }
        : name === 'credentials'
          ? {
              describe: async () => ({ configured: false, writable: true }),
              describeRecord: async () => ({ configured: true, writable: true }),
            }
          : base.get(name),
  });
  assert.equal(value.providers.find((row) => row.provider === 'alpha').credential, CREDENTIALS.MISSING);
});

test('a sign-in record is read for a route without OAuth too', async () => {
  const base = host();
  const value = await collectModels({
    get: (name) =>
      name === 'llm'
        ? {
            ...base.get('llm'),
            listProviders: () => [{ id: 'groq', name: 'Groq' }],
            listConfigurableProviders: () => [
              {
                provider: 'groq',
                displayName: 'Groq',
                settingsNs: 'llm-pi-ai',
                settingsPath: ['providers', 'groq'],
                nativeAuth: { env: ['GROQ_API_KEY'], oauth: false },
              },
            ],
          }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { groq: {} } } }] }
          : name === 'credentials'
            ? {
                describe: async () => ({ configured: false, writable: true }),
                describeRecord: async () => ({ configured: true, writable: true }),
              }
            : base.get(name),
  });
  assert.equal(value.providers[0].credential, CREDENTIALS.CONFIGURED);
});
