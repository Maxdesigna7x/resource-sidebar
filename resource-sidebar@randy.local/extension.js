import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const METRICS = [
    ['cpu', 'CPU', '#76a9d4'],
    ['memory', 'RAM', '#d0787f'],
    ['disk', 'HDD', '#d1a071'],
    ['network', 'Wi-Fi', '#aa90cd'],
    ['gpu', 'GPU', '#88b894'],
];
const EXPANDED_MIN_WIDTH = 156;
const COMPACT_WIDTH = 44;
const EDGE_HEIGHT = 210;
const valid = n => typeof n === 'number' && Number.isFinite(n);
const percent = n => valid(n) ? `${Math.round(n)}%` : '—';
const temperature = n => valid(n) ? `${Math.round(n)} °C` : '— °C';
const gib = n => valid(n) ? (n / 1073741824).toFixed(1) : '—';
const vram = n => valid(n) ? (n / 1024).toFixed(1) : '—';
function rate(n) {
    if (!valid(n)) return '—';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB/s`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB/s`;
    return `${(n / 1000).toFixed(1)} KB/s`;
}

export default class ResourceSidebar extends Extension {
    enable() {
        this._active = true;
        this._settings = this.getSettings();
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._rows = new Map();
        this._sources = new Set();
        this._state = 'hidden';
        this._size = this._settings.get_boolean('expanded') ? 'expanded' : 'peek';
        this._expandedWidth = EXPANDED_MIN_WIDTH * this._scale;
        this._edgeHovered = false;
        this._hoverSuppressed = false;
        this._failures = 0;
        this._card = new St.BoxLayout({vertical: true, style_class: 'rs-card', reactive: true,
            accessible_name: 'Monitor de recursos'});
        this._header = new St.BoxLayout({style_class: 'rs-header'});
        this._pin = new St.Button({style_class: 'rs-pin', can_focus: true,
            accessible_name: 'Fijar o soltar el panel'});
        this._pinIcon = new St.Icon({gicon: Gio.icon_new_for_string(`${this.path}/icons/pin.svg`), icon_size: 14});
        this._pin.set_child(this._pinIcon);
        this._pin.connect('clicked', () => this._setPinned(!this._settings.get_boolean('pinned')));
        this._header.add_child(this._pin);
        this._card.add_child(this._header);
        for (const [key, title, color] of METRICS)
            this._makeRow(key, title, color);
        this._keyboardOpen = false;
        Main.layoutManager.addChrome(this._card, {affectsStruts: false, trackFullscreen: false});
        this._card.connect('enter-event', () => {
            this._cancelHide();
            return Clutter.EVENT_PROPAGATE;
        });
        this._card.connect('leave-event', () => {
            this._scheduleHide();
            return Clutter.EVENT_PROPAGATE;
        });
        this._card.connect('button-release-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const [pinX, pinY] = this._pin.get_transformed_position();
            const onPin = x >= pinX && x < pinX + this._pin.width && y >= pinY && y < pinY + this._pin.height;
            if (event.get_button() !== 1 || onPin)
                return Clutter.EVENT_PROPAGATE;
            this._toggleSize();
            return Clutter.EVENT_STOP;
        });
        Main.wm.addKeybinding('toggle-sidebar', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._toggleKeyboard());
        this._gateSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._syncHoverGate();
            return GLib.SOURCE_CONTINUE;
        });
        this._sources.add(this._gateSource);
        this._settingsSignal = this._settings.connect('changed::pinned', () => {
            this._keyboardOpen = false;
            if (this._state === 'hidden' && this._settings.get_boolean('pinned'))
                this._show(this._size);
            else
                this._refreshPin();
            if (!this._settings.get_boolean('pinned')) this._scheduleHide();
        });
        this._monitorSignal = Main.layoutManager.connect('monitors-changed', () => this._position());
        this._workAreaSignal = global.display.connect('workareas-changed', () => this._position());
        this._scaleSignal = St.ThemeContext.get_for_stage(global.stage).connect('notify::scale-factor', () => {
            this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            this._show(this._state);
        });
        this._show(this._settings.get_boolean('pinned') ? this._size : 'hidden');
        this._startCollector();
    }

    _makeRow(key, title, color) {
        const button = new St.BoxLayout({vertical: true, style_class: 'rs-metric',
            accessible_name: `${title}: mostrar detalles`});
        const box = new St.BoxLayout({vertical: true, style_class: 'rs-metric-box', x_expand: true, x_align: Clutter.ActorAlign.FILL});
        const top = new St.BoxLayout({style_class: 'rs-metric-top'});
        const symbol = new St.Icon({gicon: Gio.icon_new_for_string(`${this.path}/icons/${key}.svg`), icon_size: 16});
        const label = new St.Label({text: title, style_class: 'rs-metric-title',
            y_align: Clutter.ActorAlign.CENTER});
        top.add_child(symbol);
        top.add_child(label);
        const bottom = new St.BoxLayout({style_class: 'rs-metric-bottom'});
        const graph = new St.DrawingArea({style_class: 'rs-graph', y_align: Clutter.ActorAlign.CENTER});
        const values = new St.BoxLayout({vertical: true, x_expand: true,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        const primary = new St.Label({text: '—', style_class: 'rs-value', x_align: Clutter.ActorAlign.START});
        const secondary = new St.Label({text: '—', style_class: 'rs-secondary', x_align: Clutter.ActorAlign.START});
        values.add_child(primary);
        values.add_child(secondary);
        bottom.add_child(graph);
        bottom.add_child(values);
        box.add_child(top);
        box.add_child(bottom);
        button.add_child(box);
        this._card.add_child(button);
        const row = {button, symbol, label, graph, values, primary, secondary, history: [], color};
        graph.connect('repaint', () => this._draw(row, key));
        this._rows.set(key, row);
    }

    _draw(row, key) {
        const cr = row.graph.get_context();
        const [w, h] = row.graph.get_surface_size();
        try {
            const rgb = row.color.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255);
            cr.setSourceRGBA(...rgb, 0.10);
            cr.setLineWidth(1);
            for (const y of [h * .33, h * .66, h - 1]) {
                cr.moveTo(0, y); cr.lineTo(w, y);
            }
            cr.stroke();
            if (row.history.length < 2) return;
            const values = row.history;
            const dynamic = key === 'disk' || key === 'network';
            const max = dynamic ? Math.max(4096, ...values.flat().filter(valid)) * 1.15 : 100;
            const x = i => w * (60 - values.length + i) / 59;
            const y = value => h - 2 - Math.min(max, Math.max(0, value)) / max * (h - 5);
            for (let channel = dynamic ? 1 : 0; channel >= 0; channel--) {
                // Missing readings break the line instead of inventing zero values.
                let drawing = false;
                cr.setSourceRGBA(...rgb, channel ? .48 : .95);
                cr.setLineWidth(this._scale * (channel ? 1 : 1.5));
                for (let i = 0; i < values.length; i++) {
                    const value = values[i][channel];
                    if (!valid(value)) { drawing = false; continue; }
                    if (!drawing) cr.moveTo(x(i), y(value));
                    else cr.lineTo(x(i), y(value));
                    drawing = true;
                }
                cr.stroke();
            }
            // Subtle area below the primary series, only across valid adjacent points.
            cr.setSourceRGBA(...rgb, .12);
            for (let i = 1; i < values.length; i++) {
                if (!valid(values[i - 1][0]) || !valid(values[i][0])) continue;
                cr.moveTo(x(i - 1), h);
                cr.lineTo(x(i - 1), y(values[i - 1][0]));
                cr.lineTo(x(i), y(values[i][0]));
                cr.lineTo(x(i), h); cr.closePath();
            }
            cr.fill();
        } finally {
            cr.$dispose();
        }
    }

    _setPinned(pinned) {
        // Pinning never changes size; changing size never changes pinning.
        this._settings.set_boolean('pinned', pinned);
        this._refreshPin();
    }

    _refreshPin() {
        const pinned = this._settings.get_boolean('pinned');
        this._pinIcon.gicon = Gio.icon_new_for_string(`${this.path}/icons/${pinned ? 'pin-active' : 'pin'}.svg`);
        this._pin.accessible_name = pinned ? 'Soltar panel' : 'Anclar este tamaño';
        this._pin.set_style_class_name(`rs-pin ${pinned ? 'rs-pin-active' : ''}`);
    }

    _toggleSize() {
        this._size = this._size === 'expanded' ? 'peek' : 'expanded';
        this._settings.set_boolean('expanded', this._size === 'expanded');
        this._show(this._size);
    }

    _fitExpandedWidth() {
        // Fit actual glyph widths, including units, rather than reserving a blank column.
        const textWidth = Math.max(...[...this._rows.values()].flatMap(row =>
            [row.primary, row.secondary].map(label => label.get_preferred_width(-1)[1])));
        this._expandedWidth = Math.ceil(Math.max(EXPANDED_MIN_WIDTH * this._scale,
            (60 + 6 + 22) * this._scale + textWidth));
        if (this._state === 'expanded') this._card.set_width(this._expandedWidth);
    }

    _show(state) {
        this._state = state;
        const expanded = state === 'expanded';
        this._card.visible = state !== 'hidden';
        this._card.set_style_class_name(`rs-card ${expanded ? 'rs-expanded' : 'rs-compact'}`);
        this._card.set_width(expanded ? this._expandedWidth : COMPACT_WIDTH * this._scale);
        this._header.x_align = expanded ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER;
        this._refreshPin();
        for (const row of this._rows.values()) {
            row.label.visible = expanded;
            row.values.visible = expanded;
            row.graph.set_size((expanded ? 60 : 26) * this._scale, (expanded ? 24 : 13) * this._scale);
            row.graph.queue_repaint();
        }
        if (expanded) this._fitExpandedWidth();
        this._position();
        this._syncHoverGate();
    }

    _position() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const s = this._scale;
        const width = this._state === 'expanded' ? this._expandedWidth : COMPACT_WIDTH * s;
        const right = area.x + area.width;
        const top = area.y + 18 * s;
        this._card.set_position(right - width - 4 * s, top);
        this._edgeBand = {x: right - 3 * s, y: top, width: 3 * s, height: Math.min(EDGE_HEIGHT * s, area.height - 18 * s)};
    }

    _desktopAvailable(x, y) {
        if (Main.overview.visible || Main.sessionMode.isLocked) return false;
        if (x === undefined || y === undefined) [x, y] = global.get_pointer();
        const workspace = global.workspace_manager.get_active_workspace();
        return !global.get_window_actors().some(actor => {
            const window = actor.meta_window;
            if (!window || window.minimized || !window.located_on_workspace(workspace) ||
                !window.showing_on_its_workspace()) return false;
            // Frame rectangles distinguish exposed wallpaper from the rest of the workspace.
            if (![Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
                Meta.WindowType.UTILITY, Meta.WindowType.MENU, Meta.WindowType.POPUP_MENU,
                Meta.WindowType.DROPDOWN_MENU].includes(window.get_window_type())) return false;
            const rect = window.get_frame_rect();
            return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        });
    }

    _pointerOnFreeEdge() {
        if (!this._edgeBand) return false;
        const [x, y] = global.get_pointer();
        const band = this._edgeBand;
        return x >= band.x && x < band.x + band.width &&
            y >= band.y && y < band.y + band.height && this._desktopAvailable(x, y);
    }

    _syncHoverGate() {
        if (!this._active) return;
        // Poll pointer position, without overlaying an input actor on application edges.
        const onEdge = this._pointerOnFreeEdge();
        if (!onEdge) {
            this._hoverSuppressed = false;
            this._cancelHover();
            if (this._edgeHovered) this._scheduleHide();
        } else {
            this._cancelHide();
            if (!this._hoverSuppressed && this._state === 'hidden' && !this._hoverSource)
                this._hoverSource = this._later(180, () => {
                    this._hoverSource = 0;
                    if (this._pointerOnFreeEdge() && !this._hoverSuppressed)
                        this._show(this._size);
                });
        }
        this._edgeHovered = onEdge;
    }

    _toggleKeyboard() {
        this._cancelHover();
        this._cancelHide();
        if (this._state === 'hidden') {
            this._keyboardOpen = true;
            this._show(this._size);
        } else {
            this._keyboardOpen = false;
            this._hoverSuppressed = true;
            this._show('hidden');
        }
        // Only the pin button changes the persisted anchor state.
    }

    _later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            if (this._active) callback();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }
    _removeSource(id) {
        if (id && this._sources.delete(id)) GLib.Source.remove(id);
    }
    _cancelHover() { this._removeSource(this._hoverSource); this._hoverSource = 0; }
    _cancelHide() { this._removeSource(this._hideSource); this._hideSource = 0; }
    _scheduleHide() {
        this._cancelHide();
        if (this._settings.get_boolean('pinned') || this._keyboardOpen) return;
        this._hideSource = this._later(650, () => {
            this._hideSource = 0;
            if (!(this._card.visible && this._card.has_pointer) && !this._pointerOnFreeEdge())
                this._show('hidden');
        });
    }

    _startCollector() {
        if (!this._active) return;
        try {
            this._cancellable = new Gio.Cancellable();
            this._process = Gio.Subprocess.new(['/usr/bin/python3', `${this.path}/collector.py`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._stream = new Gio.DataInputStream({base_stream: this._process.get_stdout_pipe()});
            this._readLine(this._stream, this._cancellable);
        } catch (error) {
            this._collectorFailed(error);
        }
    }
    _readLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            if (!this._active || cancellable.is_cancelled()) return;
            try {
                const [line] = source.read_line_finish_utf8(result);
                if (line === null) { this._collectorFailed(new Error('El lector de métricas se cerró')); return; }
                this._update(JSON.parse(line));
                this._failures = 0;
                this._readLine(stream, cancellable);
            } catch (error) {
                if (!cancellable.is_cancelled()) this._collectorFailed(error);
            }
        });
    }
    _collectorFailed(error) {
        console.error(`[Resource Sidebar] ${error.message}`);
        this._stopCollector();
        this._card.accessible_name = 'Monitor de recursos · sin datos, reintentando';
        for (const row of this._rows.values()) {
            row.primary.text = '—'; row.secondary.text = 'Sin datos';
            row.history = []; row.graph.queue_repaint();
        }
        this._later(Math.min(30000, 2000 * 2 ** Math.min(this._failures++, 4)), () => this._startCollector());
    }
    _stopCollector() {
        this._cancellable?.cancel();
        this._process?.force_exit();
        try { this._stream?.close(null); } catch (_) { /* Cancelled stream. */ }
        this._process = null;
        this._stream = null;
        this._cancellable = null;
    }
    _update(data) {
        const c = data.cpu, m = data.memory, d = data.disk, n = data.network, g = data.gpu;
        const entries = {
            cpu: [percent(c.usage), temperature(c.temperature), [c.usage]],
            memory: [`${gib(m.used)} / ${gib(m.total)} GiB`, percent(m.usage), [m.usage]],
            disk: [`R  ${rate(d.read)}`, `W  ${rate(d.write)}`, [d.read, d.write]],
            network: [`↑  ${rate(n.up)}`, `↓  ${rate(n.down)}`, [n.down, n.up]],
            gpu: [`${vram(g.used_mib)} / ${vram(g.total_mib)} GiB`, `${percent(g.usage)}   ${temperature(g.temperature)}`, [g.usage]],
        };
        this._rows.get('network').label.text = 'Wi-Fi';
        for (const [key, [primary, secondary, point]] of Object.entries(entries)) {
            const row = this._rows.get(key);
            row.primary.text = primary;
            row.secondary.text = secondary;
            row.button.accessible_name = `${row.label.text}: ${primary}, ${secondary}`;
            row.history.push(point);
            if (row.history.length > 60) row.history.shift();
            row.graph.queue_repaint();
        }
        this._rows.get('disk').button.accessible_name += `, ${d.devices.join(', ')}`;
        this._rows.get('gpu').button.accessible_name += `, ${g.name}`;
        this._card.accessible_name = 'Monitor de recursos';
        if (this._state === 'expanded') {
            this._fitExpandedWidth();
            this._position();
        }
    }

    disable() {
        this._active = false;
        Main.wm.removeKeybinding('toggle-sidebar');
        this._stopCollector();
        for (const id of this._sources ?? []) GLib.Source.remove(id);
        this._sources?.clear();
        if (this._settingsSignal) this._settings.disconnect(this._settingsSignal);
        if (this._monitorSignal) Main.layoutManager.disconnect(this._monitorSignal);
        if (this._workAreaSignal) global.display.disconnect(this._workAreaSignal);
        if (this._scaleSignal) St.ThemeContext.get_for_stage(global.stage).disconnect(this._scaleSignal);
        this._card?.destroy();
        this._rows?.clear();
        this._settings = null;
        this._card = this._header = this._pin = this._pinIcon = null;
        this._settingsSignal = this._monitorSignal = this._workAreaSignal = this._scaleSignal = 0;
        this._hoverSource = this._hideSource = this._gateSource = 0;
    }
}
