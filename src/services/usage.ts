import { Clock, DateTime, Effect, Option } from "effect";

import type { GithubFailed } from "../domain/github-failed.ts";
import type { LedgerFailed } from "../domain/ledger-failed.ts";
import {
  ledgerFor,
  minutesByLabels,
  monthOf,
  selectRuns,
  settle,
} from "../domain/ledger.ts";
import type { RunOutcome, RunRef } from "../domain/ledger.ts";
import { GithubApi } from "./github-api.ts";
import { LedgerStore } from "./ledger-store.ts";

const INSPECT_CONCURRENCY = 4;

const vanished = (id: number, since: string): RunRef => ({
  completed: true,
  createdAt: since,
  id,
});

export interface UsageReport {
  readonly minutes: ReadonlyMap<string, number>;
  readonly saveWarning: Option.Option<string>;
}

export const refreshUsage: Effect.Effect<
  UsageReport,
  GithubFailed | LedgerFailed,
  GithubApi | LedgerStore
> = Effect.gen(function* refresh() {
  const api = yield* GithubApi;

  const store = yield* LedgerStore;

  const millis = yield* Clock.currentTimeMillis;

  const month = monthOf(DateTime.formatIso(DateTime.makeUnsafe(millis)));

  const stored = yield* store.load(month);

  const ledger = ledgerFor(month, Option.getOrUndefined(stored));

  const listed = yield* api.listRuns(ledger.checkpoint);

  const selection = selectRuns(ledger, listed);

  const fetched = yield* Effect.forEach(
    selection.toFetch,
    (id) =>
      api
        .getRun(id)
        .pipe(
          Effect.map((run) =>
            Option.getOrElse(run, () => vanished(id, ledger.checkpoint))
          )
        ),
    { concurrency: INSPECT_CONCURRENCY }
  );

  const outcomes: readonly RunOutcome[] = yield* Effect.forEach(
    [...selection.known, ...fetched],
    (run) =>
      run.completed
        ? api.listJobs(run.id).pipe(Effect.map((jobs) => ({ jobs, run })))
        : Effect.succeed({ jobs: [], run }),
    { concurrency: INSPECT_CONCURRENCY }
  );

  const next = settle(ledger, listed, outcomes);

  const saveWarning = yield* store.save(next).pipe(
    Effect.as(Option.none<string>()),
    Effect.catch((error) => Effect.succeedSome(error.message))
  );

  return { minutes: minutesByLabels(next), saveWarning };
});
