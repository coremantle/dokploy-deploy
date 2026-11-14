# dokploy-deploy

A Forgejo/GitHub action through which an application deploys **itself** to
[Dokploy](https://dokploy.com): after a green build, the application's CI
applies its own deployment — environment as secret references, domains, then
the deploy — with an API key scoped to its Dokploy project.

> **Status — `v1`.** `plan` diffs the [manifest](#manifest) against the
> compose in Dokploy and reports it (as a pull request comment on pull
> requests); `apply` [converges](#what-apply-writes) the environment block and
> the domains, then [deploys](#the-deploy) the compose and fails the job unless
> Dokploy deployed the job's commit. `v1` is the first tag that acts on
> Dokploy; `v0` stays on the read-only `v0.1.0`.

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
          api-url: ${{ vars.DOKPLOY_API_URL }} # e.g. https://dokploy.example.com/api
          api-key: ${{ secrets.DOKPLOY_API_KEY }}
          environment: production
          mode: plan

  deploy:
    if: github.ref == 'refs/heads/main'
    needs: ci
    runs-on: ubuntu-latest
    concurrency: deploy-production # one deploy at a time; a running one is never cancelled
    steps:
      - uses: actions/checkout@v7
      - id: deploy
        uses: https://github.com/coremantle/dokploy-deploy@v1
        with:
          api-url: ${{ vars.DOKPLOY_API_URL }}
          api-key: ${{ secrets.DOKPLOY_API_KEY }}
          environment: production
          mode: apply
      - run: echo "deployed ${{ steps.deploy.outputs.sha }} in ${{ steps.deploy.outputs.duration }} s"
```

`api-url` has no default: the action is not tied to one Dokploy. Keep it in a
repository (or organization) variable such as `DOKPLOY_API_URL`, next to the
`DOKPLOY_API_KEY` secret.

On GitHub, `uses: coremantle/dokploy-deploy@v1` works too; the full URL is
what Forgejo needs. Pin the **major tag** and let Renovate bump it. `@v0`
only plans, without the diff or the comment.

The action is **composite**: it runs `node` on a bundled entry point
(`dist/index.mjs`) committed with each release, so the calling job installs
nothing. The runner — or the job's container image — must provide **Node.js
20 or later**; the action fails with a clear message otherwise.

## Inputs

| Input            | Required | Default               | Description                                                                                                 |
| ---------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `api-url`        | yes      | —                     | Base URL of the Dokploy API, e.g. `https://dokploy.example.com/api`.                                        |
| `api-key`        | yes      | —                     | API key of a Dokploy member scoped to the project. Pass it from a secret.                                   |
| `manifest`       | no       | `deploy/dokploy.yml`  | Path of the deployment manifest, relative to the workspace.                                                 |
| `environment`    | no       | `production`          | Key of the manifest's `environments` to plan or deploy.                                                     |
| `mode`           | no       | `plan`                | `plan` reads Dokploy and reports the changes, writing nothing to Dokploy; `apply` makes them.               |
| `token`          | no       | `${{ github.token }}` | Token that comments the plan on the pull request. Masked in the log.                                        |
| `pr-comment`     | no       | `true`                | `true`: `plan` on a pull request posts its report as one comment, edited on each run. `false`: log it only. |
| `deploy`         | no       | `true`                | `true`: `apply` deploys the compose after writing the changes and waits for the result. `false`: no deploy. |
| `commit`         | no       | `${{ github.sha }}`   | Full sha the deployment must have deployed. Empty: deploy without the check (the `sha` output stays empty). |
| `deploy-timeout` | no       | `1800`                | Seconds to wait for the deployment to end once requested, Dokploy's queue included.                         |

Every input is trimmed, then validated before anything runs: a URL that is
not `https`, a blank key or one with spaces or line breaks inside, a manifest
path spanning several lines, an environment that is not a lowercase name, a
mode other than `plan` / `apply`, a `pr-comment` or `deploy` other than
`true` / `false`, a `commit` that is not a full 40- or 64-character sha, or a
`deploy-timeout` that is not a positive number of seconds fails the step.

## Outputs

Set by `apply` when it deploys (`deploy: true`), also when the deployment
fails, times out or can no longer be followed, so a later `if: failure()`
step can read them. Empty otherwise. An output file the step cannot write
only logs a warning: the step's result is the deployment's.

| Output          | Meaning                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment-id` | Id of the Dokploy deployment the action started. Empty if Dokploy never picked the request up before the timeout.                                     |
| `status`        | `done`, `error` or `cancelled` (Dokploy's final status); `running` or `queued` when the action timed out while the deployment ran or still waited.    |
| `sha`           | The deployed commit, **only when the action verified it equals `commit`**. Empty when the check is off, failed, or the deployment did not end `done`. |
| `duration`      | Seconds the deployment ran in Dokploy, from its start to its end (queue excluded). Empty while it has not ended.                                      |

### The plan comment

`plan` on a `pull_request` event comments its report on the pull request: the
environment keys added, changed or removed, the domains created, updated
or deleted, and the warnings (a Traefik router host the manifest does not
declare, see [Restricting HTTP methods](#restricting-http-methods)). One
comment per environment and Dokploy compose, found again by a hidden marker
at its start and edited in place on each push. It goes
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
# yaml-language-server: $schema=https://raw.githubusercontent.com/coremantle/dokploy-deploy/v1/manifest.schema.json
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

| Field                                  | Required | Default                      | Meaning                                                                                                                                                                     |
| -------------------------------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                              | yes      | —                            | Always `1`.                                                                                                                                                                 |
| `composeFile`                          | no       | `docker-compose.dokploy.yml` | Compose file, relative to the workspace: its services must hold the domains, and its `${VAR}` without a default must all be secret keys.                                    |
| `secrets.folder`                       | yes      | —                            | Infisical folder the references point to: `/<project>`, a folder under it, or `/shared` (see the reference guard).                                                          |
| `environments.<name>`                  | yes, ≥ 1 | —                            | One entry per environment; `<name>` is what the `environment` input selects.                                                                                                |
| `environments.<name>.dokploy`          | yes      | —                            | `project`, `environment` and `compose` **names**, resolved to ids through the API.                                                                                          |
| `environments.<name>.secrets.provider` | no       | see below                    | Dokploy vault provider that reads `secrets.folder` for this environment.                                                                                                    |
| `environments.<name>.domain`           | yes      | —                            | Parent domain: every host is `<subdomain>.<domain>`.                                                                                                                        |
| `domains[]`                            | yes, ≥ 1 | —                            | Shared by every environment.                                                                                                                                                |
| `domains[].service`                    | yes      | —                            | Compose service the domain routes to.                                                                                                                                       |
| `domains[].subdomain`                  | yes      | —                            | A single DNS label.                                                                                                                                                         |
| `domains[].port`                       | yes      | —                            | Container port, 1–65535.                                                                                                                                                    |
| `domains[].path`                       | no       | `/`                          | Path prefix.                                                                                                                                                                |
| `domains[].https`                      | no       | `true`                       | Serve the domain over HTTPS.                                                                                                                                                |
| `domains[].certificateType`            | no       | `letsencrypt`                | `letsencrypt`, `none` or `custom`.                                                                                                                                          |
| `domains[].allowedMethods`             | no       | —                            | HTTP methods the domain answers. Dokploy's domain API has no such setting: `plan` warns and `apply` refuses the manifest — use [Traefik labels](#restricting-http-methods). |

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
10. **Traefik label check** (a warning, never a failure), reported with the
    plan once every step above has passed: every host named in a `Host(...)`
    matcher of a `traefik.http.routers.<name>.rule` label of `composeFile` is
    a domain host of the manifest — see
    [Restricting HTTP methods](#restricting-http-methods).

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

1. refuses the manifest, before any write, if a domain sets `allowedMethods`
   (carry it as Traefik labels instead, see
   [Restricting HTTP methods](#restricting-http-methods));
2. saves the environment block with `compose.saveEnvironment` — only when it
   differs from the current env, which it then **replaces** entirely;
3. updates, with `domain.update`, the domains whose service, port, `https` or
   certificate type differ;
4. creates, with `domain.create`, the missing ones;
5. deletes, last, with `domain.delete`, every domain of the compose the
   manifest does not declare: **the application owns every domain of its
   compose**. A failed create thus never leaves a compose without its old
   route.

6. deploys the compose, unless `deploy: false` — see [the deploy](#the-deploy).

Settings the manifest does not express (internal path, strip path,
middlewares, custom certificate resolver) are left as they are on a domain
that is kept. The manifest cannot name a custom certificate resolver yet: a
`certificateType: custom` domain is created without one (Dokploy accepts it),
so set the resolver in Dokploy afterwards; `apply` keeps it.

Run twice with the same manifest, `apply` writes no env and no domain the
second time; it still deploys again (see below). The first Dokploy error
stops it and fails the step with the endpoint, the status and Dokploy's
message; the writes already made stay. Compose env and domains take effect on
the deploy that follows.

The key's member needs, on the compose: read access, `envVars: write`,
`domain: read`, `create` (Dokploy also checks it for `domain.update`) and
`delete`, and `deployment: create` and `read`. Create the key with
`rateLimitEnabled: false`: a deploy polls Dokploy every 5 seconds, far beyond
the default limit of a Dokploy API key (10 requests a day).

### Restricting HTTP methods

Dokploy domains match on host and path only, so `allowedMethods` cannot be
applied through its API. Carry the allow-list in the compose file instead, as
Traefik labels on the routed service: a router of higher priority than the
ones Dokploy generates answers **403** to every other method, through a
deny-all `ipAllowList` and Traefik's `noop@internal` service. One router per
entrypoint; on `web` it also takes precedence over Dokploy's redirect to
https. Leave `allowedMethods` out of the manifest.

```yaml
services:
  my-app-storage:
    labels:
      - traefik.enable=true
      - traefik.http.middlewares.my-app-deny.ipallowlist.sourcerange=127.0.0.1/32
      - traefik.http.routers.my-app-methods-websecure.rule=Host(`assets.example.com`) && !(Method(`GET`) || Method(`HEAD`))
      - traefik.http.routers.my-app-methods-websecure.priority=100000
      - traefik.http.routers.my-app-methods-websecure.entrypoints=websecure
      - traefik.http.routers.my-app-methods-websecure.tls.certresolver=letsencrypt
      - traefik.http.routers.my-app-methods-websecure.middlewares=my-app-deny
      - traefik.http.routers.my-app-methods-websecure.service=noop@internal
      - traefik.http.routers.my-app-methods-web.rule=Host(`assets.example.com`) && !(Method(`GET`) || Method(`HEAD`))
      - traefik.http.routers.my-app-methods-web.priority=100000
      - traefik.http.routers.my-app-methods-web.entrypoints=web
      - traefik.http.routers.my-app-methods-web.middlewares=my-app-deny
      - traefik.http.routers.my-app-methods-web.service=noop@internal
```

Router and middleware names must be unique across the Traefik instance, and
the entrypoint and certificate resolver names must match Dokploy's Traefik
(`web`, `websecure`, `letsencrypt` by default). Add `&& PathPrefix(...)` to the
rules to restrict a path only. The labels live in the compose, not in the env
or the domains: `plan` shows no change for them, and the next deploy makes
them live.

The host is thus written twice, in the labels and in the manifest, and a host
renamed in one place only leaves the restriction on a host nothing routes to
any more. `plan` and `apply` read every `traefik.http.routers.<name>.rule`
label of `composeFile`'s services, under `labels` or `deploy.labels`, in the
list (`- key=value`) or the map syntax; they take each host of its `Host(...)`
matchers (`HostHeader(...)` too; backtick- or double-quoted, several per rule
or per matcher), and **warn** — in the job log and in the plan comment — for
each host that is a domain (`<subdomain>.<domain>`) of no environment of the
manifest, naming the router and the service. A host of another environment
is not reported: a compose shared by several environments can only name one
of them unless the host comes from a `${VAR}`. The step does not fail on it.
Labels of other routers, rules without a `Host(...)`, a `Host(...)` directly
negated (`!Host(...)`), `HostRegexp(...)` and hosts built from a `${VAR}` are
not checked; neither is the path. A `Host(...)` inside a negated group
(`!(Host(...) || ...)`) is still read as a routed host.

### The deploy

After the writes, `apply` deploys the compose and waits for the result; the
job is green only when Dokploy deployed **the job's commit**:

1. it lists the compose's deployments (`deployment.allByCompose`), then asks
   for a deploy (`compose.deploy`);
2. it polls the deployments every 5 seconds: its deployment is the first one
   that was not there before the request. Dokploy runs deployments **one at
   a time for the whole instance**, so it may wait minutes in the queue
   behind other projects' deploys — `deploy-timeout` (30 minutes by default)
   covers the queue and the build; a poll that fails on a network error, a
   timeout, a 429 or a 5xx is retried up to 3 times; any other Dokploy error
   fails the step, still reporting the deployment last seen;
3. on `error`, `cancelled` (or any other final status a later Dokploy may
   add), it fails the step with the last 50 lines of the deployment log
   (`deployment.readLogs`), each prefixed with `| ` — Dokploy leaves
   `errorMessage` empty, the cause is only there, e.g.
   `Infisical: secret "X" not found at "/my-app" in environment "prod"`;
4. on `done`, it reads the commit Dokploy recorded for the deployment (the
   deployment's `Commit: <sha>`, which Dokploy writes a moment after marking
   it done — the action waits up to 30 seconds for it) and fails the step
   unless it equals the `commit` input. This catches a compose whose branch
   moved on (a newer push), points at another branch, or clones a source
   lagging behind. Dokploy only records a commit for a **git-based** compose
   (Git, GitHub, GitLab, Bitbucket, Gitea sources): for a raw compose, set
   `commit: ''` — the step then reports no `sha`, never one it did not check.

On timeout the step fails but the deployment goes on in Dokploy: the action
cannot cancel it. The commit read after `done` and the requests themselves
come on top of `deploy-timeout` (about a minute at most).

Running `apply` again deploys again, even when nothing changed: re-running
the latest job redeploys the same commit, which is how a secret rotated in
Infisical reaches the running service (Dokploy resolves the references at
each deploy). **Dokploy always deploys the head of the compose's branch**, it
cannot pin a commit: re-running an _older_ job after the branch moved writes
that job's env and domains, deploys the newer head, then fails on the commit
check — re-run the latest job instead, or guard the job with a check that its
commit is still the branch head.

Give the job a `concurrency` group per environment, never cancelled, so two
deploys of the same compose do not overlap: the action tells its deployment
apart from one started before its request, not from one requested at the
same time (the commit check still catches one that deployed another commit).
Keep the compose's auto-deploy off (babel's `owner: app` does), so nothing
else starts deployments behind the job's back. A request left in the queue by a job that
timed out still runs later, and the next job may take it for its own — the
commit check then decides, as it compares what was actually deployed.

`commit` defaults to `github.sha`, the pushed commit on a `push`. On a
`pull_request` event that is a merge commit Dokploy never deploys: pass
`commit: ${{ github.event.pull_request.head.sha }}` there.

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
- **A failed deploy prints the end of its log.** The last 50 lines of the
  Dokploy deployment log go to the job log, as Dokploy shows them to anyone
  who can read the compose's deployments: Dokploy's own lines name missing
  keys, never values, but what the compose's build prints is up to the
  application — do not print secrets there.
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
git tag -a v1.0.0 -m "v1.0.0"
git tag -f -a v1 -m "v1 → v1.0.0"
git push origin v1.0.0
git push -f origin v1
gh release create v1.0.0 --generate-notes
```

A breaking change to the inputs, outputs or behaviour bumps the major version
and starts a new major tag; the previous one stays where it was.

### Trying `plan` and `apply` without a Dokploy

CI's `smoke` job plans `.github/smoke/dokploy.yml`, applies it twice and
checks that each `apply` deploys the job's commit and that the second one
writes nothing else, against `.github/smoke/fake-dokploy.mjs`: a fake Dokploy
over https with a throwaway certificate, which answers the reads, keeps the
writes in memory and runs a deployment in two seconds (its last argument is
the commit it records). The same
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
