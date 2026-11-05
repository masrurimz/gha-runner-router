# Provenance

gha-runner-router bans comments in code (see AGENTS.md). Credit for borrowed code lives here instead. The tooling is copied from `omp-org-account-router`, which copied it from `omp-agent-mesh`, which ported it from rat-stack.

| Code | Origin | Notes |
| --- | --- | --- |
| `oxlint.config.ts`, `oxfmt.config.ts`, the Effect diagnostics map in `tsconfig.json`, `.pre-commit-config.yaml` | [rat-stack](https://github.com/joelhooks/rat-stack) via `omp-agent-mesh` and `omp-org-account-router` (MIT) | Copied; `tsconfig.json` swaps the platform package for `@effect/platform-node` and allows `effect/http`, and `typecheck:fast` calls `tsrs` directly. |
| `scripts/oxlint-plugin-no-comments.ts`, `scripts/oxlint-plugin-patterns.ts` | rat-stack `scripts/` via `omp-agent-mesh` (MIT) | Copied unchanged. |
| `scripts/oxlint-plugin-effect-tests.ts` | [t3code](https://github.com/pingdotgg/t3code) `no-manual-effect-runtime-in-tests.ts`, via rat-stack | Copied unchanged. |
| `scripts/oxlint-plugin-xstate-effect.ts` | [statelyai/xstate](https://github.com/statelyai/xstate) `scripts/oxlint-plugin-xstate-effect.mjs`, MIT, via rat-stack | Copied unchanged; inert here because there are no machines. |
| `tools/oxlint/anti-slop/` | [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `c44ef22`, MIT, via rat-stack | Vendored; see `UPSTREAM.md` there. |
| Bundled `dist/index.js` | [`@actions/artifact`](https://github.com/actions/toolkit) (MIT), [Effect](https://github.com/Effect-TS/effect) (MIT), [yaml](https://github.com/eemeli/yaml) (ISC) and their dependencies | Built by `bun run build`; licenses of the bundled packages are in `node_modules` at build time. |

Not copied from `omp-org-account-router`: `.omp/extensions/vcs-policy.ts`, `scripts/vcs-command-policy.ts`, `scripts/smoke.ts` and everything under `src/omp/`, because they belong to the omp extension this repo does not have.
