import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { decide, judgeMetered, usageNeeded } from "../src/domain/decision.ts";
import { poolLabelKey } from "../src/domain/pool.ts";
import {
  RESERVE_BP,
  hostFacts,
  localPool,
  meteredPool,
  routingOf,
} from "./support.ts";

const hosted = meteredPool();

const usageOf = (used: number, pool = hosted) =>
  Option.some(new Map([[poolLabelKey(pool), used]]));

describe("decide with a local pool first", () => {
  const routing = routingOf(localPool(), hosted);

  it("takes the local pool while a slot and memory are free", () => {
    const decision = decide(routing, hostFacts({ busyWorkers: 3 }), usageOf(0));

    assert.strictEqual(decision.pool.name, "x1");
    assert.isFalse(decision.queued);
    assert.include(decision.reason, "3/4 busy");
  });

  it("skips the local pool when every slot is busy", () => {
    const decision = decide(routing, hostFacts({ busyWorkers: 4 }), usageOf(0));

    assert.strictEqual(decision.pool.name, "hosted");
    assert.include(decision.reason, "x1 busy 4/4 slots");
  });

  it("skips the local pool when memory is one MB under the floor", () => {
    const low = decide(
      routing,
      hostFacts({ memAvailableMb: 7999 }),
      usageOf(0)
    );

    const exact = decide(
      routing,
      hostFacts({ memAvailableMb: 8000 }),
      usageOf(0)
    );

    assert.strictEqual(low.pool.name, "hosted");
    assert.include(low.reason, "low memory 7999 MB < 8000 MB");
    assert.strictEqual(exact.pool.name, "x1");
  });

  it("skips the local pool when the router job is not on a self-hosted runner", () => {
    const decision = decide(
      routing,
      hostFacts({ selfHosted: false }),
      usageOf(0)
    );

    assert.strictEqual(decision.pool.name, "hosted");
    assert.include(decision.reason, "not on its host");
  });

  it("matches the pool host name case-insensitively and rejects another host", () => {
    const pinned = routingOf(
      localPool({ host: Option.some("X1-Dev") }),
      hosted
    );

    assert.strictEqual(
      decide(pinned, hostFacts({ hostname: "x1-dev" }), usageOf(0)).pool.name,
      "x1"
    );
    assert.strictEqual(
      decide(pinned, hostFacts({ hostname: "other" }), usageOf(0)).pool.name,
      "hosted"
    );
  });
});

describe("metered quota boundary", () => {
  const limit = (RESERVE_BP * hosted.freeMinutes) / 10_000;

  it("is available one minute under the reserve and full exactly at it", () => {
    assert.isTrue(
      judgeMetered(hosted, usageOf(limit - 1), RESERVE_BP).available
    );
    assert.isFalse(judgeMetered(hosted, usageOf(limit), RESERVE_BP).available);
    assert.isFalse(
      judgeMetered(hosted, usageOf(limit + 1), RESERVE_BP).available
    );
  });

  it("burns minutes at the pool multiplier", () => {
    const large = meteredPool({ minuteMultiplier: 2 });

    assert.isTrue(
      judgeMetered(large, usageOf(limit / 2 - 1, large), RESERVE_BP).available
    );
    assert.isFalse(
      judgeMetered(large, usageOf(limit / 2, large), RESERVE_BP).available
    );
  });

  it("counts only jobs whose labels match the pool, ignoring label order and case", () => {
    const labelled = meteredPool({ runsOn: ["Linux", "X64"] });
    const usage = Option.some(new Map([["linux,x64", limit]]));

    assert.isFalse(judgeMetered(labelled, usage, RESERVE_BP).available);
    assert.isTrue(
      judgeMetered(labelled, Option.some(new Map()), RESERVE_BP).available
    );
  });

  it("is skipped when usage could not be read", () => {
    const verdict = judgeMetered(hosted, Option.none(), RESERVE_BP);

    assert.isFalse(verdict.available);
    assert.include(verdict.note, "usage could not be read");
  });

  it.prop(
    "more usage never makes a full pool available",
    {
      first: Schema.Int.check(Schema.isBetween({ maximum: 4000, minimum: 0 })),
      second: Schema.Int.check(Schema.isBetween({ maximum: 4000, minimum: 0 })),
    },
    ({ first, second }) => {
      const low = Math.min(first, second);
      const high = Math.max(first, second);

      if (judgeMetered(hosted, usageOf(high), RESERVE_BP).available) {
        assert.isTrue(judgeMetered(hosted, usageOf(low), RESERVE_BP).available);
      }
    }
  );

  it.prop(
    "available exactly when used minutes are below the reserve limit",
    { used: Schema.Int.check(Schema.isBetween({ maximum: 4000, minimum: 0 })) },
    ({ used }) => {
      assert.strictEqual(
        judgeMetered(hosted, usageOf(used), RESERVE_BP).available,
        used < limit
      );
    }
  );
});

describe("ordering and fallback", () => {
  const avrea = meteredPool({
    freeMinutes: 3000,
    name: "avrea",
    runsOn: ["avrea-placeholder"],
  });

  it("walks the pools in order and takes the first available", () => {
    const routing = routingOf(localPool(), avrea, hosted);

    const usage = Option.some(
      new Map([
        [poolLabelKey(avrea), 2700],
        [poolLabelKey(hosted), 0],
      ])
    );

    const decision = decide(routing, hostFacts({ busyWorkers: 4 }), usage);

    assert.strictEqual(decision.pool.name, "hosted");
    assert.include(decision.reason, "avrea at reserve");
  });

  it("falls back to the configured pool and reports queueing when everything is full", () => {
    const routing = {
      ...routingOf(localPool(), hosted),
      fallback: localPool(),
    };

    const decision = decide(
      routing,
      hostFacts({ busyWorkers: 4 }),
      usageOf(1800)
    );

    assert.strictEqual(decision.pool.name, "x1");
    assert.isTrue(decision.queued);
    assert.include(decision.reason, "(fallback)");
  });

  it("only needs usage when a metered pool is reached", () => {
    const routing = routingOf(localPool(), hosted);
    const free = decide(routing, hostFacts(), Option.none());
    const busy = decide(routing, hostFacts({ busyWorkers: 4 }), Option.none());
    const meteredFirst = routingOf(hosted, localPool());

    assert.isFalse(usageNeeded(routing, free));
    assert.isTrue(usageNeeded(routing, busy));
    assert.isTrue(
      usageNeeded(
        meteredFirst,
        decide(meteredFirst, hostFacts(), Option.none())
      )
    );
  });
});
