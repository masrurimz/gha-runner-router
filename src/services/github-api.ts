import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { GithubFailed } from "../domain/github-failed.ts";
import type { JobRecord, RunRef } from "../domain/ledger.ts";

const NOT_FOUND = 404;

const PAGE_SIZE = 100;

const MAX_PAGES = 10;

const RunSchema = Schema.Struct({
  created_at: Schema.String,
  id: Schema.Finite,
  status: Schema.NullOr(Schema.String),
});

const RunsPageSchema = Schema.Struct({
  workflow_runs: Schema.Array(RunSchema),
});

const JobsPageSchema = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      completed_at: Schema.NullOr(Schema.String),
      labels: Schema.Array(Schema.String),
      started_at: Schema.NullOr(Schema.String),
    })
  ),
});

const ArtifactsPageSchema = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      expired: Schema.Boolean,
      id: Schema.Finite,
      workflow_run: Schema.NullOr(Schema.Struct({ id: Schema.Finite })),
    })
  ),
});

export interface ArtifactRef {
  readonly id: number;
  readonly runId: number;
}

const toRunRef = (run: typeof RunSchema.Type): RunRef => ({
  completed: run.status === "completed",
  createdAt: run.created_at,
  id: run.id,
});

const decode = <S extends Schema.Constraint>(
  operation: string,
  schema: S,
  response: HttpClientResponse.HttpClientResponse
) =>
  HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.mapError(
      (failure) => new GithubFailed({ operation, reason: failure.message })
    )
  );

export class GithubApi extends Context.Service<GithubApi>()(
  "gha-runner-router/services/GithubApi",
  {
    make: Effect.gen(function* make() {
      const client = yield* HttpClient.HttpClient;
      const token = yield* Config.Redacted("INPUT_GITHUB-TOKEN");
      const repository = yield* Config.String("GITHUB_REPOSITORY");

      const base = yield* Config.String("GITHUB_API_URL").pipe(
        Config.withDefault("https://api.github.com")
      );

      const send = (
        operation: string,
        path: string,
        params: Readonly<Record<string, string>>
      ) =>
        client
          .execute(
            HttpClientRequest.get(
              `${base}/repos/${repository}/actions/${path}`
            ).pipe(
              HttpClientRequest.bearerToken(Redacted.value(token)),
              HttpClientRequest.setHeader(
                "Accept",
                "application/vnd.github+json"
              ),
              HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
              HttpClientRequest.setUrlParams(params)
            )
          )
          .pipe(
            Effect.retry({ times: 2 }),
            Effect.mapError(
              (failure) =>
                new GithubFailed({ operation, reason: failure.message })
            )
          );

      const getJson = <S extends Schema.Constraint>(
        operation: string,
        path: string,
        params: Readonly<Record<string, string>>,
        schema: S
      ) =>
        send(operation, path, params).pipe(
          Effect.flatMap((response) => decode(operation, schema, response))
        );

      const listRuns = Effect.fn("GithubApi.listRuns")(function* listRuns(
        since: string
      ) {
        const runs: RunRef[] = [];

        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const body = yield* getJson(
            `list workflow runs since ${since}`,
            "runs",
            {
              created: `>=${since}`,
              page: String(page),
              per_page: String(PAGE_SIZE),
            },
            RunsPageSchema
          );

          runs.push(...body.workflow_runs.map(toRunRef));

          if (body.workflow_runs.length < PAGE_SIZE) {
            break;
          }
        }

        return runs;
      });

      const getRun = Effect.fn("GithubApi.getRun")(function* getRun(
        id: number
      ) {
        const operation = `get workflow run ${id}`;
        const response = yield* send(operation, `runs/${id}`, {});

        if (response.status === NOT_FOUND) {
          return Option.none<RunRef>();
        }

        const body = yield* decode(operation, RunSchema, response);

        return Option.some(toRunRef(body));
      });

      const listJobs = Effect.fn("GithubApi.listJobs")(function* listJobs(
        runId: number
      ) {
        const jobs: JobRecord[] = [];

        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const body = yield* getJson(
            `list jobs of run ${runId}`,
            `runs/${runId}/jobs`,
            {
              filter: "all",
              page: String(page),
              per_page: String(PAGE_SIZE),
            },
            JobsPageSchema
          );

          jobs.push(
            ...body.jobs.map((job) => ({
              completedAt: job.completed_at,
              labels: job.labels,
              startedAt: job.started_at,
            }))
          );

          if (body.jobs.length < PAGE_SIZE) {
            break;
          }
        }

        return jobs;
      });

      const findArtifact = Effect.fn("GithubApi.findArtifact")(
        function* findArtifact(name: string) {
          const body = yield* getJson(
            `find artifact ${name}`,
            "artifacts",
            { name, per_page: "1" },
            ArtifactsPageSchema
          );

          return Option.fromNullishOr(body.artifacts[0]).pipe(
            Option.filter((artifact) => !artifact.expired),
            Option.flatMap((artifact) =>
              Option.map(
                Option.fromNullishOr(artifact.workflow_run),
                (run): ArtifactRef => ({ id: artifact.id, runId: run.id })
              )
            )
          );
        }
      );

      return { findArtifact, getRun, listJobs, listRuns };
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly fake = (api: GithubApi["Service"]) =>
    Layer.succeed(this, api);
}
