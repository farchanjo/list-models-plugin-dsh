/**
 * list-models-plugin-dsh — read-only inventory of the models DSH has registered.
 *
 * One tool, no service, no state file, no core change. The plugin reads the
 * live `llm` registry through its public listing API and reports what is there:
 * active provider routes, dormant routes a plugin declared, the credential
 * state of each, and the models each active adapter advertises. The default
 * selection is marked.
 *
 * Provider rows are isolated on purpose. A missing key, a throwing adapter, or
 * an unmounted `settings` service degrades one row; the inventory still
 * answers. Nothing here resolves a model call, so listing stays cheap.
 *
 * @module list-models-plugin-dsh
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { CREDENTIALS, collectModels, DEFAULT_PROBE_TIMEOUT_MS, KINDS } from './collect.js';

export const name = 'list-models-plugin-dsh';

/** Both services are hard dependencies: without `llm` there is nothing to list. */
export const inject = ['tools', 'llm'];

/** Argument bounds. */
const MAX_PROVIDER_CHARS = 128;

/**
 * Read one boolean argument.
 * @param value - raw argument.
 * @param fallback - value used when the argument is absent.
 * @param field - argument name for the diagnostic.
 * @returns the boolean.
 */
function flag(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`list_models: ${field} must be a boolean`);
  return value;
}

/**
 * Read and validate the provider filter.
 * @param value - raw argument.
 * @returns the trimmed provider id, or undefined.
 */
function providerFilter(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('list_models: provider must be a string');
  const trimmed = value.trim();
  if (trimmed.length > MAX_PROVIDER_CHARS) {
    throw new TypeError(`list_models: provider must not exceed ${MAX_PROVIDER_CHARS} characters`);
  }
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Render one provider heading.
 * @param row - provider row.
 * @returns the heading line.
 */
function heading(row) {
  const marks = [];
  if (row.kind === KINDS.DORMANT) marks.push('dormant');
  // `configured` is the normal case; every other state carries information.
  if (row.credential !== CREDENTIALS.CONFIGURED) marks.push(row.credential);
  const suffix = marks.length === 0 ? '' : ` [${marks.join(', ')}]`;
  return `${row.provider} — ${row.name}${suffix}`;
}

/**
 * Render the inventory as a text table.
 * @param value - validated inventory.
 * @returns content blocks.
 */
function render(value) {
  const lines = [];
  if (value.default !== undefined) {
    const effort = value.default.reasoningEffort === undefined ? '' : ` (${value.default.reasoningEffort})`;
    lines.push(`default: ${value.default.provider} / ${value.default.model}${effort}`, '');
  }
  if (value.providers.length === 0) lines.push('no provider route is registered.');

  for (const row of value.providers) {
    lines.push(heading(row));
    if (row.note !== undefined) lines.push(`  ${row.note}`);
    if (row.error !== undefined) lines.push(`  error: ${row.error}`);
    for (const model of row.models) {
      const modalities = model.inputModalities === undefined ? '' : ` (${model.inputModalities.join('+')})`;
      lines.push(`  - ${model.id}${model.name === model.id ? '' : ` — ${model.name}`}${modalities}`);
    }
    if (row.truncated === true) lines.push('  … truncated');
  }

  lines.push(
    '',
    `${value.counts.active} active, ${value.counts.dormant} dormant, ${value.counts.models} models, ${value.counts.failures} failed`,
  );
  if (value.truncated === true) lines.push('provider list truncated');
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Build the tool definition against one host context.
 * @param ctx - plugin context used for service access.
 * @returns the tool definition.
 */
function definition(ctx) {
  return defineTool({
    name: 'list_models',
    description:
      'List the models registered in this DSH instance, read-only. Reports every active provider route with the models it advertises, every dormant route a plugin declared, and the credential state of each; the default provider/model is marked. One failing or slow provider degrades its own row. Use it before naming a provider or model.',
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS * 2,
    parameters: {
      provider: {
        type: 'string',
        description: 'Exact provider id to report, at most 128 characters; omit for every registered route.',
      },
      includeDormant: {
        type: 'boolean',
        description: 'Include routes that are declared but not activated. Defaults to true.',
      },
      probeModels: {
        type: 'boolean',
        description:
          'Ask each active adapter for its catalog. Defaults to true; false answers instantly from the registry.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          generatedAt: { type: 'string', required: true },
          default: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
              reasoningEffort: { type: 'string' },
            },
          },
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: [KINDS.ACTIVE, KINDS.DORMANT] },
                credential: {
                  type: 'string',
                  required: true,
                  enum: [CREDENTIALS.CONFIGURED, CREDENTIALS.MISSING, CREDENTIALS.NOT_APPLICABLE, CREDENTIALS.UNKNOWN],
                },
                note: { type: 'string' },
                error: { type: 'string' },
                truncated: { type: 'boolean' },
                models: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                      description: { type: 'string' },
                      inputModalities: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          failures: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          counts: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              providers: { type: 'integer', required: true },
              active: { type: 'integer', required: true },
              dormant: { type: 'integer', required: true },
              models: { type: 'integer', required: true },
              failures: { type: 'integer', required: true },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => render(value),
      presentationMeta: (_args, value) => ({
        generatedAt: value.generatedAt,
        ...(value.default === undefined ? {} : { default: value.default }),
        counts: value.counts,
        truncated: value.truncated,
      }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title:
        typeof args.provider === 'string' && args.provider !== '' ? `List models: ${args.provider}` : 'List models',
    }),
    presentResult: (_args, result) => {
      const counts = typeof result.meta === 'object' && result.meta !== null ? result.meta.counts : undefined;
      return {
        card: 'generic',
        title:
          typeof counts === 'object' && counts !== null
            ? `${counts.active} active, ${counts.dormant} dormant, ${counts.models} models`
            : 'Listed models',
        content: result.content,
      };
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return collectModels(ctx, {
        provider: providerFilter(args.provider),
        includeDormant: flag(args.includeDormant, true, 'includeDormant'),
        probeModels: flag(args.probeModels, true, 'probeModels'),
        signal: exec?.signal,
      });
    },
  });
}

/**
 * Register the tool for the lifetime of the row.
 * @param ctx - Cordis context of the profile row.
 */
export function apply(ctx) {
  ctx.tools.register(definition(ctx));
}
