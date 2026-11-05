import { Effect, Option, Ref } from "effect";

import type { HostFacts } from "../src/domain/decision.ts";
import type { JobRecord, Ledger, RunRef } from "../src/domain/ledger.ts";
import type { LocalPool, MeteredPool } from "../src/domain/pool.ts";
import type { Routing } from "../src/domain/routing.ts";
import { GithubApi } from "../src/services/github-api.ts";
import { LedgerStore } from "../src/services/ledger-store.ts";

export const RESERVE_BP = 9000;

export const localPool = (overrides: Partial<LocalPool> = {}): LocalPool => ({
  host: Option.none(),
  kind: "local",
  minAvailableMb: 8000,
  name: "x1",
  runsOn: ["self-hosted", "x1"],
  slots: 4,
  workers: 8,
  ...overrides,
});

export const meteredPool = (
  overrides: Partial<MeteredPool> = {}
): MeteredPool => ({
  freeMinutes: 2000,
  kind: "metered",
  minuteMultiplier: 1,
  name: "hosted",
  runsOn: ["ubuntu-latest"],
  workers: 2,
  ...overrides,
});

export const routingOf = (
  first: LocalPool | MeteredPool,
  ...rest: readonly (LocalPool | MeteredPool)[]
): Routing => ({
  fallback: first,
  pools: [first, ...rest],
  reserveBp: RESERVE_BP,
});

export const hostFacts = (overrides: Partial<HostFacts> = {}): HostFacts => ({
  busyWorkers: 0,
  hostname: "x1-dev",
  memAvailableMb: 32_000,
  selfHosted: true,
  ...overrides,
});

const TWO_DIGITS = 2;

const SECONDS_PER_MINUTE = 60;

const SECONDS_PER_HOUR = 3600;

const SECONDS_PER_DAY = 86_400;

const pad = (value: number): string => String(value).padStart(TWO_DIGITS, "0");

export const jobOf = (
  seconds: number,
  labels: readonly string[] = ["ubuntu-latest"]
): JobRecord => {
  const day = 2 + Math.floor(seconds / SECONDS_PER_DAY);
  const rest = seconds % SECONDS_PER_DAY;
  const hours = Math.floor(rest / SECONDS_PER_HOUR);
  const mins = Math.floor((rest % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const secs = rest % SECONDS_PER_MINUTE;

  return {
    completedAt: `2026-11-${pad(day)}T${pad(hours)}:${pad(mins)}:${pad(secs)}Z`,
    labels,
    startedAt: "2026-11-02T00:00:00Z",
  };
};

export interface FakeRun {
  readonly run: RunRef;
  readonly jobs: readonly JobRecord[];
}

export interface Calls {
  readonly listRuns: number;
  readonly getRun: number;
  readonly listJobs: number;
}

export const fakeGithub = (runs: Ref.Ref<readonly FakeRun[]>) => {
  const calls = Ref.makeUnsafe<Calls>({ getRun: 0, listJobs: 0, listRuns: 0 });

  const layer = GithubApi.fake({
    findArtifact: () => Effect.succeedNone,
    getRun: (id) =>
      Effect.gen(function* getRun() {
        yield* Ref.update(calls, (c) => ({ ...c, getRun: c.getRun + 1 }));

        const all = yield* Ref.get(runs);

        return Option.fromNullishOr(
          all.find((entry) => entry.run.id === id)?.run
        );
      }),
    listJobs: (runId) =>
      Effect.gen(function* listJobs() {
        yield* Ref.update(calls, (c) => ({ ...c, listJobs: c.listJobs + 1 }));

        const all = yield* Ref.get(runs);

        return [...(all.find((entry) => entry.run.id === runId)?.jobs ?? [])];
      }),
    listRuns: (since) =>
      Effect.gen(function* listRuns() {
        yield* Ref.update(calls, (c) => ({ ...c, listRuns: c.listRuns + 1 }));

        const all = yield* Ref.get(runs);

        return all
          .map((entry) => entry.run)
          .filter((run) => run.createdAt >= since);
      }),
  });

  return { calls, layer };
};

export const memoryStore = (stored: Ref.Ref<Option.Option<Ledger>>) =>
  LedgerStore.fake({
    load: () => Ref.get(stored),
    save: (ledger) => Ref.set(stored, Option.some(ledger)),
  });
