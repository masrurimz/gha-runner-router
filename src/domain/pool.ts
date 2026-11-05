import type { Option } from "effect";

export interface LocalPool {
  readonly kind: "local";
  readonly name: string;
  readonly runsOn: readonly string[];
  readonly workers: number;
  readonly slots: number;
  readonly minAvailableMb: number;
  readonly host: Option.Option<string>;
}

export interface MeteredPool {
  readonly kind: "metered";
  readonly name: string;
  readonly runsOn: readonly string[];
  readonly workers: number;
  readonly freeMinutes: number;
  readonly minuteMultiplier: number;
}

export type Pool = LocalPool | MeteredPool;

export const labelKey = (labels: readonly string[]): string =>
  labels
    .map((label) => label.toLowerCase())
    .toSorted()
    .join(",");

export const poolLabelKey = (pool: Pool): string => labelKey(pool.runsOn);
