import { Schema } from "effect";

export class GithubFailed extends Schema.TaggedError<
  GithubFailed,
  { readonly brand: unique symbol }
>()("GithubFailed", {
  operation: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `RUNNER_ROUTER_GITHUB_FAILED: ${this.operation} failed (${this.reason}). Fix: give the job "permissions: actions: read" and check the github-token input.`;
  }
}
