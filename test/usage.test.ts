import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { Ledger, RunRef } from "../src/domain/ledger.ts";
import { poolLabelKey } from "../src/domain/pool.ts";
import { Host } from "../src/services/host.ts";
import { route } from "../src/services/router.ts";
import { refreshUsage } from "../src/services/usage.ts";
import type { FakeRun } from "./support.ts";
import {
  fakeGithub,
  hostFacts,
  jobOf,
  localPool,
  memoryStore,
  meteredPool,
  routingOf,
} from "./support.ts";

const NOW = Date.parse("2026-11-05T13:00:00Z");

const runOf = (
  id: number,
  createdAt: string,
  seconds: readonly number[],
  completed = true
): FakeRun => ({
  jobs: seconds.map((value) => jobOf(value)),
  run: { completed, createdAt, id } satisfies RunRef,
});

const setup = (initial: readonly FakeRun[]) =>
  Effect.gen(function* setupProgram() {
    yield* TestClock.setTime(NOW);

    const runs = yield* Ref.make(initial);
    const stored = yield* Ref.make(Option.none<Ledger>());
    const github = fakeGithub(runs);

    return {
      calls: github.calls,
      layer: Layer.mergeAll(github.layer, memoryStore(stored)),
      runs,
      stored,
    };
  });

const USAGE_KEY = poolLabelKey(meteredPool());

describe("refreshUsage", () => {
  it.effect(
    "sums whole-minute jobs of finished runs and persists the ledger",
    () =>
      Effect.gen(function* firstScan() {
        const world = yield* setup([
          runOf(1, "2026-11-02T10:00:00Z", [61, 30]),
          runOf(2, "2026-11-03T10:00:00Z", [600]),
        ]);

        const report = yield* refreshUsage.pipe(Effect.provide(world.layer));
        const saved = yield* Ref.get(world.stored);

        assert.strictEqual(report.minutes.get(USAGE_KEY), 13);
        assert.isTrue(Option.isSome(saved));
        assert.isTrue(Option.isNone(report.saveWarning));
      })
  );

  it.effect("a second scan lists jobs only for runs it has not seen", () =>
    Effect.gen(function* secondScan() {
      const world = yield* setup([
        runOf(1, "2026-11-02T10:00:00Z", [60]),
        runOf(2, "2026-11-03T10:00:00Z", [60]),
      ]);

      yield* refreshUsage.pipe(Effect.provide(world.layer));

      const afterFirst = yield* Ref.get(world.calls);

      yield* Ref.update(world.runs, (runs) => [
        ...runs,
        runOf(3, "2026-11-04T10:00:00Z", [120]),
      ]);

      const report = yield* refreshUsage.pipe(Effect.provide(world.layer));
      const afterSecond = yield* Ref.get(world.calls);

      assert.strictEqual(report.minutes.get(USAGE_KEY), 4);
      assert.strictEqual(afterSecond.listJobs - afterFirst.listJobs, 1);
    })
  );

  it.effect("an unfinished run is counted once it completes", () =>
    Effect.gen(function* pendingRun() {
      const world = yield* setup([
        runOf(1, "2026-11-04T10:00:00Z", [60]),
        runOf(2, "2026-11-05T10:00:00Z", [180], false),
      ]);

      const before = yield* refreshUsage.pipe(Effect.provide(world.layer));

      assert.strictEqual(before.minutes.get(USAGE_KEY), 1);

      yield* Ref.update(world.runs, (runs) =>
        runs.map((entry) =>
          entry.run.id === 2
            ? { ...entry, run: { ...entry.run, completed: true } }
            : entry
        )
      );

      const after = yield* refreshUsage.pipe(Effect.provide(world.layer));

      assert.strictEqual(after.minutes.get(USAGE_KEY), 4);
    })
  );

  it.effect(
    "concurrent routers that restored the same ledger agree on the totals",
    () =>
      Effect.gen(function* concurrent() {
        const world = yield* setup([runOf(1, "2026-11-02T10:00:00Z", [60])]);

        yield* refreshUsage.pipe(Effect.provide(world.layer));
        yield* Ref.update(world.runs, (runs) => [
          ...runs,
          runOf(2, "2026-11-04T10:00:00Z", [300]),
        ]);

        const snapshot = yield* Ref.get(world.stored);

        const [left, right] = yield* Effect.all(
          [
            refreshUsage.pipe(Effect.provide(world.layer)),
            refreshUsage.pipe(Effect.provide(world.layer)),
          ],
          { concurrency: 2 }
        );

        assert.isTrue(Option.isSome(snapshot));
        assert.strictEqual(left.minutes.get(USAGE_KEY), 6);
        assert.strictEqual(right.minutes.get(USAGE_KEY), 6);
      })
  );

  it.effect("starts from zero on a new month", () =>
    Effect.gen(function* rollover() {
      const world = yield* setup([runOf(1, "2026-11-02T10:00:00Z", [600])]);

      yield* refreshUsage.pipe(Effect.provide(world.layer));
      yield* TestClock.setTime(Date.parse("2026-12-01T00:00:00Z"));

      const report = yield* refreshUsage.pipe(Effect.provide(world.layer));

      assert.strictEqual(report.minutes.get(USAGE_KEY) ?? 0, 0);
    })
  );
});

describe("route", () => {
  const routing = routingOf(localPool(), meteredPool());

  it.effect("does not touch GitHub when the local pool has a slot", () =>
    Effect.gen(function* localFirst() {
      const world = yield* setup([]);

      const routed = yield* route(routing).pipe(
        Effect.provide(Layer.merge(world.layer, Host.factsLayer(hostFacts())))
      );

      const calls = yield* Ref.get(world.calls);

      assert.strictEqual(routed.decision.pool.name, "x1");
      assert.strictEqual(calls.listRuns, 0);
    })
  );

  it.effect("overflows to the metered pool while it is under the reserve", () =>
    Effect.gen(function* overflow() {
      const world = yield* setup([runOf(1, "2026-11-02T10:00:00Z", [600])]);

      const routed = yield* route(routing).pipe(
        Effect.provide(
          Layer.merge(
            world.layer,
            Host.factsLayer(hostFacts({ busyWorkers: 4 }))
          )
        )
      );

      assert.strictEqual(routed.decision.pool.name, "hosted");
      assert.isFalse(routed.decision.queued);
    })
  );

  it.effect(
    "queues on the fallback when the metered pool reached its reserve",
    () =>
      Effect.gen(function* exhausted() {
        const world = yield* setup([
          runOf(1, "2026-11-02T10:00:00Z", [108_000]),
        ]);

        const routed = yield* route(routing).pipe(
          Effect.provide(
            Layer.merge(
              world.layer,
              Host.factsLayer(hostFacts({ busyWorkers: 4 }))
            )
          )
        );

        assert.strictEqual(routed.decision.pool.name, "x1");
        assert.isTrue(routed.decision.queued);
      })
  );
});
