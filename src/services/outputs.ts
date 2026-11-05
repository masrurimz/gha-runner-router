import type { Decision } from "../domain/decision.ts";

export const formatOutputs = (decision: Decision): string =>
  [
    `runs-on=${JSON.stringify(decision.pool.runsOn)}`,
    `pool=${decision.pool.name}`,
    `workers=${decision.pool.workers}`,
    `reason=${decision.reason}`,
    "",
  ].join("\n");

export const formatSummary = (decision: Decision): string =>
  [
    "### gha-runner-router",
    "",
    "| Pool | runs-on | Workers | Queued |",
    "| --- | --- | --- | --- |",
    `| ${decision.pool.name} | \`${JSON.stringify(decision.pool.runsOn)}\` | ${decision.pool.workers} | ${decision.queued ? "yes" : "no"} |`,
    "",
    decision.reason,
    "",
  ].join("\n");
