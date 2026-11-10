#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-upload.viloai.fun}"
WEB_ROOT="${WEB_ROOT:-/var/www/vilo-upload}"
UPSTREAM="${UPSTREAM:-http://127.0.0.1:3010}"
SITE_AVAILABLE="${SITE_AVAILABLE:-/etc/nginx/sites-available/${DOMAIN}.conf}"
SITE_ENABLED="${SITE_ENABLED:-/etc/nginx/sites-enabled/${DOMAIN}.conf}"
CERT_DIR="${CERT_DIR:-/etc/letsencrypt/live/${DOMAIN}}"
MODE="check"

case "${1:-}" in
  "") ;;
  --fix) MODE="fix" ;;
  -h|--help)
    echo "用法：sudo $0 [--fix]"
    echo "默认只检查；--fix 会备份并重写 ${DOMAIN} 的 Nginx 站点配置。"
    exit 0
    ;;
  *) echo "未知参数：$1" >&2; exit 2 ;;
esac

ok() { printf '✓ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
fail() { printf '✗ %s\n' "$*" >&2; }
section() { printf '\n== %s ==\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { fail "缺少命令：$1"; exit 1; }; }

need nginx
need curl
need openssl

section "基础检查"
if [[ -f "${WEB_ROOT}/index.html" ]]; then ok "静态页面存在：${WEB_ROOT}/index.html"; else fail "缺少静态页面：${WEB_ROOT}/index.html"; fi
if curl -fsS --max-time 5 "${UPSTREAM}/health" >/tmp/vilo-template-health.$$ 2>/dev/null; then
  ok "模板服务正常：$(cat /tmp/vilo-template-health.$$)"
else
  warn "模板服务不可访问：${UPSTREAM}/health（不阻止修复 Nginx）"
fi
rm -f /tmp/vilo-template-health.$$

if getent ahostsv4 "${DOMAIN}" >/dev/null 2>&1; then
  ok "DNS 已解析：$(getent ahostsv4 "${DOMAIN}" | awk 'NR==1 {print $1}')"
else
  warn "DNS 尚未解析：${DOMAIN}"
fi

if [[ -r "${CERT_DIR}/fullchain.pem" && -r "${CERT_DIR}/privkey.pem" ]]; then
  ok "证书文件存在：${CERT_DIR}"
  openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName
  if openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -checkend 604800 >/dev/null; then
    ok "证书至少七天内有效"
  else
    warn "证书将在七天内到期或已经失效"
  fi
else
  fail "未找到证书：${CERT_DIR}/fullchain.pem 和 privkey.pem"
  [[ "${MODE}" == "fix" ]] && exit 1
fi

section "Nginx 当前状态"
nginx -t
if systemctl is-active --quiet nginx; then ok "Nginx 正在运行"; else warn "Nginx 未运行"; fi
ss -ltnp 2>/dev/null | grep -E ':(80|443)\b' || warn "未发现 80/443 监听"
nginx -T 2>/dev/null | grep -n -A8 -B3 "server_name ${DOMAIN}" || warn "Nginx 当前未加载 ${DOMAIN}"

if [[ "${MODE}" == "fix" ]]; then
  [[ "${EUID}" -eq 0 ]] || { fail "--fix 必须使用 sudo/root 执行"; exit 1; }
  section "修复 ${DOMAIN} 配置"
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup="${SITE_AVAILABLE}.backup-${timestamp}"
  [[ -e "${SITE_AVAILABLE}" ]] && cp -a "${SITE_AVAILABLE}" "${backup}"

  tmp="$(mktemp /tmp/vilo-upload-nginx.XXXXXX)"
  trap 'rm -f "${tmp:-}"' EXIT
  cat >"${tmp}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${DOMAIN};

    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root ${WEB_ROOT};
    index index.html;
    client_max_body_size 500M;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /template-api/ {
        proxy_pass ${UPSTREAM}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location = /template-health {
        proxy_pass ${UPSTREAM}/health;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  install -m 0644 "${tmp}" "${SITE_AVAILABLE}"
  ln -sfn "${SITE_AVAILABLE}" "${SITE_ENABLED}"

  if nginx -t; then
    systemctl reload nginx
    ok "配置已修复并重新加载"
    [[ -e "${backup}" ]] && ok "原配置备份：${backup}"
  else
    fail "新配置校验失败，正在回滚"
    if [[ -e "${backup}" ]]; then cp -a "${backup}" "${SITE_AVAILABLE}"; else rm -f "${SITE_AVAILABLE}" "${SITE_ENABLED}"; fi
    nginx -t || true
    exit 1
  fi
fi

section "SNI 与接口验证"
if echo | openssl s_client -connect 127.0.0.1:443 -servername "${DOMAIN}" 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName; then
  ok "本机 SNI 已返回证书"
else
  warn "无法从本机 443 获取 ${DOMAIN} 证书"
fi

curl -kfsSI --max-time 10 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/" | sed -n '1,8p' \
  || warn "本机 HTTPS 页面验证失败"
curl -kfsS --max-time 10 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/template-health" \
  || warn "本机模板健康检查失败"
printf '\n'

echo "检查完成。只检查：sudo $0；自动修复：sudo $0 --fix"
