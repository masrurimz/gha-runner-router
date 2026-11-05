import { Effect, Option } from "effect";

import { decide, usageNeeded } from "../domain/decision.ts";
import type { Decision, Usage } from "../domain/decision.ts";
import type { Routing } from "../domain/routing.ts";
import { Host } from "./host.ts";
import { refreshUsage } from "./usage.ts";

export interface Routed {
  readonly decision: Decision;
  readonly warnings: readonly string[];
}

interface UsageOutcome {
  readonly usage: Usage;
  readonly warnings: readonly string[];
}

export const route = Effect.fn("route")(function* route(routing: Routing) {
  const host = yield* Host;
  const facts = yield* host.facts;
  const first = decide(routing, facts, Option.none());

  if (!usageNeeded(routing, first)) {
    return { decision: first, warnings: [] } satisfies Routed;
  }

  const outcome: UsageOutcome = yield* refreshUsage.pipe(
    Effect.map((report) => ({
      usage: Option.some(report.minutes),
      warnings: Option.toArray(report.saveWarning),
    })),
    Effect.catch((error) =>
      Effect.succeed({ usage: Option.none(), warnings: [error.message] })
    )
  );

  return {
    decision: decide(routing, facts, outcome.usage),
    warnings: outcome.warnings,
  } satisfies Routed;
});
