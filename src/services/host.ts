// @effect-diagnostics nodeBuiltinImport:off -- Reads the machine hostname with Node's os module.
import { hostname } from "node:os";

import { Config, Context, Effect, FileSystem, Layer } from "effect";

import type { HostFacts } from "../domain/decision.ts";

const PROC = "/proc";

const WORKER_COMM = "Runner.Worker";

const KB_PER_MB = 1024;

const PROBE_CONCURRENCY = 16;

const PID = /^\d+$/u;

const MEM_AVAILABLE = /^MemAvailable:\s+(?<kb>\d+) kB$/mu;

export const countWorkers = (comms: readonly string[]): number =>
  comms.filter((comm) => comm.trim() === WORKER_COMM).length;

export const memAvailableMb = (meminfo: string): number | undefined => {
  const kb = MEM_AVAILABLE.exec(meminfo)?.groups?.kb;

  return kb === undefined ? undefined : Math.floor(Number(kb) / KB_PER_MB);
};

export const notOnHost = (name: string): HostFacts => ({
  busyWorkers: 0,
  hostname: name,
  memAvailableMb: 0,
  selfHosted: false,
});

export class Host extends Context.Service<Host>()(
  "gha-runner-router/services/Host",
  {
    make: Effect.gen(function* make() {
      const fs = yield* FileSystem.FileSystem;

      const environment = yield* Config.String("RUNNER_ENVIRONMENT").pipe(
        Config.withDefault("github-hosted")
      );

      const name = hostname();

      const facts = Effect.gen(function* facts() {
        if (environment !== "self-hosted") {
          return notOnHost(name);
        }

        const entries = yield* fs.readDirectory(PROC);

        const comms = yield* Effect.forEach(
          entries.filter((entry) => PID.test(entry)),
          (pid) =>
            fs
              .readFileString(`${PROC}/${pid}/comm`)
              .pipe(Effect.orElseSucceed(() => "")),
          { concurrency: PROBE_CONCURRENCY }
        );

        const meminfo = yield* fs.readFileString(`${PROC}/meminfo`);
        const available = memAvailableMb(meminfo);

        if (available === undefined) {
          return notOnHost(name);
        }

        return {
          busyWorkers: Math.max(0, countWorkers(comms) - 1),
          hostname: name,
          memAvailableMb: available,
          selfHosted: true,
        };
      }).pipe(Effect.orElseSucceed(() => notOnHost(name)));

      return { facts };
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly factsLayer = (facts: HostFacts) =>
    Layer.succeed(this, { facts: Effect.succeed(facts) });
}
