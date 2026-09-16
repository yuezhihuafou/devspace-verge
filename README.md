# DevSpace Verge

[![CI](https://github.com/yuezhihuafou/devspace-verge/actions/workflows/ci.yml/badge.svg)](https://github.com/yuezhihuafou/devspace-verge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

DevSpace Verge is an independently maintained, agent-optimized derivative of
[Waishnav/devspace](https://github.com/Waishnav/devspace). It preserves the
upstream MIT license and compatible `devspace` CLI/configuration conventions,
while focusing on long-running ChatGPT/Codex-style coding sessions where tool
output size, process lifetime, context quality, and recovery matter.

It is not an official DevSpace release.

## Why Verge exists

The upstream project provides the core idea: expose selected local coding
workspaces through MCP. Verge keeps that foundation and develops it further for
heavy agent workflows rather than treating every tool call as a short,
fully-inline request.

Current Verge-specific work includes:

- bounded model-facing command results while preserving complete local logs
- stable `runId` references with on-demand `read`, `tail`, `grep`, byte-range,
  and metadata retrieval
- durable long-running tasks that can detach from an MCP request and be queried
  later without occupying the conversation
- compact error/status reporting with exit codes and persisted terminal state
- conversation-aware workspace reuse and isolated Git worktree support
- semantic code navigation backed by Serena/LSP with bounded backend reuse
- bounded caches and log retention to control long-session resource growth
- user-level deployment helpers for persistent remote DevSpace installations
- compatibility with the existing local-agent and MCP workflow inherited from
  upstream DevSpace

The design goal is simple: keep the model context high-signal without throwing
away the raw evidence needed for debugging or verification.

## Status

Verge is usable, but it is still an early independent release line. The first
Verge release starts at `0.1.0`; this version number is intentionally separate
from upstream DevSpace's release numbering.

## Requirements

- Node.js `>=22.19 <27`
- pnpm `11.25.0`
- Git
- a Bash-compatible shell for the existing cross-platform workflow

Linux is the primary production environment. macOS and Windows environments
supported by the inherited DevSpace runtime should continue to use the same
compatibility requirements documented upstream.

## Install from source

```bash
git clone https://github.com/yuezhihuafou/devspace-verge.git
cd devspace-verge
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm build
npm link
```

The compatible CLI remains:

```bash
devspace init
devspace doctor
devspace serve
```

For a persistent Linux user service, see `docs/compact-runtime.md` and:

```bash
bash deploy/install-user-service.sh
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
pnpm typecheck
pnpm test
pnpm test:package-install
pnpm build
```

`dev:seed` creates checkout-local development state so source testing does not
modify the normal installation. See `docs/development.md` for the development
and manual-QA workflow.

## Project layout

- `src/` — MCP server, workspace/runtime logic, durable tasks, semantic tooling,
  local-agent integration, and tests
- `bin/` — command-line launchers
- `docs/` — operation, development, security, and Verge runtime documentation
- `deploy/` — persistent user-service deployment helpers
- `schema/` — configuration schema
- `skills/` — agent-facing skills shipped with the project
- `test/` — package/install smoke tests

## Relationship to upstream

DevSpace Verge is derived from
[Waishnav/devspace](https://github.com/Waishnav/devspace), by Waishnav and
contributors. The original copyright and MIT permission notice are preserved
verbatim in `LICENSE` as required by that license. `NOTICE` records the
relationship between the upstream work and this independently maintained
derivative.

Where Verge has not intentionally changed behavior, upstream DevSpace
documentation remains useful as background. Verge-specific behavior and release
instructions in this repository take precedence for this fork.

## License

MIT. See `LICENSE` and `NOTICE`.

The MIT license permits modification, redistribution, publication, sublicensing,
and sale of copies, provided the original copyright and permission notice are
included in copies or substantial portions of the software.
