# AGENTS.md

Notes for coding agents working on the omreq repository itself. To use omreq in another
project, read [docs/ai.md](docs/ai.md) or [llms-full.txt](llms-full.txt) instead.

## Layout

- `packages/omreq/src` — TypeScript API (`createClient`, `OmreqClient`, `OmreqResponse`,
  profiles, errors). Published as the `omreq` npm package.
- `crates/` — Rust napi-rs bridge; `vendor/` — vendored wreq, wreq-proto and
  http2; `patches/` — patches applied to vendored code.
- `native/omreq-*` — per-platform packages carrying `omreq.node`.
- `profiles/` — bundled browser profiles (`chrome-<major>-macos.json`) and
  `profile-v1.schema.json`. Generated TypeScript lives in `packages/omreq/src`
  (`pnpm generate`); do not edit generated files listed in `.gitignore`.
- `fixtures/references/` — captures from real Chrome used as byte-for-byte regression tests.
- `docs/` — user documentation. `llms.txt` and `llms-full.txt` are built from README and
  `docs/`; `packages/omreq/llms-full.txt` is the copy shipped on npm. Regenerate both
  after changing docs with `pnpm docs:llms`.

## Commands

```bash
pnpm build      # generate + TypeScript + native module
pnpm check      # biome, tsc, cargo fmt/clippy/test, Node and Bun tests
pnpm test       # Node tests only
pnpm profile:new  # capture a new Chrome version (macOS, Chrome installed)
```

## Conventions

- TypeScript and scripts are formatted with Biome (`pnpm format`); Rust with `cargo fmt`.
- A bundled profile change must keep the byte-for-byte comparison with real Chrome
  passing (`pnpm profile:qualify`).
- Public API changes go with updates to `docs/usage.md` (and `README.md` when user-facing).
