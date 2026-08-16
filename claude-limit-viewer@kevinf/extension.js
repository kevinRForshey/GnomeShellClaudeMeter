import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

// Same endpoint and headers Claude Code's own `/usage` command uses.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

const POLL_INTERVAL_SECONDS = 60;
const BAR_WIDTH = 220;
const BAR_HEIGHT = 6;

const KIND_LABELS = {
    session: 'Current session (5h)',
    weekly_all: 'Weekly (7d), all models',
    weekly_opus: 'Weekly (7d), Opus',
    weekly_sonnet: 'Weekly (7d), Sonnet',
};

function credentialsPath() {
    const configDir = GLib.getenv('CLAUDE_CONFIG_DIR');
    const base = configDir && configDir.length > 0
        ? configDir
        : GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    return GLib.build_filenamev([base, '.credentials.json']);
}

function severityClass(percent) {
    if (percent >= 90)
        return 'claude-sev-critical';
    if (percent >= 70)
        return 'claude-sev-warning';
    return 'claude-sev-normal';
}

function labelFor(limit) {
    const scope = limit.scope || {};
    const model = scope.model && scope.model.display_name;
    if (model)
        return model;
    const kind = limit.kind || '';
    return KIND_LABELS[kind] || kind.replace(/_/g, ' ');
}

function formatRemaining(resetsAtIso) {
    if (!resetsAtIso)
        return '';
    const resetMs = Date.parse(resetsAtIso);
    if (Number.isNaN(resetMs))
        return '';
    const diffMs = resetMs - Date.now();
    if (diffMs <= 0)
        return 'resets now';
    const totalMinutes = Math.round(diffMs / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0)
        return `resets in ${days}d ${hours}h`;
    if (hours > 0)
        return `resets in ${hours}h ${minutes}m`;
    return `resets in ${minutes}m`;
}

function makeBar(percent) {
    const clamped = Math.min(100, Math.max(0, percent));
    const track = new St.Widget({style_class: 'claude-bar-track', width: BAR_WIDTH, height: BAR_HEIGHT});
    const fillWidth = clamped <= 0 ? 0 : Math.max(2, Math.round(BAR_WIDTH * clamped / 100));
    const fill = new St.Widget({
        style_class: `claude-bar-fill ${severityClass(clamped)}`,
        width: fillWidth,
        height: BAR_HEIGHT,
    });
    fill.set_position(0, 0);
    track.add_child(fill);
    return track;
}

const UsageRow = GObject.registerClass(
class UsageRow extends PopupMenu.PopupBaseMenuItem {
    _init(limit) {
        super._init({reactive: false, can_focus: false});

        const percent = typeof limit.percent === 'number' ? limit.percent : 0;
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'claude-usage-row'});

        const headerBox = new St.BoxLayout({x_expand: true});
        const label = new St.Label({text: labelFor(limit), x_expand: true, style_class: 'claude-row-label'});
        const percentLabel = new St.Label({
            text: `${Math.round(percent)}%`,
            style_class: `claude-row-percent ${severityClass(percent)}`,
        });
        headerBox.add_child(label);
        headerBox.add_child(percentLabel);

        const footerBox = new St.BoxLayout({x_expand: true});
        const resetLabel = new St.Label({
            text: formatRemaining(limit.resets_at),
            x_expand: true,
            style_class: 'claude-row-reset',
        });
        footerBox.add_child(resetLabel);
        if (limit.is_active) {
            footerBox.add_child(new St.Label({text: 'in use', style_class: 'claude-row-active'}));
        }

        box.add_child(headerBox);
        box.add_child(makeBar(percent));
        box.add_child(footerBox);
        this.add_child(box);
    }
});

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Claude Usage', false);

        this._session = new Soup.Session({timeout: 10});
        this._cancellable = new Gio.Cancellable();
        this._timeoutId = null;

        const box = new St.BoxLayout({style_class: 'claude-panel-box'});
        this._icon = new St.Icon({icon_name: 'utilities-terminal-symbolic', style_class: 'system-status-icon'});
        this._label = new St.Label({text: 'Claude', y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-panel-label'});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this.refresh();
        });

        this.refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('Loading…', {reactive: false, can_focus: false});
        this.menu.addMenuItem(this._statusItem);

        this._rowsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._rowsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._updatedItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
            style_class: 'claude-updated-item',
        });
        this.menu.addMenuItem(this._updatedItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);
    }

    _setPanelText(text, sevClass) {
        this._label.text = text;
        this._label.remove_style_class_name('claude-sev-normal');
        this._label.remove_style_class_name('claude-sev-warning');
        this._label.remove_style_class_name('claude-sev-critical');
        if (sevClass)
            this._label.add_style_class_name(sevClass);
    }

    async refresh() {
        let token;
        try {
            const file = Gio.File.new_for_path(credentialsPath());
            const [contents] = await file.load_contents_async(this._cancellable);
            const text = new TextDecoder('utf-8').decode(contents);
            token = JSON.parse(text)?.claudeAiOauth?.accessToken;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            this._showSignedOut('No Claude Code credentials found — run claude to sign in');
            return;
        }

        if (!token) {
            this._showSignedOut('No Claude Code credentials found — run claude to sign in');
            return;
        }

        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', OAUTH_BETA_HEADER);
        message.request_headers.append('Content-Type', 'application/json');

        try {
            const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
            const status = message.get_status();

            if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN) {
                this._showSignedOut('Session expired — run claude to sign in again');
                return;
            }
            if (status !== Soup.Status.OK) {
                this._showError(`Usage request failed (HTTP ${status})`);
                return;
            }

            const text = new TextDecoder('utf-8').decode(bytes.get_data());
            this._showData(JSON.parse(text));
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            this._showError('Network error contacting Claude');
        }
    }

    _showSignedOut(message) {
        this._setPanelText('Sign in', 'claude-sev-critical');
        this._statusItem.label.text = message;
        this._rowsSection.removeAll();
        this._updatedItem.label.text = '';
    }

    _showError(message) {
        this._setPanelText('Error', 'claude-sev-warning');
        this._statusItem.label.text = message;
    }

    _showData(data) {
        const limits = Array.isArray(data.limits) ? data.limits : [];

        const parts = [];
        let maxPercent = 0;
        if (data.five_hour) {
            parts.push(`5h ${Math.round(data.five_hour.utilization)}%`);
            maxPercent = Math.max(maxPercent, data.five_hour.utilization);
        }
        if (data.seven_day) {
            parts.push(`7d ${Math.round(data.seven_day.utilization)}%`);
            maxPercent = Math.max(maxPercent, data.seven_day.utilization);
        }
        this._setPanelText(parts.length ? parts.join(' · ') : 'Claude', severityClass(maxPercent));

        this._statusItem.label.text = 'Claude Code usage';
        this._rowsSection.removeAll();

        const validLimits = limits.filter(limit => limit && typeof limit.percent === 'number');
        if (validLimits.length === 0) {
            this._rowsSection.addMenuItem(new PopupMenu.PopupMenuItem('No usage data reported', {
                reactive: false,
                can_focus: false,
            }));
        } else {
            for (const limit of validLimits)
                this._rowsSection.addMenuItem(new UsageRow(limit));
        }

        const now = GLib.DateTime.new_now_local();
        this._updatedItem.label.text = `Updated ${now.format('%H:%M:%S')}`;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._cancellable.cancel();
        super.destroy();
    }
});

export default class ClaudeLimitViewerExtension extends Extension {
    enable() {
        this._indicator = new ClaudeIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
