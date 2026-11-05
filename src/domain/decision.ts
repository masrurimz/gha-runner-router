import { Option } from "effect";

import type { LocalPool, MeteredPool, Pool } from "./pool.ts";
import { poolLabelKey } from "./pool.ts";
import type { Routing } from "./routing.ts";

export interface HostFacts {
  readonly selfHosted: boolean;
  readonly hostname: string;
  readonly busyWorkers: number;
  readonly memAvailableMb: number;
}

export type Usage = Option.Option<ReadonlyMap<string, number>>;

export interface Verdict {
  readonly available: boolean;
  readonly note: string;
}

export interface Decision {
  readonly pool: Pool;
  readonly queued: boolean;
  readonly reason: string;
}

const BASIS_POINTS = 10_000;

const onPoolHost = (pool: LocalPool, host: HostFacts): boolean =>
  host.selfHosted &&
  Option.match(pool.host, {
    onNone: () => true,
    onSome: (name) => name.toLowerCase() === host.hostname.toLowerCase(),
  });

export const judgeLocal = (pool: LocalPool, host: HostFacts): Verdict => {
  if (!onPoolHost(pool, host)) {
    return {
      available: false,
      note: `${pool.name} skipped, the router job is not on its host`,
    };
  }

  if (host.busyWorkers >= pool.slots) {
    return {
      available: false,
      note: `${pool.name} busy ${host.busyWorkers}/${pool.slots} slots`,
    };
  }

  if (host.memAvailableMb < pool.minAvailableMb) {
    return {
      available: false,
      note: `${pool.name} low memory ${host.memAvailableMb} MB < ${pool.minAvailableMb} MB`,
    };
  }

  return {
    available: true,
    note: `${pool.name} has a free slot (${host.busyWorkers}/${pool.slots} busy, ${host.memAvailableMb} MB available)`,
  };
};

export const judgeMetered = (
  pool: MeteredPool,
  usage: Usage,
  reserveBp: number
): Verdict => {
  if (Option.isNone(usage)) {
    return {
      available: false,
      note: `${pool.name} skipped, usage could not be read`,
    };
  }

  const used = usage.value.get(poolLabelKey(pool)) ?? 0;
  const burned = used * pool.minuteMultiplier;
  const limit = (reserveBp * pool.freeMinutes) / BASIS_POINTS;
  const figures = `${burned}/${pool.freeMinutes} min used, full at ${limit}`;

  return burned * BASIS_POINTS < reserveBp * pool.freeMinutes
    ? { available: true, note: `${pool.name} under reserve (${figures})` }
    : { available: false, note: `${pool.name} at reserve (${figures})` };
};

const judge = (
  pool: Pool,
  host: HostFacts,
  usage: Usage,
  reserveBp: number
): Verdict =>
  pool.kind === "local"
    ? judgeLocal(pool, host)
    : judgeMetered(pool, usage, reserveBp);

export const decide = (
  routing: Routing,
  host: HostFacts,
  usage: Usage
): Decision => {
  const verdicts: Verdict[] = [];

  for (const pool of routing.pools) {
    const verdict = judge(pool, host, usage, routing.reserveBp);

    verdicts.push(verdict);

    if (verdict.available) {
      return {
        pool,
        queued: false,
        reason: `${pool.name}: ${verdicts.map((entry) => entry.note).join("; ")}`,
      };
    }
  }

  return {
    pool: routing.fallback,
    queued: true,
    reason: `${routing.fallback.name} (fallback): ${verdicts.map((entry) => entry.note).join("; ")}`,
  };
};

export const usageNeeded = (
  routing: Routing,
  withoutUsage: Decision
): boolean => {
  const reached = withoutUsage.queued
    ? routing.pools
    : routing.pools.slice(0, routing.pools.indexOf(withoutUsage.pool) + 1);

  return reached.some((pool) => pool.kind === "metered");
};
