# Compact runtime and persistent deployment

This fork keeps the upstream DevSpace MCP server and adds a small runtime layer
around shell execution.

## Shell output behavior

`src/pi-tools.ts` still uses the upstream shell tool. After each shell call the
full output is stored locally under:

```text
~/.local/share/devspace/runs/YYYY-MM-DD/<runId>/
```

The MCP-visible result is bounded and includes status, exit code, duration,
output size, a preview, and the `runId`. Additional output can be requested
through the shell tool with:

```text
devspace-log read <runId> <start> <count>
devspace-log tail <runId> [lines]
devspace-log grep <runId> <pattern>
devspace-log bytes <runId> <offset> <length>
devspace-log meta <runId>
```

The other DevSpace capabilities remain in the upstream source tree.

## Persistent user service

From this checkout:

```bash
bash deploy/install-user-service.sh
```

The installer installs dependencies, builds `dist/`, writes a concrete
`~/.config/systemd/user/devspace.service`, stops the old transient compact
service, and enables/restarts the persistent service.

The Cloudflare Tunnel remains a separate service. Use
`deploy/systemd/cloudflared-devspace.service.example` as the version-controlled
unit template; keep the tunnel token out of Git.

## Rollback

```bash
systemctl --user disable --now devspace.service
```

Do not commit `~/.devspace/auth.json`, Cloudflare tokens, or generated
`node_modules/` and `dist/` files.
