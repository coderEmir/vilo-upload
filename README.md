# Vilo Template Platform

Vue 3 + Vite template management UI.

1. Set `TEMPLATE_ADMIN_API_KEY` in the backend environment to a secret of at least 32 characters.
2. Copy `.env.example` to `.env` and set `VITE_API_BASE` if the API is not `http://localhost:3000/api`.
3. Run `npm install` and `npm run dev` from this directory.
4. Enter the management key in the page footer. It is stored in browser local storage.

The management API is `GET/POST /api/templates` and `PATCH/DELETE /api/templates/:id`. Episode list changes are synchronized in one database transaction while preserving IDs for retained episodes.
