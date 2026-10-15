#!/bin/bash
# Start an isolated, headless GNOME Shell on a private D-Bus session that loads
# Tiling Shell straight from the repo's dist/ folder. It does not touch the
# running desktop session, its settings or the installed extensions.
#
# usage: tools/headless/start.sh [--dark] WxH [WxH ...]
#   e.g. tools/headless/start.sh 5120x1440          (32:9 1440p)
#        tools/headless/start.sh 3440x1440 1920x1080 (two monitors)
#
# Run `npm run build` first. Stops any previous instance, starts the new one in
# the background and returns once Tiling Shell is enabled.
set -euo pipefail
H=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$H/../.." && pwd)
RUN=${TS_HEADLESS_DIR:-$H/.run}
DISPLAY_NAME=${TS_HEADLESS_WAYLAND_DISPLAY:-wayland-tilingshell-test}
UUID=tilingshell@ferrarodomenico.com

COLOR_SCHEME=default
if [[ ${1:-} == --dark ]]; then COLOR_SCHEME=prefer-dark; shift; fi
[[ $# -ge 1 ]] || { sed -n '2,13p' "$0"; exit 1; }
[[ -f $REPO/dist/metadata.json ]] || { echo "dist/ not found: run 'npm run build' first" >&2; exit 1; }

"$H/stop.sh"

# fresh state every time (apps like gnome-text-editor remember their geometry)
rm -rf "$RUN"
mkdir -p "$RUN"/{config/glib-2.0/settings,data/gnome-shell/extensions,cache,state}
ln -sfn "$REPO/dist" "$RUN/data/gnome-shell/extensions/$UUID"
ln -sfn "$H/testhelper" "$RUN/data/gnome-shell/extensions/testhelper@local"
echo "$DISPLAY_NAME" > "$RUN/wayland-display"

# GSETTINGS_BACKEND=keyfile keeps every setting inside $RUN instead of dconf
cat > "$RUN/config/glib-2.0/settings/keyfile" <<KF
[org/gnome/shell]
enabled-extensions=['testhelper@local', '$UUID']
welcome-dialog-last-shown-version='999'
disable-user-extensions=false

[org/gnome/desktop/interface]
enable-animations=true
# the pointer starts at (0, 0): the hot corner would open the overview
enable-hot-corners=false
color-scheme='$COLOR_SCHEME'
KF

MONITORS=()
for m in "$@"; do MONITORS+=(--virtual-monitor "$m"); done

(
    export XDG_CONFIG_HOME=$RUN/config XDG_DATA_HOME=$RUN/data
    export XDG_CACHE_HOME=$RUN/cache XDG_STATE_HOME=$RUN/state
    export GSETTINGS_BACKEND=keyfile
    unset WAYLAND_DISPLAY DISPLAY
    exec setsid dbus-run-session -- bash -c "echo \$DBUS_SESSION_BUS_ADDRESS > '$RUN/bus'; \
        exec gnome-shell --headless --wayland --no-x11 --wayland-display '$DISPLAY_NAME' \
        ${MONITORS[*]} --force-animations"
) > "$RUN/shell.log" 2>&1 &

if ! timeout 30 bash -c "until grep -q 'GNOME Shell started' '$RUN/shell.log' 2>/dev/null; do sleep 0.3; done"; then
    echo "gnome-shell did not start, see $RUN/shell.log" >&2
    exit 1
fi
python3 "$H/ctl.py" wait-ready
echo "headless shell ready (monitors: $*), log: $RUN/shell.log"
