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

The management API is `GET/POST /api/templates` and `PATCH/DELETE /api/templates/:id`. Subject-remix candidates enter the formal template catalog through the same server-owned validation and persistence service as manual uploads.
