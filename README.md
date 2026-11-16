# Vilo Template Platform

Vue 3 + Vite template management UI.

1. Set `TEMPLATE_ADMIN_API_KEY` in the backend environment to a secret of at least 32 characters.
2. Copy `.env.example` to `.env` and set `VITE_API_BASE` if the API is not `http://localhost:3000/api`.
3. Run `npm install` and `npm run dev` from this directory.
4. Enter the management key in the page footer. It is stored in browser local storage.

The top navigation separates the existing template catalog from the subject-remix workspace.

- Template CRUD uses the independent `vilo-template` service on port `3010`.
- Subject replacement uses the independent `vilo-template-remix-api` service on port `3020` and `vilo-template-remix-worker` for queued provider work.
- Production Nginx routes `/template-api` and `/remix-api` independently.

PM2 can start or restart each backend surface separately:

```bash
pm2 start ecosystem.config.js --only vilo-template --env production
pm2 start ecosystem.config.js --only vilo-template-remix-api --env production
pm2 start ecosystem.config.js --only vilo-template-remix-worker --env production
```

## Production deployment

Prerequisites: Node.js 20+, Nginx, PM2, a DNS record for `upload.viloai.fun`, and both backend services listening on `127.0.0.1:3010` and `127.0.0.1:3020`.

1. Configure the backend secret in `/etc/vilo/backend.env` (recommended) or `vilo-backend/.env`. Generate it with `openssl rand -base64 48` and set the same value as `TEMPLATE_ADMIN_API_KEY`. Do not put this secret in a `VITE_*` variable.
2. Build and start the independent backend services:

   ```bash
   cd /path/to/Vilo/vilo-backend
   ENV_FILE=/etc/vilo/backend.env npm run check:config -- --no-connect
   npm ci
   ENV_FILE=/etc/vilo/backend.env node scripts/prisma.mjs remote generate
   ENV_FILE=/etc/vilo/backend.env node scripts/migrate-all.mjs --target remote --skip-seed
   npm run build
   ENV_FILE=/etc/vilo/backend.env pm2 startOrReload ecosystem.config.js --only vilo-template,vilo-template-remix-api,vilo-template-remix-worker --env production --update-env
   pm2 save
   ```

3. Deploy the static upload console:

   ```bash
   cd /path/to/Vilo/vilo-upload
   chmod +x scripts/deploy.sh
   sudo install -d -o "$(id -un)" -g "$(id -gn)" /var/www/vilo-upload
   VITE_API_BASE=/template-api VITE_REMIX_API_BASE=/remix-api WEB_ROOT=/var/www/vilo-upload ./scripts/deploy.sh
   ```

4. Install the supplied Nginx site, obtain the TLS certificate, then validate the page and both API proxies. If an existing Let's Encrypt certificate is already present, the helper can repair and reload the complete HTTPS config:

   ```bash
   sudo cp deploy/nginx-upload.viloai.fun.conf /etc/nginx/sites-available/upload.viloai.fun.conf
   sudo ln -sfn /etc/nginx/sites-available/upload.viloai.fun.conf /etc/nginx/sites-enabled/upload.viloai.fun.conf
   sudo nginx -t && sudo systemctl reload nginx
   sudo ./scripts/check-fix-upload-nginx.sh --fix
   ```

5. Open `https://upload.viloai.fun`, enter `TEMPLATE_ADMIN_API_KEY` in the footer, and click **验证并保存**. The browser stores the verified key locally; it is never embedded in the frontend bundle.

After changing the key, restart both API services with `--update-env`; otherwise their running processes continue using the old value.

The management API is `GET/POST /api/templates` and `PATCH/DELETE /api/templates/:id`. Subject-remix candidates enter the formal template catalog through the same server-owned validation and persistence service as manual uploads.
