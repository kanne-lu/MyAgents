#!/bin/bash
# Download Node.js LTS binaries for bundling with MyAgents.
#
# This script downloads the official Node.js distribution for each platform
# and extracts it into src-tauri/resources/nodejs/.
#
# The full distribution includes node, npm, and npx — everything needed
# for MCP servers and AI bash tool execution.
#
# Usage:
#   ./scripts/download_nodejs.sh              # Download for current platform only
#   ./scripts/download_nodejs.sh --all        # Download for all platforms (CI/CD)
#   ./scripts/download_nodejs.sh --clean      # Remove existing downloads first

set -e

# ========================================
# Configuration
# ========================================
NODE_VERSION="24.14.0"  # LTS, pin to specific patch
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ========================================
# Helpers
# ========================================

log_info()  { echo -e "${BLUE}[nodejs]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[nodejs]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[nodejs]${NC} $1"; }
log_error() { echo -e "${RED}[nodejs]${NC} $1"; }

# Check if Node.js is already downloaded and correct version
check_existing() {
    local node_bin="$1"
    if [[ -f "$node_bin" ]]; then
        local existing_ver
        existing_ver=$("$node_bin" --version 2>/dev/null || echo "")
        if [[ "$existing_ver" == "v${NODE_VERSION}" ]]; then
            return 0  # Already correct version
        fi
    fi
    return 1
}

# Download and extract Node.js for macOS
download_macos() {
    local arch="$1"  # arm64 or x64
    local node_arch
    local tauri_triple

    if [[ "$arch" == "arm64" ]]; then
        node_arch="arm64"
        tauri_triple="aarch64-apple-darwin"
    else
        node_arch="x64"
        tauri_triple="x86_64-apple-darwin"
    fi

    local tarball="node-v${NODE_VERSION}-darwin-${node_arch}.tar.xz"
    local url="${NODE_BASE_URL}/${tarball}"
    local node_bin="${RESOURCES_DIR}/bin/node"

    # Check if already downloaded
    if check_existing "$node_bin"; then
        log_ok "macOS ${arch}: Already at v${NODE_VERSION}"
        return 0
    fi

    log_info "Downloading Node.js v${NODE_VERSION} for macOS ${arch}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" RETURN

    # Download
    curl -sL "$url" -o "${tmp_dir}/${tarball}"

    # Extract — strip the top-level directory
    log_info "Extracting..."
    mkdir -p "$RESOURCES_DIR"
    tar xf "${tmp_dir}/${tarball}" -C "$tmp_dir"

    # Copy full distribution (replacing any existing)
    local extracted_dir="${tmp_dir}/node-v${NODE_VERSION}-darwin-${node_arch}"
    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"
    cp -R "${extracted_dir}/bin" "$RESOURCES_DIR/"
    cp -R "${extracted_dir}/lib" "$RESOURCES_DIR/"

    # Resolve symlinks: npm/npx are symlinks, but Tauri resource copy may not
    # preserve them. Replace with actual shell scripts.
    for cmd in npm npx; do
        local link_target
        link_target=$(readlink "${RESOURCES_DIR}/bin/${cmd}" 2>/dev/null || echo "")
        if [[ -n "$link_target" ]]; then
            local cli_name
            if [[ "$cmd" == "npm" ]]; then cli_name="npm-cli"; else cli_name="npx-cli"; fi
            rm -f "${RESOURCES_DIR}/bin/${cmd}"
            cat > "${RESOURCES_DIR}/bin/${cmd}" <<EOF
#!/bin/sh
basedir=\$(cd "\$(dirname "\$0")" && pwd)
exec "\$basedir/node" "\$basedir/../lib/node_modules/npm/bin/${cli_name}.js" "\$@"
EOF
            chmod +x "${RESOURCES_DIR}/bin/${cmd}"
        fi
    done

    # Remove unnecessary files to reduce size
    rm -rf "${RESOURCES_DIR}/bin/corepack"
    rm -rf "${RESOURCES_DIR}/include"
    rm -rf "${RESOURCES_DIR}/share"
    rm -rf "${RESOURCES_DIR}/lib/node_modules/corepack"

    chmod +x "${RESOURCES_DIR}/bin/node"

    log_ok "macOS ${arch}: Node.js v${NODE_VERSION} ready"
}

# Download Node.js for Windows (used in CI/CD cross-build)
download_windows() {
    local arch="$1"  # x64 or arm64
    local zipfile="node-v${NODE_VERSION}-win-${arch}.zip"
    local url="${NODE_BASE_URL}/${zipfile}"

    log_info "Downloading Node.js v${NODE_VERSION} for Windows ${arch}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" RETURN

    curl -sL "$url" -o "${tmp_dir}/${zipfile}"

    log_info "Extracting..."
    unzip -q "${tmp_dir}/${zipfile}" -d "$tmp_dir"

    local extracted_dir="${tmp_dir}/node-v${NODE_VERSION}-win-${arch}"
    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"

    # Windows: flat structure (node.exe, npm.cmd, npx.cmd, node_modules/)
    cp "${extracted_dir}/node.exe" "$RESOURCES_DIR/"
    cp "${extracted_dir}/npm.cmd" "$RESOURCES_DIR/" 2>/dev/null || true
    cp "${extracted_dir}/npx.cmd" "$RESOURCES_DIR/" 2>/dev/null || true
    cp "${extracted_dir}/npm" "$RESOURCES_DIR/" 2>/dev/null || true
    cp "${extracted_dir}/npx" "$RESOURCES_DIR/" 2>/dev/null || true
    cp -R "${extracted_dir}/node_modules" "$RESOURCES_DIR/" 2>/dev/null || true

    # Remove corepack
    rm -f "${RESOURCES_DIR}/corepack.cmd" "${RESOURCES_DIR}/corepack"
    rm -rf "${RESOURCES_DIR}/node_modules/corepack"

    log_ok "Windows ${arch}: Node.js v${NODE_VERSION} ready"
}

# ========================================
# Main
# ========================================

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}Node.js v${NODE_VERSION} Download${NC}               ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"
echo ""

# Handle --clean flag
if [[ "$1" == "--clean" ]]; then
    log_warn "Cleaning existing Node.js resources..."
    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"
    touch "$RESOURCES_DIR/.gitkeep"
    shift
fi

if [[ "$1" == "--all" ]]; then
    # Download for all platforms (CI/CD)
    log_info "Downloading for ALL platforms..."
    # Note: For cross-platform builds, each platform build downloads its own.
    # This mode is for pre-populating caches.
    download_macos "arm64"
    download_macos "x64"
    # Windows requires a separate build environment
    log_warn "Windows binaries must be downloaded on the Windows build machine"
elif [[ "$1" == "--windows" ]]; then
    download_windows "${2:-x64}"
else
    # Download for current platform only
    ARCH=$(uname -m)
    PLATFORM=$(uname -s)

    if [[ "$PLATFORM" == "Darwin" ]]; then
        if [[ "$ARCH" == "arm64" ]]; then
            download_macos "arm64"
        else
            download_macos "x64"
        fi
    elif [[ "$PLATFORM" == "Linux" ]]; then
        log_warn "Linux support: download manually from ${NODE_BASE_URL}"
    else
        log_error "Unsupported platform: $PLATFORM"
        exit 1
    fi
fi

echo ""
log_ok "Done! Node.js resources at: ${RESOURCES_DIR}"
echo ""

# Show contents
if [[ -f "${RESOURCES_DIR}/bin/node" ]]; then
    local_ver=$("${RESOURCES_DIR}/bin/node" --version 2>/dev/null || echo "unknown")
    log_info "Bundled node version: ${local_ver}"
    log_info "Contents:"
    du -sh "${RESOURCES_DIR}" 2>/dev/null | awk '{print "  Total: " $1}'
    du -sh "${RESOURCES_DIR}/bin/node" 2>/dev/null | awk '{print "  node binary: " $1}'
    du -sh "${RESOURCES_DIR}/lib/node_modules/npm" 2>/dev/null | awk '{print "  npm: " $1}'
elif [[ -f "${RESOURCES_DIR}/node.exe" ]]; then
    log_info "Windows Node.js extracted"
fi
