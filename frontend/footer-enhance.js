(() => {
  const safeStorageGet = (key) => {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch (_) {
      return null;
    }
  };
  const allowedThemes = ["light", "dark", "ocean", "purple"];
  const storedTheme = safeStorageGet("theme");
  if (allowedThemes.includes(storedTheme)) {
    document.documentElement.setAttribute("data-theme", storedTheme);
  }

  const detectFrontendBasePrefix = () => {
    const pathname = String(window.location.pathname || "/");
    if (pathname === "/frontend" || pathname.startsWith("/frontend/")) {
      return "/frontend";
    }
    return "";
  };

  const FRONTEND_BASE_PREFIX = detectFrontendBasePrefix();
  const socialIconMap = {
    instagram: "instagram.svg",
    github: "github.svg",
    linkedin: "linkedin.svg",
    email: "email.svg",
  };
  const socialLinkMap = {
    instagram: "https://www.instagram.com/aman_kumar4257/?hl=en",
    github: "https://github.com/Amankumar121456",
    linkedin: "https://www.linkedin.com/in/aman-kumar-760024371",
    email: "mailto:amankumar48979@gmail.com",
  };
  const iconBasePath = `${FRONTEND_BASE_PREFIX || ""}/image/icon`;
  const getSocialIconSrc = (network) => `${iconBasePath}/${socialIconMap[network]}`;
  const getSocialIconMarkup = (network) =>
    `<img src="${getSocialIconSrc(network)}" alt="" width="32" height="32" loading="eager" decoding="async" aria-hidden="true">`;
  const normalizeSocialLabel = (label) => (label === "facebook" ? "github" : label);

  const replaceSocialIcons = (scope) => {
    scope.querySelectorAll(".socialBtn[aria-label]").forEach((anchor) => {
      const rawLabel = String(anchor.getAttribute("aria-label") || "").trim().toLowerCase();
      const label = normalizeSocialLabel(rawLabel);
      if (!socialIconMap[label]) return;
      if (label !== rawLabel) {
        anchor.setAttribute("aria-label", label.charAt(0).toUpperCase() + label.slice(1));
        if (socialLinkMap[label]) anchor.setAttribute("href", socialLinkMap[label]);
      }
      anchor.innerHTML = getSocialIconMarkup(label);
    });
  };

  const rewriteAbsoluteFrontendLinks = () => {
    if (!FRONTEND_BASE_PREFIX) return;
    const blockedPrefixes = ["/convert/", "/share/", "/s/", "/api/", "/health"];
    document.querySelectorAll('a[href^="/"]').forEach((anchor) => {
      const href = String(anchor.getAttribute("href") || "").trim();
      if (!href) return;
      if (href.startsWith("//")) return;
      if (href === "/frontend" || href.startsWith("/frontend/")) return;
      if (blockedPrefixes.some((prefix) => href.startsWith(prefix))) return;
      anchor.setAttribute("href", `${FRONTEND_BASE_PREFIX}${href}`);
    });
  };

  const STYLE_ID = "hd-footer-enhance-style";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      footer.hdFooter{
        margin-top:18px;
        border-top:1px solid var(--border, var(--b, #e6eaf3));
        padding:22px 0 12px;
        color:var(--muted, var(--m, #64748b));
      }
      footer.hdFooter .footerGrid{
        width:min(90%, 1160px);
        margin:0 auto;
        display:grid;
        grid-template-columns:1.4fr 1fr;
        gap:18px;
        align-items:start;
      }
      footer.hdFooter .footerTitle{
        margin:0 0 10px;
        font-weight:900;
        font-size:24px;
        letter-spacing:-0.2px;
        color:var(--text, var(--t, #0f172a));
      }
      footer.hdFooter .footerText{
        margin:0;
        color:var(--muted, var(--m, #64748b));
        line-height:1.7;
        font-size:13px;
      }
      footer.hdFooter .footerLinks{
        display:grid;
        gap:8px;
      }
      footer.hdFooter .footerLinks a{
        text-decoration:none;
        color:var(--muted, var(--m, #64748b));
        font-weight:700;
        font-size:13px;
      }
      footer.hdFooter .footerLinks a:hover{
        color:var(--accent, var(--a, #2563eb));
      }
      footer.hdFooter .socialRow{
        display:flex;
        gap:10px;
        flex-wrap:wrap;
        margin-top:10px;
      }
      footer.hdFooter .socialBtn{
        position:relative;
        width:50px;
        height:50px;
        border-radius:14px;
        display:grid;
        place-items:center;
        border:1px solid color-mix(in srgb, var(--accent, var(--a, #2563eb)) 20%, var(--border, var(--b, #e6eaf3)));
        background:
          radial-gradient(70% 70% at 25% 20%, color-mix(in srgb, var(--accent, var(--a, #2563eb)) 14%, transparent), transparent 70%),
          linear-gradient(180deg, color-mix(in srgb, var(--card, #fff) 96%, transparent), var(--card, #fff));
        box-shadow:
          0 10px 20px rgba(15,23,42,0.09),
          inset 0 1px 0 rgba(255,255,255,0.7);
        color:var(--text, var(--t, #0f172a));
        text-decoration:none;
        transition:transform .2s ease, box-shadow .2s ease, color .2s ease, border-color .2s ease;
      }
      footer.hdFooter .socialBtn:hover{
        transform:translateY(-3px) scale(1.03);
        border-color:color-mix(in srgb, var(--accent, var(--a, #2563eb)) 58%, var(--border, var(--b, #e6eaf3)));
        color:var(--accent, var(--a, #2563eb));
        box-shadow:
          0 16px 30px color-mix(in srgb, var(--accent, var(--a, #2563eb)) 30%, transparent),
          inset 0 1px 0 rgba(255,255,255,0.85);
      }
      footer.hdFooter .socialBtn svg,
      footer.hdFooter .socialBtn img{
        width:32px;
        height:32px;
        transition:transform .2s ease;
        display:block;
        object-fit:contain;
      }
      footer.hdFooter .socialBtn:hover svg,
      footer.hdFooter .socialBtn:hover img{
        transform:scale(1.1);
      }
      footer.hdFooter .copy{
        width:min(90%, 1160px);
        margin:14px auto 0;
        color:var(--muted, var(--m, #64748b));
        font-size:12px;
      }
      footer.hdFooter .footerLegacyNote{
        width:min(90%, 1160px);
        margin:12px auto 0;
        color:var(--muted, var(--m, #64748b));
        font-size:12px;
        line-height:1.6;
      }
      a.brand > span:last-child,
      .brandText{
        font-size:24px !important;
        font-weight:900;
        letter-spacing:-0.2px;
      }
      @media (max-width:900px){
        footer.hdFooter .footerGrid{
          grid-template-columns:1fr;
        }
        a.brand > span:last-child,
        .brandText{
          font-size:21px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  const footerMarkup = `
    <div class="footerGrid">
      <div>
        <p class="footerTitle">Makepdf.in</p>
        <p class="footerText">Browser-based PDF and image tools focused on fast, private workflows that run directly on your device.</p>
        <div class="socialRow" aria-label="Social links">
          <a class="socialBtn" href="${socialLinkMap.instagram}" target="_blank" rel="noopener" aria-label="Instagram">
            ${getSocialIconMarkup("instagram")}
          </a>
          <a class="socialBtn" href="${socialLinkMap.github}" target="_blank" rel="noopener" aria-label="GitHub">
            ${getSocialIconMarkup("github")}
          </a>
          <a class="socialBtn" href="${socialLinkMap.linkedin}" target="_blank" rel="noopener" aria-label="LinkedIn">
            ${getSocialIconMarkup("linkedin")}
          </a>
          <a class="socialBtn" href="${socialLinkMap.email}" aria-label="Email">
            ${getSocialIconMarkup("email")}
          </a>
        </div>
      </div>
      <div>
        <p class="footerTitle">Company</p>
        <div class="footerLinks">
          <a href="/about.html">About</a>
          <a href="/privacy.html">Privacy Policy</a>
          <a href="/terms.html">Terms</a>
          <a href="/contact.html">Contact</a>
        </div>
      </div>
    </div>
    <div class="copy">&copy; <span class="js-year"></span> Makepdf.in. All rights reserved.</div>
  `;

  let footer = document.querySelector("footer");
  if (!footer) {
    footer = document.createElement("footer");
    document.body.appendChild(footer);
  }
  footer.classList.add("hdFooter");

  const hasRichFooter = !!footer.querySelector(".footerGrid");
  if (!hasRichFooter) {
    const existingMarkup = (footer.innerHTML || "").trim();
    const existingText = (footer.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const genericText = "browser-based pdf and image tools focused on fast, private workflows that run directly on your device.";
    const keepLegacy = existingMarkup && existingText && !existingText.includes(genericText);

    footer.innerHTML = "";
    footer.insertAdjacentHTML("afterbegin", footerMarkup);
    if (keepLegacy) {
      footer.insertAdjacentHTML("beforeend", `<div class="footerLegacyNote">${existingMarkup}</div>`);
    }
  }

  if (!footer.querySelector(".copy")) {
    footer.insertAdjacentHTML("beforeend", `<div class="copy">&copy; <span class="js-year"></span> Makepdf.in. All rights reserved.</div>`);
  }

  replaceSocialIcons(footer);
  rewriteAbsoluteFrontendLinks();

  const year = String(new Date().getFullYear());
  footer.querySelectorAll(".js-year, #year").forEach((node) => {
    node.textContent = year;
  });
})();
