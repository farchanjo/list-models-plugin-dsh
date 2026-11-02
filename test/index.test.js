/**
 * Tool surface: the definition is registry-valid, the arguments validate, the
 * canonical value matches the output schema, and the rendering is a table.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { DEFAULT_PROBE_TIMEOUT_MS } from '../lib/collect.js';
import { apply } from '../lib/index.js';

/**
 * Build a host context over a fake registry and capture the registration.
 * @returns the fake context and the captured definition accessor.
 */
function host() {
  let captured;
  const services = {
    settings: { describe: () => [] },
    credentials: { describe: async () => ({ configured: false, writable: true }) },
    llm: {
      listProviders: () => [{ id: 'alpha', name: 'Alpha' }],
      listModels: async (provider) => [{ provider, id: 'alpha-large', name: 'Alpha Large' }],
      listConfigurableProviders: () => [],
    },
  };
  const ctx = {
    llm: services.llm,
    get: (name) => services[name],
    tools: {
      register(definition) {
        captured = definition;
        return () => {};
      },
    },
  };
  return { ctx, definition: () => captured };
}

test('registers list_models with a registry-supported schema', () => {
  const { ctx, definition } = host();
  apply(ctx);
  const tool = definition();
  assert.equal(tool.name, 'list_models');
  assertSupportedJsonSchema(tool.output.schema);
  assertSupportedJsonSchema(tool.parameters);
});

test('a wrong argument type is rejected by the declared schema', () => {
  const { ctx, definition } = host();
  apply(ctx);
  const schema = definition().parameters;
  assert.deepEqual(validateJsonSchemaValue(schema, {}, ''), []);
  assert.deepEqual(validateJsonSchemaValue(schema, { provider: 'alpha', probeModels: false }, ''), []);
  assert.notDeepEqual(validateJsonSchemaValue(schema, { provider: 7 }, ''), []);
  // The root is deliberately open: a stray key is ignored, not rejected.
  assert.deepEqual(validateJsonSchemaValue(schema, { bogus: 1 }, ''), []);
});

test('an over-long provider filter is rejected at execution', async () => {
  const { ctx, definition } = host();
  apply(ctx);
  await assert.rejects(() => definition().execute({ provider: 'p'.repeat(129) }, {}), /at most|exceed/);
});

test('executes into a value the output schema accepts and renders a table', async () => {
  const { ctx, definition } = host();
  apply(ctx);
  const tool = definition();
  const value = await tool.execute({}, {});
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), []);
  assert.equal(value.providers[0].provider, 'alpha');
  assert.equal(value.providers[0].models[0].id, 'alpha-large');

  const blocks = tool.output.render({}, value);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /alpha — Alpha/);
  assert.match(blocks[0].text, /alpha-large/);
  assert.match(blocks[0].text, /1 active, 0 dormant, 1 models, 0 failed/);

  const meta = tool.output.presentationMeta({}, value);
  assert.equal(meta.counts.models, 1);
  assert.equal(meta.generatedAt, value.generatedAt);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), []);
});

test('a mounted registry with no route renders the empty sentence', async () => {
  const { ctx, definition } = host();
  const empty = {
    llm: { listProviders: () => [], listModels: async () => [], listConfigurableProviders: () => [] },
    get: (name) => ctx.get(name),
    tools: ctx.tools,
  };
  apply(empty);
  const tool = definition();
  const value = await tool.execute({}, {});
  const text = tool.output.render({}, value)[0].text;
  assert.match(text, /no provider route is registered/);
});

test('the render marks every state except configured', async () => {
  const { ctx, definition } = host();
  apply(ctx);
  const tool = definition();
  const unread = await tool.execute({ includeDormant: true }, {});
  assert.match(tool.output.render({}, unread)[0].text, /alpha — Alpha \[unknown\]/);

  const configured = {
    ...ctx,
    get: (name) =>
      name === 'credentials'
        ? { describe: async () => ({ configured: true, writable: true }) }
        : name === 'settings'
          ? { describe: () => [{ ns: 'llm-alpha', value: { profile: { apiKeyEnv: 'ALPHA_KEY' } } }] }
          : ctx.get(name),
  };
  // `ctx.llm` wins over `ctx.get('llm')`, so the override must live there.
  const llm = {
    ...ctx.get('llm'),
    listConfigurableProviders: () => [
      { provider: 'alpha', displayName: 'Alpha', settingsNs: 'llm-alpha', settingsPath: ['profile'] },
      { provider: 'gamma', displayName: 'Gamma', settingsNs: 'llm-gamma', settingsPath: ['profile'] },
    ],
  };
  const directory = { ...configured, llm };
  apply(directory);
  const text = definition()
    .output.render({}, await definition().execute({}, {}))
    .at(0).text;
  assert.match(text, /alpha — Alpha\n/);
  assert.match(text, /dormant, not-applicable\]/);
});

test('presentCall names the filter and presentResult titles the counts', async () => {
  const { ctx, definition } = host();
  apply(ctx);
  const tool = definition();
  assert.match(tool.presentCall({ provider: 'alpha' }).title, /alpha$/);
  const value = await tool.execute({}, {});
  const meta = tool.output.presentationMeta({}, value);
  const view = tool.presentResult({}, { content: [{ type: 'text', text: 'x' }], isError: false, meta });
  assert.match(view.title, /^1 active, 0 dormant, 1 models$/);
  const failed = tool.presentResult({}, { content: [], isError: true, meta });
  assert.match(failed.title, /\(failed\)$/);
});

test('the tool budget leaves headroom over the internal call budget', () => {
  const { ctx, definition } = host();
  apply(ctx);
  assert.ok(definition().timeoutMs > DEFAULT_PROBE_TIMEOUT_MS);
});

test('the caller signal reaches the collector', async () => {
  const { ctx, definition } = host();
  apply(ctx);
  const controller = new AbortController();
  controller.abort();
  const value = await definition().execute({}, { signal: controller.signal });
  assert.ok(value.providers.every((row) => /aborted/.test(row.error)));
});
