# Production Deploy Checklist (One Page)

## 1) Backend deploy first (`backend/`)

Use Render/Railway/Fly (Docker or Node runtime). Ensure LibreOffice is installed in the runtime image.

### Required env vars (copy-paste)

```env
PORT=8080
DOCX_TO_PDF_ENGINE=soffice
CORS_ORIGIN=https://YOUR-FRONTEND-DOMAIN
SERVE_STATIC_SITE=0
SHARE_PUBLIC_BASE_URL=https://YOUR-BACKEND-DOMAIN
SHARE_FILE_TTL_MS=86400000
SHARE_CLEANUP_INTERVAL_MS=60000
SHARE_DASHBOARD_TOKEN=CHANGE_ME_STRONG_TOKEN
MAX_FILE_MB=50
CONVERT_TIMEOUT_MS=240000
```

### Start command

```bash
npm ci
npm start
```

### Health checks

```bash
curl https://YOUR-BACKEND-DOMAIN/health
curl -I https://YOUR-BACKEND-DOMAIN/share/dashboard
```

Expected: `200` response and JSON health payload.

## 2) Frontend deploy (`frontend/`)

Deploy `frontend/` to Netlify/Vercel/static host.

Edit `frontend/frontend-config.js`:

```js
window.CONVERTER_API_BASE = "https://YOUR-BACKEND-DOMAIN";
```

Redeploy frontend after this change.

## 3) Production smoke test (must pass)

1. `DOCX -> PDF` page converts and downloads PDF.
2. `PDF -> Word` page converts.
3. `PDF -> PowerPoint` page converts in `server` mode.
4. `PowerPoint -> PDF` page converts and downloads PDF.
5. `PDF -> QR Code` page returns QR + link.
6. Scan QR on mobile data (not same Wi-Fi) and PDF opens.
7. `https://YOUR-BACKEND-DOMAIN/share/dashboard?token=...` opens and shows records.

## 4) Reliability guardrails

1. Keep `CORS_ORIGIN` strict (only your frontend domain).
2. Set a strong `SHARE_DASHBOARD_TOKEN`.
3. Monitor `/health` every 1-5 minutes (uptime monitor).
4. Keep `SHARE_PUBLIC_BASE_URL` on HTTPS public domain (not localhost).
5. If large files fail, increase `MAX_FILE_MB` and `CONVERT_TIMEOUT_MS` together.

## 5) Rollback plan

1. Keep previous working backend image/version tag.
2. If errors spike, rollback backend first.
3. Frontend rollback is instant by redeploying previous build.