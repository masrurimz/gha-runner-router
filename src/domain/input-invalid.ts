import { Schema } from "effect";

export class InputInvalid extends Schema.TaggedError<
  InputInvalid,
  { readonly brand: unique symbol }
>()("InputInvalid", {
  input: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `RUNNER_ROUTER_INPUT_INVALID: input "${this.input}" is invalid (${this.reason}). Fix: see the inputs table in the README.`;
  }
}
