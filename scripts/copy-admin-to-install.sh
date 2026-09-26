#!/usr/bin/env bash
# Refresh the Docker build context without copying host-installed dependencies.
set -euo pipefail

source_dir=${1:?source checkout required}
install_dir=${2:?install directory required}
if [[ ! -d "$source_dir/admin" || ! -d "$install_dir" ]]; then
    echo 'source admin directory or install directory is missing' >&2
    exit 2
fi

tar -C "$source_dir" \
    --exclude='admin/backend/node_modules' \
    --exclude='admin/frontend/node_modules' \
    --exclude='admin/backend/data' \
    --exclude='admin/backend/.env' \
    --exclude='admin/frontend/.env' \
    -cf - admin | tar -C "$install_dir" -xf -
