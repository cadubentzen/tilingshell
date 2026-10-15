#!/bin/bash
# Stop the headless shell started by start.sh (only that one: the pattern
# matches its private Wayland display name). Its apps exit with it.
DISPLAY_NAME=${TS_HEADLESS_WAYLAND_DISPLAY:-wayland-tilingshell-test}
if pkill -f "^gnome-shell --headless .*--wayland-display $DISPLAY_NAME"; then
    timeout 10 bash -c "while pgrep -f '^gnome-shell --headless .*--wayland-display $DISPLAY_NAME' >/dev/null; do sleep 0.2; done"
fi
exit 0
