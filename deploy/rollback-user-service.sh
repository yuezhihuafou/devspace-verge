#!/usr/bin/env bash
set -euo pipefail

home_dir=${HOME:?HOME must be set}
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

service_dir="${XDG_CONFIG_HOME:-$home_dir/.config}/systemd/user"
unit_path="$service_dir/devspace.service"
backup_path="$service_dir/devspace.service.pre-personal-fork"

if [[ ! -f "$backup_path" ]]; then
  echo "No saved pre-fork service found at $backup_path" >&2
  exit 1
fi

cp -p "$backup_path" "$unit_path"
systemctl --user daemon-reload
systemctl --user enable devspace.service
systemctl --user restart devspace.service

echo "Restored $unit_path from $backup_path"
systemctl --user --no-pager --full status devspace.service
