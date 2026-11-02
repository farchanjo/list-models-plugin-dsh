/**
 * Tool surface: the definition is registry-valid, the arguments validate, the
 * canonical value matches the output schema, and the rendering is a table.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

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

test('a row that lost the llm service still fails loudly', async () => {
  // `inject` keeps this from happening under Cordis; the collector guard backs it.
  let captured;
  apply({ get: () => undefined, tools: { register: (definition) => (captured = definition) } });
  await assert.rejects(() => captured.execute({}, {}), /llm service is not mounted/);
});
