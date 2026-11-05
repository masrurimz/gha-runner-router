const DIST = "dist/index.js";

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  format: "esm",
  minify: false,
  target: "node",
});

if (!result.success) {
  throw new AggregateError(result.logs, "bundle failed");
}

const [artifact] = result.outputs;

if (artifact === undefined) {
  throw new Error("bundle produced no output");
}

const bundled = await artifact.text();

if (Bun.argv.includes("--check")) {
  const committed = await Bun.file(DIST).text();

  if (committed !== bundled) {
    throw new Error(
      `${DIST} is stale. Fix: run "bun run build" and commit it.`
    );
  }
} else {
  await Bun.write(DIST, bundled);
}
