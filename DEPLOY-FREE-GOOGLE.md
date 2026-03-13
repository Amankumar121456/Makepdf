# Free Deploy Guide

Recommended production setup for this project:

1. Frontend on Netlify
2. Backend on Google Cloud Run
3. QR share storage on Google Cloud Storage

This keeps static pages cheap/free, supports Google indexing, and avoids QR links breaking early on stateless backend instances.

## Why this setup

- Netlify serves the `frontend/` folder well and supports `_redirects`.
- Cloud Run runs the conversion API and scales down when idle.
- Cloud Storage keeps 24-hour QR share files alive even if Cloud Run instances restart.

## Frontend deploy

1. Push this repo to GitHub.
2. Create a new Netlify site from the repo.
3. Use:
   - Base directory: empty
   - Publish directory: `frontend`
4. After backend deploy, edit `frontend/frontend-config.js` and set:

```js
window.CONVERTER_API_BASE = "https://YOUR-CLOUD-RUN-URL";
```

5. Redeploy Netlify.

## Backend deploy

1. Create a Google Cloud project.
2. Create a Cloud Storage bucket for QR-share PDFs.
3. Deploy `backend/` to Cloud Run using the included Dockerfile.
4. Set these environment variables:

```text
PORT=8080
MAX_FILE_MB=50
CONVERT_TIMEOUT_MS=120000
SHARE_FILE_TTL_MS=86400000
SHARE_CLEANUP_INTERVAL_MS=60000
SHARE_STORAGE_BACKEND=gcs
SHARE_GCS_BUCKET=YOUR_BUCKET_NAME
SHARE_GCS_PREFIX=share
SHARE_PUBLIC_BASE_URL=https://YOUR-CLOUD-RUN-URL
CORS_ORIGIN=https://YOUR-NETLIFY-DOMAIN
SERVE_STATIC_SITE=0
```

5. Give the Cloud Run service account permission to read/write objects in that bucket.

## SEO / Google indexing

After frontend is live on the final domain:

1. Make sure `frontend/sitemap.xml` uses your real domain.
2. Make sure `frontend/robots.txt` is live.
3. If you use a custom domain, prefer that domain in sitemap and canonicals.
4. Add the site to Google Search Console.
5. Submit the sitemap URL.

## Important notes

- The QR link intentionally expires after 24 hours.
- Backend-only tools need a working backend URL; static deploy alone is not enough.
- Cloud Run is stateless, so local-disk QR shares are not reliable there. That is why this repo now supports GCS-backed share storage.
