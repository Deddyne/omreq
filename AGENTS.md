# AGENTS.md

Notes for coding agents working on the omreq repository itself. To use omreq in another
project, read [docs/ai.md](docs/ai.md) or [llms-full.txt](llms-full.txt) instead.

## Layout

- `packages/omreq/src` — TypeScript API (`createClient`, `OmreqClient`, `OmreqResponse`,
  profiles, errors). Published as the `omreq` npm package.
- `crates/` — Rust napi-rs bridge; `vendor/` — vendored wreq, wreq-proto, http2,
  quic, quic-proto and http3; `patches/` — patches applied to vendored code.
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

## Upstream updates

`vendor/<crate>` is upstream source plus `patches/<crate>-<version>.patch`, pinned by
`patches/vendor-manifest.json`. `scripts/upstream.mjs` lists the vendored crates (wreq,
wreq-proto, http2 from crates.io; quic, quic-proto, http3 as `cargo package` of a git
revision), the `=`-pinned crates (wreq-rt, chromium-roots, webpki-root-certs) and btls
(git rev in `[patch.crates-io]`).

- `.github/workflows/upstream.yml` runs daily. `scripts/upstream-check.mjs` compares
  crates.io and the btls git HEAD with what we pin, and Chrome stable with the newest
  profile. Each update is re-vendored by `scripts/upgrade-vendor.mjs`, built and checked
  on the three CI platforms (`pnpm profile:qualify` too when the macOS runner's Chrome is
  the profile's exact version), then opened as a PR on `upstream/<crate>-<version>`.
  A patch that no longer applies or a failing check opens one issue per crate and version
  with the log instead; it is retried when `main` moves, or by running the workflow with
  `retry`. A new Chrome major opens an issue: capture it with `pnpm profile:new` on a Mac.
  Set an `UPSTREAM_TOKEN` secret (fine-grained, contents/PR/issue write) so these PRs run
  `ci.yml`; with the default token, also allow Actions to create pull requests.
- By hand: `node scripts/upgrade-vendor.mjs <crate> <version|git-rev|latest> [...]`.
  It applies our patch with `git apply`, falling back to a 3-way merge against the old
  upstream source; on conflict it exits 2 and prints the conflicts and rejected hunks.
  Otherwise it rewrites `vendor/<crate>`, renames and regenerates the patch
  (`refresh-transport.mjs`), and updates the manifest, Cargo pins, `Cargo.lock`, version
  strings, `patches/transport.json` and `THIRD_PARTY_NOTICES.md`. `--dry-run` only reports.
  Upgrade quic and quic-proto together. Review prose that names an upstream revision, such
  as `vendor/*/OMREQ_PATCHES.md` and `transport.json` backport notes.
- `.github/dependabot.yml` covers the remaining Cargo, npm and Actions dependencies and
  ignores the crates above. Cargo and npm runtime bumps need `node scripts/notices.mjs`.
