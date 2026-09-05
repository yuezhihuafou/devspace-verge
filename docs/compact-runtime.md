# Compact runtime and persistent deployment

This personal fork keeps the upstream DevSpace MCP server and adds bounded
model-facing command output while preserving full execution logs locally.

## Command output behavior

Both supported command surfaces are covered:

- the Claude-style `bash` tool in `src/pi-tools.ts`
- the process-based `exec_command` / `write_stdin` tools

Full output is stored locally under:

```text
~/.local/share/devspace/runs/YYYY-MM-DD/<runId>/
```

Long-running process sessions keep the same `runId` across `write_stdin` polls.
The MCP-visible result stays bounded and includes status, exit code or running
state, duration, output size, a preview, and the `runId`.

Additional output can be requested with:

```text
devspace-log read <runId> <start> <count>
devspace-log tail <runId> [lines]
devspace-log grep <runId> <pattern>
devspace-log bytes <runId> <offset> <length>
devspace-log meta <runId>
```

`exec_command` handles these `devspace-log` forms internally; they are not
external executables that must be installed on the host.

## Retention

By default, run logs are retained for up to 30 days and the store targets a
2 GiB maximum. The limits can be changed with:

```text
DEVSPACE_COMPACT_LOG_RETENTION_DAYS
DEVSPACE_COMPACT_LOG_MAX_BYTES
```

Cleanup operates on individual runs, oldest first. The run that just completed
is protected from its own cleanup pass, so a single run larger than the byte
limit may temporarily exceed the limit; older runs are removed first.

## Persistent user service

From this checkout:

```bash
bash deploy/install-user-service.sh
```

The installer installs dependencies, builds `dist/`, writes a concrete
`~/.config/systemd/user/devspace.service`, stops the old transient compact
service, and enables/restarts the persistent service.

On the first install, an existing service unit is preserved as:

```text
~/.config/systemd/user/devspace.service.pre-personal-fork
```

The Cloudflare Tunnel remains a separate service. Use
`deploy/systemd/cloudflared-devspace.service.example` as the version-controlled
unit template; keep the tunnel token out of Git.

## Rollback

If the installer saved a pre-fork service, restore and restart it with:

```bash
bash deploy/rollback-user-service.sh
```

The repository is marked as a private npm package to prevent accidentally
publishing the personal fork under the upstream package identity.

Do not commit `~/.devspace/auth.json`, Cloudflare tokens, generated
`node_modules/`, `dist/`, or local run logs.
