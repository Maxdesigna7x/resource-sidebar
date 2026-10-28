#!/usr/bin/env bash
# User-local install. Run without sudo.
set -euo pipefail
sidebar_uuid='resource-sidebar@randy.local'
sidebar_source="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$sidebar_uuid"
sidebar_data="${XDG_DATA_HOME:-$HOME/.local/share}"
sidebar_target="$sidebar_data/gnome-shell/extensions/$sidebar_uuid"
if [[ "$(id -u)" == 0 ]]; then
    echo 'Ejecuta este instalador como tu usuario, sin sudo.' >&2
    exit 1
fi
for sidebar_command in gnome-shell gsettings glib-compile-schemas /usr/bin/python3; do
    if ! command -v "$sidebar_command" >/dev/null; then
        echo "Falta una dependencia: $sidebar_command" >&2
        exit 1
    fi
done
sidebar_version="$(gnome-shell --version | /usr/bin/python3 -c 'import re,sys; print(re.search(r"\d+", sys.stdin.read()).group())')"
if [[ "$sidebar_version" != 46 ]]; then
    echo "Esta versión está validada para GNOME 46. Encontrado: GNOME $sidebar_version." >&2
    echo 'Consulta README.md para adaptar o portar la extensión.' >&2
    exit 1
fi
if [[ -d "$sidebar_target" ]]; then
    mkdir -p "$sidebar_data/resource-sidebar/backups"
    sidebar_backup="$sidebar_data/resource-sidebar/backups/$(date +%Y%m%d-%H%M%S)-$$"
    cp -a -- "$sidebar_target" "$sidebar_backup"
    echo "Copia de la versión anterior: $sidebar_backup"
fi
mkdir -p -- "$sidebar_target/icons" "$sidebar_target/schemas"
cp -- "$sidebar_source/extension.js" "$sidebar_source/collector.py" "$sidebar_source/metadata.json" "$sidebar_source/stylesheet.css" "$sidebar_target/"
cp -- "$sidebar_source/icons/"*.svg "$sidebar_target/icons/"
cp -- "$sidebar_source/schemas/"*.xml "$sidebar_target/schemas/"
glib-compile-schemas --strict "$sidebar_target/schemas"
# Append only our UUID, preserving the user's other enabled extensions.
/usr/bin/python3 - <<'PY'
from gi.repository import Gio
settings = Gio.Settings.new('org.gnome.shell')
extensions = settings.get_strv('enabled-extensions')
uuid = 'resource-sidebar@randy.local'
if uuid not in extensions:
    settings.set_strv('enabled-extensions', extensions + [uuid])
Gio.Settings.sync()
PY
if command -v gnome-extensions >/dev/null; then
    gnome-extensions enable "$sidebar_uuid" 2>/dev/null || true
fi
echo "Instalado en: $sidebar_target"
echo 'Cierra sesión y vuelve a entrar para cargar la instalación nueva o una actualización.'
echo 'En una parte visible del escritorio: pasa el cursor por el borde superior derecho. En cualquier aplicación: Shift + Alt.'
