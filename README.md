# gha-runner-router

Pick a job's `runs-on` per run. Use your own self-hosted box while it has a free slot. Overflow to free-tier pools in order. Never spend past a quota reserve.

```yaml
route:
  runs-on: [self-hosted, my-box-router]
  outputs:
    runs-on: ${{ steps.route.outputs.runs-on }}
    workers: ${{ steps.route.outputs.workers }}
  steps:
    - id: route
      uses: masrurimz/gha-runner-router@v1
      with:
        pools: |
          - {name: box, kind: local, runs-on: [self-hosted, my-box], workers: 8, slots: 4, min-available-mb: 15000}
          - {name: hosted, kind: metered, runs-on: ubuntu-latest, workers: 2, free-minutes: 2000}
test:
  needs: route
  runs-on: ${{ fromJSON(needs.route.outputs.runs-on) }}
```

## Why

**Queueing on a shared self-hosted box.** A box with four runner processes serves four jobs. A pull request that fans out into three jobs waits for three slots, and the wait is often longer than the work. If the box is also a dev machine, a full test run can push it into swap.

**Free-tier overflow.** CI vendors and GitHub itself give monthly free minutes. Those minutes are only useful if something sends jobs there when your box is full, and stops before the free allowance runs out so nothing is billed.

The router makes that choice per run, from live facts. It reads the box's busy runner workers and free memory, and it counts each metered pool's minutes this month from the GitHub API. It also tells the job how many test workers to start, so a job that lands on a small free runner does not start as many as one on a large box.

## How it decides

Pools are tried in the order you list them. The first available pool wins.

- A `local` pool is available when all three hold. The router job itself runs on that host. The number of busy `Runner.Worker` processes found in `/proc` (not counting the router job's own) is below `slots`. `MemAvailable` is at least `min-available-mb`.
- A `metered` pool is available while `month-to-date minutes × minute-multiplier < quota-reserve × free-minutes`. At exactly the reserve the pool counts as full.
- When no pool is available, the `fallback` pool wins and the job queues there. The fallback is normally the local pool.

The `reason` output says why, in one line:

```
github-hosted: unreachable-box skipped, the router job is not on its host; github-hosted under reserve (3/2000 min used, full at 1800)
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `pools` | yes |  | Ordered YAML list of pools. See below. |
| `quota-reserve` | no | `0.9` | A metered pool counts as full at `quota-reserve × free-minutes`. A number in (0, 1]. |
| `fallback` | no | first `local` pool, else first pool | Name of the pool used when every pool is full or busy. |
| `github-token` | no | `${{ github.token }}` | Token used to read this repository's workflow runs and jobs. Only `actions: read` is assumed. |

Pool fields:

| Field | Applies to | Description |
| --- | --- | --- |
| `name` | all | Unique pool name. Reported in the `pool` output. |
| `kind` | all | `local` or `metered`. |
| `runs-on` | all | A label string or a list of labels. Emitted as the `runs-on` output. For `metered` pools it is also how the router finds that pool's jobs, so use the labels exactly as your jobs use them (case and order do not matter). |
| `workers` | all | Test-worker budget to emit when this pool is chosen. Positive integer. |
| `slots` | `local` | Runner processes on this host. Positive integer. |
| `min-available-mb` | `local` | Smallest `MemAvailable` in MB that still counts as free. |
| `host` | `local`, optional | Machine hostname. The pool only matches a router job running on that machine. Use it when two local pools are on different machines. |
| `free-minutes` | `metered` | Free minutes per calendar month (UTC). Positive integer. |
| `minute-multiplier` | `metered`, optional | Minutes burned per minute of wall time, default `1`. Use `2` for a 4-vCPU size that burns twice. |

Unknown keys, a bad `kind`, a missing field, a non-positive budget, an empty label list, duplicate names, an unknown `fallback` and a `quota-reserve` outside (0, 1] fail the step with a `RUNNER_ROUTER_INPUT_INVALID` message that names the input.

## Outputs

| Output    | Description                                                   |
| --------- | ------------------------------------------------------------- |
| `runs-on` | The chosen labels as a JSON array, for `fromJSON`.            |
| `pool`    | Name of the chosen pool.                                      |
| `workers` | That pool's `workers` budget.                                 |
| `reason`  | One human-readable line with the verdict for each pool tried. |

The action also writes the decision to the step summary and prints it as `runner-router: <reason>` in the log.

## Full example

Four pools: a shared self-hosted box first, then two free-tier vendors, then GitHub-hosted runners. The Avrea and Blacksmith labels depend on the size you install, so the values below are placeholders. Replace each `REPLACE_WITH_...` with the label from that vendor's documentation.

```yaml
name: pr

on: pull_request

permissions:
  actions: read
  contents: read

jobs:
  route:
    runs-on: [self-hosted, x1-router]
    outputs:
      runs-on: ${{ steps.route.outputs.runs-on }}
      pool: ${{ steps.route.outputs.pool }}
      workers: ${{ steps.route.outputs.workers }}
      reason: ${{ steps.route.outputs.reason }}
    steps:
      - id: route
        uses: masrurimz/gha-runner-router@v1
        with:
          fallback: x1
          pools: |
            - name: x1
              kind: local
              runs-on: [self-hosted, x1-dev-zahid]
              workers: 8
              slots: 4
              min-available-mb: 15000
            - name: avrea
              kind: metered
              runs-on: [REPLACE_WITH_AVREA_LABEL_FROM_AVREA_DOCS]
              workers: 4
              free-minutes: 3000
            - name: blacksmith
              kind: metered
              runs-on: [REPLACE_WITH_BLACKSMITH_LABEL_FROM_BLACKSMITH_DOCS]
              workers: 4
              free-minutes: 3000
            - name: github-hosted
              kind: metered
              runs-on: ubuntu-latest
              workers: 2
              free-minutes: 2000

  check:
    needs: route
    runs-on: ${{ fromJSON(needs.route.outputs.runs-on) }}
    env:
      TEST_WORKERS: ${{ needs.route.outputs.workers }}
    steps:
      - uses: actions/checkout@v5
      - run: echo "${{ needs.route.outputs.reason }}"
      - run: npx vitest run --maxWorkers=$TEST_WORKERS
```

The same workflow is in [`examples/x1-vendors-hosted.yml`](examples/x1-vendors-hosted.yml). A hosted-only setup is in [`examples/hosted-only.yml`](examples/hosted-only.yml).

Things this example relies on:

- **A router runner on the box.** The `route` job runs on a runner on the same machine as the local pool, because that is how the router can read the box's runner processes. Give it its own label (`x1-router` here) and run it as an extra runner process that is not counted in `slots`. If the router job shared the pool's labels it would queue behind the very jobs it is trying to avoid. The router counts its own worker as busy and subtracts it.
- **Jobs on vendor runners need the vendor's app installed** on the repository or org. Nothing here sets that up.
- **`actions: read`** on the workflow or the route job. Without it the router cannot read usage, and metered pools are skipped with a warning.

## Quota accounting

The router counts minutes from this repository's workflow jobs. Each job is rounded up to a whole minute, which is GitHub's billing rule. A job is attributed to a metered pool when its `runs-on` labels equal the pool's labels. That also works for vendors whose minutes never show in GitHub billing, because the router counts by label and not by invoice.

Re-reading every job of the month on every run would cost thousands of API calls, so the router keeps an incremental ledger in a workflow artifact named `gha-runner-router-ledger-YYYY-MM`. Each run downloads the newest ledger, reads only runs created since its checkpoint, and uploads the updated ledger as a new artifact. In steady state that is about 20 API calls or fewer. The ledger is derived from the API on every pass, so concurrent routers cannot corrupt it. Why artifacts and not the Actions cache is explained in [AGENTS.md](AGENTS.md).

A ledger older than the retention (31 days) or deleted is rebuilt from the start of the month. On a busy repository that first rebuild costs roughly one call per run in the month.

If usage cannot be read, the router warns and treats metered pools as unavailable, so it goes to the local pool or the fallback and never spends minutes it could not count.

## Concurrency

Correctness does not need a lock. Two routers that start together both read the same API truth and agree on the totals. Two routers can both see the last free slot, or the last free minutes, and both take it. The `quota-reserve` and the queueing `fallback` absorb that.

You can serialize routers with a `concurrency` group to avoid duplicate scans:

```yaml
route:
  concurrency:
    group: gha-runner-router
    cancel-in-progress: false
```

Know the cost before you add it. GitHub allows one running and one pending job per group and cancels older pending jobs. In a burst of pull requests, router jobs get cancelled and their downstream jobs are skipped. Add the group only when router jobs are rare enough that two are never pending at once, and leave it off otherwise.

## Limitations

- **Other repositories are invisible.** A repository-scoped token only sees this repository's runs. Minutes that other repositories in the same org spend on the same free allowance do not appear in the count. This is what `quota-reserve` is for: set it below `1` to leave headroom, and lower it if several repositories share a pool.
- **Local detection needs Linux and a self-hosted runner.** The router reads `/proc` to count `Runner.Worker` processes. On a hosted runner, or a platform without `/proc`, a `local` pool is skipped.
- **The router job must run on the pool's host.** It cannot see another machine. If every runner on the box is busy, the router job queues like any other job. A dedicated router runner avoids that.
- **Rerun attempts after settling are not recounted.** A run is settled once it completes. Re-running its jobs later adds minutes the ledger does not see.
- **Minutes are attributed to the month the run was created.** A run that spans midnight UTC on the last day of a month counts in the earlier month.
- **At most 1000 runs per query.** The runs API caps filtered queries at 1000 results. A ledger bootstrapped mid-month on a repository with more runs than that since the checkpoint undercounts.
- **One router call per workflow run.** Artifact names cannot repeat inside one workflow run, so a second router call in the same run cannot save its ledger. It still routes, with a warning.
- **Free allowances differ by plan, OS and runner size.** Set `free-minutes` and `minute-multiplier` from your own plan. The router does not look them up.
- **Public GitHub-hosted runners are free.** Nothing here tracks that. Leave a pool out if its minutes cost nothing.

## Development

```sh
bun install
bun run check     # oxlint, oxfmt, effect-tsrs --strict, tsrs, vitest, dist check
bun run build     # rebuild dist/index.js after changing src/
```

The action runs the committed `dist/index.js`, built with `bun build --target=node`. CI fails when it is stale. See [AGENTS.md](AGENTS.md) for the architecture and [PROVENANCE.md](PROVENANCE.md) for where the lint fence comes from.

## License

MIT. See [LICENSE](LICENSE).
