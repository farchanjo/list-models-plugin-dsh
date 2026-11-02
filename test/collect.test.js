/**
 * Collector contract: both registry halves are reported, one broken provider
 * never sinks the answer, and a missing service degrades instead of throwing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CREDENTIALS, collectModels, credentialState, KINDS } from '../lib/collect.js';

/**
 * Build a host context over a fake registry.
 * @param overrides - registry and service overrides.
 * @returns the fake context.
 */
function host(overrides = {}) {
  const services = {
    llm: {
      listProviders: () => [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ],
      listModels: async (provider) => {
        if (provider === 'beta') throw new Error('catalog unavailable');
        return [
          { provider, id: 'alpha-large', name: 'Alpha Large', inputModalities: ['text', 'image'] },
          { provider, id: 'alpha-small', name: 'Alpha Small' },
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
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'alpha', model: 'alpha-large' }) },
    ...overrides,
  };
  return { get: (name) => services[name] };
}

test('reports active and dormant routes with credential state', async () => {
  const value = await collectModels(host());
  assert.deepEqual(
    value.providers.map((row) => [row.provider, row.kind, row.credential]),
    [
      ['alpha', KINDS.ACTIVE, CREDENTIALS.CONFIGURED],
      ['beta', KINDS.ACTIVE, CREDENTIALS.UNKNOWN],
      ['gamma', KINDS.DORMANT, CREDENTIALS.UNKNOWN],
    ],
  );
  assert.deepEqual(value.default, { provider: 'alpha', model: 'alpha-large' });
  assert.deepEqual(
    value.providers[0].models.map((model) => model.id),
    ['alpha-large', 'alpha-small'],
  );
});

test('one throwing adapter degrades its own row only', async () => {
  const value = await collectModels(host());
  const beta = value.providers.find((row) => row.provider === 'beta');
  assert.equal(beta.error, 'catalog unavailable');
  assert.deepEqual(beta.models, []);
  assert.deepEqual(value.failures, [{ provider: 'beta', message: 'catalog unavailable' }]);
  assert.equal(value.counts.failures, 1);
  assert.equal(value.providers[0].error, undefined);
});

test('a missing credential marks the row and notes the empty catalog', async () => {
  const value = await collectModels(host(), { probeModels: false });
  const alpha = value.providers.find((row) => row.provider === 'alpha');
  assert.equal(alpha.credential, CREDENTIALS.CONFIGURED);
  const base = host();
  const missing = await collectModels({
    get: (name) =>
      name === 'credentials'
        ? { describe: async () => ({ configured: false, writable: true }) }
        : name === 'llm'
          ? { ...base.get('llm'), listModels: async () => [] }
          : base.get(name),
  });
  const row = missing.providers.find((entry) => entry.provider === 'alpha');
  assert.equal(row.credential, CREDENTIALS.MISSING);
  assert.equal(row.note, 'no credential; the adapter advertises nothing');
  assert.equal(missing.providers.find((entry) => entry.provider === 'beta').note, undefined);
});

test('unknown services degrade to unknown instead of throwing', async () => {
  const value = await collectModels(host({ settings: undefined, credentials: undefined }));
  assert.ok(value.providers.every((row) => row.credential === CREDENTIALS.UNKNOWN));
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
    ['alpha', 'beta'],
  );
});

test('probeModels false never calls the adapter', async () => {
  let calls = 0;
  const value = await collectModels(
    host({
      llm: {
        ...host().get('llm'),
        listModels: async () => {
          calls += 1;
          return [];
        },
      },
    }),
    { probeModels: false },
  );
  assert.equal(calls, 0);
  assert.equal(value.counts.models, 0);
});

test('a context without the llm service fails loudly', async () => {
  await assert.rejects(() => collectModels({ get: () => undefined }), /llm service is not mounted/);
});

test('credentialState answers unknown for a missing entry or a non-object profile', async () => {
  const ctx = host();
  assert.equal(await credentialState(ctx, undefined), CREDENTIALS.UNKNOWN);
  assert.equal(await credentialState(ctx, { settingsNs: 'absent', settingsPath: ['profile'] }), CREDENTIALS.UNKNOWN);
  assert.equal(await credentialState(ctx, { settingsNs: 'llm-gamma', settingsPath: ['profile'] }), CREDENTIALS.UNKNOWN);
});
