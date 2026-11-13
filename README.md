# dokploy-deploy

A Forgejo/GitHub action through which an application deploys **itself** to
[Dokploy](https://dokploy.com): after a green build, the application's CI
applies its own deployment — environment as secret references, domains, then
the deploy — with an API key scoped to its Dokploy project.

> **Status — `v0`, read-only.** `plan` reads the [manifest](#manifest),
> resolves its Dokploy names, lists the secret keys through Dokploy and
> reports the environment block and the domains it would write; it changes
> nothing. `apply` fails without touching Dokploy, so no pipeline can pass for
> a deploy. The diff against Dokploy, `apply` and the deploy arrive in the next
> releases; `v1` is the first one that acts on Dokploy.

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
          environment: production
          mode: plan
```

On GitHub, `uses: coremantle/dokploy-deploy@v0` works too; the full URL is
what Forgejo needs. Pin the **major tag** and let Renovate bump it.

The action is **composite**: it runs `node` on a bundled entry point
(`dist/index.mjs`) committed with each release, so the calling job installs
nothing. The runner — or the job's container image — must provide **Node.js
20 or later**; the action fails with a clear message otherwise.

## Inputs

| Input         | Required | Default              | Description                                                                                       |
| ------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `api-url`     | yes      | —                    | Base URL of the Dokploy API, e.g. `https://dokploy.example.com/api`.                              |
| `api-key`     | yes      | —                    | API key of a Dokploy member scoped to the project. Pass it from a secret.                         |
| `manifest`    | no       | `deploy/dokploy.yml` | Path of the deployment manifest, relative to the workspace.                                       |
| `environment` | no       | `production`         | Key of the manifest's `environments` to plan or deploy.                                           |
| `mode`        | no       | `plan`               | `plan` reads Dokploy and reports the changes; `apply` makes them (see the status above for `v0`). |

Every input is trimmed, then validated before anything runs: a URL that is
not `https`, a blank key or one with spaces or line breaks inside, a manifest
path spanning several lines, an environment that is not a lowercase name, or a
mode other than `plan` / `apply` fails the step.

## Manifest

The application describes its deployment in `deploy/dokploy.yml` (the
`manifest` input). Its JSON Schema is published at the root of this
repository; point your editor at the major tag you pin:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/coremantle/dokploy-deploy/v0/manifest.schema.json
version: 1
composeFile: docker-compose.dokploy.yml

secrets:
  folder: /my-app

environments:
  production:
    dokploy:
      project: my-app
      environment: production
      compose: my-app
    domain: my-app.example.com

domains:
  - service: my-app-web
    subdomain: app
    port: 3000
  - service: my-app-api
    subdomain: api
    port: 4000
```

| Field                                  | Required | Default                      | Meaning                                                                                                                                  |
| -------------------------------------- | -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                              | yes      | —                            | Always `1`.                                                                                                                              |
| `composeFile`                          | no       | `docker-compose.dokploy.yml` | Compose file, relative to the workspace: its services must hold the domains, and its `${VAR}` without a default must all be secret keys. |
| `secrets.folder`                       | yes      | —                            | Infisical folder the references point to: `/<project>`, a folder under it, or `/shared` (see the reference guard).                       |
| `environments.<name>`                  | yes, ≥ 1 | —                            | One entry per environment; `<name>` is what the `environment` input selects.                                                             |
| `environments.<name>.dokploy`          | yes      | —                            | `project`, `environment` and `compose` **names**, resolved to ids through the API.                                                       |
| `environments.<name>.secrets.provider` | no       | see below                    | Dokploy vault provider that reads `secrets.folder` for this environment.                                                                 |
| `environments.<name>.domain`           | yes      | —                            | Parent domain: every host is `<subdomain>.<domain>`.                                                                                     |
| `domains[]`                            | yes, ≥ 1 | —                            | Shared by every environment.                                                                                                             |
| `domains[].service`                    | yes      | —                            | Compose service the domain routes to.                                                                                                    |
| `domains[].subdomain`                  | yes      | —                            | A single DNS label.                                                                                                                      |
| `domains[].port`                       | yes      | —                            | Container port, 1–65535.                                                                                                                 |
| `domains[].path`                       | no       | `/`                          | Path prefix.                                                                                                                             |
| `domains[].https`                      | no       | `true`                       | Serve the domain over HTTPS.                                                                                                             |
| `domains[].certificateType`            | no       | `letsencrypt`                | `letsencrypt`, `none` or `custom`.                                                                                                       |
| `domains[].allowedMethods`             | no       | —                            | HTTP methods the domain answers. Decoded and reported only: how it is applied is decided with `apply`.                                   |

Unknown keys are rejected: a typo fails `plan` instead of being ignored. The
default provider is the one babel creates when onboarding the project:
`infisical-<project>`, plus `-<environment>` unless the Dokploy environment is
named exactly `production`, both as lowercase slugs of the Dokploy names (64
characters at most).

### What `plan` checks and renders

1. The manifest decodes and declares the requested `environment`.
2. **Reference guard**: `secrets.folder` is `/<project slug>`, a folder under
   it, or `/shared`, before any call to Dokploy.
3. Every domain routes to a service of `composeFile`, and no host and path is
   declared twice.
4. The project, environment and compose names each match exactly one item the
   key sees (`project.all`).
5. The provider is visible to the key, is an Infisical provider, and reads
   exactly `secrets.folder` (`vaultProvider.all`).
6. The folder's keys, imports included, are listed with
   `vaultProvider.listSecretNames`: no Infisical credential is needed.
7. **Compose check**: every `${VAR}` of `composeFile` without a default
   (`$VAR`, `${VAR}`, `${VAR:?…}`, `${VAR?…}`) is one of those keys — a
   reference to a missing key fails the Dokploy deploy.
8. The environment block is rendered, one line per key, sorted:
   `KEY='${{vault.<provider>.<folder>:KEY}}'`. Key names are limited to
   letters, digits, `_`, `.` and `-`.

The block only holds references, never a value, so `plan` prints it. It is
always single-quoted: Dokploy substitutes the value before parsing the block,
so a secret whose value holds a `'` or ends with a `\` would be altered —
keep such characters out of secrets read by references. The action never sees
the values, so it cannot detect them.

## Threat model

- **The key is project-scoped.** It belongs to a Dokploy _member_ whose access
  is limited to the application's project, environments and services. Dokploy
  itself refuses the key anywhere else; the action never needs an admin key.
- **The CI never holds a secret value.** The environment it writes into
  Dokploy is made of references (`${{vault…}}`) that Dokploy resolves at
  deploy time; the key is the only secret the job sees, and the action masks
  it in the log before doing anything else.
- **Reference guard — accident protection, not a barrier.** The action only
  renders references under `/<project>` (the slug of the Dokploy project
  name) and `/shared`. Dokploy's providers do not confine references to a
  folder, so this guard stops a typo or a copy-paste from pointing an
  application at another one's secrets. It does
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
pnpm build         # esbuild → dist/index.mjs, then manifest.schema.json
```

**Any change to `src/` or to a runtime dependency is committed together with
the rebuilt `dist/` and `manifest.schema.json`.** CI rebuilds both and fails
when they differ from the committed ones. Renovate PRs that bump `effect` or `esbuild` therefore need
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

### Trying `plan` without a Dokploy

CI's `smoke` job plans `.github/smoke/dokploy.yml` against
`.github/smoke/fake-dokploy.mjs`, a fake Dokploy answering the three read
calls over https with a throwaway certificate. The same works locally:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout /tmp/fake.key -out /tmp/fake.crt
node .github/smoke/fake-dokploy.mjs /tmp/fake.crt /tmp/fake.key 8443 &
NODE_EXTRA_CA_CERTS=/tmp/fake.crt \
DOKPLOY_DEPLOY_API_URL=https://localhost:8443/api \
DOKPLOY_DEPLOY_API_KEY=smoke-test-key-not-a-secret \
DOKPLOY_DEPLOY_MANIFEST=.github/smoke/dokploy.yml \
DOKPLOY_DEPLOY_ENVIRONMENT=production DOKPLOY_DEPLOY_MODE=plan \
node dist/index.mjs
```
