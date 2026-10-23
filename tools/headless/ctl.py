#!/usr/bin/env python3
"""Drive the headless GNOME Shell started by tools/headless/start.sh.

CLI usage (also importable as a module, see focus_mode_tests.py):
  ctl.py eval '<js>'            run JS in the shell (org.gnome.Shell.Eval), print result
  ctl.py keys '<Super>f' ...    inject key presses (org.gnome.Mutter.RemoteDesktop)
  ctl.py click X Y              warp the pointer to X,Y and left-click
  ctl.py shot NAME [MONITOR]    screenshot into shots/NAME.png (optionally cropped to a monitor)
  ctl.py run CMD ...            launch a Wayland app inside the headless shell
  ctl.py state                  print windows (bottom to top), focus and focus-mode backdrop
  ctl.py wait-ready             wait until Tiling Shell is enabled and the overview hidden

Key names: '<Super>', '<Ctrl>', '<Shift>', '<Alt>' modifiers, plus single
characters or the names in KEYSYMS (Tab, Return, Left, Page_Down, ...).
"""
import json
import os
import subprocess
import sys
import time

import gi

gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf, Gio, GLib  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.environ.get('TS_HEADLESS_DIR', os.path.join(HERE, '.run'))
# kept across restarts, unlike RUN which start.sh wipes
SHOTS = os.environ.get('TS_HEADLESS_SHOTS', os.path.join(HERE, 'shots'))
UUID = 'tilingshell@ferrarodomenico.com'

_bus = None


def bus():
    global _bus
    if _bus is None:
        address = open(os.path.join(RUN, 'bus')).read().strip()
        _bus = Gio.DBusConnection.new_for_address_sync(
            address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
    return _bus


def call(name, path, iface, method, args=None, reply=None, timeout=10000):
    return bus().call_sync(name, path, iface, method, args,
                           GLib.VariantType(reply) if reply else None,
                           Gio.DBusCallFlags.NONE, timeout, None)


def js(code):
    """Evaluate JS in the shell. Returns the result string (JSON-encoded by the
    shell, so strings come back quoted). Raises on JS errors."""
    ok, res = call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
                   GLib.Variant('(s)', (code,)), '(bs)').unpack()
    if not ok:
        raise RuntimeError(res)
    return res


def js_json(code):
    """Evaluate JS that returns JSON.stringify(...) and decode it."""
    res = js(code)
    return json.loads(json.loads(res)) if res else None


KEYSYMS = {'super': 0xffeb, 'shift': 0xffe1, 'ctrl': 0xffe3, 'control': 0xffe3, 'alt': 0xffe9,
           'escape': 0xff1b, 'return': 0xff0d, 'tab': 0xff09, 'backspace': 0xff08,
           'left': 0xff51, 'up': 0xff52, 'right': 0xff53, 'down': 0xff54,
           'page_up': 0xff55, 'page_down': 0xff56, 'home': 0xff50, 'end': 0xff57, 'space': 0x20,
           'grave': 0x60}


def _parse(accel):
    mods, rest = [], accel
    while rest.startswith('<'):
        i = rest.index('>')
        mods.append(KEYSYMS[rest[1:i].lower()])
        rest = rest[i + 1:]
    key = KEYSYMS.get(rest.lower(), ord(rest.lower()) if len(rest) == 1 else None)
    if key is None:
        raise ValueError(f'unknown key {rest!r}')
    return mods, key


class RemoteDesktop:
    """A mutter remote desktop session, used to inject real input events."""

    def __enter__(self):
        self.path = call('org.gnome.Mutter.RemoteDesktop', '/org/gnome/Mutter/RemoteDesktop',
                         'org.gnome.Mutter.RemoteDesktop', 'CreateSession', None, '(o)').unpack()[0]
        self('Start')
        time.sleep(0.2)
        return self

    def __call__(self, method, args=None):
        return call('org.gnome.Mutter.RemoteDesktop', self.path,
                    'org.gnome.Mutter.RemoteDesktop.Session', method, args)

    def __exit__(self, *exc):
        self('Stop')


def keys(accels, delay=0.3):
    with RemoteDesktop() as rd:
        for accel in accels:
            mods, key = _parse(accel)
            for m in mods:
                rd('NotifyKeyboardKeysym', GLib.Variant('(ub)', (m, True)))
            rd('NotifyKeyboardKeysym', GLib.Variant('(ub)', (key, True)))
            rd('NotifyKeyboardKeysym', GLib.Variant('(ub)', (key, False)))
            for m in reversed(mods):
                rd('NotifyKeyboardKeysym', GLib.Variant('(ub)', (m, False)))
            time.sleep(delay)


def warp(x, y):
    js(f'imports.gi.Clutter.get_default_backend().get_default_seat().warp_pointer({x}, {y}); ""')


def click(x, y, button=0x110):  # BTN_LEFT
    # absolute pointer motion needs a screencast stream, so warp instead
    with RemoteDesktop() as rd:
        warp(x, y)
        time.sleep(0.2)
        rd('NotifyPointerButton', GLib.Variant('(ib)', (button, True)))
        rd('NotifyPointerButton', GLib.Variant('(ib)', (button, False)))
        time.sleep(0.3)


def monitors():
    return js_json('JSON.stringify(Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height]))')


def shot(name, monitor=None):
    """Screenshot the whole stage (or one monitor) to shots/NAME.png."""
    os.makedirs(SHOTS, exist_ok=True)
    path = os.path.join(SHOTS, name + '.png')
    ok, _ = call('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot',
                 'org.gnome.Shell.Screenshot', 'Screenshot',
                 GLib.Variant('(bbs)', (False, False, path)), '(bs)').unpack()
    if not ok:
        raise RuntimeError('screenshot failed')
    if monitor is not None:
        x, y, w, h = monitors()[monitor]
        pix = GdkPixbuf.Pixbuf.new_from_file(path)
        pix.new_subpixbuf(x, y, w, h).savev(path, 'png', [], [])
    return path


def run(argv):
    """Launch a Wayland client inside the headless shell, isolated like the shell."""
    env = dict(os.environ,
               WAYLAND_DISPLAY=open(os.path.join(RUN, 'wayland-display')).read().strip(),
               GDK_BACKEND='wayland',
               DBUS_SESSION_BUS_ADDRESS=open(os.path.join(RUN, 'bus')).read().strip(),
               XDG_CONFIG_HOME=os.path.join(RUN, 'config'), XDG_DATA_HOME=os.path.join(RUN, 'data'),
               XDG_CACHE_HOME=os.path.join(RUN, 'cache'), XDG_STATE_HOME=os.path.join(RUN, 'state'),
               GSETTINGS_BACKEND='keyfile')
    env.pop('DISPLAY', None)
    subprocess.Popen(argv, env=env, stdout=open(os.path.join(RUN, 'apps.log'), 'a'),
                     stderr=subprocess.STDOUT, start_new_session=True)


STATE_JS = '''JSON.stringify({
  focus: global.display.focus_window ? global.display.focus_window.get_wm_class() : null,
  stack: global.window_group.get_children().map(a => {
    if (a.meta_window) { const w = a.meta_window, f = w.get_frame_rect();
      return {cls: w.get_wm_class(), title: w.get_title(), r: [f.x, f.y, f.width, f.height],
              monitor: w.get_monitor(), max: w.maximizedHorizontally && w.maximizedVertically,
              min: w.minimized, visible: a.visible, focus: w.has_focus(), above: w.is_above()}; }
    if (a.name === 'TilingShellFocusModeBackdrop')
      return {cls: 'BACKDROP', r: [a.x, a.y, a.width, a.height], opacity: a.opacity};
    return null; }).filter(x => x),
  workArea: (() => { const fw = global.display.focus_window;
    const w = Main.layoutManager.getWorkAreaForMonitor(fw ? fw.get_monitor() : 0);
    return [w.x, w.y, w.width, w.height]; })(),
  monitor: (() => { const fw = global.display.focus_window;
    const m = Main.layoutManager.monitors[fw ? fw.get_monitor() : 0];
    return [m.x, m.y, m.width, m.height]; })(),
  gaps: Main.extensionManager.lookup('%s').stateObj.getSettings().get_uint('outer-gaps'),
  innerGaps: Main.extensionManager.lookup('%s').stateObj.getSettings().get_uint('inner-gaps'),
  ws: global.workspace_manager.get_active_workspace_index(),
  overview: Main.overview.visible,
})''' % (UUID, UUID)


def state():
    """Windows in stacking order (bottom to top), focus, work area of the
    focused window's monitor, outer gaps, workspace and overview state."""
    return js_json(STATE_JS)


def wait(cond, timeout=5.0):
    """Poll state() until cond(state) is true; return the last state."""
    end = time.time() + timeout
    while time.time() < end:
        st = state()
        if cond(st):
            return st
        time.sleep(0.1)
    return state()


def wait_ready(timeout=30.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if js_json(f'JSON.stringify(Main.extensionManager.lookup("{UUID}")?.state === 1 '
                       '&& !Main.overview.visible && !Main.layoutManager._startingUp)'):
                # park the pointer away from the corners and the top bar
                m = monitors()[0]
                warp(m[0] + m[2] // 2, m[1] + m[3] // 2)
                time.sleep(0.3)  # let the testhelper clear the notifications
                return
        except (GLib.Error, RuntimeError, FileNotFoundError):
            pass
        time.sleep(0.3)
    raise TimeoutError('headless shell not ready')


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd, args = argv[1], argv[2:]
    if cmd == 'eval':
        print(js(args[0]))
    elif cmd == 'keys':
        keys(args)
    elif cmd == 'click':
        click(int(args[0]), int(args[1]))
    elif cmd == 'shot':
        print(shot(args[0], int(args[1]) if len(args) > 1 else None))
    elif cmd == 'run':
        run(args)
    elif cmd == 'state':
        st = state()
        print(f"focus={st['focus']} workspace={st['ws']} overview={st['overview']} gaps={st['gaps']}")
        for w in st['stack']:
            flags = ' '.join(k for k in ('focus', 'max', 'min') if w.get(k))
            print(f"  {w['cls']:<28} {w['r']} {flags}")
    elif cmd == 'wait-ready':
        wait_ready()
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
