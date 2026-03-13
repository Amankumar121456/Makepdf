Netlify upload package

1) Upload this whole folder or the zip to Netlify.
2) For Vercel deploys, set `FRONTEND_CONVERTER_API_BASE` in env, or update `.env.production`.
3) `frontend-config.js` is generated during build from that env value.
4) Backend-required tools will not work on static hosting alone:
   - DOCX to PDF
   - PDF to Word
   - PDF to PowerPoint
   - PowerPoint to PDF
   - PDF to QR Code
5) After Netlify gives you your final site URL, open robots.txt and sitemap.xml and replace:
   https://YOUR-NETLIFY-SITE.netlify.app
   with your real site URL.
6) If you connect a custom domain, replace that URL again.

Recommended free production pairing:
- Frontend: Netlify
- Backend: Google Cloud Run
- QR share storage: Google Cloud Storage

If you use Vercel + Render instead:
- Frontend: Vercel with Root Directory = `frontend`
- Backend: Render using `render.yaml`
- See `DEPLOY-VERCEL-RENDER.md`

SEO note:
This package uses descriptive titles, meta descriptions, internal links, robots.txt, sitemap.xml, favicon, and structured data. It intentionally avoids the meta keywords tag because Google does not use that tag for ranking.

Added in this SEO version: meta keywords tag, keyword hub page, richer homepage keyword sections, extra structured data, and sitemap entry for seo-keywords.html.

Added clean SEO routes: /jpg-to-pdf, /png-to-pdf, /merge-pdf, /split-pdf, /compress-pdf, /doc-to-pdf, /pdf-to-word, /unlock-pdf, /ocr-pdf, /pdf-maker and more.
Netlify _redirects file included.
