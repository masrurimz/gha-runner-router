# gha-runner-router

A JavaScript GitHub Action (`runs.using: node24`) that picks a job's `runs-on` per run from an ordered list of pools. A `local` pool is a self-hosted box: it is available when the router job itself runs on that host, the count of busy `Runner.Worker` processes found in `/proc` is below `slots`, and `MemAvailable` is at least `min-available-mb`. A `metered` pool is a free-tier vendor or GitHub-hosted size: it is available while month-to-date minutes times `minute-multiplier` stay below `quota-reserve` times `free-minutes`. The first available pool wins. When none is, the `fallback` pool wins and the job queues there. Outputs are `runs-on` (JSON array for `fromJSON`), `pool`, `workers` and `reason`.

## Effect

This repo uses Effect 4 with the same stack as `omp-org-account-router` and `omp-agent-mesh`. Before writing Effect code, read `node_modules/effect/AGENTS.md` completely, and grep `node_modules/effect/src` for any API name it does not show. HTTP lives under `effect/http` (`HttpClient`, `HttpClientRequest`, `HttpClientResponse`, `FetchHttpClient`).

Architecture rules:

- Failures are `Schema.TaggedError` classes, one per file in `src/domain/`: `InputInvalid` (bad `pools`, `quota-reserve` or `fallback`, fails the step), `GithubFailed` and `LedgerFailed` (usage accounting, degrade the decision). Each carries context and a `RUNNER_ROUTER_*` fix-hint message. `Option` is only for a value that is legitimately absent (no stored ledger, no `host` pin, a run that returned 404).
- Pure rules stay plain functions in `src/domain/`: `judgeLocal`, `judgeMetered`, `decide`, `usageNeeded` in `decision.ts`; `jobMinutes`, `selectRuns`, `settle`, `ledgerFor` in `ledger.ts`; `buildRouting` and the strict `decodePools` in `routing.ts`. They take the host facts and the usage map as arguments and read nothing.
- Services are `Context.Service` classes whose `make` captures dependencies, plus `static layer` and a `static fake` for tests. `GithubApi` owns every REST call. `LedgerStore` owns the artifact SDK. `Host` owns `/proc`. `usage.ts` composes the first two into `refreshUsage`. `router.ts` composes `Host` and `refreshUsage` into `route`. `main.ts` is the only place that reads the action inputs (`INPUT_*` environment variables) and writes `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY`.
- Fail-safe rule: if usage cannot be read (API error, missing permission), metered pools count as unavailable with a warning, so the router never spends free-tier minutes it could not verify. A broken router must not block CI, so that case is a warning, not a failure. Invalid inputs are the only failure.
- No comments (enforced, see Fence). Knowledge goes in names, tests, or the commit message.

## Quota ledger design

The ledger is an incremental, derived cache of what the GitHub API already says. It is JSON in a workflow artifact named `gha-runner-router-ledger-YYYY-MM` (UTC month), 31 day retention.

1. Find the newest artifact with that exact name (`GET /actions/artifacts?name=`, 1 call) and download it (a few calls). No artifact means a fresh ledger for the month.
2. List runs created at or after the ledger checkpoint (`created=>=`, 1 call per 100 runs). Runs already settled at the checkpoint second are skipped by id.
3. For each new or still pending run: a completed run costs 1 `jobs` call (`filter=all`, so re-run attempts count); an open run goes into `pending` and costs 1 `GET /runs/{id}` per later router until it completes. Each job is rounded up to whole minutes (GitHub's billing rule) and added to `settled` under its sorted lowercase label set. A pool's usage is the `settled` entry for its own label set.
4. Save the new ledger as a new artifact (never overwrite).

Steady state is about 1 + 3 + new runs + pending runs calls, normally under 20.

Why artifacts and not the Actions cache: caches are scoped to the branch that saved them. A PR run can only restore caches from its own ref and the base branch, so a ledger saved from one PR is invisible to the next. Artifacts are listed and downloaded through the REST API with only `actions: read`, from any ref. Why not a variable or a file in the repo: both need a write permission the router does not otherwise have.

Correctness across concurrent routers needs no lock. The ledger is derived data: two routers that restore the same ledger both scan the same API truth and both compute the same totals, so the last saved artifact is as correct as any other. A lost save only costs the next router a bigger scan. The `settle` property test checks that two incremental passes equal one full scan, including runs created in the same second as the checkpoint and runs that finish between passes.

A workflow `concurrency` group is therefore only an optimization against duplicate scans, and a hazard: GitHub keeps one running and one pending job per group and cancels older pending jobs, so a burst would cancel router jobs and skip the downstream jobs. The README documents this. Two routers deciding on the same stale view can both take the last free slot or the last free minutes. The reserve and the `fallback` queue absorb that.

Known blind spots, all documented in the README: usage from other repositories in the same org is invisible to a repo-scoped token (the reserve exists for it); re-running a run after it settled is not recounted; the runs API returns at most 1000 results per filtered query, so a ledger bootstrapped mid-month on a very busy repo can undercount; minutes are attributed to the month the run was created.

## Local pool detection

`Host` reports `selfHosted` only when `RUNNER_ENVIRONMENT` is `self-hosted` and `/proc` is readable. Busy slots are the `Runner.Worker` processes found by `/proc/<pid>/comm`, minus one for the router job's own worker. An optional `host` on a local pool pins it to a machine hostname, so two local pools on different machines do not both claim a router job that landed on one of them. Run the router job on a dedicated runner label on the same host, or it queues when every slot is busy.

## Checks

Run one after another, never in parallel, and check `free -h` first:

```sh
bun run lint            # oxlint
bun run fmt             # oxfmt --check
bun run typecheck       # effect-tsrs diagnostics --strict
bun run typecheck:fast  # tsrs --noEmit
bun run test            # vitest run --maxWorkers=2
bun run dist:check      # dist/index.js matches a fresh bun build
```

`bun run check` runs all of them. After any change under `src/`, run `bun run build` and commit `dist/index.js`; the action runs the committed bundle and `dist:check` fails when it is stale. `bun run fmt:write` formats, and `oxlint --fix` fixes the spacing rule.

`typecheck:fast` calls `tsrs` directly instead of `bun check --no-script`. On Bun 1.4.3 `bun check` resolves to the package script named `check` and the `--no-script` flag does not exist, so the sibling repos' form recurses.

Tests assert behavior and properties, use `it.effect` and `it.prop`, and fake IO with `GithubApi.fake`, `LedgerStore.fake` and `Host.factsLayer`. The properties are: a metered pool is available exactly when used minutes are below the reserve limit and more usage never frees a full pool; incremental scans equal a full scan. Boundary tests cover exactly at the reserve, a UTC month rollover, all pools full going to the fallback, local slots full, low memory, and malformed pool input rejected with `InputInvalid`. When adding a property, plant a bug once to confirm it fails.

## Layout

- `src/domain/` schemas, the errors, and pure rules.
- `src/services/` the services, `usage.ts`, `router.ts`, `inputs.ts` (YAML text to `Routing`), `outputs.ts`.
- `src/main.ts` the action entrypoint, bundled to `dist/index.js` by `scripts/build.ts`.
- `.github/workflows/ci.yml` runs `bun run check`. `.github/workflows/proof.yml` runs the action from `./` and feeds a downstream job through `fromJSON`.

## Fence

Ported from rat-stack via `omp-org-account-router` (see `PROVENANCE.md`). `oxlint.config.ts` extends `ultracite/oxlint/core` (typeAware) with `no-comments`, `anti-slop/*`, `anti-slop-effect/*`, `xstate-effect/no-inline-effect`, `rat-stack-patterns/*` and `effect-tests/no-manual-effect-runtime-in-tests`, all at error. The Effect language-service severities in `tsconfig.json` are enforced by `effect-tsrs --strict`.

The baseline is zero violations and only shrinks. Fix code rather than disable a rule. A targeted `oxlint-disable` or `@effect-diagnostics` directive needs `-- reason` and a true boundary. The two in use are the `yaml.parse` return value (decoded with a Schema right after) and the promise-based Actions artifact SDK.

Skipped rat-stack rules, for surfaces this repo does not have:

- XState lifecycle machine and `xstate-effect/*` beyond the lint fence: one action run is a straight pipeline with no states, retries or cancellation to model.
- `src/contract/` tool contract and `define-tool`: the action registers no tool.
- Effect `Scope`, `Effect.forkScoped`, `SubscriptionRef`, `PubSub` and long-lived `Ref` state: the process lives for one run. `TestClock` is used only to pin the month.
- `.omp/extensions/vcs-policy.ts` and `scripts/vcs-command-policy.ts`: they block agent `git --no-verify` inside omp, and this repo has no omp extension.
- Foldkit and `rat-stack-boundaries/*`, `rat-stack-patterns/{contract-binding-matches-name,flag-removal-date,learn-snippet-idiom,no-shared-pending-cache,shared-waiters,watch-effect-actors}`, and the debt-ledger plugin: no browser, server, capability or cloud surface.
