import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  emptyLedger,
  jobMinutes,
  ledgerFor,
  monthOf,
  monthStart,
  selectRuns,
  settle,
} from "../src/domain/ledger.ts";
import type { RunOutcome, RunRef } from "../src/domain/ledger.ts";
import { jobOf } from "./support.ts";

const NOVEMBER = emptyLedger("2026-11");

const runAt = (id: number, createdAt: string, completed = true): RunRef => ({
  completed,
  createdAt,
  id,
});

describe("jobMinutes", () => {
  it("rounds each job up to a whole minute", () => {
    assert.strictEqual(jobMinutes(jobOf(1)), 1);
    assert.strictEqual(jobMinutes(jobOf(60)), 1);
    assert.strictEqual(jobMinutes(jobOf(61)), 2);
    assert.strictEqual(jobMinutes(jobOf(119)), 2);
  });

  it("bills nothing for a job that never started or finished", () => {
    assert.strictEqual(jobMinutes(jobOf(0)), 0);
    assert.strictEqual(
      jobMinutes({ completedAt: null, labels: [], startedAt: null }),
      0
    );
    assert.strictEqual(jobMinutes({ ...jobOf(90), completedAt: null }), 0);
  });
});

describe("months", () => {
  it("rolls over at midnight UTC", () => {
    assert.strictEqual(monthOf("2026-11-30T23:59:59Z"), "2026-11");
    assert.strictEqual(monthOf("2026-12-01T00:00:00Z"), "2026-12");
    assert.strictEqual(monthOf("2026-12-31T23:59:59Z"), "2026-12");
    assert.strictEqual(monthOf("2027-01-01T00:00:00Z"), "2027-01");
  });

  it("starts a fresh ledger when the stored one is from another month", () => {
    const stale = settle(
      NOVEMBER,
      [runAt(1, "2026-11-20T10:00:00Z")],
      [{ jobs: [jobOf(600)], run: runAt(1, "2026-11-20T10:00:00Z") }]
    );

    const december = ledgerFor("2026-12", stale);

    assert.deepStrictEqual(december, emptyLedger("2026-12"));
    assert.strictEqual(december.checkpoint, monthStart("2026-12"));
    assert.strictEqual(ledgerFor("2026-11", stale), stale);
  });
});

describe("settle", () => {
  it("sums rounded job minutes per label set", () => {
    const run = runAt(1, "2026-11-05T12:00:00Z");

    const ledger = settle(
      NOVEMBER,
      [run],
      [
        {
          jobs: [jobOf(61), jobOf(30), jobOf(100, ["self-hosted", "x1"])],
          run,
        },
      ]
    );

    assert.deepStrictEqual(ledger.settled, {
      "self-hosted,x1": 2,
      "ubuntu-latest": 3,
    });
  });

  it("never counts a run twice, even one created exactly at the checkpoint", () => {
    const run = runAt(1, "2026-11-05T12:00:00Z");
    const first = settle(NOVEMBER, [run], [{ jobs: [jobOf(60)], run }]);
    const again = selectRuns(first, [run]);

    assert.deepStrictEqual(again.known, []);
    assert.deepStrictEqual(again.toFetch, []);
  });

  it("keeps an unfinished run pending and settles it once it completes", () => {
    const open = runAt(1, "2026-11-05T12:00:00Z", false);
    const first = settle(NOVEMBER, [open], [{ jobs: [], run: open }]);

    assert.deepStrictEqual(first.pending, [1]);
    assert.deepStrictEqual(first.settled, {});

    const later = selectRuns(first, [runAt(2, "2026-11-05T12:05:00Z")]);

    assert.deepStrictEqual(later.toFetch, [1]);

    const done = { ...open, completed: true };
    const second = settle(first, [], [{ jobs: [jobOf(120)], run: done }]);

    assert.deepStrictEqual(second.pending, []);
    assert.deepStrictEqual(second.settled, { "ubuntu-latest": 2 });
  });

  it("re-inspects a pending run that was created exactly at the checkpoint", () => {
    const open = runAt(1, "2026-11-05T12:00:00Z", false);
    const first = settle(NOVEMBER, [open], [{ jobs: [], run: open }]);
    const selection = selectRuns(first, [{ ...open, completed: true }]);

    assert.deepStrictEqual(
      selection.known.map((run) => run.id),
      [1]
    );
  });
});

const GeneratedRun = Schema.Struct({
  createdSecond: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 })),
  finishesLater: Schema.Boolean,
  jobs: Schema.Array(
    Schema.Int.check(Schema.isBetween({ maximum: 600, minimum: 0 }))
  ),
});

const Cutoff = Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 }));

const second = (offset: number): string => `2026-11-05T12:00:0${offset}Z`;

describe("incremental accounting", () => {
  it.prop(
    "scanning in two passes gives the same totals as one full scan",
    { cutoff: Cutoff, generated: Schema.Array(GeneratedRun) },
    ({ cutoff, generated }) => {
      const finished: RunRef[] = generated.map((entry, index) =>
        runAt(index + 1, second(entry.createdSecond))
      );

      const finish = (id: number): RunOutcome => ({
        jobs: (generated[id - 1]?.jobs ?? []).map((seconds) => jobOf(seconds)),
        run: finished[id - 1] ?? runAt(id, second(0)),
      });

      const full = settle(
        NOVEMBER,
        finished,
        finished.map((run) => finish(run.id))
      );

      const firstSeen = finished.filter(
        (run) => run.createdAt <= second(cutoff)
      );

      const firstView = firstSeen.map((run) =>
        generated[run.id - 1]?.finishesLater === true
          ? { ...run, completed: false }
          : run
      );

      const afterFirst = settle(
        NOVEMBER,
        firstView,
        firstView.map((run) =>
          run.completed ? finish(run.id) : { jobs: [], run }
        )
      );

      const visible = finished.filter(
        (run) => run.createdAt >= afterFirst.checkpoint
      );

      const selection = selectRuns(afterFirst, visible);

      const incremental = settle(afterFirst, visible, [
        ...selection.known.map((run) => finish(run.id)),
        ...selection.toFetch.map((id) => finish(id)),
      ]);

      assert.deepStrictEqual(incremental.settled, full.settled);
      assert.deepStrictEqual(incremental.pending, []);
    }
  );
});
