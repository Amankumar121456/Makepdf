# Windows + MS Word Deployment (Exact DOCX Fidelity)

This setup uses Microsoft Word for DOCX -> PDF conversion to get the closest
possible match to the original DOCX layout (shapes, image crops, fonts, etc).

## Why this is needed
LibreOffice on Linux does not guarantee 1:1 layout for complex DOCX files.
Microsoft Word is the native renderer, so it produces the most faithful output.

## Prerequisites
- Windows Server or Windows 10/11
- Microsoft Word (licensed)
- Node.js LTS
- Git (or download ZIP)

## Step-by-step
1. Install Microsoft Word and open it once to complete first-run prompts.
2. Install Node.js LTS.
3. Clone the repo:
   ```powershell
   git clone https://github.com/Amankumar121456/Makepdf.git
   cd Makepdf\backend
   ```
4. Install dependencies:
   ```powershell
   npm install
   ```
5. Set environment variables (PowerShell example):
   ```powershell
   $env:PORT="8080"
   $env:DOCX_TO_PDF_ENGINE="word-only"
   $env:CORS_ORIGIN="https://makepdf.in"
   $env:SHARE_PUBLIC_BASE_URL="https://YOUR-WINDOWS-BACKEND-DOMAIN"
   $env:SERVE_STATIC_SITE="0"
   $env:MAX_FILE_MB="50"
   ```
6. Start the backend:
   ```powershell
   npm start
   ```
7. Expose the backend over HTTPS (recommended):
   - Use IIS + ARR reverse proxy, or
   - Use Caddy/Nginx for Windows.
8. Update Vercel env:
   - `FRONTEND_CONVERTER_API_BASE=https://YOUR-WINDOWS-BACKEND-DOMAIN`
   - Redeploy Vercel.

## Notes
- Word automation works best when the process runs under a logged-in user
  session. If you run it as a service, ensure it can access the desktop.
- Keep Word updated for better compatibility.
- This backend is Windows-only when using `DOCX_TO_PDF_ENGINE=word-only`.
