---
name: implement-issue
description: Take a GitHub issue of coremantle/dokploy-deploy (number or URL), check the issue is sound and feasible, implement it, verify it with local checks and tests, review it locally, have the user validate it, then open the PR, merge it and release it once the user agrees.
argument-hint: <issue-number | issue-url>
disable-model-invocation: true
---

# Implement a dokploy-deploy issue end to end

Issue: **$ARGUMENTS** on `coremantle/dokploy-deploy` (GitHub, `gh` CLI).

Talk to the user in the language they use; everything written into the
repository (code, comments, commits, PR, GitHub comments) is in English.

Work through the phases **in order**. Phase 1 is a gate: if it finds a
problem, stop and report — never start on a doubtful issue.

## What this repository is — and why it matters here

dokploy-deploy is a **Forgejo/GitHub action**: an application's own CI calls
it to deploy itself to Dokploy (env references, domains, deploy) with a
**project-scoped API key**. Two consequences drive the rules below:

- its **inputs, outputs and behaviour are a public API**: every consumer
  workflow pinned to `@main` or to a moving major tag (`@v1`) picks up a
  change as soon as it is merged or the tag moves. A merge or a release
  **is a deployment** to every consumer;
- running it for real **writes to a live Dokploy instance** (env, domains,
  deployments). Tests run against a mock or a fake server, never against a
  real instance without the user's OK.

Invoking this command authorises, after a clean phase 1:

- creating a branch and editing files in it;
- the **local** checks of phase 3: build, lint, type check, unit and
  integration tests against a mocked Dokploy API, `actionlint`, read-only
  `GET`s on a Dokploy API when the user has provided a key for it;
- running the local `code-review` skill.

It does **not** authorise — each needs the user's explicit OK, asked at the
phase that needs it:

- any call that writes to a Dokploy instance (create/update env, domains,
  trigger a deploy), including an end-to-end run of the action;
- **committing** (only once the user has tested and validated);
- pushing, opening the PR, merging, creating a tag or a release, moving a
  major tag.

Never, whatever the user says in passing: write a real API key or token in
the repository, print a secret in logs or output (mask it with
`::add-mask::`), push to test, or run an interactive command on the user's
behalf (a login, a password prompt) — give them the command instead.

**Attribution**: end commit messages and the PR body with the attribution
lines the harness gives for this session, if it gives any; add none
otherwise.

## Phase 0 — Input

- `$ARGUMENTS` is an issue number (`12`, `#12`) or an issue URL of this
  repository (`https://github.com/coremantle/dokploy-deploy/issues/12`):
  take the number. Anything else — a pull request URL, another repository,
  several issues, nothing — stop and ask for it.

## Phase 1 — Analyse and check feasibility

1. Read the issue, its comments, and what it depends on:

   ```sh
   gh issue view <n> -R coremantle/dokploy-deploy --comments
   gh pr list -R coremantle/dokploy-deploy --state open   # an open PR may already cover it
   ```

   Dependencies are written in the body (`Depends on #NN`, or an issue of
   another tracker such as `coremantle/babel` or a Forgejo repository):
   check each one is closed **and** its work merged.

2. Read what the task needs: `CLAUDE.md` and `README.md` (conventions, the
   documented inputs/outputs), `action.yml`, the source and tests the change
   reaches, and the Dokploy API endpoints involved (their request/response
   shape and the permissions a project-scoped key has).
3. **Verify every claim of the issue against the repository** — inputs,
   outputs, files, functions it names exist and behave as described on
   `origin/main` — and, when it is about Dokploy's behaviour, against the
   Dokploy API documentation or source, or read-only `GET`s.
4. Look for blockers. Any of these is a **problem**:
   - the issue is closed, already done, or covered by an open PR;
   - a dependency is still open or not merged;
   - the description contradicts the repository or Dokploy's API, or the
     acceptance criteria are missing, ambiguous or untestable;
   - the change **breaks the public interface** (renames or removes an
     input/output, changes a default, changes behaviour consumers rely on)
     without the issue planning a major version;
   - it relies on a feature only one of GitHub Actions or Forgejo Actions
     supports, without a fallback;
   - it needs a permission a project-scoped key does not have, or an admin
     key;
   - it needs something only the user can do or decide: a Dokploy instance
     or key to test against, a secret in the repository settings, a release
     strategy;
   - it is too large for one reviewable PR — propose a split (one concern
     each);
   - a change whose effect on a live Dokploy instance you cannot verify
     safely.

5. **If there is a problem**: stop. Report what you found, why it blocks, and
   the options with a recommendation. When the decision is the user's, ask
   them — through `AskUserQuestion` when it is available. Do not branch, edit
   or comment on GitHub.
6. **If all is good**: state in a few lines your understanding, the planned
   change, the files involved, the checks you will run, and what the user
   will have to test in phase 5 — then continue without waiting.

## Phase 2 — Implement

1. Start clean from an up-to-date `main`, on a branch
   `<type>/<n>-<short-slug>` (`feat/12-domains`):

   ```sh
   git status --porcelain       # must be empty
   git fetch origin
   git switch -c <type>/<n>-<slug> origin/main
   ```

   If the issue builds on an unmerged branch, branch from it instead, open
   the PR with `--base <parent>`, and say so.

2. Implement following `CLAUDE.md` and these rules:
   - **idempotent**: running the action twice with the same inputs leaves
     Dokploy in the same state and reports no change the second time
     (update in place, never duplicate env entries or domains);
   - **least privilege**: only the calls a project-scoped key is allowed to
     make, only on the project it targets;
   - **no secret leaks**: mask every secret input and every value read
     back from Dokploy that may be sensitive; never log request bodies
     carrying env values;
   - **fail loudly**: a Dokploy API error fails the step with a clear
     message (endpoint, status, Dokploy's error), no silent retries that
     hide it;
   - **portable**: works on GitHub and Forgejo runners;
   - a new or changed input/output is declared in `action.yml` and
     documented in `README.md` in the same change, with its default;
   - when the action ships a built bundle (e.g. `dist/`), rebuild it and
     commit it with the source.
3. Add or update tests for the new behaviour, with the Dokploy API mocked —
   including the error paths and the second (idempotent) run.
4. Update the docs the change makes stale: `README.md` (usage examples,
   inputs/outputs), `CLAUDE.md`, `CHANGELOG.md` if there is one.

## Phase 3 — Local checks

All must pass before going further; none of them touches a live instance.

- the project's own install, build, lint, type check and test commands (as
  documented in `README.md` / `CLAUDE.md` or the package manifest);
- `actionlint` on the workflows touched; `action.yml` still valid;
- the built bundle, if any, is up to date with the source (rebuild, then
  `git diff --exit-code` on it);
- when the user provided a Dokploy key for it: read-only `GET`s to confirm
  the API shape the change relies on.

Read the output, do not just look at the exit code. When a check cannot run
(missing tool, missing key), report it, do not work around it.

## Phase 4 — Local code review

1. Run the `code-review` skill on the branch diff (level `high`; never `max`
   or `ultra` unless the user asks).
2. Fix the significant findings, re-run **the checks** (phase 3), and re-run
   the review if the fixes changed behaviour. Note the findings you
   deliberately leave, with the reason, for the PR description.

## Phase 5 — Validation by the user (gate)

Nothing is committed yet. Present to the user:

- the **diff** (`git diff origin/main`), summarised, with the files;
- the result of the phase 3 checks and of the review;
- the **interface impact**: inputs/outputs added, changed or removed, and
  whether it is a patch, minor or **major** change for consumers;
- the **end-to-end test plan**: a workflow (or a local run) that calls the
  action against a test Dokploy project, the secrets it needs, what it
  should change in Dokploy, how to verify it, and how to undo it;
- the **idempotence check**: the same run a second time must report no
  change.

Then ask whether the user runs the end-to-end test themselves or lets you run
the non-interactive commands of the plan. Write nothing to a Dokploy instance
without that answer.

Wait for the user's **explicit validation**. A failure sends you back to
phase 2.

## Phase 6 — Commit, pull request, merge, release

1. Commit in Conventional Commits, `type(scope): imperative summary` — the
   scope is the area touched (`feat(domains): …`, `fix(env): …`,
   `docs(readme): …`); a breaking change carries `!` and a
   `BREAKING CHANGE:` footer — one concern per commit.
2. Push and open the PR:

   ```sh
   git push -u origin HEAD
   gh pr create -R coremantle/dokploy-deploy --base main --title "<type>(<scope>): <summary>" --body-file <file>
   ```

   The body has these sections:
   - `## Why` — the problem, with `Closes #<n>`;
   - `## What` — the change, and the interface impact (inputs/outputs);
   - `## Verification` — checks, tests, review (findings left and why), the
     user's end-to-end validation and the idempotence result;
   - `## Compatibility` — patch / minor / major, and what consumers must
     change, if anything;
   - `## Rollback` — how to undo it (revert, move the major tag back);
   - `## Release` — **what the merge and the release ship to consumers**:
     who picks it up (`@main`, `@v<major>`), and the tag planned.

3. **Merging is a deployment to consumers**: ask the user before merging,
   recalling the `## Release` section. On their OK:

   ```sh
   gh pr merge <pr> -R coremantle/dokploy-deploy --squash --delete-branch
   ```

   Creating a version tag, a GitHub release or moving the major tag
   (`v1`) is a separate step: propose the exact commands and run them only
   on the user's explicit OK.

4. Report to the user: PR link, what was implemented, the release state, and
   what the user still has to do (secrets, consumer updates for a major
   change).
