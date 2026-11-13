# dokploy-deploy

A composite Forgejo/GitHub action (`action.yml`) running `node` on a bundled
entry point (`dist/index.mjs`, built by esbuild from `src/`). Context and
design decisions: babel plan `docs/plans/app-self-deploy.md`. Usage, inputs,
threat model and the release procedure are in [`README.md`](README.md).

## Commands

```sh
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm format:check
pnpm build         # rebuild dist/ — commit it with every src/ or dependency change
pnpm build:check   # what CI runs: rebuild, then fail if dist/ differs
```

## Rules

The code follows the `ddd-template` conventions (Effect v4 only, purely
functional). The ones that matter here:

- **Pipe first**; `Effect.gen` only in tests, or with a `// Why:`.
- **Every method returning an `Effect` ends with `Effect.withSpan`**, named
  `<Component>.<method>`.
- **Every log goes through `EffectLog`** (`src/effect/`): a fixed message,
  data in annotations, the real `Cause` under `cause`. Never a secret in a
  message, an annotation or a span attribute.
- **`Schema` for every input and every Dokploy answer**; typed errors, no
  defect without a `// Defect:` line.
- **Environment reads only in `action-inputs.config.ts`**: the composite step
  maps each input to a `DOKPLOY_DEPLOY_*` variable.
- **Services are classes** implementing a `<Name>Shape`, with
  `buildTestService` / `testLayer` / `buildTestLayer`.
- **No `as` casts, no `new` outside the declaring module, no comments** except
  `// Why:`, `// Defect:`, `// TODO(@handle):` and Given / When / Then in tests.
- **Tests**: titles start with `should`, bodies follow Given / When / Then,
  the Dokploy API is always mocked.
- **The action is a public API**: an input, output or behaviour change is
  declared in `action.yml` and `README.md` in the same change; a breaking one
  is a new major version.
- **Portable**: it runs on GitHub and Forgejo runners, under `sh`, on Node 20
  or later (esbuild targets `node20`).
- **Public repository**: no secret, no internal host name.

`tools/oxlint-plugin/` is a copy of `ddd-template`'s
`packages/tooling/oxlint-plugin/src` (without `no-unlocalized-string`, which
only targets JSX copy) and `tools/oxlint-config/` of its `oxlint-config`. Keep
them in sync by copying again, not by editing here.

Commits: Conventional Commits, `type(scope): imperative summary`. Run
`/code-review` locally before pushing a PR. `/implement-issue <n>` drives an
issue end to end.
