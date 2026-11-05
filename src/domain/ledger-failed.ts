import { Schema } from "effect";

export class LedgerFailed extends Schema.TaggedError<
  LedgerFailed,
  { readonly brand: unique symbol }
>()("LedgerFailed", {
  operation: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `RUNNER_ROUTER_LEDGER_FAILED: ${this.operation} failed (${this.reason}). Fix: the workflow run needs the artifact service environment, which only JS actions on a runner receive.`;
  }
}
