#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home_dir=${HOME:?HOME must be set}
node_bin=${NODE_BIN:-$(command -v node || true)}

# Non-login invocations may not export the user systemd bus variables.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "node >=22.19 is required; set NODE_BIN=/path/to/node" >&2
  exit 1
fi

node_version=$($node_bin --version)
echo "Using $node_bin ($node_version)"

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  corepack enable
  pnpm_cmd=(pnpm)
else
  echo "pnpm or corepack is required" >&2
  exit 1
fi

"${pnpm_cmd[@]}" --dir "$repo_root" install --frozen-lockfile
"${pnpm_cmd[@]}" --dir "$repo_root" build

service_dir="${XDG_CONFIG_HOME:-$home_dir/.config}/systemd/user"
mkdir -p "$service_dir"
node_dir=$(dirname "$(readlink -f "$node_bin")")
template="$repo_root/deploy/systemd/devspace.service.in"
unit_path="$service_dir/devspace.service"
backup_path="$service_dir/devspace.service.pre-personal-fork"
tmp_path=$(mktemp "$service_dir/devspace.service.XXXXXX")
trap 'rm -f "$tmp_path"' EXIT

if [[ -f "$unit_path" && ! -f "$backup_path" ]]; then
  cp -p "$unit_path" "$backup_path"
  echo "Saved previous service as $backup_path"
fi

sed \
  -e "s|@REPO_ROOT@|$repo_root|g" \
  -e "s|@HOME_DIR@|$home_dir|g" \
  -e "s|@NODE_BIN@|$node_bin|g" \
  -e "s|@NODE_DIR@|$node_dir|g" \
  "$template" > "$tmp_path"
chmod 0644 "$tmp_path"
mv "$tmp_path" "$unit_path"
trap - EXIT

# The transient timer must stop before its service, otherwise it can
# immediately recreate the old process and reclaim port 7676.
systemctl --user stop devspace-compact-live.timer 2>/dev/null || true
systemctl --user stop devspace-compact-live.service 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable devspace.service
systemctl --user restart devspace.service

echo "Installed and started $unit_path"
if [[ -f "$backup_path" ]]; then
  echo "Rollback backup: $backup_path"
fi
systemctl --user --no-pager --full status devspace.service
