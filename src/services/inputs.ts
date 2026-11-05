import { Effect } from "effect";
import { parse } from "yaml";

import { InputInvalid } from "../domain/input-invalid.ts";
import { buildRouting, decodePools } from "../domain/routing.ts";
import type { Routing } from "../domain/routing.ts";

export const readRouting = (
  poolsText: string,
  reserveText: string,
  fallbackName: string
): Effect.Effect<Routing, InputInvalid> =>
  Effect.gen(function* read() {
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- yaml.parse returns any; decodePools validates the value with a Schema before use
    const raw = yield* Effect.try({
      catch: (cause) =>
        new InputInvalid({
          input: "pools",
          reason: `not valid YAML (${String(cause)})`,
        }),
      // oxlint-disable-next-line typescript/no-unsafe-return -- yaml.parse returns any; decodePools validates the value with a Schema before use
      try: () => parse(poolsText),
    });

    const inputs = yield* decodePools(raw).pipe(
      Effect.mapError(
        (failure) =>
          new InputInvalid({ input: "pools", reason: failure.message })
      )
    );

    return yield* buildRouting(inputs, reserveText, fallbackName);
  });
