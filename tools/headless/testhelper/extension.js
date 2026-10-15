// Test-only extension, loaded by tools/headless/start.sh in the isolated
// headless shell. Never install it in a real session.
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class TestHelper extends Extension {
    enable() {
        // allow org.gnome.Shell.Eval and org.gnome.Shell.Screenshot over D-Bus
        global.context.unsafe_mode = true;

        const ready = () => {
            Main.overview.hide();
            // drop the "System was put in unsafe mode" banner, it would end
            // up in every screenshot
            this._clearId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                Main.messageTray.getSources().forEach(source => source.destroy());
                this._clearId = 0;
                return GLib.SOURCE_REMOVE;
            });
        };
        if (Main.layoutManager._startingUp)
            this._startupId = Main.layoutManager.connect('startup-complete', ready);
        else
            ready();
    }

    disable() {
        if (this._startupId) Main.layoutManager.disconnect(this._startupId);
        if (this._clearId) GLib.source_remove(this._clearId);
        this._startupId = this._clearId = 0;
        global.context.unsafe_mode = false;
    }
}
