#!/bin/bash
#
# Ark - PM2 デプロイスクリプト
#
# 使用方法:
#   ./deploy.sh           - 更新デプロイ（git pull, install, build, pm2 restart）
#   ./deploy.sh --install - 初回セットアップ（git pull, install, build, pm2 start）
#
# 前提条件:
#   - pnpm がインストールされていること
#   - pm2 がグローバルにインストールされていること
#   - ecosystem.config.cjs が packages/server/ に存在すること
#

set -euo pipefail

# スクリプトのディレクトリを取得
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ecosystem.config.cjs のパス（monorepo 化により packages/server/ 配下）
ECOSYSTEM_FILE="${PROJECT_DIR}/packages/server/ecosystem.config.cjs"

# 色付き出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ログ関数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
    exit 1
}

# 使用方法を表示
usage() {
    cat <<EOF
使用方法: $(basename "$0") [オプション]

オプション:
    --install   初回セットアップ（pm2 start）
    -h, --help  このヘルプを表示

例:
    $(basename "$0")           # 更新デプロイ
    $(basename "$0") --install # 初回セットアップ
EOF
    exit 0
}

# 前提条件をチェック
check_prerequisites() {
    log_info "前提条件をチェックしています..."

    # pnpm が利用可能かチェック
    if ! command -v pnpm &> /dev/null; then
        log_error "pnpm が見つかりません。インストールしてください。"
    fi

    # pm2 が利用可能かチェック
    if ! command -v pm2 &> /dev/null; then
        log_error "pm2 が見つかりません。'npm install -g pm2' でインストールしてください。"
    fi

    # ecosystem.config.cjs が存在するかチェック
    if [[ ! -f "${ECOSYSTEM_FILE}" ]]; then
        log_error "ecosystem.config.cjs が見つかりません: ${ECOSYSTEM_FILE}"
    fi

    log_success "前提条件のチェック完了"
}

# Node の絶対パスを解決して PM2_INTERPRETER を export する。
#
# pm2 の interpreter:"node" は spawn 時の PATH に依存する。
# 過去 /usr/bin/node v18.19.1 が PATH 先頭に来て --env-file=.env.production を
# 受け付けず、本番がクラッシュループに陥った（2026-05-13）。
# `mise which node` で mise が解決する絶対パスを取得し、ecosystem.config.cjs に
# 環境変数経由で渡す。mise 非利用環境では `command -v node` にフォールバック。
resolve_node_interpreter() {
    log_info "node の絶対パスを解決しています..."

    local node_path=""

    if command -v mise &> /dev/null; then
        node_path="$(mise which node 2>/dev/null || true)"
    fi

    if [[ -z "${node_path}" ]]; then
        node_path="$(command -v node || true)"
    fi

    if [[ -z "${node_path}" || ! -x "${node_path}" ]]; then
        log_error "node の絶対パスを解決できませんでした (mise which / command -v 双方失敗)"
    fi

    # 解決した node が 20.6+ であることを確認（--env-file 必須要件）。
    local node_version
    node_version="$("${node_path}" --version)"
    local major
    major="$(echo "${node_version}" | sed -E 's/^v([0-9]+)\..*/\1/')"
    local minor
    minor="$(echo "${node_version}" | sed -E 's/^v[0-9]+\.([0-9]+)\..*/\1/')"

    if [[ "${major}" -lt 20 ]] || { [[ "${major}" -eq 20 ]] && [[ "${minor}" -lt 6 ]]; }; then
        log_error "node ${node_version} は要件 (>=20.6) を満たしません: ${node_path}"
    fi

    export PM2_INTERPRETER="${node_path}"
    log_success "PM2_INTERPRETER=${PM2_INTERPRETER} (${node_version})"
}

# Git pull
git_pull() {
    log_info "最新のコードを取得しています..."

    cd "${PROJECT_DIR}"

    # 未コミットの変更があるか確認
    if ! git diff --quiet; then
        log_warn "未コミットの変更があります"
    fi

    git pull origin main

    log_success "コードの取得完了"
}

# 依存関係のインストール
install_dependencies() {
    log_info "依存関係をインストールしています..."

    cd "${PROJECT_DIR}"
    pnpm install --frozen-lockfile

    log_success "依存関係のインストール完了"
}

# ビルド
build() {
    log_info "アプリケーションをビルドしています..."

    cd "${PROJECT_DIR}"
    pnpm build

    log_success "ビルド完了"
}

# PM2 起動（初回）
pm2_start() {
    log_info "PM2でアプリケーションを起動しています..."

    cd "${PROJECT_DIR}"

    # 既に起動している場合は警告
    if pm2 describe claude-code-ark &> /dev/null; then
        log_warn "アプリケーションは既に起動しています。restart を実行します。"
        pm2 restart "${ECOSYSTEM_FILE}"
    else
        pm2 start "${ECOSYSTEM_FILE}"
    fi

    # PM2の保存（再起動時に自動復旧）
    pm2 save

    log_success "PM2起動完了"
}

# PM2 再起動
pm2_restart() {
    log_info "PM2でアプリケーションを再起動しています..."

    cd "${PROJECT_DIR}"

    # プロセスが存在するか確認
    if pm2 describe claude-code-ark &> /dev/null; then
        pm2 restart "${ECOSYSTEM_FILE}"
    else
        log_warn "プロセスが存在しません。新規起動します。"
        pm2 start "${ECOSYSTEM_FILE}"
    fi

    # PM2の保存
    pm2 save

    log_success "PM2再起動完了"
}

# PM2 ステータス表示
pm2_status() {
    log_info "PM2ステータス:"
    echo ""
    pm2 status
    echo ""
}

# メイン処理
main() {
    local install_mode=false

    # 引数解析
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --install)
                install_mode=true
                shift
                ;;
            -h|--help)
                usage
                ;;
            *)
                log_error "不明なオプション: $1"
                ;;
        esac
    done

    echo ""
    echo "========================================"
    echo "  Ark - Deploy Script"
    echo "========================================"
    echo ""

    # 前提条件チェック
    check_prerequisites

    # node 絶対パスを解決し PM2_INTERPRETER として export
    resolve_node_interpreter

    # デプロイ処理
    git_pull
    install_dependencies
    build

    # PM2 操作
    if [[ "$install_mode" == true ]]; then
        pm2_start
    else
        pm2_restart
    fi

    # 完了
    pm2_status

    echo ""
    log_success "デプロイが完了しました!"
    echo ""
    echo "アクセス URL: http://localhost:4001"
    echo ""
    echo "便利なコマンド:"
    echo "  pm2 logs claude-code-ark  # ログを表示"
    echo "  pm2 monit                     # モニタリング"
    echo "  pm2 stop claude-code-ark  # 停止"
    echo ""
}

main "$@"
