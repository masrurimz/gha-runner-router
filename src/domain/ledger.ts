import { Schema } from "effect";

import { labelKey } from "./pool.ts";

export const LedgerSchema = Schema.Struct({
  atCheckpoint: Schema.Array(Schema.Finite),
  checkpoint: Schema.String,
  month: Schema.String,
  pending: Schema.Array(Schema.Finite),
  settled: Schema.Record(Schema.String, Schema.Finite),
  version: Schema.Literal(1),
});

export type Ledger = typeof LedgerSchema.Type;

export interface RunRef {
  readonly id: number;
  readonly createdAt: string;
  readonly completed: boolean;
}

export interface JobRecord {
  readonly labels: readonly string[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface RunOutcome {
  readonly run: RunRef;
  readonly jobs: readonly JobRecord[];
}

export interface RunSelection {
  readonly known: readonly RunRef[];
  readonly toFetch: readonly number[];
}

const MONTH_LENGTH = 7;

const SECONDS_PER_MINUTE = 60;

const MS_PER_SECOND = 1000;

export const monthOf = (iso: string): string => iso.slice(0, MONTH_LENGTH);

export const monthStart = (month: string): string => `${month}-01T00:00:00Z`;

export const emptyLedger = (month: string): Ledger => ({
  atCheckpoint: [],
  checkpoint: monthStart(month),
  month,
  pending: [],
  settled: {},
  version: 1,
});

export const ledgerFor = (month: string, stored: Ledger | undefined): Ledger =>
  stored !== undefined && stored.month === month ? stored : emptyLedger(month);

export const jobMinutes = (job: JobRecord): number => {
  if (job.startedAt === null || job.completedAt === null) {
    return 0;
  }

  const seconds =
    (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / MS_PER_SECOND;

  return seconds > 0 ? Math.ceil(seconds / SECONDS_PER_MINUTE) : 0;
};

export const selectRuns = (
  ledger: Ledger,
  listed: readonly RunRef[]
): RunSelection => {
  const atCheckpoint = new Set(ledger.atCheckpoint);
  const pending = new Set(ledger.pending);
  const listedIds = new Set(listed.map((run) => run.id));

  return {
    known: listed.filter(
      (run) => pending.has(run.id) || !atCheckpoint.has(run.id)
    ),
    toFetch: ledger.pending.filter((id) => !listedIds.has(id)),
  };
};

const addMinutes = (
  settled: Readonly<Record<string, number>>,
  jobs: readonly JobRecord[]
) => {
  const totals = new Map(Object.entries(settled));

  for (const job of jobs) {
    const key = labelKey(job.labels);

    totals.set(key, (totals.get(key) ?? 0) + jobMinutes(job));
  }

  return Object.fromEntries(totals);
};

const advanceCheckpoint = (
  ledger: Ledger,
  listed: readonly RunRef[]
): Pick<Ledger, "atCheckpoint" | "checkpoint"> => {
  let newest = ledger.checkpoint;

  for (const run of listed) {
    if (run.createdAt > newest) {
      newest = run.createdAt;
    }
  }

  const idsAtNewest = listed.flatMap((run) =>
    run.createdAt === newest ? [run.id] : []
  );

  const carried = newest === ledger.checkpoint ? ledger.atCheckpoint : [];

  return {
    atCheckpoint: [...new Set([...carried, ...idsAtNewest])],
    checkpoint: newest,
  };
};

export const settle = (
  ledger: Ledger,
  listed: readonly RunRef[],
  outcomes: readonly RunOutcome[]
): Ledger => {
  const handled = new Set(outcomes.map((outcome) => outcome.run.id));
  const finished: RunOutcome[] = [];
  const stillOpen: number[] = [];

  for (const outcome of outcomes) {
    if (outcome.run.completed) {
      finished.push(outcome);
    } else {
      stillOpen.push(outcome.run.id);
    }
  }

  return {
    ...ledger,
    ...advanceCheckpoint(ledger, listed),
    pending: [...ledger.pending.filter((id) => !handled.has(id)), ...stillOpen],
    settled: addMinutes(
      ledger.settled,
      finished.flatMap((outcome) => outcome.jobs)
    ),
  };
};

export const minutesByLabels = (ledger: Ledger): ReadonlyMap<string, number> =>
  new Map(Object.entries(ledger.settled));
