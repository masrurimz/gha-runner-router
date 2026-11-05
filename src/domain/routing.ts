import { Array as Arr, Effect, Option, Schema } from "effect";

import { InputInvalid } from "./input-invalid.ts";
import type { Pool } from "./pool.ts";

const Count = Schema.Int.check(Schema.isGreaterThan(0));

const Labels = Schema.Union([
  Schema.NonEmptyString,
  Schema.NonEmptyArray(Schema.NonEmptyString),
]);

const LocalPoolInputSchema = Schema.Struct({
  host: Schema.optionalKey(Schema.NonEmptyString),
  kind: Schema.Literal("local"),
  "min-available-mb": Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.NonEmptyString,
  "runs-on": Labels,
  slots: Count,
  workers: Count,
});

const MeteredPoolInputSchema = Schema.Struct({
  "free-minutes": Count,
  kind: Schema.Literal("metered"),
  "minute-multiplier": Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0))
  ),
  name: Schema.NonEmptyString,
  "runs-on": Labels,
  workers: Count,
});

export const PoolsInputSchema = Schema.NonEmptyArray(
  Schema.Union([LocalPoolInputSchema, MeteredPoolInputSchema])
);

export type PoolsInput = typeof PoolsInputSchema.Type;

type PoolInput = PoolsInput[number];

export const decodePools = Schema.decodeUnknownEffect(PoolsInputSchema, {
  onExcessProperty: "error",
});

const labelsOf = (value: string | readonly string[]): readonly string[] =>
  Arr.ensure(value);

const toPool = (input: PoolInput): Pool =>
  input.kind === "local"
    ? {
        host: Option.fromNullishOr(input.host),
        kind: "local",
        minAvailableMb: input["min-available-mb"],
        name: input.name,
        runsOn: labelsOf(input["runs-on"]),
        slots: input.slots,
        workers: input.workers,
      }
    : {
        freeMinutes: input["free-minutes"],
        kind: "metered",
        minuteMultiplier: input["minute-multiplier"] ?? 1,
        name: input.name,
        runsOn: labelsOf(input["runs-on"]),
        workers: input.workers,
      };

export interface Routing {
  readonly pools: readonly [Pool, ...Pool[]];
  readonly reserveBp: number;
  readonly fallback: Pool;
}

const BASIS_POINTS = 10_000;

const invalid = (input: string, reason: string) =>
  new InputInvalid({ input, reason });

const parseReserve = (text: string): Effect.Effect<number, InputInvalid> => {
  const value = Number(text.trim());

  return Number.isFinite(value) && value > 0 && value <= 1
    ? Effect.succeed(Math.round(value * BASIS_POINTS))
    : Effect.fail(
        invalid("quota-reserve", `"${text}" is not a number in (0, 1]`)
      );
};

const duplicateName = (pools: readonly Pool[]): Option.Option<string> =>
  Option.fromNullishOr(
    pools.find(
      (pool, index) =>
        pools.findIndex((other) => other.name === pool.name) !== index
    )?.name
  );

const chooseFallback = (
  pools: readonly [Pool, ...Pool[]],
  name: string
): Effect.Effect<Pool, InputInvalid> => {
  const wanted = name.trim();

  if (wanted === "") {
    return Effect.succeed(
      pools.find((pool) => pool.kind === "local") ?? pools[0]
    );
  }

  const found = pools.find((pool) => pool.name === wanted);

  return found === undefined
    ? Effect.fail(
        invalid(
          "fallback",
          `"${wanted}" is not a pool name (pools: ${pools.map((pool) => pool.name).join(", ")})`
        )
      )
    : Effect.succeed(found);
};

export const buildRouting = (
  inputs: PoolsInput,
  reserveText: string,
  fallbackName: string
): Effect.Effect<Routing, InputInvalid> =>
  Effect.gen(function* build() {
    const [first, ...rest] = inputs.map(toPool);

    if (first === undefined) {
      return yield* invalid("pools", "empty list");
    }

    const pools: readonly [Pool, ...Pool[]] = [first, ...rest];
    const duplicate = duplicateName(pools);

    if (Option.isSome(duplicate)) {
      return yield* invalid(
        "pools",
        `duplicate pool name "${duplicate.value}"`
      );
    }

    const reserveBp = yield* parseReserve(reserveText);
    const fallback = yield* chooseFallback(pools, fallbackName);

    return { fallback, pools, reserveBp };
  });
