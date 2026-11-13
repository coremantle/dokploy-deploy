# dokploy-deploy

A Forgejo/GitHub action through which an application deploys **itself** to
[Dokploy](https://dokploy.com): after a green build, the application's CI
applies its own deployment — environment as secret references, domains, then
the deploy — with an API key scoped to its Dokploy project.

> **Status — before `v1`.** On `main`, `plan` diffs the [manifest](#manifest)
> against the compose in Dokploy and reports it (as a pull request comment on
> pull requests), and `apply` [converges](#what-apply-writes) the environment
> block and the domains. The deploy itself arrives in a later release. The
> `v0` tag is still the read-only `v0.1.0`, where `apply` fails without
> touching Dokploy; `v1` is the first tag that acts on Dokploy.

## Usage

```yaml
jobs:
  plan:
    if: github.event_name == 'pull_request'
    needs: ci
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # the plan comment
    steps:
      - uses: actions/checkout@v7
      - uses: https://github.com/coremantle/dokploy-deploy@v1
        with:
          api-url: https://dokploy.example.com/api
          api-key: ${{ secrets.DOKPLOY_API_KEY }}
          environment: production
          mode: plan

  deploy:
    if: github.ref == 'refs/heads/main'
    needs: ci
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: https://github.com/coremantle/dokploy-deploy@v1
        with:
          api-url: https://dokploy.example.com/api
          api-key: ${{ secrets.DOKPLOY_API_KEY }}
          environment: production
          mode: apply
```

On GitHub, `uses: coremantle/dokploy-deploy@v1` works too; the full URL is
what Forgejo needs. Pin the **major tag** and let Renovate bump it. Until `v1`
is tagged, `@v0` only plans, without the diff or the comment.

The action is **composite**: it runs `node` on a bundled entry point
(`dist/index.mjs`) committed with each release, so the calling job installs
nothing. The runner — or the job's container image — must provide **Node.js
20 or later**; the action fails with a clear message otherwise.

## Inputs

| Input         | Required | Default               | Description                                                                                                 |
| ------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `api-url`     | yes      | —                     | Base URL of the Dokploy API, e.g. `https://dokploy.example.com/api`.                                        |
| `api-key`     | yes      | —                     | API key of a Dokploy member scoped to the project. Pass it from a secret.                                   |
| `manifest`    | no       | `deploy/dokploy.yml`  | Path of the deployment manifest, relative to the workspace.                                                 |
| `environment` | no       | `production`          | Key of the manifest's `environments` to plan or deploy.                                                     |
| `mode`        | no       | `plan`                | `plan` reads Dokploy and reports the changes, writing nothing to Dokploy; `apply` makes them.               |
| `token`       | no       | `${{ github.token }}` | Token that comments the plan on the pull request. Masked in the log.                                        |
| `pr-comment`  | no       | `true`                | `true`: `plan` on a pull request posts its report as one comment, edited on each run. `false`: log it only. |

Every input is trimmed, then validated before anything runs: a URL that is
not `https`, a blank key or one with spaces or line breaks inside, a manifest
path spanning several lines, an environment that is not a lowercase name, a
mode other than `plan` / `apply`, or a `pr-comment` other than `true` /
`false` fails the step.

### The plan comment

`plan` on a `pull_request` event comments its report on the pull request: the
environment keys added, changed or removed, and the domains created, updated
or deleted. One comment per environment and Dokploy compose, found again by
a hidden marker at its start and edited in place on each push. It goes
through the forge's issue comment API, the same on GitHub and Forgejo, with
the `token` input:

- **GitHub**: give the job `permissions: pull-requests: write`. Pull requests
  from forks get a read-only token (and no Dokploy secret): set
  `pr-comment: false`, or do not run the plan on them.
- **Forgejo**: the job's automatic token can comment on pull requests of its
  own repository.

A comment that cannot be posted fails the step, with the forge's answer. The
token is only ever sent to an `https` forge API: on a forge served over plain
`http`, set `pr-comment: false` (`apply` is not affected).

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
| `domains[].allowedMethods`             | no       | —                            | HTTP methods the domain answers. Dokploy's domain API has no such setting: `plan` warns and `apply` refuses the manifest.                |

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
9. **Diff**: the block is compared with the compose's current env
   (`compose.one`), and the manifest domains with the
   compose's domains (`domain.byComposeId`), matched by host and path.

The block only holds references, never a value, so `plan` prints it. It is
always single-quoted: Dokploy substitutes the value before parsing the block,
so a secret whose value holds a `'` or ends with a `\` would be altered —
keep such characters out of secrets read by references. The action never sees
the values, so it cannot detect them.

The env **in Dokploy**, on the other hand, may still hold values typed by hand
before the application moved to references: the diff only ever reports key
names (added, changed, removed), never a current value.

### What `apply` writes

`apply` runs the same checks and diff as `plan`, then:

1. refuses the manifest, before any write, if a domain sets `allowedMethods`;
2. saves the environment block with `compose.saveEnvironment` — only when it
   differs from the current env, which it then **replaces** entirely;
3. updates, with `domain.update`, the domains whose service, port, `https` or
   certificate type differ;
4. creates, with `domain.create`, the missing ones;
5. deletes, last, with `domain.delete`, every domain of the compose the
   manifest does not declare: **the application owns every domain of its
   compose**. A failed create thus never leaves a compose without its old
   route.

Settings the manifest does not express (internal path, strip path,
middlewares, custom certificate resolver) are left as they are on a domain
that is kept. The manifest cannot name a custom certificate resolver yet: a
`certificateType: custom` domain is created without one (Dokploy accepts it),
so set the resolver in Dokploy afterwards; `apply` keeps it.

Run twice with the same manifest, `apply` writes nothing the second time. The
first Dokploy error stops it and fails the step with the endpoint, the status
and Dokploy's message; the writes already made stay. Compose env and domains
take effect on the compose's next deploy.

The key's member needs, on the compose: read access, `envVars: write`, and
`domain: read`, `create` (Dokploy also checks it for `domain.update`) and
`delete`.

## Threat model

- **The key is project-scoped.** It belongs to a Dokploy _member_ whose access
  is limited to the application's project, environments and services. Dokploy
  itself refuses the key anywhere else; the action never needs an admin key.
- **The CI never holds a secret value.** The environment it writes into
  Dokploy is made of references (`${{vault…}}`) that Dokploy resolves at
  deploy time; the key and the forge token are the only secrets the job
  sees, and the action masks both in the log before doing anything else. The
  env it reads back from Dokploy may hold values: only its key names are
  logged or commented.
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

### Trying `plan` and `apply` without a Dokploy

CI's `smoke` job plans `.github/smoke/dokploy.yml`, applies it twice and
checks that the second `apply` writes nothing, against
`.github/smoke/fake-dokploy.mjs`: a fake Dokploy over https with a throwaway
certificate, which answers the reads and keeps the writes in memory. The same
works locally (switch `DOKPLOY_DEPLOY_MODE` to `apply`):

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
