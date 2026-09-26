#!/bin/sh
# Starts Pi Web, preferring a release installed by the in-container updater.
#
# The updater (`PI_WEB_ALLOW_SELF_UPDATE=1`) installs a published release into
# PI_WEB_RELEASES_DIR and points `current` at it, so the next start picks it up
# without rebuilding the image. Without a `current` link this runs the build
# baked into the image.
set -eu

releases="${PI_WEB_RELEASES_DIR:-/opt/pi-web-releases}"
current="${releases}/current"

if [ -f "${current}/package.json" ]; then
  echo "[pi-web] Starting release from ${current}"
  exec node "${current}/bin/pi-web.js" "$@"
fi

exec node /opt/pi-web/bin/pi-web.js "$@"
