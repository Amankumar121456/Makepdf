# Separate Frontend + Backend Deploy (Free)

## 1) Deploy backend (`backend`)

Use Render (free) with Docker:

- Root directory: `backend`
- Dockerfile: `backend/Dockerfile`
- Env:
  - `DOCX_TO_PDF_ENGINE=soffice` (cloud Linux)
  - `CORS_ORIGIN=https://YOUR-FRONTEND-DOMAIN`
  - `SERVE_STATIC_SITE=0`
  - `SHARE_PUBLIC_BASE_URL=https://YOUR-BACKEND-DOMAIN` (important for phone-scannable QR links)
  - `SHARE_FILE_TTL_MS=86400000` (optional, 24h)
  - `SHARE_CLEANUP_INTERVAL_MS=60000` (optional)
  - `SHARE_DASHBOARD_TOKEN=YOUR_SECRET` (optional, protect dashboard)

Test:

```bash
curl https://YOUR-BACKEND/health
```

## 2) Deploy frontend (Netlify free)

- Publish root: `frontend`
- Make sure `frontend/frontend-config.js` exists

Edit `frontend/frontend-config.js`:

```js
window.CONVERTER_API_BASE = "https://YOUR-BACKEND-DOMAIN";
```

## 3) Verify in browser

- Open frontend `doc-to-pdf` page
- Upload DOCX and convert
- If backend is connected correctly, exact server mode is used
- Open `pdf-to-qrcode` page and verify:
  - custom short URL works (`/s/abc123`)
  - scanned QR opens PDF on mobile network
  - dashboard works: `https://YOUR-BACKEND/share/dashboard?token=YOUR_SECRET`
- Open `powerpoint-to-pdf` page and verify PPT/PPTX to PDF conversion.
