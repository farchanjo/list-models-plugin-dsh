# AGENTS.md

Read-only model inventory for DSH: lists registered provider routes, dormant configurable routes, and credential state without touching core.

Plugin for DSH. Runtime only: `lib/` ships as committed JavaScript, there is no
build step. Everything below is binding for any agent or human working in this
repository.

## Distribution

**GitHub Releases only. This package is never published to npm.**

A release is the install unit. Each one carries a packed tarball and its SHA-256
next to the tag:

```
https://github.com/farchanjo/list-models-plugin-dsh/releases/download/v<version>/list-models-plugin-dsh-<version>.tgz
https://github.com/farchanjo/list-models-plugin-dsh/releases/download/v<version>/list-models-plugin-dsh-<version>.tgz.sha256
```

Consumers install the tarball URL and nothing else. A git clone is a development
convenience, not an install path.

## Mandatory: every change ships a release

Never leave a change sitting on `main` without a version bump and a release. A
commit that lands on `main` without one is an incomplete change, and a consumer
pinned to the previous tarball silently misses it.

`main` must always correspond to a published tag. There is no unreleased state.

## Release procedure

```sh
./scripts/release.sh patch     # fix
./scripts/release.sh minor     # feature
./scripts/release.sh major     # breaking
```

The script refuses a dirty tree, a branch other than `main`, and a `main` that
is behind `origin`. It then:

1. installs the lockfile;
2. runs the test suite and the linter (skipped when the script is absent);
3. bumps `package.json` and mirrors the version into `dsh-plugin.json`;
4. commits `chore(release): vX.Y.Z`, tags it, and pushes branch and tag;
5. packs the tarball, writes its SHA-256, and creates the GitHub release with
   both assets and the install instructions.

Never tag by hand and never publish a release without the tarball asset. The
release notes are generated; add detail by editing the release afterwards.

## Version invariants

- `package.json` and `dsh-plugin.json` carry the same version. The mount rejects
  a mismatch, so bump both — the script does.
- Semver. A removed or renamed option, a changed tool schema, or a different
  tool id is `major`.
- The tag is `v<version>`, annotated, and points at the release commit.

## Checks before pushing

```sh
pnpm test
pnpm lint
```

## Pulling a release

```sh
dsh plugin --profile <profile> add \
  https://github.com/farchanjo/list-models-plugin-dsh/releases/download/v<version>/list-models-plugin-dsh-<version>.tgz
```

Verify the asset first:

```sh
curl -sSLO https://github.com/farchanjo/list-models-plugin-dsh/releases/download/v<version>/list-models-plugin-dsh-<version>.tgz
curl -sSLO https://github.com/farchanjo/list-models-plugin-dsh/releases/download/v<version>/list-models-plugin-dsh-<version>.tgz.sha256
sha256sum -c list-models-plugin-dsh-<version>.tgz.sha256
```

A profile pins the URL in `package.json` and the integrity hash in
`pnpm-lock.yaml`. Moving to a newer release means adding the new URL, never
re-pointing a branch.

## Layout

- `lib/index.js` — plugin entry: registers the single `list_models` tool and its output schema.
- `lib/collect.js` — concurrent collection, per-row degradation, credential lookup, budgets.
- `cordis.patch.yml` — bundle patch that inserts the profile row.

## Conventions

- Artifacts — code, comments, docs, commits, release notes — are en-US.
- The bundle patch (`cordis.patch.yml`) inserts the profile row; keep it in sync
  with the ids the plugin actually registers.
- Public extension points only: no fork, no edit to DSH core or another plugin.
- Unloading removes everything the plugin registered.
