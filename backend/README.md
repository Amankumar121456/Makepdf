# LibreOffice Conversion Service

This service converts:
- `.docx` to `.pdf`
- `.pdf` to `.docx`
- `.pdf` to `.pptx`
- `.ppt/.pptx` to `.pdf`
- `.pdf` to shareable URL/short URL (`/s/{code}`)

It uses LibreOffice headless for high layout fidelity.
On Windows, DOCX to PDF uses **MS Word automation first** (if available) for best layout match, then falls back to LibreOffice.

## Architecture (frontend/backend split)

- Frontend: static site (Netlify/Vercel/GitHub Pages)
- Backend: this conversion API service (recommended: Google Cloud Run or Render)
- Frontend calls backend using `window.CONVERTER_API_BASE`

For QR share links on stateless platforms such as Cloud Run, use Google Cloud Storage for share files so the 24h QR links survive instance restarts.

## Run with Docker

```bash
docker build -t docx-pdf-service .
docker run --rm -p 8080:8080 docx-pdf-service
```

Health check:

```bash
curl http://localhost:8080/health
```

Convert DOCX to PDF:

```bash
curl -X POST http://localhost:8080/convert/docx-to-pdf \
  -F "file=@/path/to/file.docx" \
  -o output.pdf
```

Convert PDF to DOCX:

```bash
curl -X POST http://localhost:8080/convert/pdf-to-docx \
  -F "file=@/path/to/file.pdf" \
  -o output.docx
```

Convert PDF to PPTX:

```bash
curl -X POST http://localhost:8080/convert/pdf-to-pptx \
  -F "file=@/path/to/file.pdf" \
  -o output.pptx
```

Convert PPTX to PDF:

```bash
curl -X POST http://localhost:8080/convert/ppt-to-pdf \
  -F "file=@/path/to/file.pptx" \
  -o output.pdf
```

Create shareable PDF URL (for QR):

```bash
curl -X POST http://localhost:8080/share/pdf-to-url \
  -F "file=@/path/to/file.pdf" \
  -F "shortCode=invoice-2026"
```

## Environment variables

- `PORT` (default `8080`)
- `MAX_FILE_MB` (default `50`)
- `CONVERT_TIMEOUT_MS` (default `120000`)
- `SOFFICE_BIN` (default auto-detect; on Windows it tries `C:\Program Files\LibreOffice\program\soffice.exe`)
- `TMP_ROOT` (default OS temp folder)
- `CORS_ORIGIN` (default `*`, supports comma-separated list for split deployments)
- `SHARE_PUBLIC_BASE_URL` (recommended in production; e.g. `https://api.example.com`)
- `SHARE_FILE_TTL_MS` (default `86400000`, 24h)
- `SHARE_CLEANUP_INTERVAL_MS` (default `60000`)
- `SHARE_DASHBOARD_TOKEN` (optional; protect `/share/dashboard` and `/share/dashboard.json`)
- `SHARE_STORAGE_BACKEND`:
  - `local` (default)
  - `gcs` (recommended for Cloud Run / stateless deploys)
- `SHARE_GCS_BUCKET`:
  - required when `SHARE_STORAGE_BACKEND=gcs`
- `SHARE_GCS_PREFIX`:
  - optional path prefix inside bucket
  - default `share`
- `DOCX_TO_PDF_ENGINE`:
  - `word-first` (default on Windows)
  - `word-only` (Windows only, no fallback)
  - `soffice` (force LibreOffice only)
- `SERVE_STATIC_SITE`:
  - `0` (default, backend API only)
  - `1` (optional all-in-one mode: serves static website too)

## Local (without deploy)

1. Install LibreOffice on your machine.
2. Create a local env file:

```bash
cp .env.example .env
```

3. Update `.env` values as needed.
4. Start backend service:

```bash
cd backend
npm install
npm start
```

5. Open health:
   - `http://127.0.0.1:8080/health`
6. Serve frontend separately (for example with Live Server on `:5500`).

## `.env` support

The backend now loads environment variables from a local `.env` file using `dotenv`.

- Example file: [backend/.env.example](c:\Users\amank\Desktop\netlify-best-seo-package%20(1)\backend\.env.example)
- On Render, set the same values in the Render dashboard env section.

## Connect frontend to backend

Preferred (single setting for all tools):

```js
localStorage.setItem("converter_api_base", "https://YOUR-BACKEND-DOMAIN");
location.reload();
```

Or set in `frontend-config.js`:

```html
<script>window.CONVERTER_API_BASE = "https://YOUR-BACKEND-DOMAIN";</script>
```

Optional per-tool override:

```js
localStorage.setItem("docx_to_pdf_endpoint", "https://YOUR-BACKEND-DOMAIN/convert/docx-to-pdf");
localStorage.setItem("pdf_to_docx_endpoint", "https://YOUR-BACKEND-DOMAIN/convert/pdf-to-docx");
location.reload();
```

When API base is set, pages use exact server conversion mode.

## Share endpoints

- `POST /share/pdf-to-url`: upload PDF and get short URL + direct URL.
- `GET /s/:shortCode`: opens PDF directly.
- `GET /share/files/:id`: direct file URL.
- `GET /share/dashboard`: active shares + cleanup list.
- `GET /share/dashboard.json`: dashboard API.

## Cloud Run note

If you deploy the backend on Google Cloud Run, prefer:

- `SHARE_STORAGE_BACKEND=gcs`
- `SHARE_GCS_BUCKET=your-bucket-name`
- `SHARE_PUBLIC_BASE_URL=https://YOUR-CLOUD-RUN-URL`
- `CORS_ORIGIN=https://YOUR-FRONTEND-DOMAIN`

Without object storage, QR share files live only on the container filesystem and can disappear on instance replacement/restart.
