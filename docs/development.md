# Development and Manual QA

Use the installed DevSpace Verge checkout for normal work. When testing DevSpace
itself, run the source checkout against a checkout-local fork of your DevSpace
configuration and SQLite state.

## First run in a checkout

Install dependencies, then seed the checkout from your normal DevSpace setup:

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
```

`dev:seed` creates an ignored `.devspace-dev/` directory in the current
checkout. It copies the current config, auth file, DevSpace-local skills and
agent profiles, and makes a SQLite backup of the configured state database. The
copied config is rewritten so `storage.stateDir` points at the checkout-local
state directory. By default, the QA server uses an isolated loopback port
(source port plus 1000 where possible) and loopback public URL. OAuth clients,
authorization codes, access tokens, and refresh tokens are removed from the
**QA backup only**. The production database and credentials are not modified.

`pnpm dev` only uses that local QA configuration. If the checkout has not been
seeded, it stops with an instruction to run `pnpm dev:seed` instead of silently
falling back to your normal DevSpace state.

By default the seed source is `~/.devspace`. If your normal installation uses a
custom `DEVSPACE_CONFIG_DIR`, keep that value exported while using `dev:seed`
and `dev:reset` so both commands fork the same installation.

## Testing with ChatGPT

The QA server now uses a separate loopback origin. The installed production
server and its tunnel can continue running without competing for the QA port.
Use `pnpm dev` for local QA and unit tests. To test with ChatGPT, supply the QA
instance with its **own** HTTPS tunnel URL and a **separate** ChatGPT MCP
connection. Do not point the existing production connector at a QA database
copy.

Old `.devspace-dev` directories seeded before this change can still contain
production OAuth state and URLs. Run `pnpm dev:reset` in the source checkout
to re-isolate them. `pnpm dev` refuses to launch a fork with the same
production public URL but a different state directory.

This restriction prevents independent refresh-token rotation from invalidating
an existing ChatGPT connection when switching between production and QA.

## Switching between worktrees

Each worktree keeps its own `.devspace-dev/` state:

```bash
# worktree A
pnpm dev:seed
pnpm dev

# stop it, then switch to worktree B
pnpm dev:seed
pnpm dev
```

Once a worktree has been seeded, later runs only need `pnpm dev`.

This keeps source changes and OAuth identities isolated without requiring
DevSpace to know which Git branch or worktree is active.

## Database and migration changes

Do not point experimental source builds at your normal DevSpace state directory.
Use the checkout-local fork so migrations operate on disposable data that began
as a realistic copy of your current installation.

To repeat a migration from the same baseline, discard the checkout QA state and
fork it again:

```bash
pnpm dev:reset
pnpm dev
```

`dev:reset` replaces the entire `.devspace-dev/` directory from the current
normal DevSpace config and state. Any QA-only workspace sessions, OAuth changes,
agent sessions, and database migrations in that checkout are discarded.

DevSpace also validates the migration journal at startup. If an applied
migration version has a different name than the current build expects, or the
database contains a migration version unknown to the build, startup fails
instead of silently using an incompatible schema.

## Normal verification

The usual repository checks are:

```bash
pnpm typecheck
pnpm test
pnpm test:package-install
pnpm build
```

## Releases

DevSpace Verge uses its own release line, independent of upstream DevSpace.
Releases are created by the manual `Release` GitHub Actions workflow.

The workflow only accepts runs dispatched from `main`, and the exact commit must
already have a successful `CI` push run. The requested version must exactly
match `package.json`.

Supported versions are:

```text
0.1.0
0.2.0-beta.1
0.2.0-rc.1
```

The workflow verifies the source, packs the repository with `npm pack`, attaches
the resulting tarball to a GitHub Release, and creates the matching `vX.Y.Z`
tag. Stable releases are marked latest; beta and release-candidate versions are
marked prerelease.

Verge does not currently publish to the upstream npm package or use the upstream
npm publishing identity. Do not publish under `@waishnav/devspace`.

Before a release, verify that `LICENSE` still preserves the upstream MIT
copyright and permission notice and that `NOTICE` accurately describes the
relationship to the upstream project.
