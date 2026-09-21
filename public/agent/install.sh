#!/bin/sh
set -eu

BASE_URL="${HIGHSEAS_MONITOR_BASE_URL:-https://raw.githubusercontent.com/gongseas/highseas-webssh-edge/main/public/agent}"
VERSION="0.3.0"
BINARY="/usr/local/sbin/highseas-monitor"
SERVICE="/etc/systemd/system/highseas-monitor.service"

say() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

download() {
  url="$1"
  output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$output" "$url"
  else
    fail "curl or wget is required"
  fi
}

[ "$(id -u)" = "0" ] || fail "run with sudo or as root"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"

if [ "${1:-}" = "--uninstall" ]; then
  say "Stopping Highseas Monitor"
  systemctl disable --now highseas-monitor.service 2>/dev/null || true
  rm -f "$SERVICE" "$BINARY"
  rm -rf /run/highseas-monitor
  systemctl daemon-reload
  say "Highseas Monitor removed"
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) architecture="amd64" ;;
  aarch64|arm64) architecture="arm64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT INT TERM
asset="highseas-monitor-linux-$architecture"

say "Downloading Highseas Monitor for linux/$architecture"
download "$BASE_URL/$asset?v=$VERSION" "$temporary/$asset"
download "$BASE_URL/SHA256SUMS.txt?v=$VERSION" "$temporary/SHA256SUMS.txt"
# Release files may be produced on Windows. Remove CR so GNU awk sees the
# asset name exactly as it appears on Linux.
expected="$(tr -d '\r' < "$temporary/SHA256SUMS.txt" | awk -v name="$asset" '$2 == name { print $1; exit }')"
[ -n "$expected" ] || fail "checksum not found for $asset"
actual="$(sha256sum "$temporary/$asset" | awk '{ print $1 }')"
[ "$actual" = "$expected" ] || fail "checksum verification failed"

getent group highseas-monitor >/dev/null 2>&1 || groupadd --system highseas-monitor
install -m 0755 "$temporary/$asset" "$BINARY.new"
mv -f "$BINARY.new" "$BINARY"

cat > "$SERVICE" <<'UNIT'
[Unit]
Description=Highseas UDP connection monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=highseas-monitor
ExecStart=/usr/local/sbin/highseas-monitor daemon
Restart=on-failure
RestartSec=3
RuntimeDirectory=highseas-monitor
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
UMask=0007
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_PACKET AF_INET AF_INET6
CapabilityBoundingSet=CAP_NET_RAW CAP_DAC_READ_SEARCH CAP_SYS_PTRACE

[Install]
WantedBy=multi-user.target
UNIT

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  usermod -aG highseas-monitor "$SUDO_USER" || true
fi

say "Starting Highseas Monitor"
systemctl daemon-reload
systemctl enable highseas-monitor.service
systemctl restart highseas-monitor.service
sleep 1
systemctl is-active --quiet highseas-monitor.service || {
  journalctl -u highseas-monitor.service -n 30 --no-pager >&2 || true
  fail "service failed to start"
}
"$BINARY" snapshot --json >/dev/null
say "Installed successfully. UDP peers will appear after they send traffic."
