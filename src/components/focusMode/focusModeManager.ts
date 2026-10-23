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
// titles of the picture-in-picture windows of Firefox and Chromium
const PIP_TITLE_REGEX = /^picture[- ]in[- ]picture$/i;

interface SavedWindowState {
    rect: Mtk.Rectangle;
    maximized: boolean;
    above: boolean;
}

function isMaximized(window: Meta.Window): boolean {
    return window.maximizedHorizontally || window.maximizedVertically;
}

/** Picture-in-picture video windows, e.g. from Firefox or Chromium. */
function isPictureInPicture(window: Meta.Window): boolean {
    if (window.get_window_type() !== Meta.WindowType.NORMAL) return false;

    const tag = window.get_tag?.() ?? '';
    return (
        PIP_TITLE_REGEX.test(window.get_title() ?? '') ||
        /picture-in-picture|\bpip\b/i.test(tag)
    );
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

/**
 * The blurred area on the left of the focused window, where picture-in-picture
 * windows go, or null if there is no room for them.
 */
function computePipArea(monitorIndex: number): Mtk.Rectangle | null {
    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
    const outerGaps = Settings.get_outer_gaps();
    const innerGaps = Settings.get_inner_gaps();
    const target = computeTargetRect(monitorIndex);
    const x = workArea.x + outerGaps.left;
    const width = target.x - innerGaps.right - x;
    if (width <= 0) return null;

    return buildRectangle({ x, y: target.y, width, height: target.height });
}

/**
 * Stack picture-in-picture windows vertically in the given area, keeping their
 * aspect ratio (width / height). They take the whole width of the area, or
 * are scaled down to fit its height, and the stack is at the bottom.
 */
function layoutPipWindows(
    area: Mtk.Rectangle,
    aspectRatios: number[]
): Mtk.Rectangle[] {
    const gap = Settings.get_inner_gaps().top;
    const totalGaps = gap * (aspectRatios.length - 1);
    const heights = aspectRatios.map(ratio => area.width / ratio);
    const totalHeight = heights.reduce((sum, h) => sum + h, 0);
    const scale = Math.min(
        1,
        Math.max(0, area.height - totalGaps) / totalHeight
    );

    let y =
        area.y + Math.floor(area.height - totalHeight * scale - totalGaps);
    return heights.map(h => {
        const height = Math.floor(h * scale);
        const width = Math.floor(area.width * scale);
        const rect = buildRectangle({
            x: area.x + Math.floor((area.width - width) / 2),
            y,
            width,
            height,
        });
        y += height + gap;
        return rect;
    });
}

interface FocusModeWindowCallbacks {
    /** The geometry given to the window in focus mode. */
    targetRect: () => Mtk.Rectangle;
    onUnmanaging: () => void;
    onMinimized: () => void;
    onLeftWorkspace: () => void;
}

/**
 * A window given the focus mode geometry. It remembers the original geometry
 * and maximized state of the window, to restore them when leaving focus mode.
 * Picture-in-picture windows are also kept above the others (and the
 * backdrop) until then.
 */
class FocusModeWindow {
    public readonly window: Meta.Window;
    public readonly isPip: boolean;
    private readonly _callbacks: FocusModeWindowCallbacks;
    private readonly _signals: SignalHandling;
    private readonly _savedState: SavedWindowState;
    private _unmaximizeSignalId: number;
    private _awaitingResize: boolean;
    private _resizeTimeoutId: number;

    constructor(
        window: Meta.Window,
        isPip: boolean,
        callbacks: FocusModeWindowCallbacks
    ) {
        this.window = window;
        this.isPip = isPip;
        this._callbacks = callbacks;
        this._signals = new SignalHandling();
        this._savedState = {
            rect: window.get_frame_rect().copy(),
            maximized: isMaximized(window),
            above: window.is_above(),
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

    /** Width / height of the window before focus mode. */
    public get aspectRatio(): number {
        const rect = this._savedState.rect;
        return rect.height > 0 ? rect.width / rect.height : 16 / 9;
    }

    public center() {
        const window = this.window;
        if (window.is_fullscreen()) return;

        if (this.isPip && !window.is_above()) window.make_above();

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

        const target = this._callbacks.targetRect();
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
        if (this.isPip && !state.above && window.is_above())
            window.unmake_above();
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

        const target = this._callbacks.targetRect();
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
 * Picture-in-picture windows are kept above, in the blurred area on the left.
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
        // if a picture-in-picture window is focused, use the window below it
        const target =
            window && isPictureInPicture(window)
                ? (this._workspaceWindows()[0] ?? null)
                : this._focusableWindow(window);
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
        this._signals.connect(
            global.display,
            'window-created',
            (_display: Meta.Display, win: Meta.Window) =>
                this._onWindowCreated(win)
        );
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
            isPictureInPicture(window) ||
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
            this._pipWindows()
                .filter(win => win.get_monitor() === monitorIndex)
                .forEach(win => this._manageWindow(win, true));
        }
        this._backdrop.placeBelow(window);
    }

    private _pipWindows(): Meta.Window[] {
        // picture-in-picture windows may be skipped by the tab list
        const workspace = global.workspaceManager.get_active_workspace();
        return global.display
            .list_all_windows()
            .filter(
                win =>
                    isPictureInPicture(win) &&
                    !win.minimized &&
                    win.located_on_workspace(workspace)
            );
    }

    private _onWindowCreated(window: Meta.Window) {
        // wait for the window to be shown: its title may not be set yet, and
        // its initial position is chosen when it is mapped
        const actor = window.get_compositor_private() as Meta.WindowActor;
        if (!actor) return;

        const id = actor.connect('first-frame', () => {
            actor.disconnect(id);
            if (
                this.active &&
                this._backdrop?.monitorIndex === window.get_monitor() &&
                isPictureInPicture(window) &&
                !window.minimized &&
                window.located_on_workspace(
                    global.workspaceManager.get_active_workspace()
                )
            )
                this._manageWindow(window, true);
        });
    }

    private _pipTargetRect(window: Meta.Window): Mtk.Rectangle {
        const monitorIndex = window.get_monitor();
        const area = computePipArea(monitorIndex);
        if (!area) return window.get_frame_rect();

        const pips = [...this._windows.values()].filter(
            fmWindow =>
                fmWindow.isPip && fmWindow.window.get_monitor() === monitorIndex
        );
        const rects = layoutPipWindows(
            area,
            pips.map(fmWindow => fmWindow.aspectRatio)
        );
        const index = pips.findIndex(fmWindow => fmWindow.window === window);
        return rects[index] ?? window.get_frame_rect();
    }

    /** Move the picture-in-picture windows to their place in the layout. */
    private _layoutPipWindows() {
        this._windows.forEach(fmWindow => {
            if (fmWindow.isPip) fmWindow.moveToTargetRect();
        });
    }

    private _manageWindow(window: Meta.Window, isPip: boolean = false) {
        if (this._windows.has(window)) return;
        // leave picture-in-picture windows alone if there is no room for them
        if (isPip && !computePipArea(window.get_monitor())) return;

        const fmWindow: FocusModeWindow = new FocusModeWindow(window, isPip, {
            targetRect: () =>
                isPip
                    ? this._pipTargetRect(window)
                    : computeTargetRect(window.get_monitor()),
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
        // make room for the new picture-in-picture window
        if (isPip) this._layoutPipWindows();
    }

    private _forgetWindow(window: Meta.Window) {
        const fmWindow = this._windows.get(window);
        this._windows.delete(window);
        // give the room of the window to the other picture-in-picture windows
        if (fmWindow?.isPip) this._layoutPipWindows();
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
