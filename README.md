# list-models-plugin-dsh

Read-only model inventory for DSH, delivered as one tool. It answers what this
instance actually has registered, and nothing else.

`list_models` reports three things:

- every **active** provider route, with the models its adapter advertises;
- every **dormant** route a plugin declared but nobody activated;
- the **credential state** of each route: `configured`, `missing`,
  `not-applicable`, or `unknown`.

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
| `credentials.describeRecord()` | a stored sign-in or API-key record |
| `agentDefaultModel.currentSelection()` | the default route to mark |

## Isolation

One provider never sinks the answer. A throwing adapter, a rejected key
lookup, or an unmounted `settings`/`credentials` service degrades that row —
`error`, `unknown`, or an empty catalog — and the rest of the inventory still
reports. Rows are built concurrently, the credential lookup and the catalog
probe overlap, and one 5 s budget covers the whole call; the caller's abort
signal cuts it short. A credential lookup that fails still leaves the row's
catalog intact, and both failures are reported side by side. The tool also stops
at 500 models per provider and 200 providers, and flags truncation.

Nothing here resolves a model call or writes settings.

## Install

Every tagged version ships a packed tarball on the
[Releases](https://github.com/farchanjo/list-models-plugin-dsh/releases) page:

```sh
dsh plugin --profile <profile> add \
  https://github.com/farchanjo/list-models-plugin-dsh/releases/download/v<version>/list-models-plugin-dsh-<version>.tgz
```

Verify the asset against the `.sha256` published beside it before installing.
Remove with `dsh plugin --profile <profile> remove list-models-plugin-dsh`.

A git clone works too, for development. The release contract — bump, tag,
assets, checks — lives in [AGENTS.md](AGENTS.md).

## Tool contract

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | string | all | exact provider id to report, at most 128 characters |
| `includeDormant` | boolean | `true` | include declared-but-inactive routes |
| `probeModels` | boolean | `true` | ask adapters for their catalog; `false` answers from the registry alone |

The canonical value is JSON and the model sees a readable table. Host
presenters receive a compact projection — `generatedAt`, `default`, `counts`,
`truncated` — through the tool's `presentationMeta`, not the full row list.

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
      "credential": "not-applicable",
      "note": "declared, not activated; it has no adapter and no models",
      "models": []
    }
  ],
  "failures": [],
  "counts": { "providers": 2, "active": 1, "dormant": 1, "models": 1, "failures": 0 },
  "truncated": false
}
```

`kind` is `active` or `dormant`. `credential` is one of:

| Value | Means |
| --- | --- |
| `configured` | a stored sign-in or API-key record exists, or at least one variable the adapter discovers is set (it may be a non-secret such as an organization or project id) |
| `missing` | the route declares credentials and none of them is set |
| `not-applicable` | the route declares no reference at all and has no sign-in flow, so nothing can be missing |
| `unknown` | the probe could not run or could not answer, never a claim that the key is absent |

Precedence follows the adapter: a profile `apiKeyEnv` wins outright, even when
it is unset or malformed, because the adapter resolves it before anything else.
Without one, a stored sign-in or API-key record wins over the environment. `configured`
means a credential is present, not that a call was made with it: an adapter
that authenticates from a file (an AWS profile, for example) still reads
`missing`, because only declared variables and stored records are visible.

The `note` "no credential; the adapter advertises nothing" is only attached
when the adapter was actually asked and answered with an empty catalog.

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
