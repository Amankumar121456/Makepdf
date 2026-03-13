# Vercel + Render Deploy Guide

Recommended setup for this repo:

1. Frontend on Vercel
2. Backend on Render
3. Optional but recommended for QR-share reliability: Google Cloud Storage

## Why this setup

- Vercel is a good fit for the static `frontend/` site.
- Render can run the LibreOffice backend using the existing Dockerfile.
- Render free web services spin down on idle and use an ephemeral filesystem, so QR-share files stored only on local disk can disappear early after restart or redeploy.

## Frontend on Vercel

1. Push the repo to GitHub.
2. In Vercel, create a new project from the repo.
3. Set the project Root Directory to `frontend`.
4. This repo now generates `frontend-config.js` from env during the Vercel build.
5. In Vercel Project Settings, add:

```text
FRONTEND_CONVERTER_API_BASE=https://YOUR-RENDER-SERVICE.onrender.com
```

6. Redeploy Vercel.

`frontend/vercel.json` already includes the security headers and redirect rules needed for Vercel.

## Backend on Render

1. In Render, create a new Blueprint from this repo, or create a Web Service manually.
2. If you use Blueprint, [render.yaml](c:\Users\amank\Desktop\netlify-best-seo-package%20(1)\render.yaml) is ready.
3. If you create manually:
   - Runtime: Docker
   - Root Directory: `backend`
   - Dockerfile Path: `./Dockerfile`
   - Health Check Path: `/health`

Set these environment variables:

```text
PORT=8080
MAX_FILE_MB=50
CONVERT_TIMEOUT_MS=120000
SHARE_FILE_TTL_MS=86400000
SHARE_CLEANUP_INTERVAL_MS=60000
SERVE_STATIC_SITE=0
CORS_ORIGIN=https://YOUR-VERCEL-DOMAIN
SHARE_PUBLIC_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

## QR-share reliability

Default Render free behavior:

- service spins down on idle
- filesystem is ephemeral

That means DOCX/PDF conversion still works, but 24-hour PDF-to-QR links stored only on local disk are not fully reliable across restart/redeploy.

If you want QR links to stay reliable for the full 24 hours, also set:

```text
SHARE_STORAGE_BACKEND=gcs
SHARE_GCS_BUCKET=YOUR_BUCKET_NAME
SHARE_GCS_PREFIX=share
```

and give the Render service credentials/permission to access that bucket.

## Final production checklist

1. Deploy backend first.
2. Put the Render URL into `frontend/frontend-config.js`.
3. Deploy frontend on Vercel.
4. Update `sitemap.xml` and any domain-specific references to your final domain.
5. Add the site to Google Search Console and submit the sitemap.
