#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${ROOT_DIR}"
WEB_ROOT="${WEB_ROOT:-/var/www/vilo-upload}"
VITE_API_BASE="${VITE_API_BASE:-/template-api}"
RELEASE_DIR="${WEB_ROOT}.release.$$"
BACKUP_DIR="${WEB_ROOT}.previous"

die() { echo "错误：$*" >&2; exit 1; }
cleanup() { rm -rf -- "${RELEASE_DIR}"; }
trap cleanup EXIT

[[ -d "${APP_DIR}" ]] || die "上传平台目录不存在：${APP_DIR}"
[[ -f "${APP_DIR}/package-lock.json" ]] || die "缺少 package-lock.json，无法执行可重复构建"
[[ "${WEB_ROOT}" == /* ]] || die "WEB_ROOT 必须是绝对路径"
[[ "${WEB_ROOT}" != "/" ]] || die "WEB_ROOT 不允许为根目录"
[[ "${VITE_API_BASE}" == /* || "${VITE_API_BASE}" =~ ^https?:// ]] \
  || die "VITE_API_BASE 必须是 / 开头的同源路径或 http(s) 地址"

command -v node >/dev/null 2>&1 || die "未安装 Node.js（需要 >= 20）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge 20 ]] || die "Node.js 版本过低：$(node -v)，需要 >= 20"
command -v npm >/dev/null 2>&1 || die "未安装 npm"

echo "构建 vilo-upload（API: ${VITE_API_BASE}）"
cd "${APP_DIR}"
npm ci --no-audit --no-fund
VITE_API_BASE="${VITE_API_BASE}" npm run build

echo "发布静态文件到 ${WEB_ROOT}"
install -d -m 0755 "$(dirname "${WEB_ROOT}")"
install -d -m 0755 "${RELEASE_DIR}"
cp -a dist/. "${RELEASE_DIR}/"
find "${RELEASE_DIR}" -type d -exec chmod 0755 {} +
find "${RELEASE_DIR}" -type f -exec chmod 0644 {} +
[[ -f "${RELEASE_DIR}/index.html" ]] || die "构建产物缺少 index.html"

rm -rf -- "${BACKUP_DIR}"
if [[ -e "${WEB_ROOT}" ]]; then
  mv -- "${WEB_ROOT}" "${BACKUP_DIR}"
fi

if ! mv -- "${RELEASE_DIR}" "${WEB_ROOT}"; then
  [[ ! -e "${WEB_ROOT}" && -e "${BACKUP_DIR}" ]] && mv -- "${BACKUP_DIR}" "${WEB_ROOT}"
  die "发布失败，已尝试恢复上一版本"
fi

echo "vilo-upload 发布完成"
echo "上一版本备份：${BACKUP_DIR}"
