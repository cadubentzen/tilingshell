#!/usr/bin/env python3
"""Take presentation screenshots of focus mode on a realistic desktop: two
text editors (focus mode source code and README) and a calculator side by side.

  npm run build && tools/headless/start.sh [--dark] 5120x1440 && tools/headless/demo_focus_mode.py [PREFIX]

Screenshots are saved in tools/headless/shots/PREFIX-*.png.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ctl  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
prefix = sys.argv[1] if len(sys.argv) > 1 else 'demo'


def window_js(title):
    return (f'global.get_window_actors().map(a => a.meta_window)'
            f'.find(w => (w.get_title() || "").includes("{title}"))')


def wait_title(title, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if ctl.js_json(f'JSON.stringify(!!{window_js(title)})'):
            return
        time.sleep(0.2)
    raise TimeoutError(title)


def place(title, x, y, w, h):
    ctl.js(f'{window_js(title)}.move_resize_frame(false, {x}, {y}, {w}, {h}); ""')


def activate(title):
    ctl.js(f'{window_js(title)}.activate(global.get_current_time()); ""')
    time.sleep(0.5)


def shot(name):
    time.sleep(0.6)  # let animations (backdrop fade) finish
    print(ctl.shot(f'{prefix}-{name}', 0))


ctl.run(['gnome-calculator'])
wait_title('Calculator')
ctl.run(['gnome-text-editor', os.path.join(REPO, 'README.md')])
wait_title('README.md')
ctl.run(['gnome-text-editor', '--new-window',
         os.path.join(REPO, 'src/components/focusMode/focusModeManager.ts')])
wait_title('focusModeManager.ts')
time.sleep(1.5)

# three columns on the first monitor, like a tiled desktop
st = ctl.state()
x, y, w, h = ctl.js_json('JSON.stringify((() => { const a = Main.layoutManager.getWorkAreaForMonitor(0); '
                         'return [a.x, a.y, a.width, a.height]; })())')
g = 8
col = (w - 4 * g) // 3
place('focusModeManager.ts', x + g, y + g, col, h - 2 * g)
place('README.md', x + 2 * g + col, y + g, col, h - 2 * g)
place('Calculator', x + 3 * g + 2 * col, y + g, col, h - 2 * g)
time.sleep(1)
# most recently used order, so that switching windows goes to the README
activate('README.md')
activate('focusModeManager.ts')
shot('0-desktop')

ctl.keys(['<Super>f'])
shot('1-focus-mode')

# Alt+` switches between windows of the same app (Alt+Tab between apps)
ctl.keys(['<Alt>grave'])
shot('2-focus-follows-window-switch')

ctl.keys(['<Super>f'])
shot('3-after-exit')
