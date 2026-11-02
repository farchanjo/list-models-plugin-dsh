# list-models-plugin-dsh

Read-only model inventory for DSH, delivered as one tool. It answers what this
instance actually has registered, and nothing else.

`list_models` reports three things:

- every **active** provider route, with the models its adapter advertises;
- every **dormant** route a plugin declared but nobody activated;
- the **credential state** of each route: `configured`, `missing`, or `unknown`.

The default provider and model are marked. No file of DSH, of `dsh-tui`, of the
web app, or of any other plugin is touched: the plugin only reads the public
listing API of the `llm` service.

## Why two sources

A catalog-only read lies. The pi-ai adapter answers `listModels()` with an empty
array when a provider has no API key, so a route that *is* registered would
vanish from the answer. The inventory therefore joins two registry halves:

| Source | Gives |
| --- | --- |
| `llm.listProviders()` | routes with a live adapter, key or no key |
| `llm.listModels(provider)` | the catalog one active adapter advertises |
| `llm.listConfigurableProviders()` | routes declared and not activated |
| `settings.describe()` + `credentials.describe()` | credential state per route |
| `agentDefaultModel.currentSelection()` | the default route to mark |

## Isolation

One provider never sinks the answer. A throwing adapter, a rejected key
lookup, or an unmounted `settings`/`credentials` service degrades that row —
`error`, `unknown`, or an empty catalog — and the rest of the inventory still
reports. The tool also stops at 500 models per provider and 200 providers, and
flags truncation.

Nothing here resolves a model call or writes settings, so a listing is cheap.

## Install

```sh
dsh plugin --profile dsh-tui add /root/dev/list-models-plugin-dsh
```

The bundle patch inserts the row; no manual profile edit is needed.

## Tool contract

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | string | all | exact provider id to report |
| `includeDormant` | boolean | `true` | include declared-but-inactive routes |
| `probeModels` | boolean | `true` | ask adapters for their catalog; `false` answers from the registry alone |

The canonical value is JSON; the model sees a readable table, and the same
value is what `presentResult` consumers receive.

```json
{
  "generatedAt": "2026-11-01T23:10:00.000Z",
  "default": { "provider": "openrouter", "model": "~deepseek/deepseek-flash-latest" },
  "providers": [
    {
      "provider": "openrouter",
      "name": "OpenRouter",
      "kind": "active",
      "credential": "configured",
      "models": [{ "id": "deepseek/deepseek-flash", "name": "DeepSeek Flash", "inputModalities": ["text"] }]
    },
    {
      "provider": "dsv41",
      "name": "DeepSeek Flash 41",
      "kind": "dormant",
      "credential": "missing",
      "note": "declared, not activated; it has no adapter and no models",
      "models": []
    }
  ],
  "failures": [],
  "counts": { "providers": 2, "active": 1, "dormant": 1, "models": 1, "failures": 0 },
  "truncated": false
}
```

`kind` is `active` or `dormant`. `credential` is `configured`, `missing`, or
`unknown`; `unknown` means the credential could not be probed, never that it is
absent.

## Layout

```text
lib/collect.js   pure inventory projection, no Cordis
lib/index.js     tool definition and registration
test/            collector and tool-surface contracts
```

## Development

```sh
pnpm install
pnpm test
pnpm lint
```

## Limits

- Listing does not prove a route dispatches: a configured credential can still
  be rejected upstream. Use a real call for that.
- A dormant route has no adapter, so it can report no models.
- The tool is read-only. It never changes the default selection or a profile.

## License

MIT. See `LICENSE`.
