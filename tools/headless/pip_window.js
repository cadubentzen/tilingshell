#!/usr/bin/env -S gjs -m
// A stand-in for a browser's picture-in-picture video window, for the focus
// mode tests: a GTK 4 window titled like Firefox's, with a 16:9 default size.
//
//   tools/headless/ctl.py run tools/headless/pip_window.js [WIDTH HEIGHT]
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

const [width, height] = [
    parseInt(ARGV[0] ?? '480'),
    parseInt(ARGV[1] ?? '270'),
];

const app = new Gtk.Application({
    application_id: 'org.tilingshell.PipTest',
    // allow several picture-in-picture windows
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Picture-in-Picture',
        default_width: width,
        default_height: height,
        decorated: false,
    });
    window.present();
});
app.run([]);
