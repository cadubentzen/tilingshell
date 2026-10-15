#!/usr/bin/env python3
"""End-to-end tests of Tiling Shell's focus mode, run against the headless
shell started by tools/headless/start.sh (any monitor size or count):

  npm run build && tools/headless/start.sh 5120x1440 && tools/headless/focus_mode_tests.py

Screenshots of the main steps are saved in tools/headless/shots/.
Exits with a non-zero status if a check fails.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ctl  # noqa: E402

EDITOR, CALC, CLOCKS = 'org.gnome.TextEditor', 'org.gnome.Calculator', 'org.gnome.clocks'
failures = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  -> {detail}'))
    if not cond:
        failures.append(name)


def find(st, cls):
    for i, w in enumerate(st['stack']):
        if w['cls'] == cls:
            return i, w
    return -1, None


def rect(st, cls):
    w = find(st, cls)[1]
    return w['r'] if w else None


def has_backdrop(st):
    return find(st, 'BACKDROP')[1] is not None


def expected_rect(st):
    """Focus mode rect: full work area height minus the outer gaps, 2:1 or the
    whole width if narrower, horizontally centered."""
    x, y, w, h = st['workArea']
    g = st['gaps']
    aw, ah = w - 2 * g, h - 2 * g
    width = min(aw, round(ah * 2))
    return [x + g + (aw - width) // 2, y + g, width, ah]


def wait(cond, timeout=5.0):
    return ctl.wait(cond, timeout)


def activate(cls):
    ctl.js(f'global.get_window_actors().find(a => a.meta_window.get_wm_class() === "{cls}")'
           '.meta_window.activate(global.get_current_time()); ""')
    return wait(lambda s: s['focus'] == cls)


def launch(cmd, cls):
    ctl.run(cmd)
    wait(lambda s: find(s, cls)[1] is not None, 20)
    time.sleep(1)  # let the window settle at its initial size
    return ctl.state()


def js(code):
    ctl.js(code)


def all_centered(st, monitor=None):
    """Every visible window of the monitor (by default the focused window's
    one) has the focus mode rect, including the ones behind the backdrop."""
    if monitor is None:
        monitor = next((w['monitor'] for w in st['stack'] if w.get('focus')), 0)
    wins = [w for w in st['stack']
            if w['cls'] != 'BACKDROP' and not w['min'] and w['monitor'] == monitor]
    return bool(wins) and all(w['r'] == expected_rect(st) for w in wins)


def all_restored(st, orig):
    return all(rect(st, cls) == r for cls, r in orig.items())


def enter(cls):
    ctl.keys(['<Super>f'])
    return wait(lambda s: has_backdrop(s) and s['focus'] == cls and all_centered(s))


def assert_focus_mode(name, st, cls):
    i_win, win = find(st, cls)
    i_bd, bd = find(st, 'BACKDROP')
    check(f'{name}: {cls} focused', st['focus'] == cls, st['focus'])
    check(f'{name}: {cls} has the 2:1 centered rect', win and win['r'] == expected_rect(st),
          f"{win and win['r']} != {expected_rect(st)}")
    check(f'{name}: backdrop covers the monitor', bd is not None and bd['r'] == st['monitor'],
          (bd, st['monitor']))
    check(f'{name}: backdrop right below the focused window', i_bd == i_win - 1, st['stack'])
    below = [w['cls'] for w in st['stack'][:max(i_bd, 0)]]
    # minimized windows keep their stacking position but are not drawn
    check(f'{name}: other windows hidden below the backdrop',
          all(w['cls'] in below or (w['min'] and not w['visible'])
              for w in st['stack'] if w['cls'] not in (cls, 'BACKDROP')), st['stack'])


monitors = ctl.monitors()
print('monitors', monitors)
st = launch(['gnome-text-editor'], EDITOR)
st = launch(['gnome-calculator'], CALC)
st = activate(EDITOR)
orig = {cls: rect(st, cls) for cls in (EDITOR, CALC)}
print('original rects', orig)
ctl.shot('0-before')

# 1. enter focus mode with the keybinding
st = enter(EDITOR)
assert_focus_mode('enter', st, EDITOR)
check('enter: the window behind has the same centered rect', rect(st, CALC) == expected_rect(st),
      f'{rect(st, CALC)} != {expected_rect(st)}')
x, y, w, h = st['workArea']
if w - 2 * st['gaps'] <= 2 * (h - 2 * st['gaps']):
    check('narrow monitor: the window spans the whole width',
          rect(st, EDITOR)[2] == w - 2 * st['gaps'], rect(st, EDITOR))
time.sleep(0.5)  # fade-in
ctl.shot('1-focus-editor')

# 2. focus mode follows the focus: Alt+Tab switches between the centered windows
ctl.keys(['<Alt>Tab'])
st = wait(lambda s: s['focus'] == CALC and all_centered(s))
assert_focus_mode('follow focus', st, CALC)
check('follow focus: previous window stays centered behind', rect(st, EDITOR) == expected_rect(st),
      rect(st, EDITOR))
time.sleep(0.3)
ctl.shot('2-focus-calculator')
ctl.keys(['<Alt>Tab'])
st = wait(lambda s: s['focus'] == EDITOR and all_centered(s))
assert_focus_mode('switch back', st, EDITOR)
check('switch back: both windows still centered', all_centered(st), st['stack'])

# 2b. a window opened in focus mode is centered too, closing it goes back to the previous one
st = launch(['gnome-clocks'], CLOCKS)
st = wait(lambda s: s['focus'] == CLOCKS and all_centered(s))
assert_focus_mode('new window', st, CLOCKS)
js('global.display.focus_window.delete(global.get_current_time()); ""')
st = wait(lambda s: find(s, CLOCKS)[1] is None and s['focus'] == EDITOR and all_centered(s))
assert_focus_mode('new window closed', st, EDITOR)
ctl.keys(['<Alt>Tab'])
st = wait(lambda s: s['focus'] == CALC and all_centered(s))
assert_focus_mode('switch again', st, CALC)

# 3. clicking the blurred area does not reach the hidden windows
margin = expected_rect(st)[0] - st['monitor'][0]
if margin >= 2:
    ctl.click(st['monitor'][0] + margin // 2, st['monitor'][1] + st['monitor'][3] // 2)
    time.sleep(0.5)
    st = ctl.state()
    check('click on backdrop: overview not shown', not st['overview'])
    check('click on backdrop: focus unchanged', st['focus'] == CALC, st['focus'])
    check('click on backdrop: still in focus mode', has_backdrop(st), st['stack'])

# 4. leave focus mode with the keybinding
ctl.keys(['<Super>f'])
st = wait(lambda s: not has_backdrop(s) and all_restored(s, orig))
check('exit: backdrop removed', not has_backdrop(st), st['stack'])
for cls in (EDITOR, CALC):
    check(f'exit: {cls} restored', rect(st, cls) == orig[cls], f'{rect(st, cls)} != {orig[cls]}')
ctl.shot('3-after-exit')

# 5. tiling the focused window keeps it in its tile (focus mode must not re-center it)
activate(EDITOR)
enter(EDITOR)
ctl.keys(['<Super>Left'])
st = wait(lambda s: rect(s, EDITOR) != expected_rect(s))
time.sleep(1.5)
st2 = ctl.state()
tiled = ctl.js_json('JSON.stringify(!!global.display.focus_window.assignedTile)')
check('tile in focus mode: window tiled', tiled and rect(st, EDITOR) != expected_rect(st), rect(st, EDITOR))
check('tile in focus mode: stays in its tile', rect(st2, EDITOR) == rect(st, EDITOR),
      f'{rect(st, EDITOR)} -> {rect(st2, EDITOR)}')
check('tile in focus mode: still in focus mode', has_backdrop(st2))
ctl.keys(['<Super>f'])
st = wait(lambda s: not has_backdrop(s) and all_restored(s, orig))
check('tile in focus mode: exit restores the original geometry', rect(st, EDITOR) == orig[EDITOR], rect(st, EDITOR))
check('tile in focus mode: exit restores the window behind', rect(st, CALC) == orig[CALC], rect(st, CALC))

# 6. minimizing: focus mode moves to the next window, minimizing the last one leaves it
activate(EDITOR)
enter(EDITOR)
js('global.display.focus_window.minimize(); ""')
# also wait for the minimize animation, the actor is hidden when it is done
st = wait(lambda s: s['focus'] == CALC and rect(s, CALC) == expected_rect(s) and not find(s, EDITOR)[1]['visible'])
assert_focus_mode('minimize', st, CALC)
js('global.display.focus_window.minimize(); ""')
st = wait(lambda s: not has_backdrop(s) and rect(s, CALC) == orig[CALC])
check('minimize last: focus mode left', not has_backdrop(st), st['stack'])
for cls in (EDITOR, CALC):
    js(f'global.get_window_actors().find(a => a.meta_window.get_wm_class() === "{cls}").meta_window.unminimize(); ""')
st = wait(lambda s: rect(s, EDITOR) == orig[EDITOR] and rect(s, CALC) == orig[CALC])
for cls in (EDITOR, CALC):
    check(f'minimize: {cls} restored', rect(st, cls) == orig[cls], rect(st, cls))

# 7. maximized windows are restored as maximized, keeping their unmaximized geometry
activate(EDITOR)
# Control cycle without focus mode: GNOME Shell 50 itself unmaximizes a window
# at a wrong position the first time after an Alt+Tab (it happens with Tiling
# Shell disabled too), so get that out of the way and move the window back.
js('global.display.focus_window.maximize(Meta.MaximizeFlags.BOTH); ""')
wait(lambda s: find(s, EDITOR)[1]['max'] and rect(s, EDITOR) == s['workArea'])
js('global.display.focus_window.unmaximize(Meta.MaximizeFlags.BOTH); ""')
st = wait(lambda s: not find(s, EDITOR)[1]['max'] and rect(s, EDITOR)[2:] == orig[EDITOR][2:])
print('control maximize/unmaximize cycle without focus mode ->', rect(st, EDITOR))
js(f'global.display.focus_window.move_resize_frame(false, {", ".join(map(str, orig[EDITOR]))}); ""')
wait(lambda s: rect(s, EDITOR) == orig[EDITOR])
js('global.display.focus_window.maximize(Meta.MaximizeFlags.BOTH); ""')
# wait for the client to commit the maximized size too (asynchronous on Wayland)
st = wait(lambda s: find(s, EDITOR)[1]['max'] and rect(s, EDITOR) == s['workArea'])
check('maximized: window maximized', rect(st, EDITOR) == st['workArea'], rect(st, EDITOR))
st = enter(EDITOR)
assert_focus_mode('maximized', st, EDITOR)
check('maximized: unmaximized in focus mode', not find(st, EDITOR)[1]['max'])
ctl.keys(['<Super>f'])
st = wait(lambda s: not has_backdrop(s) and find(s, EDITOR)[1]['max'] and rect(s, EDITOR) == s['workArea'])
check('maximized: maximized again after exit', find(st, EDITOR)[1]['max'], find(st, EDITOR)[1])
check('maximized: the window behind is restored', rect(st, CALC) == orig[CALC], rect(st, CALC))
js('global.display.focus_window.unmaximize(Meta.MaximizeFlags.BOTH); ""')
st = wait(lambda s: rect(s, EDITOR) == orig[EDITOR])
check('maximized: unmaximize goes back to the original geometry', rect(st, EDITOR) == orig[EDITOR],
      f'{rect(st, EDITOR)} != {orig[EDITOR]}')

# 7b. a maximized window behind the focused one is centered too, and maximized again after exit
activate(CALC)
# same control cycle as above, for this window
js('global.display.focus_window.maximize(Meta.MaximizeFlags.BOTH); ""')
wait(lambda s: find(s, CALC)[1]['max'] and rect(s, CALC) == s['workArea'])
js('global.display.focus_window.unmaximize(Meta.MaximizeFlags.BOTH); ""')
st = wait(lambda s: not find(s, CALC)[1]['max'] and rect(s, CALC)[2:] == orig[CALC][2:])
print('control maximize/unmaximize cycle without focus mode ->', rect(st, CALC))
js(f'global.display.focus_window.move_resize_frame(false, {", ".join(map(str, orig[CALC]))}); ""')
wait(lambda s: rect(s, CALC) == orig[CALC])
js('global.display.focus_window.maximize(Meta.MaximizeFlags.BOTH); ""')
wait(lambda s: find(s, CALC)[1]['max'] and rect(s, CALC) == s['workArea'])
activate(EDITOR)
st = enter(EDITOR)
assert_focus_mode('maximized behind', st, EDITOR)
check('maximized behind: unmaximized and centered', not find(st, CALC)[1]['max'] and rect(st, CALC) == expected_rect(st),
      find(st, CALC)[1])
ctl.keys(['<Super>f'])
st = wait(lambda s: not has_backdrop(s) and find(s, CALC)[1]['max'] and rect(s, CALC) == s['workArea']
          and rect(s, EDITOR) == orig[EDITOR])
check('maximized behind: maximized again after exit', find(st, CALC)[1]['max'] and rect(st, CALC) == st['workArea'],
      find(st, CALC)[1])
js('global.get_window_actors().find(a => a.meta_window.get_wm_class() === "%s").meta_window'
   '.unmaximize(Meta.MaximizeFlags.BOTH); ""' % CALC)
st = wait(lambda s: not find(s, CALC)[1]['max'] and rect(s, CALC) == orig[CALC])
check('maximized behind: unmaximize goes back to the original geometry', rect(st, CALC) == orig[CALC],
      f'{rect(st, CALC)} != {orig[CALC]}')

# 8. switching workspace leaves focus mode
st = enter(EDITOR)
check('workspace: entered focus mode', has_backdrop(st))
ctl.keys(['<Super>Page_Down'])
st = wait(lambda s: s['ws'] == 1 and not has_backdrop(s) and all_restored(s, orig))
check('workspace: switched', st['ws'] == 1, st['ws'])
check('workspace: focus mode left and windows restored',
      not has_backdrop(st) and all_restored(st, orig), st)
ctl.keys(['<Super>Page_Up'])
wait(lambda s: s['ws'] == 0)
activate(EDITOR)

# 9. with several monitors, the backdrop follows the window to another monitor
if len(monitors) > 1:
    enter(EDITOR)
    other = 1 - ctl.js_json('JSON.stringify(global.display.focus_window.get_monitor())')
    js(f'global.display.focus_window.move_to_monitor({other}); ""')
    st = wait(lambda s: has_backdrop(s) and find(s, 'BACKDROP')[1]['r'] == monitors[other]
              and rect(s, EDITOR) == expected_rect(s))
    i_win, _ = find(st, EDITOR)
    i_bd, bd = find(st, 'BACKDROP')
    check('multi-monitor: backdrop moved to the new monitor', bd and bd['r'] == monitors[other], (bd, monitors))
    check('multi-monitor: backdrop right below the window', i_bd == i_win - 1, st['stack'])
    check('multi-monitor: window centered on the new monitor', rect(st, EDITOR) == expected_rect(st),
          f'{rect(st, EDITOR)} != {expected_rect(st)}')
    ctl.shot('4-moved-to-other-monitor')
    ctl.keys(['<Super>f'])
    st = wait(lambda s: not has_backdrop(s) and all_restored(s, orig))
    check('multi-monitor: exit restores', not has_backdrop(st) and all_restored(st, orig), st)
    activate(EDITOR)

# 10. closing the focused window moves focus mode to the next one, closing the last one leaves it
enter(EDITOR)
js('global.display.focus_window.delete(global.get_current_time()); ""')
st = wait(lambda s: find(s, EDITOR)[1] is None and s['focus'] == CALC and rect(s, CALC) == expected_rect(s))
check('close: editor closed', find(st, EDITOR)[1] is None, st['stack'])
assert_focus_mode('close', st, CALC)
js('global.display.focus_window.delete(global.get_current_time()); ""')
st = wait(lambda s: find(s, CALC)[1] is None and not has_backdrop(s))
check('close last: focus mode left', not has_backdrop(st), st['stack'])

errors = [line for line in open(os.path.join(ctl.RUN, 'shell.log'))
          if 'tilingshell' in line.lower() and ('error' in line.lower() or 'exception' in line.lower())]
check('no Tiling Shell errors in the shell log', not errors, ''.join(errors[-5:]))

print(f'\n{len(failures)} failure(s)' + (': ' + ', '.join(failures) if failures else ''))
sys.exit(1 if failures else 0)
