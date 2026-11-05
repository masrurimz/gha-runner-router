// @effect-diagnostics asyncFunction:off -- The Actions artifact SDK is promise based and the lint fence requires its adapter callbacks to be async.
import { DefaultArtifactClient } from "@actions/artifact";
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";

import { LedgerFailed } from "../domain/ledger-failed.ts";
import { LedgerSchema } from "../domain/ledger.ts";
import type { Ledger } from "../domain/ledger.ts";
import { GithubApi } from "./github-api.ts";

const RETENTION_DAYS = 31;

const LEDGER_FILE = "ledger.json";

const encodeLedger = Schema.encodeEffect(Schema.fromJsonString(LedgerSchema));

const decodeLedger = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LedgerSchema)
);

export const artifactName = (month: string): string =>
  `gha-runner-router-ledger-${month}`;

const failed = (operation: string) => (cause: { readonly message: string }) =>
  new LedgerFailed({ operation, reason: cause.message });

export class LedgerStore extends Context.Service<LedgerStore>()(
  "gha-runner-router/services/LedgerStore",
  {
    make: Effect.gen(function* make() {
      const fs = yield* FileSystem.FileSystem;

      const api = yield* GithubApi;

      const token = yield* Config.String("INPUT_GITHUB-TOKEN");

      const repository = yield* Config.String("GITHUB_REPOSITORY");

      const [repositoryOwner = "", repositoryName = ""] = repository.split("/");

      const client = new DefaultArtifactClient();

      const load = Effect.fn("LedgerStore.load")(function* load(month: string) {
        const found = yield* api.findArtifact(artifactName(month));

        if (Option.isNone(found)) {
          return Option.none<Ledger>();
        }

        const artifact = found.value;

        const directory = yield* fs
          .makeTempDirectory({ prefix: "runner-router-load-" })
          .pipe(Effect.mapError(failed("create temp directory")));

        yield* Effect.tryPromise({
          catch: (cause) =>
            new LedgerFailed({
              operation: "download ledger artifact",
              reason: String(cause),
            }),
          try: async () =>
            await client.downloadArtifact(artifact.id, {
              findBy: {
                repositoryName,
                repositoryOwner,
                token,
                workflowRunId: artifact.runId,
              },
              path: directory,
            }),
        });

        const text = yield* fs
          .readFileString(`${directory}/${LEDGER_FILE}`)
          .pipe(Effect.mapError(failed("read ledger artifact")));

        return yield* decodeLedger(text).pipe(
          Effect.map((ledger) => Option.some<Ledger>(ledger)),
          Effect.orElseSucceed(() => Option.none<Ledger>())
        );
      });

      const save = Effect.fn("LedgerStore.save")(function* save(
        ledger: Ledger
      ) {
        const directory = yield* fs
          .makeTempDirectory({ prefix: "runner-router-save-" })
          .pipe(Effect.mapError(failed("create temp directory")));

        const file = `${directory}/${LEDGER_FILE}`;

        const text = yield* encodeLedger(ledger).pipe(
          Effect.mapError(failed("encode ledger"))
        );

        yield* fs
          .writeFileString(file, text)
          .pipe(Effect.mapError(failed("write ledger file")));

        yield* Effect.tryPromise({
          catch: (cause) =>
            new LedgerFailed({
              operation: "upload ledger artifact",
              reason: String(cause),
            }),
          try: async () =>
            await client.uploadArtifact(
              artifactName(ledger.month),
              [file],
              directory,
              { retentionDays: RETENTION_DAYS }
            ),
        });
      });

      return { load, save };
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly fake = (store: LedgerStore["Service"]) =>
    Layer.succeed(this, store);
}
