import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import { Clutter, GLib, Meta, Mtk, Shell } from '../../gi/ext';
import SignalHandling from '../../utils/signalHandling';
import Settings from '../../settings/settings';
import { logger } from '../../utils/logger';
import { buildRectangle } from '../../utils/ui';
import ExtendedWindow from '../tilingsystem/extendedWindow';
import {
    buildBlurEffect,
    maximizeWindow,
    unmaximizeWindow,
} from '../../utils/gnomesupport';

const debug = logger('FocusMode');

const FOCUS_ASPECT_RATIO = 2; // width / height of the focused window
const BACKDROP_BLUR_SIGMA = 30;
const BACKDROP_BRIGHTNESS = 0.85;
const BACKDROP_FADE_DURATION = 200; // ms
const RESIZE_TIMEOUT = 1000; // ms to wait for the window to answer a resize
const ABANDONED_TIMEOUT = 1000; // ms to wait for a window to replace a closed one

interface SavedWindowState {
    rect: Mtk.Rectangle;
    maximized: boolean;
}

function isMaximized(window: Meta.Window): boolean {
    return window.maximizedHorizontally || window.maximizedVertically;
}

/**
 * Blurred desktop background covering a whole monitor. It is placed in the
 * window group right below the focused window, hiding every other window
 * of that monitor.
 */
class FocusModeBackdrop {
    public readonly monitorIndex: number;
    private readonly _actor: Clutter.Actor;
    private readonly _bgManager: Background.BackgroundManager;

    constructor(monitorIndex: number) {
        this.monitorIndex = monitorIndex;
        const monitor = Main.layoutManager.monitors[monitorIndex];

        // do not use a Meta.BackgroundGroup: mutter always moves those
        // to the bottom of the window group when restacking
        this._actor = new Clutter.Actor({
            name: 'TilingShellFocusModeBackdrop',
            layout_manager: new Clutter.BinLayout(),
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            // swallow clicks so that windows behind cannot be reached
            reactive: true,
            opacity: 0,
        });
        this._bgManager = new Background.BackgroundManager({
            container: this._actor,
            monitorIndex,
            vignette: false,
            controlPosition: false,
            useContentSize: false,
        });
        this._actor.add_effect_with_name(
            'blur',
            buildBlurEffect(
                BACKDROP_BLUR_SIGMA,
                Shell.BlurMode.ACTOR,
                BACKDROP_BRIGHTNESS
            )
        );
        global.windowGroup.add_child(this._actor);

        this._actor.ease({
            opacity: 255,
            duration: BACKDROP_FADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    public placeBelow(window: Meta.Window) {
        const winActor = window.get_compositor_private() as Meta.WindowActor;
        if (!winActor || winActor.get_parent() !== global.windowGroup) return;

        global.windowGroup.set_child_below_sibling(this._actor, winActor);
    }

    public destroy(animate: boolean) {
        this._actor.remove_all_transitions();
        if (!animate) {
            this._bgManager.destroy();
            this._actor.destroy();
            return;
        }

        this._actor.ease({
            opacity: 0,
            duration: BACKDROP_FADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this._bgManager.destroy();
                this._actor.destroy();
            },
        });
    }
}

function computeTargetRect(monitorIndex: number): Mtk.Rectangle {
    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
    const gaps = Settings.get_outer_gaps();
    const availableWidth = workArea.width - gaps.left - gaps.right;
    const availableHeight = workArea.height - gaps.top - gaps.bottom;

    // use a 2:1 aspect ratio, or the whole width if the screen is narrower
    const width = Math.min(
        availableWidth,
        Math.round(availableHeight * FOCUS_ASPECT_RATIO)
    );

    return buildRectangle({
        x: workArea.x + gaps.left + Math.floor((availableWidth - width) / 2),
        y: workArea.y + gaps.top,
        width,
        height: availableHeight,
    });
}

interface FocusModeWindowCallbacks {
    onUnmanaging: () => void;
    onMinimized: () => void;
    onLeftWorkspace: () => void;
}

/**
 * A window given the focus mode geometry. It remembers the original geometry
 * and maximized state of the window, to restore them when leaving focus mode.
 */
class FocusModeWindow {
    public readonly window: Meta.Window;
    private readonly _signals: SignalHandling;
    private readonly _savedState: SavedWindowState;
    private _unmaximizeSignalId: number;
    private _awaitingResize: boolean;
    private _resizeTimeoutId: number;

    constructor(window: Meta.Window, callbacks: FocusModeWindowCallbacks) {
        this.window = window;
        this._signals = new SignalHandling();
        this._savedState = {
            rect: window.get_frame_rect().copy(),
            maximized: isMaximized(window),
        };
        this._unmaximizeSignalId = 0;
        this._awaitingResize = false;
        this._resizeTimeoutId = 0;
        // auto-tiling must not move the window while focus mode owns it
        (window as ExtendedWindow).inFocusMode = true;

        this._signals.connect(window, 'unmanaging', () =>
            callbacks.onUnmanaging()
        );
        this._signals.connect(window, 'notify::minimized', () => {
            if (window.minimized) callbacks.onMinimized();
        });
        this._signals.connect(window, 'workspace-changed', () => {
            if (
                !window.located_on_workspace(
                    global.workspaceManager.get_active_workspace()
                )
            )
                callbacks.onLeftWorkspace();
        });
        // windows might not accept the requested size (e.g. they have a
        // maximum size), so keep them centered. Only do that in response to
        // our own request, not when the window is tiled or resized later.
        this._signals.connect(window, 'size-changed', () => {
            if (!this._awaitingResize || this._unmaximizeSignalId) return;

            this._awaitingResize = false;
            this._recenter();
        });
    }

    public center() {
        const window = this.window;
        if (window.is_fullscreen()) return;

        if (!isMaximized(window)) {
            this.moveToTargetRect();
            return;
        }

        // Save the geometry of the unmaximized window instead of the maximized
        // one, so that unmaximizing it after leaving focus mode brings it back
        // where it was. That geometry is known only once the window is resized
        // (asynchronously on Wayland), so connect before unmaximizing.
        this._unmaximizeSignalId = window.connect('size-changed', () => {
            if (isMaximized(window)) return;

            this._disconnectUnmaximizeSignal();
            this._savedState.rect = window.get_frame_rect().copy();
            this.moveToTargetRect();
        });
        this._startResizeTimeout();
        unmaximizeWindow(window);
    }

    public moveToTargetRect() {
        const window = this.window;
        if (window.is_fullscreen() || isMaximized(window)) return;

        const target = computeTargetRect(window.get_monitor());
        if (window.get_frame_rect().equal(target)) return;

        this._awaitingResize = true;
        this._startResizeTimeout();
        window.move_resize_frame(
            false,
            target.x,
            target.y,
            target.width,
            target.height
        );
    }

    /** The user is moving or resizing the window, do not interfere. */
    public stopAwaitingResize() {
        this._awaitingResize = false;
    }

    /** Give the window its original geometry and maximized state back. */
    public restore() {
        const window = this.window;
        const state = this._savedState;
        this.release();
        if (window.is_fullscreen()) return;

        if (isMaximized(window)) unmaximizeWindow(window);
        window.move_resize_frame(
            false,
            state.rect.x,
            state.rect.y,
            state.rect.width,
            state.rect.height
        );
        if (state.maximized) maximizeWindow(window);
    }

    /** Stop managing the window, leaving it where it is. */
    public release() {
        this._disconnectUnmaximizeSignal();
        (this.window as ExtendedWindow).inFocusMode = false;
        this._signals.disconnect();
        this._clearResizeTimeout();
        this._awaitingResize = false;
    }

    private _recenter() {
        const window = this.window;
        if (window.is_fullscreen() || isMaximized(window)) return;

        const target = computeTargetRect(window.get_monitor());
        const rect = window.get_frame_rect();
        const x = target.x + Math.floor((target.width - rect.width) / 2);
        const y = target.y + Math.floor((target.height - rect.height) / 2);
        if (rect.x !== x || rect.y !== y) window.move_frame(false, x, y);
    }

    private _startResizeTimeout() {
        // stop waiting if the window does not answer (e.g. its size did not
        // change), so later resizes are left alone
        this._clearResizeTimeout();
        this._resizeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RESIZE_TIMEOUT,
            () => {
                this._resizeTimeoutId = 0;
                this._awaitingResize = false;
                if (this._unmaximizeSignalId) {
                    this._disconnectUnmaximizeSignal();
                    this.moveToTargetRect();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    private _disconnectUnmaximizeSignal() {
        if (this._unmaximizeSignalId)
            this.window.disconnect(this._unmaximizeSignalId);
        this._unmaximizeSignalId = 0;
    }

    private _clearResizeTimeout() {
        if (this._resizeTimeoutId) GLib.source_remove(this._resizeTimeoutId);
        this._resizeTimeoutId = 0;
    }
}

/**
 * Focus mode: the focused window is centered on its monitor with a 2:1 aspect
 * ratio (or spans the whole width if the monitor is narrower than that), while
 * the rest of the monitor shows the blurred desktop background. Every other
 * window of that monitor gets the same geometry behind the backdrop, so that
 * switching between windows (e.g. with Alt+Tab) keeps the focus mode layout.
 * Focus mode follows the focus, and leaving it gives every window its
 * original position, size and maximized state back.
 */
export default class FocusModeManager {
    private readonly _signals: SignalHandling;
    private readonly _windows: Map<Meta.Window, FocusModeWindow>;
    private _window: Meta.Window | null;
    private _grabbedWindow: Meta.Window | null;
    private _backdrop: FocusModeBackdrop | null;
    private _syncSourceId: number;
    private _abandonedTimeoutId: number;

    constructor() {
        this._signals = new SignalHandling();
        this._windows = new Map();
        this._window = null;
        this._grabbedWindow = null;
        this._backdrop = null;
        this._syncSourceId = 0;
        this._abandonedTimeoutId = 0;
    }

    public get active(): boolean {
        return this._backdrop !== null;
    }

    public toggle(window: Meta.Window | null) {
        if (this.active) this.exit();
        else this._enter(window);
    }

    public exit(animate: boolean = true) {
        if (!this.active) return;

        debug('exit focus mode');
        this._signals.disconnect();
        this._clearSyncSource();
        this._clearAbandonedTimeout();
        this._windows.forEach(fmWindow => fmWindow.restore());
        this._windows.clear();
        this._window = null;
        this._grabbedWindow = null;
        this._backdrop?.destroy(animate);
        this._backdrop = null;
    }

    public destroy() {
        this.exit(false);
    }

    private _enter(window: Meta.Window | null) {
        const target = this._focusableWindow(window);
        if (!target) return;

        debug('enter focus mode');
        this._focusWindow(target);

        this._signals.connect(global.display, 'notify::focus-window', () =>
            this._scheduleSync()
        );
        // mutter may move our backdrop when restacking the windows
        this._signals.connect(global.display, 'restacked', () => {
            if (this._window) this._backdrop?.placeBelow(this._window);
        });
        this._signals.connect(global.display, 'workareas-changed', () => {
            this._windows.forEach(fmWindow => fmWindow.moveToTargetRect());
        });
        // the focused window was moved to another monitor
        this._signals.connect(
            global.display,
            'window-entered-monitor',
            (
                _display: Meta.Display,
                monitorIndex: number,
                win: Meta.Window
            ) => {
                if (win !== this._window || win.get_monitor() !== monitorIndex)
                    return;

                this._showBackdropOn(win);
                // do not fight the user dragging the window
                if (win !== this._grabbedWindow)
                    this._windows.get(win)?.moveToTargetRect();
            }
        );
        // the user is moving or resizing the window, do not interfere
        this._signals.connect(
            global.display,
            'grab-op-begin',
            (_display: Meta.Display, grabbedWindow: Meta.Window) => {
                this._grabbedWindow = grabbedWindow;
                this._windows.get(grabbedWindow)?.stopAwaitingResize();
            }
        );
        this._signals.connect(global.display, 'grab-op-end', () => {
            this._grabbedWindow = null;
        });
        this._signals.connect(
            global.workspaceManager,
            'active-workspace-changed',
            () => this.exit()
        );
        this._signals.connect(Main.layoutManager, 'monitors-changed', () =>
            this.exit(false)
        );
    }

    private _focusableWindow(window: Meta.Window | null): Meta.Window | null {
        if (!window) return null;

        // use the parent of modal dialogs
        const transient = window.get_transient_for();
        if (window.is_attached_dialog() && transient) window = transient;

        if (
            window.get_window_type() !== Meta.WindowType.NORMAL ||
            window.skipTaskbar ||
            window.minimized ||
            window.get_wm_class() === 'gjs'
        )
            return null;

        return window;
    }

    private _scheduleSync() {
        // Wait for the focus to settle (e.g. when the focused window is closed
        // mutter focuses another one) instead of moving windows while mutter
        // is still changing the focus. This still runs before the next redraw.
        if (this._syncSourceId) return;

        this._syncSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncSourceId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _sync() {
        const target = this._focusableWindow(global.display.focus_window);
        // keep the current window if the focus went to a popup, a dialog, or
        // a window that is not on the current workspace
        if (
            target &&
            target !== this._window &&
            target.located_on_workspace(
                global.workspaceManager.get_active_workspace()
            )
        )
            this._focusWindow(target);
        else if (!this._window) this._onWindowAbandoned();
    }

    private _onWindowAbandoned() {
        // the window was closed or minimized: leave focus mode if no other
        // window can take its place, otherwise wait for the focus to move
        // there (mutter may focus it later, e.g. after minimizing a window)
        const candidates = this._workspaceWindows();
        if (candidates.length === 0) {
            this.exit();
            return;
        }

        if (this._abandonedTimeoutId) return;
        this._abandonedTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            ABANDONED_TIMEOUT,
            () => {
                this._abandonedTimeoutId = 0;
                if (!this._window) this.exit();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    private _workspaceWindows(): Meta.Window[] {
        return global.display
            .get_tab_list(
                Meta.TabList.NORMAL,
                global.workspaceManager.get_active_workspace()
            )
            .filter(win => this._focusableWindow(win) === win);
    }

    private _focusWindow(window: Meta.Window) {
        this._clearAbandonedTimeout();
        this._window = window;

        // the window may be below others, e.g. with focus-follows-mouse
        window.raise();
        this._showBackdropOn(window);
        this._manageWindow(window);
    }

    private _showBackdropOn(window: Meta.Window) {
        const monitorIndex = window.get_monitor();
        if (!this._backdrop || this._backdrop.monitorIndex !== monitorIndex) {
            this._backdrop?.destroy(true);
            this._backdrop = new FocusModeBackdrop(monitorIndex);
            // give the focus mode geometry to every window of the monitor
            this._workspaceWindows()
                .filter(win => win.get_monitor() === monitorIndex)
                .forEach(win => this._manageWindow(win));
        }
        this._backdrop.placeBelow(window);
    }

    private _manageWindow(window: Meta.Window) {
        if (this._windows.has(window)) return;

        const fmWindow: FocusModeWindow = new FocusModeWindow(window, {
            // the window is going away, there is nothing to restore
            onUnmanaging: () => {
                fmWindow.release();
                this._forgetWindow(window);
            },
            onMinimized: () => {
                fmWindow.restore();
                this._forgetWindow(window);
            },
            onLeftWorkspace: () => {
                if (window === this._window) {
                    this.exit();
                    return;
                }
                fmWindow.restore();
                this._forgetWindow(window);
            },
        });
        this._windows.set(window, fmWindow);
        fmWindow.center();
    }

    private _forgetWindow(window: Meta.Window) {
        this._windows.delete(window);
        if (window !== this._window) return;

        // the next focused window will take its place
        this._window = null;
        this._scheduleSync();
    }

    private _clearAbandonedTimeout() {
        if (this._abandonedTimeoutId)
            GLib.source_remove(this._abandonedTimeoutId);
        this._abandonedTimeoutId = 0;
    }

    private _clearSyncSource() {
        if (this._syncSourceId) GLib.source_remove(this._syncSourceId);
        this._syncSourceId = 0;
    }
}
