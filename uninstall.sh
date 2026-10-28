#!/usr/bin/env bash
set -euo pipefail
sidebar_uuid='resource-sidebar@randy.local'
sidebar_target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$sidebar_uuid"
if [[ "$(id -u)" == 0 ]]; then
    echo 'Ejecuta este archivo como tu usuario, sin sudo.' >&2
    exit 1
fi
if command -v gnome-extensions >/dev/null; then
    gnome-extensions disable "$sidebar_uuid" 2>/dev/null || true
fi
/usr/bin/python3 - <<'PY'
from gi.repository import Gio
settings = Gio.Settings.new('org.gnome.shell')
settings.set_strv('enabled-extensions', [v for v in settings.get_strv('enabled-extensions') if v != 'resource-sidebar@randy.local'])
Gio.Settings.sync()
PY
# The fixed extension directory is the only directory removed.
if [[ -d "$sidebar_target" ]]; then rm -r -- "$sidebar_target"; fi
echo 'Resource Sidebar desinstalado. El paquete original y las copias de seguridad se conservan.'
