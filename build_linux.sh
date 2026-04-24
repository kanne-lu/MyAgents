#!/bin/bash
# MyAgents Linux 构建脚本 (v0.2.0+)
#
# 产出 AppImage + deb 到 src-tauri/target/release/bundle/{appimage,deb}。
# 所需系统依赖（Ubuntu 22.04+ / Debian 12+）：
#   sudo apt-get install -y \
#     build-essential libssl-dev libgtk-3-dev libayatana-appindicator3-dev \
#     librsvg2-dev libwebkit2gtk-4.1-dev patchelf
# (详见 specs/tech_docs/linux_platform_guide.md)

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${PROJECT_DIR}/.env" ]; then
    set -a
    source "${PROJECT_DIR}/.env"
    set +a
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🤖 MyAgents Linux 构建 (AppImage + deb)${NC}            ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# 版本一致性
PKG_VERSION=$(grep '"version"' "${PROJECT_DIR}/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
CARGO_VERSION=$(grep '^version = ' "${PROJECT_DIR}/src-tauri/Cargo.toml" | head -1 | sed 's/version = "\([^"]*\)".*/\1/')
if [ "$PKG_VERSION" != "$TAURI_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
    echo -e "${YELLOW}⚠ 版本号不一致，请先运行 \`node scripts/sync-version.js\`${NC}"
    exit 1
fi
echo -e "${BLUE}[信息] 构建版本: ${PKG_VERSION}${NC}"
echo ""

# 依赖检查
echo -e "${BLUE}[1/6] 检查系统依赖...${NC}"
missing=()
for pkg in pkg-config libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev patchelf; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        missing+=("$pkg")
    fi
done
if [ ${#missing[@]} -gt 0 ]; then
    echo -e "${RED}缺少系统依赖:${NC} ${missing[*]}"
    echo -e "${YELLOW}运行: sudo apt-get install -y ${missing[*]}${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 系统依赖齐全${NC}"
echo ""

# TypeScript 检查
echo -e "${BLUE}[2/6] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! npm run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 通过${NC}"
echo ""

# Sidecar + Bridge + CLI 打包
echo -e "${BLUE}[3/6] 打包 Sidecar / Bridge / CLI ...${NC}"
mkdir -p src-tauri/resources
npx esbuild ./src/server/index.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile=./src-tauri/resources/server-dist.js --sourcemap \
  --banner:js='import { createRequire } from "module"; const require = createRequire(import.meta.url);'

npx esbuild ./src/server/plugin-bridge/index.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile=./src-tauri/resources/plugin-bridge-dist.js --sourcemap \
  --banner:js='import { createRequire } from "module"; const require = createRequire(import.meta.url);' \
  --external:openclaw

mkdir -p ./src-tauri/resources/cli
npx esbuild ./src/cli/myagents.ts \
  --bundle --platform=node --format=cjs --target=node20 \
  --outfile=./src-tauri/resources/cli/myagents.js \
  --banner:js='#!/usr/bin/env node'
cp ./src/cli/myagents.cmd ./src-tauri/resources/cli/myagents.cmd

if grep -qE 'var __dirname = "/' ./src-tauri/resources/server-dist.js; then
    echo -e "${RED}✗ 错误: server-dist.js 包含硬编码的 __dirname 路径${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 打包完成${NC}"
echo ""

# SDK 依赖目录占位（per-arch 在下方拷）
rm -rf src-tauri/resources/claude-agent-sdk
mkdir -p src-tauri/resources/claude-agent-sdk

# 前端
echo -e "${BLUE}[4/6] 构建前端...${NC}"
npm run build:web
echo ""

# Tauri 构建
echo -e "${BLUE}[5/6] 构建 Tauri (AppImage + deb)...${NC}"
HOST_ARCH=$(uname -m)
if [[ "$HOST_ARCH" == "aarch64" || "$HOST_ARCH" == "arm64" ]]; then
    DEFAULT_TARGET="aarch64-unknown-linux-gnu"
    SDK_TRIPLE="linux-arm64"
    NODE_ARCH="arm64"
else
    DEFAULT_TARGET="x86_64-unknown-linux-gnu"
    SDK_TRIPLE="linux-x64"
    NODE_ARCH="x64"
fi
TARGET="${1:-$DEFAULT_TARGET}"

echo -e "  ${CYAN}目标: ${TARGET} (SDK: ${SDK_TRIPLE})${NC}"

# 确保 Node.js 匹配目标架构
"${PROJECT_DIR}/scripts/download_nodejs.sh"

# 拷贝 SDK native binary（glibc；musl 场景用户自行替换）
CLAUDE_SRC="${PROJECT_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-${SDK_TRIPLE}/claude"
CLAUDE_DEST="${PROJECT_DIR}/src-tauri/resources/claude-agent-sdk/claude"
if [ ! -f "$CLAUDE_SRC" ]; then
    echo -e "${RED}✗ Claude native binary 不存在: $CLAUDE_SRC${NC}"
    echo -e "${YELLOW}  运行 npm install 以安装 @anthropic-ai/claude-agent-sdk-${SDK_TRIPLE}${NC}"
    exit 1
fi
cp "$CLAUDE_SRC" "$CLAUDE_DEST"
chmod +x "$CLAUDE_DEST"
echo -e "  ${GREEN}✓ Claude native binary (${SDK_TRIPLE}) 就绪${NC}"

npm run tauri:build -- --target "$TARGET" --bundles appimage deb

echo ""
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/${TARGET}/release/bundle"

echo -e "${BLUE}[6/6] 输出产物${NC}"
APPIMAGE_PATH=$(find "${BUNDLE_DIR}/appimage" -name "*.AppImage" 2>/dev/null | head -1)
DEB_PATH=$(find "${BUNDLE_DIR}/deb" -name "*.deb" 2>/dev/null | head -1)

if [ -n "$APPIMAGE_PATH" ]; then
    APPIMAGE_SIZE=$(du -h "$APPIMAGE_PATH" | cut -f1)
    echo -e "  ${CYAN}AppImage:${NC} ${APPIMAGE_PATH} (${APPIMAGE_SIZE})"
fi
if [ -n "$DEB_PATH" ]; then
    DEB_SIZE=$(du -h "$DEB_PATH" | cut -f1)
    echo -e "  ${CYAN}deb:${NC} ${DEB_PATH} (${DEB_SIZE})"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Linux 构建完成!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
