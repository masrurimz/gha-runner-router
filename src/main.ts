import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { InputInvalid } from "./domain/input-invalid.ts";
import { GithubApi } from "./services/github-api.ts";
import { Host } from "./services/host.ts";
import { readRouting } from "./services/inputs.ts";
import { LedgerStore } from "./services/ledger-store.ts";
import { formatOutputs, formatSummary } from "./services/outputs.ts";
import { route } from "./services/router.ts";

const optionalEnv = (name: string, fallback: string) =>
  Config.String(name).pipe(Config.withDefault(fallback));

const readInputs = Effect.gen(function* readInputs() {
  const pools = yield* Config.String("INPUT_POOLS").pipe(
    Effect.mapError(
      () => new InputInvalid({ input: "pools", reason: "input is required" })
    )
  );

  const reserve = yield* optionalEnv("INPUT_QUOTA-RESERVE", "0.9");
  const fallback = yield* optionalEnv("INPUT_FALLBACK", "");

  return yield* readRouting(pools, reserve, fallback);
});

const appendTo = (variable: string, text: string) =>
  Effect.gen(function* appendProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* optionalEnv(variable, "");

    if (path !== "") {
      yield* fs.writeFileString(path, text, { flag: "a" });
    }
  });

const program = Effect.gen(function* program() {
  const routing = yield* readInputs;
  const routed = yield* route(routing);

  for (const warning of routed.warnings) {
    yield* Console.log(`::warning title=gha-runner-router::${warning}`);
  }

  yield* Console.log(`runner-router: ${routed.decision.reason}`);
  yield* appendTo("GITHUB_OUTPUT", formatOutputs(routed.decision));
  yield* appendTo("GITHUB_STEP_SUMMARY", formatSummary(routed.decision));
}).pipe(
  Effect.tapError((failure) =>
    Console.log(`::error title=gha-runner-router::${String(failure)}`)
  )
);

const services = Layer.mergeAll(Host.layer, LedgerStore.layer).pipe(
  Layer.provideMerge(GithubApi.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(NodeFileSystem.layer)
);

NodeRuntime.runMain(program.pipe(Effect.provide(services)));
