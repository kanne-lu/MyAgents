#!/bin/bash
# MyAgents 开发启动脚本
# 一键启动前端和后端进行开发测试

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_AGENT_DIR="${PROJECT_DIR}"
PORT=3000

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🤖 MyAgents 开发模式${NC}"
echo ""

# 解析参数
AGENT_DIR="${1:-$DEFAULT_AGENT_DIR}"
echo -e "Agent 目录: ${GREEN}${AGENT_DIR}${NC}"
echo -e "后端端口: ${GREEN}${PORT}${NC}"
echo ""

# 检查 bun 是否安装
if ! command -v bun &> /dev/null; then
    echo -e "${RED}错误: bun 未安装${NC}"
    echo "请先安装 bun: https://bun.sh"
    exit 1
fi

# 检查 npm 是否安装
if ! command -v npm &> /dev/null; then
    echo -e "${RED}错误: npm 未安装${NC}"
    exit 1
fi

# 清理函数
cleanup() {
    echo ""
    echo -e "${YELLOW}正在停止服务...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    echo -e "${GREEN}已停止${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 停止之前的开发服务
kill_existing() {
    echo -e "${YELLOW}检查并停止之前的开发服务...${NC}"
    
    # 停止占用端口 3000 的进程 (后端)
    local pid_3000=$(lsof -ti:3000 2>/dev/null)
    if [ -n "$pid_3000" ]; then
        echo -e "  停止端口 3000 上的进程: ${pid_3000}"
        kill -9 $pid_3000 2>/dev/null || true
    fi
    
    # 停止占用端口 5173 的进程 (Vite 前端)
    local pid_5173=$(lsof -ti:5173 2>/dev/null)
    if [ -n "$pid_5173" ]; then
        echo -e "  停止端口 5173 上的进程: ${pid_5173}"
        kill -9 $pid_5173 2>/dev/null || true
    fi
    
    # 停止运行中的 MyAgents 桌面版（避免端口冲突）
    local LOCK_FILE="$HOME/.myagents/app.lock"
    if [ -f "$LOCK_FILE" ]; then
        local OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
        # Validate PID is a positive integer before using it with kill
        if [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo -e "  停止 MyAgents 桌面版 (PID $OLD_PID)..."
            kill -9 "$OLD_PID" 2>/dev/null || true
        fi
        rm -f "$LOCK_FILE"
    fi
    pkill -9 -f "MyAgents.app" 2>/dev/null || true

    # 停止所有 bun run index.ts 进程 (MyAgents 后端)
    pkill -f "bun run index.ts" 2>/dev/null || true

    # 停止所有 vite 开发服务器
    pkill -f "vite" 2>/dev/null || true
    
    sleep 1
    echo -e "${GREEN}已清理之前的服务${NC}"
    echo ""
}

# 启动前先停止之前的服务
kill_existing

# 启动后端服务器
echo -e "${BLUE}启动后端服务器...${NC}"
cd "${PROJECT_DIR}/src/server"
bun run index.ts --agent-dir "${AGENT_DIR}" --port ${PORT} &
BACKEND_PID=$!
echo -e "后端 PID: ${BACKEND_PID}"

# 等待后端启动
sleep 2

# 检查后端是否成功启动
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo -e "${RED}后端启动失败${NC}"
    exit 1
fi

echo -e "${GREEN}后端已启动: http://localhost:${PORT}${NC}"
echo ""

# 启动前端开发服务器
echo -e "${BLUE}启动前端开发服务器...${NC}"
cd "${PROJECT_DIR}"
bun run dev:web &
FRONTEND_PID=$!
echo -e "前端 PID: ${FRONTEND_PID}"

# 等待前端启动
sleep 3

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}🎉 开发环境已就绪!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "前端: ${BLUE}http://localhost:5173${NC}"
echo -e "后端: ${BLUE}http://localhost:${PORT}${NC}"
echo ""
echo -e "按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
echo ""

# 等待进程
wait
