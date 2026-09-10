<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace Verge</h1>

<p align="center">An Agent-optimized unofficial fork of DevSpace.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="upstream npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/devspace/actions/workflows/ci.yml"><img alt="upstream CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/devspace/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

> [!IMPORTANT]
> **DevSpace Verge is an unofficial fork of [Waishnav/devspace](https://github.com/Waishnav/devspace).**
> The upstream project and original DevSpace code are by Waishnav and contributors.
> This fork keeps the upstream MIT license and focuses on model-facing output efficiency,
> persistent command logs, and reliability for long-running Agent workflows.

## What Verge changes

Compared with upstream DevSpace, Verge adds an Agent-friendly compact runtime:

- compact model-facing command results instead of sending large shell logs into the LLM context
- full local command-log persistence with stable `runId` references
- on-demand `devspace-log read`, `tail`, `grep`, `bytes`, and `meta` retrieval
- adaptive previews for inspection, verification/build, normal, and failed commands
- explicit process failure metadata such as exit code and MCP error state
- bounded log retention so persistent logs do not grow without limit
- user-level persistent deployment helpers for long-running DevSpace installations

The goal is to keep the model context high-signal while preserving the complete raw output locally for debugging.

[![DevSpace connected to ChatGPT](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)

**Give ChatGPT a secure connection to your own machine and turn ChatGPT into Codex.**

DevSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

The same `/mcp` endpoint serves the 2026-07-28 per-request protocol and automatically supports older 2025-era clients through stateless compatibility handling. There is no protocol mode to configure.

## Installation

DevSpace requires Node `>=22.19 <27`.

The published npm package below is the **upstream DevSpace package**:

```bash
npm install -g @waishnav/devspace
```

Then initialize DevSpace:

```bash
devspace init
```

Or run the upstream package without a global install:

```bash
npx @waishnav/devspace init
```

To use the Verge-specific changes, clone this repository and build it from source; see [Verge additions](#verge-additions) and [Local Development](#local-development).

During setup, DevSpace asks for:

- where you will use it: ChatGPT, Coding Agents, or both
- which Coding Agents DevSpace may use

If you select ChatGPT, setup also asks which local project folders it may open
and for your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy,
Tailscale Funnel, or another reverse proxy. A Coding Agents-only setup asks
neither question: local commands use the current Git project, or the current
directory outside a repository.

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.
Run `devspace serve` when using ChatGPT. For Coding Agents, setup prints a
`skills` command and lets the Skills CLI handle installation.

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `devspace init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

> [!NOTE]
> Using DevSpace as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> DevSpace. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

DevSpace gives ChatGPT tools to:

- read, write, and edit files inside the opened workspace
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

DevSpace supports Linux, macOS, and Windows environments with a Bash-compatible
shell.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Run this to inspect your local setup:

```bash
devspace doctor
```

## Verge additions

This fork includes a compact shell-output runtime and a user-level systemd
installer. The runtime preserves full shell logs locally while keeping
model-facing results bounded. See [the deployment guide](docs/compact-runtime.md)
and run:

```bash
bash deploy/install-user-service.sh
```

## Documentation

The following upstream documentation remains applicable to Verge unless a Verge-specific document says otherwise:

- [Setup Guide](https://github.com/Waishnav/devspace/blob/main/docs/setup.md)
- [ChatGPT Coding Workflow](https://github.com/Waishnav/devspace/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)
- [Native File Download](https://github.com/Waishnav/devspace/blob/main/docs/artifact-exchange.md)
- [Security Model](https://github.com/Waishnav/devspace/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/Waishnav/devspace/blob/main/docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

DevSpace is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

Verge keeps that foundation and focuses specifically on making long-running,
tool-heavy Agent sessions more context-efficient and operationally robust.

## Upstream attribution

DevSpace Verge is derived from **[Waishnav/devspace](https://github.com/Waishnav/devspace)**.
The original DevSpace project is by **Waishnav and contributors**. Their copyright
notice and the MIT license are preserved in this repository's `LICENSE` file.

DevSpace Verge is independent and is **not an official DevSpace release**.

## Local Development

For working on DevSpace Verge itself:

Install pnpm 11.25.0, the version pinned in `package.json`, with
`npm install --global pnpm@11.25.0`, then:

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`dev:seed` forks your normal DevSpace config and SQLite state into an ignored
checkout-local `.devspace-dev/` directory so source builds and migrations do not
modify your normal installation. Use `pnpm dev:reset` to discard that QA state
and fork it again. See [Development and Manual QA](docs/development.md) for
worktree switching, ChatGPT, and database-migration workflows.
