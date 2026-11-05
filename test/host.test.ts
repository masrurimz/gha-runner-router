import { assert, describe, it } from "@effect/vitest";

import { parentPid, workerCommands } from "../src/services/host.ts";
import type { Proc } from "../src/services/host.ts";

const worker = (pid: number, dir: string): Proc => ({
  cmdline: `/home/u/actions-runners/${dir}/bin/Runner.Worker spawnclient 5 6`,
  comm: "Runner.Worker\n",
  pid,
});

const other = (pid: number): Proc => ({ cmdline: "", comm: "node\n", pid });

describe("parentPid", () => {
  it("reads the parent from a stat line, even when the name has spaces and parens", () => {
    assert.strictEqual(parentPid("812 (node) S 640 812 640 0 -1 4194560"), 640);
    assert.strictEqual(
      parentPid("813 (Runner (x) Worker) R 641 813 641 0 -1"),
      641
    );
  });

  it("answers nothing for a line it cannot read", () => {
    assert.isUndefined(parentPid(""));
    assert.isUndefined(parentPid("garbage"));
  });
});

describe("workerCommands", () => {
  it("lists the command line of every Runner.Worker, other runners included", () => {
    const procs = [
      worker(10, "alkhidmah-tech-2"),
      other(11),
      worker(12, "alumni-pens"),
    ];

    const commands = workerCommands(procs, new Set());

    assert.strictEqual(commands.length, 2);
    assert.include(commands[0], "alkhidmah-tech-2");
    assert.include(commands[1], "alumni-pens");
  });

  it("leaves out the worker that runs the router itself, and only that one", () => {
    const procs = [
      worker(10, "alkhidmah-tech-4"),
      worker(12, "alkhidmah-tech"),
    ];

    const commands = workerCommands(procs, new Set([10, 11, 99]));

    assert.strictEqual(commands.length, 1);
    assert.include(commands[0], "actions-runners/alkhidmah-tech/");
  });
});
