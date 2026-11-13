# dokploy-deploy

A Forgejo/GitHub action through which an application deploys **itself** to
[Dokploy](https://dokploy.com): after a green build, the application's CI
applies its own deployment — environment as secret references, domains, then
the deploy — with an API key scoped to its Dokploy project.

> **Status — bootstrap (`v0`).** This release only validates its inputs and
> runs a **no-op**: `plan` reports nothing to compare and succeeds; `apply`
> fails without touching Dokploy, so no pipeline can pass for a deploy. The manifest, the plan/apply logic and the deploy arrive in the
> next releases; `v1` is the first one that acts on Dokploy.

## Usage

```yaml
jobs:
  deploy:
    needs: ci
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: https://github.com/coremantle/dokploy-deploy@v0
        with:
          api-url: https://dokploy.example.com/api
          api-key: ${{ secrets.DOKPLOY_API_KEY }}
          manifest: deploy/dokploy.yml
          mode: plan
```

On GitHub, `uses: coremantle/dokploy-deploy@v0` works too; the full URL is
what Forgejo needs. Pin the **major tag** and let Renovate bump it.

The action is **composite**: it runs `node` on a bundled entry point
(`dist/index.mjs`) committed with each release, so the calling job installs
nothing. The runner — or the job's container image — must provide **Node.js
20 or later**; the action fails with a clear message otherwise.

## Inputs

| Input      | Required | Default              | Description                                                                                       |
| ---------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `api-url`  | yes      | —                    | Base URL of the Dokploy API, e.g. `https://dokploy.example.com/api`.                              |
| `api-key`  | yes      | —                    | API key of a Dokploy member scoped to the project. Pass it from a secret.                         |
| `manifest` | no       | `deploy/dokploy.yml` | Path of the deployment manifest, relative to the workspace.                                       |
| `mode`     | no       | `plan`               | `plan` reads Dokploy and reports the changes; `apply` makes them (see the status above for `v0`). |

Every input is trimmed, then validated before anything runs: a URL that is
not `https`, a blank key or one with spaces or line breaks inside, a manifest
path spanning several lines, or a mode other than `plan` / `apply` fails the
step.

## Threat model

- **The key is project-scoped.** It belongs to a Dokploy _member_ whose access
  is limited to the application's project, environments and services. Dokploy
  itself refuses the key anywhere else; the action never needs an admin key.
- **The CI never holds a secret value.** The environment it writes into
  Dokploy is made of references (`${{vault…}}`) that Dokploy resolves at
  deploy time; the key is the only secret the job sees, and the action masks
  it in the log before doing anything else.
- **Reference guard — accident protection, not a barrier.** Once it writes
  the environment (from `v1`), the action only writes references under
  `/<project>` and `/shared`. Dokploy's providers do
  not confine references to a folder, so this guard stops a typo or a
  copy-paste from pointing an application at another one's secrets. It does
  not stop a determined author: the application's compose already runs with
  root-equivalent access to its host.
- **This repository is public.** It holds no secret and no internal host name;
  host names in this README are examples.

## Development

Node 24 (`.nvmrc`) and pnpm (`packageManager` in `package.json`).

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc (TypeScript 7 + Effect language service)
pnpm lint          # oxlint, with the rules of tools/oxlint-plugin
pnpm format        # oxfmt
pnpm build         # esbuild → dist/index.mjs
```

**Any change to `src/` or to a runtime dependency is committed together with
the rebuilt `dist/`.** CI rebuilds the bundle and fails when it differs from
the committed one. Renovate PRs that bump `effect` or `esbuild` therefore need
a `pnpm build` commit before they can merge.

## Releases

Semver tags plus a moving major tag. Callers pin the major tag (`@v0`, later
`@v1`); a merge to `main` alone ships nothing to them.

```sh
git switch main && git pull
pnpm install --frozen-lockfile && pnpm build:check   # dist/ is up to date
git tag -a v0.1.0 -m "v0.1.0"
git tag -f -a v0 -m "v0 → v0.1.0"
git push origin v0.1.0
git push -f origin v0
gh release create v0.1.0 --generate-notes
```

A breaking change to the inputs, outputs or behaviour bumps the major version
and starts a new major tag; the previous one stays where it was.
