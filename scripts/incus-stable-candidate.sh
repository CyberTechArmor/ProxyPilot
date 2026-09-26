#!/usr/bin/env bash
# Print the newest Incus version advertised by the signed Zabbly stable apt
# source. apt-cache madison columns are pipe-separated, not whitespace fields.
set -euo pipefail
apt-cache madison incus | awk -F'|' '
    {
        source=$3
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", source)
        if (source ~ /^https:\/\/pkgs\.zabbly\.com\/incus\/stable([[:space:]]|$)/) {
            version=$2
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", version)
            if (version != "") { print version; exit }
        }
    }
'
