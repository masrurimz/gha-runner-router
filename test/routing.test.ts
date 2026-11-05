import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { readRouting } from "../src/services/inputs.ts";

const VALID = `
- name: x1
  runs-on: [self-hosted, x1-dev]
  kind: local
  workers: 8
  slots: 4
  min-available-mb: 15000
- name: hosted
  runs-on: ubuntu-latest
  kind: metered
  workers: 2
  free-minutes: 2000
- name: large
  runs-on: [ubuntu-latest-4-cores]
  kind: metered
  workers: 4
  free-minutes: 2000
  minute-multiplier: 2
`;

const rejected = (pools: string, reserve = "0.9", fallback = "") =>
  Effect.flip(readRouting(pools, reserve, fallback));

describe("readRouting", () => {
  it.effect("decodes pools, normalises runs-on and applies defaults", () =>
    Effect.gen(function* valid() {
      const routing = yield* readRouting(VALID, "0.9", "");
      const [local, hosted, large] = routing.pools;

      assert.strictEqual(routing.reserveBp, 9000);
      assert.deepStrictEqual(hosted?.runsOn, ["ubuntu-latest"]);
      assert.deepStrictEqual(local?.runsOn, ["self-hosted", "x1-dev"]);
      assert.strictEqual(
        large?.kind === "metered" ? large.minuteMultiplier : 0,
        2
      );
      assert.strictEqual(
        hosted?.kind === "metered" ? hosted.minuteMultiplier : 0,
        1
      );
      assert.isTrue(local?.kind === "local" && Option.isNone(local.host));
    })
  );

  it.effect("defaults the fallback to the first local pool", () =>
    Effect.gen(function* defaulted() {
      const routing = yield* readRouting(VALID, "0.9", "");

      assert.strictEqual(routing.fallback.name, "x1");
    })
  );

  it.effect("accepts a named fallback", () =>
    Effect.gen(function* named() {
      const routing = yield* readRouting(VALID, "0.9", "hosted");

      assert.strictEqual(routing.fallback.name, "hosted");
    })
  );

  it.effect("rejects a fallback that names no pool", () =>
    Effect.gen(function* unknownFallback() {
      const error = yield* rejected(VALID, "0.9", "nope");

      assert.strictEqual(error._tag, "InputInvalid");
      assert.strictEqual(error.input, "fallback");
    })
  );

  it.effect("rejects text that is not YAML", () =>
    Effect.gen(function* notYaml() {
      const error = yield* rejected("- name: [unclosed");

      assert.strictEqual(error._tag, "InputInvalid");
      assert.include(error.reason, "not valid YAML");
    })
  );

  it.effect("rejects an empty list and a non-list", () =>
    Effect.gen(function* notAList() {
      assert.strictEqual((yield* rejected("[]")).input, "pools");
      assert.strictEqual((yield* rejected("name: x1")).input, "pools");
      assert.strictEqual((yield* rejected("")).input, "pools");
    })
  );

  it.effect("rejects an unknown kind, a missing field and a misspelt key", () =>
    Effect.gen(function* fields() {
      const unknownKind = `- {name: a, runs-on: x, kind: spot, workers: 1}`;
      const missingSlots = `- {name: a, runs-on: x, kind: local, workers: 1, min-available-mb: 1}`;
      const misspelt = `- {name: a, runs-on: x, kind: metered, workers: 1, free-minutes: 10, minute-multiplyer: 2}`;

      assert.strictEqual((yield* rejected(unknownKind)).input, "pools");
      assert.strictEqual((yield* rejected(missingSlots)).input, "pools");
      assert.strictEqual((yield* rejected(misspelt)).input, "pools");
    })
  );

  it.effect("rejects non-positive budgets and empty labels", () =>
    Effect.gen(function* budgets() {
      const zeroWorkers = `- {name: a, runs-on: x, kind: metered, workers: 0, free-minutes: 10}`;
      const zeroFree = `- {name: a, runs-on: x, kind: metered, workers: 1, free-minutes: 0}`;
      const fractionalSlots = `- {name: a, runs-on: x, kind: local, workers: 1, slots: 1.5, min-available-mb: 1}`;
      const emptyLabels = `- {name: a, runs-on: [], kind: metered, workers: 1, free-minutes: 10}`;

      for (const pools of [
        zeroWorkers,
        zeroFree,
        fractionalSlots,
        emptyLabels,
      ]) {
        assert.strictEqual((yield* rejected(pools)).input, "pools");
      }
    })
  );

  it.effect("rejects duplicate pool names", () =>
    Effect.gen(function* duplicates() {
      const twice = `- {name: a, runs-on: x, kind: metered, workers: 1, free-minutes: 10}\n- {name: a, runs-on: y, kind: metered, workers: 1, free-minutes: 10}`;
      const error = yield* rejected(twice);

      assert.include(error.reason, "duplicate pool name");
    })
  );

  it.effect("rejects a reserve outside (0, 1]", () =>
    Effect.gen(function* reserves() {
      for (const reserve of ["0", "-0.1", "1.01", "abc", ""]) {
        assert.strictEqual(
          (yield* rejected(VALID, reserve)).input,
          "quota-reserve"
        );
      }

      assert.strictEqual(
        (yield* readRouting(VALID, "1", "")).reserveBp,
        10_000
      );
    })
  );

  it.effect("decodes worker-match and rejects one that is not a regex", () =>
    Effect.gen(function* matches() {
      const ok = `- {name: a, runs-on: x, kind: local, workers: 1, slots: 1, min-available-mb: 1, worker-match: "runners/a(-1)?/"}`;
      const bad = `- {name: a, runs-on: x, kind: local, workers: 1, slots: 1, min-available-mb: 1, worker-match: "runners/(a"}`;
      const empty = `- {name: a, runs-on: x, kind: local, workers: 1, slots: 1, min-available-mb: 1, worker-match: ""}`;
      const [local] = (yield* readRouting(ok, "0.9", "")).pools;

      assert.deepStrictEqual(
        local?.kind === "local" ? local.workerMatch : Option.none(),
        Option.some("runners/a(-1)?/")
      );
      assert.include((yield* rejected(bad)).reason, "worker-match");
      assert.strictEqual((yield* rejected(empty)).input, "pools");
    })
  );
});
