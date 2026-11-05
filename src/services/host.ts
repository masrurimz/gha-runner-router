// @effect-diagnostics nodeBuiltinImport:off -- Reads the machine hostname with Node's os module.
import { hostname } from "node:os";

import { Config, Context, Effect, FileSystem, Layer } from "effect";

import type { HostFacts } from "../domain/decision.ts";

const PROC = "/proc";

const WORKER_COMM = "Runner.Worker";

const KB_PER_MB = 1024;

const PROBE_CONCURRENCY = 16;

const MAX_ANCESTORS = 64;

const PID = /^\d+$/u;

const MEM_AVAILABLE = /^MemAvailable:\s+(?<kb>\d+) kB$/mu;

const PARENT_PID = /^\d+ \(.*\) \S (?<ppid>\d+) /su;

export interface Proc {
  readonly pid: number;
  readonly comm: string;
  readonly cmdline: string;
}

export const parentPid = (stat: string): number | undefined => {
  const ppid = PARENT_PID.exec(stat)?.groups?.ppid;

  return ppid === undefined ? undefined : Number(ppid);
};

export const workerCommands = (
  procs: readonly Proc[],
  ancestors: ReadonlySet<number>
): readonly string[] =>
  procs.flatMap((proc) =>
    proc.comm.trim() === WORKER_COMM && !ancestors.has(proc.pid)
      ? [proc.cmdline]
      : []
  );

export const memAvailableMb = (meminfo: string): number | undefined => {
  const kb = MEM_AVAILABLE.exec(meminfo)?.groups?.kb;

  return kb === undefined ? undefined : Math.floor(Number(kb) / KB_PER_MB);
};

export const notOnHost = (name: string): HostFacts => ({
  hostname: name,
  memAvailableMb: 0,
  selfHosted: false,
  workerCommands: [],
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

      const readProc = (pid: string) =>
        Effect.gen(function* readOne() {
          const comm = yield* fs
            .readFileString(`${PROC}/${pid}/comm`)
            .pipe(Effect.orElseSucceed(() => ""));

          if (comm.trim() !== WORKER_COMM) {
            return { cmdline: "", comm, pid: Number(pid) } satisfies Proc;
          }

          const raw = yield* fs
            .readFileString(`${PROC}/${pid}/cmdline`)
            .pipe(Effect.orElseSucceed(() => ""));

          return {
            cmdline: raw.replaceAll("\0", " ").trim(),
            comm,
            pid: Number(pid),
          } satisfies Proc;
        });

      const ancestors = Effect.gen(function* walk() {
        const seen = new Set<number>();
        const { pid: self } = process;
        let pid = self;

        while (pid > 1 && seen.size < MAX_ANCESTORS) {
          seen.add(pid);

          const stat = yield* fs
            .readFileString(`${PROC}/${pid}/stat`)
            .pipe(Effect.orElseSucceed(() => ""));

          pid = parentPid(stat) ?? 0;
        }

        return seen;
      });

      const facts = Effect.gen(function* facts() {
        if (environment !== "self-hosted") {
          return notOnHost(name);
        }

        const entries = yield* fs.readDirectory(PROC);

        const procs = yield* Effect.forEach(
          entries.filter((entry) => PID.test(entry)),
          readProc,
          { concurrency: PROBE_CONCURRENCY }
        );

        const meminfo = yield* fs.readFileString(`${PROC}/meminfo`);
        const available = memAvailableMb(meminfo);

        if (available === undefined) {
          return notOnHost(name);
        }

        return {
          hostname: name,
          memAvailableMb: available,
          selfHosted: true,
          workerCommands: workerCommands(procs, yield* ancestors),
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
