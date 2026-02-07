#!/bin/bash
# Moltbot Docker 관리 스크립트

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

usage() {
    echo "Usage: $0 {start|stop|restart|logs|status|build} [service]"
    echo ""
    echo "Services: main, toeic, dev (or all)"
    echo ""
    echo "Examples:"
    echo "  $0 start          # Start all services"
    echo "  $0 start main     # Start only main service"
    echo "  $0 logs toeic     # View TOEIC service logs"
    echo "  $0 status         # Check status of all services"
}

case "$1" in
    start)
        echo "🚀 Starting Moltbot containers..."
        if [ -n "$2" ]; then
            docker compose up -d "moltbot-$2"
        else
            docker compose up -d
        fi
        echo "✅ Started successfully!"
        ;;
    stop)
        echo "🛑 Stopping Moltbot containers..."
        if [ -n "$2" ]; then
            docker compose stop "moltbot-$2"
        else
            docker compose stop
        fi
        echo "✅ Stopped successfully!"
        ;;
    restart)
        echo "🔄 Restarting Moltbot containers..."
        if [ -n "$2" ]; then
            docker compose restart "moltbot-$2"
        else
            docker compose restart
        fi
        echo "✅ Restarted successfully!"
        ;;
    logs)
        if [ -n "$2" ]; then
            docker compose logs -f "moltbot-$2"
        else
            docker compose logs -f
        fi
        ;;
    status)
        echo "📊 Moltbot Container Status:"
        docker compose ps
        echo ""
        echo "📈 Resource Usage:"
        docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
            moltbot-main moltbot-toeic moltbot-dev 2>/dev/null || echo "(No running containers)"
        ;;
    build)
        echo "🔨 Building Moltbot Docker image..."
        docker compose build --no-cache
        echo "✅ Build completed!"
        ;;
    *)
        usage
        exit 1
        ;;
esac
