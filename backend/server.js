"use strict";

require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const fssync = require("fs");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { Storage } = require("@google-cloud/storage");

function readPositiveNumber(name, fallback, min = 1) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

const PORT = readPositiveNumber("PORT", 8080);
const MAX_FILE_MB = readPositiveNumber("MAX_FILE_MB", 50);
const MAX_FILE_BYTES = Math.floor(MAX_FILE_MB * 1024 * 1024);
const CONVERT_TIMEOUT_MS = readPositiveNumber("CONVERT_TIMEOUT_MS", 120000, 1000);
const SHARE_FILE_TTL_MS = readPositiveNumber("SHARE_FILE_TTL_MS", 24 * 60 * 60 * 1000, 60000);
const SHARE_CLEANUP_INTERVAL_MS = readPositiveNumber("SHARE_CLEANUP_INTERVAL_MS", 60 * 1000, 10000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const SHARE_PUBLIC_BASE_URL = String(process.env.SHARE_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const SHARE_DASHBOARD_TOKEN = String(process.env.SHARE_DASHBOARD_TOKEN || "").trim();
const SHARE_STORAGE_BACKEND = String(process.env.SHARE_STORAGE_BACKEND || "").trim().toLowerCase();
const SHARE_GCS_BUCKET = String(process.env.SHARE_GCS_BUCKET || process.env.GCS_SHARE_BUCKET || "").trim();
const SHARE_GCS_PREFIX = String(process.env.SHARE_GCS_PREFIX || "share").trim().replace(/^\/+|\/+$/g, "") || "share";
const TMP_ROOT = process.env.TMP_ROOT || path.join(os.tmpdir(), "docx-pdf-service");
const DEFAULT_SITE_ROOT = path.resolve(__dirname, "..", "frontend");
const SITE_ROOT = fssync.existsSync(DEFAULT_SITE_ROOT)
  ? DEFAULT_SITE_ROOT
  : path.resolve(__dirname, "..");
const SERVE_STATIC_SITE = String(process.env.SERVE_STATIC_SITE || "0") === "1";
const DOCX_TO_PDF_ENGINE = String(
  process.env.DOCX_TO_PDF_ENGINE || (process.platform === "win32" ? "word-first" : "soffice")
).trim().toLowerCase();
const EFFECTIVE_SHARE_STORAGE_BACKEND = SHARE_STORAGE_BACKEND || (SHARE_GCS_BUCKET ? "gcs" : "local");

function resolveFirstLanIPv4() {
  const interfaces = os.networkInterfaces ? os.networkInterfaces() : {};
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface || []) {
      if (!addr || addr.internal) continue;
      if (addr.family === "IPv4") return addr.address;
    }
  }
  return "";
}

const LOCAL_LAN_IPV4 = resolveFirstLanIPv4();

function resolveSofficeBinary() {
  if (process.env.SOFFICE_BIN) return process.env.SOFFICE_BIN;
  if (process.platform !== "win32") return "soffice";

  const windowsCandidates = [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"
  ];
  for (const candidate of windowsCandidates) {
    if (fssync.existsSync(candidate)) return candidate;
  }
  return "soffice";
}

const SOFFICE_BIN = resolveSofficeBinary();
const SHARE_STORAGE_IS_GCS = EFFECTIVE_SHARE_STORAGE_BACKEND === "gcs";
const gcsStorage = SHARE_STORAGE_IS_GCS ? new Storage() : null;
const gcsShareBucket = SHARE_STORAGE_IS_GCS ? gcsStorage.bucket(SHARE_GCS_BUCKET) : null;

if (!["local", "gcs"].includes(EFFECTIVE_SHARE_STORAGE_BACKEND)) {
  throw new Error(`Unsupported SHARE_STORAGE_BACKEND: ${EFFECTIVE_SHARE_STORAGE_BACKEND}`);
}
if (SHARE_STORAGE_IS_GCS && !SHARE_GCS_BUCKET) {
  throw new Error("SHARE_GCS_BUCKET is required when SHARE_STORAGE_BACKEND=gcs.");
}

const app = express();
app.disable("x-powered-by");

function normalizeOrigin(input) {
  const raw = String(input || "").trim();
  if (!raw || raw === "*") return "";
  try {
    return new URL(raw).origin;
  } catch (_) {
    return "";
  }
}

function parseCorsOrigins(input) {
  const raw = String(input || "*").trim();
  if (!raw || raw === "*") return null;
  const origins = raw
    .split(",")
    .map((x) => normalizeOrigin(x))
    .filter(Boolean);
  return origins.length ? origins : null;
}

const ALLOWED_CORS_ORIGINS = parseCorsOrigins(CORS_ORIGIN);
const ALLOWED_CORS_SET = ALLOWED_CORS_ORIGINS ? new Set(ALLOWED_CORS_ORIGINS) : null;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const normalizedOrigin = normalizeOrigin(origin);
  if (!ALLOWED_CORS_ORIGINS) {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (!origin) {
    // Non-browser client (curl/server-to-server) without Origin header.
  } else if (normalizedOrigin && ALLOWED_CORS_SET.has(normalizedOrigin)) {
    res.header("Access-Control-Allow-Origin", normalizedOrigin);
    res.header("Vary", "Origin");
  } else {
    if (req.method === "OPTIONS") {
      res.sendStatus(403);
      return;
    }
    res.status(403).json({ error: `Origin not allowed by CORS: ${origin}` });
    return;
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

if (!fssync.existsSync(TMP_ROOT)) {
  fssync.mkdirSync(TMP_ROOT, { recursive: true });
}
const UPLOADS_DIR = path.join(TMP_ROOT, "uploads");
if (!fssync.existsSync(UPLOADS_DIR)) {
  fssync.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const SHARE_DIR = path.join(TMP_ROOT, "share");
if (!fssync.existsSync(SHARE_DIR)) {
  fssync.mkdirSync(SHARE_DIR, { recursive: true });
}
const SHARE_INDEX_FILE = path.join(SHARE_DIR, "index.json");
const MAX_CLEANUP_HISTORY = 300;

function getShareMetaObjectPath(id) {
  return `${SHARE_GCS_PREFIX}/meta/${id}.json`;
}

function getSharePdfObjectPath(id) {
  return `${SHARE_GCS_PREFIX}/files/${id}.pdf`;
}

function getShareShortCodeObjectPath(shortCode) {
  return `${SHARE_GCS_PREFIX}/short/${shortCode}.txt`;
}

function normalizeShareEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const shortCode = normalizeShortCode(raw.shortCode || "");
  const filePath = String(raw.path || "").trim();
  const filename = String(raw.filename || "").trim() || "document.pdf";
  const expiresAt = Number(raw.expiresAt || 0);
  const createdAt = raw.createdAt ? String(raw.createdAt) : nowIso();
  const sizeBytes = Number(raw.sizeBytes || 0);
  const storageBackend = String(raw.storageBackend || "local").trim().toLowerCase() || "local";

  if (!id || !shortCode || !filePath || !Number.isFinite(expiresAt)) return null;
  if (!isValidShortCode(shortCode)) return null;
  if (!["local", "gcs"].includes(storageBackend)) return null;

  return {
    id,
    shortCode,
    path: filePath,
    filename,
    expiresAt,
    createdAt,
    sizeBytes,
    storageBackend
  };
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: MAX_FILE_BYTES }
});
const sharedFiles = new Map();
const shortCodeToId = new Map();
const cleanupHistory = [];
let shareIndexWriteChain = Promise.resolve();

function sanitizeBaseName(filename) {
  const base = path.parse(filename || "document").name || "document";
  return base.replace(/[^\w.-]+/g, "_").slice(0, 120) || "document";
}

function isAllowedDocx(file) {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  if (ext !== ".docx") return false;
  if (!file?.mimetype) return true;
  const allowed = new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream"
  ]);
  return allowed.has(file.mimetype);
}

function isAllowedPdf(file) {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  if (ext !== ".pdf") return false;
  if (!file?.mimetype) return true;
  const allowed = new Set([
    "application/pdf",
    "application/x-pdf",
    "application/acrobat",
    "applications/vnd.pdf",
    "text/pdf",
    "text/x-pdf",
    "application/octet-stream"
  ]);
  return allowed.has(file.mimetype);
}

function isAllowedPowerPoint(file) {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  const allowedExt = new Set([".ppt", ".pptx", ".pps", ".ppsx", ".pot", ".potx"]);
  if (!allowedExt.has(ext)) return false;
  if (!file?.mimetype) return true;
  const allowed = new Set([
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    "application/octet-stream"
  ]);
  return allowed.has(String(file.mimetype || "").toLowerCase());
}

async function safeRm(target) {
  if (!target) return;
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup
  }
}

function getPublicBaseUrl(req) {
  if (SHARE_PUBLIC_BASE_URL) return SHARE_PUBLIC_BASE_URL;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = String(req.get("host") || "").trim();
  const fallback = `${protocol}://${host}`;
  if (!host) return fallback;

  try {
    const parsed = new URL(fallback);
    const hostname = String(parsed.hostname || "").toLowerCase();
    if ((hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") && LOCAL_LAN_IPV4) {
      const port = parsed.port || String(PORT);
      return `${protocol}://${LOCAL_LAN_IPV4}:${port}`;
    }
  } catch (_) {
    // keep fallback
  }

  return fallback;
}

function isLoopbackLikeBaseUrl(input) {
  try {
    const u = new URL(String(input || "").trim());
    const host = String(u.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch (_) {
    return false;
  }
}

async function pruneExpiredSharedFiles() {
  const now = Date.now();
  const expired = [];
  const entries = SHARE_STORAGE_IS_GCS
    ? await listRemoteShareEntries()
    : Array.from(sharedFiles.entries()).map(([, meta]) => meta);
  for (const meta of entries) {
    const id = meta?.id;
    if (!meta || Number(meta.expiresAt || 0) <= now) {
      expired.push(id);
    }
  }
  for (const id of expired) {
    await removeShareEntry(id, { reason: "expired" });
  }
  if (expired.length) {
    await persistShareIndexSafe("prune_expired");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function addCleanupHistory(entry, reason) {
  cleanupHistory.unshift({
    id: entry?.id || null,
    shortCode: entry?.shortCode || null,
    filename: entry?.filename || null,
    reason: String(reason || "removed"),
    at: nowIso()
  });
  if (cleanupHistory.length > MAX_CLEANUP_HISTORY) {
    cleanupHistory.length = MAX_CLEANUP_HISTORY;
  }
}

function normalizeShortCode(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function isValidShortCode(code) {
  return /^[a-z0-9-]{3,32}$/.test(code);
}

function generateShortCode() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let code = "";
    for (let i = 0; i < 8; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!shortCodeToId.has(code)) return code;
  }
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function serializeShareEntry(entry) {
  return {
    id: entry.id,
    shortCode: entry.shortCode,
    filename: entry.filename,
    path: entry.path,
    storageBackend: entry.storageBackend || "local",
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    sizeBytes: entry.sizeBytes
  };
}

async function persistShareIndex() {
  const payload = {
    generatedAt: nowIso(),
    cleanupHistory,
    items: Array.from(sharedFiles.values()).map(serializeShareEntry)
  };
  const tempFile = `${SHARE_INDEX_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempFile, SHARE_INDEX_FILE);
}

function queuePersistShareIndex(context, strictMode) {
  const writeTask = shareIndexWriteChain.then(async () => {
    await persistShareIndex();
    return true;
  });
  shareIndexWriteChain = writeTask.catch(() => undefined);
  if (strictMode) return writeTask;
  return writeTask.catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[share-index] persist failed (${context || "unknown"}): ${error?.message || error}`);
    return false;
  });
}

async function persistShareIndexSafe(context) {
  return queuePersistShareIndex(context, false);
}

async function persistShareIndexStrict(context) {
  return queuePersistShareIndex(context, true);
}

async function readGcsFileText(objectPath) {
  const file = gcsShareBucket.file(objectPath);
  const [exists] = await file.exists();
  if (!exists) return "";
  const [buffer] = await file.download();
  return buffer.toString("utf8");
}

async function writeGcsFileText(objectPath, value, contentType) {
  const file = gcsShareBucket.file(objectPath);
  await file.save(String(value || ""), {
    resumable: false,
    contentType: contentType || "text/plain; charset=utf-8",
    metadata: {
      cacheControl: "private, max-age=0, no-store"
    }
  });
}

async function deleteGcsObject(objectPath) {
  if (!objectPath) return;
  try {
    await gcsShareBucket.file(objectPath).delete({ ignoreNotFound: true });
  } catch (_) {
    // best-effort cleanup
  }
}

async function fetchRemoteShareEntryById(id) {
  if (!SHARE_STORAGE_IS_GCS) return null;
  const raw = await readGcsFileText(getShareMetaObjectPath(id));
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = null;
  }
  const entry = normalizeShareEntry(parsed);
  if (!entry) return null;
  sharedFiles.set(entry.id, entry);
  shortCodeToId.set(entry.shortCode, entry.id);
  return entry;
}

async function resolveShareEntryByShortCode(shortCode) {
  const existingId = shortCodeToId.get(shortCode);
  if (existingId) return existingId;
  if (!SHARE_STORAGE_IS_GCS) return "";
  const id = String(await readGcsFileText(getShareShortCodeObjectPath(shortCode))).trim();
  if (!id) return "";
  shortCodeToId.set(shortCode, id);
  return id;
}

async function writeRemoteShareEntry(entry) {
  if (!SHARE_STORAGE_IS_GCS) return;
  await writeGcsFileText(
    getShareMetaObjectPath(entry.id),
    JSON.stringify(serializeShareEntry(entry), null, 2),
    "application/json; charset=utf-8"
  );
  await writeGcsFileText(getShareShortCodeObjectPath(entry.shortCode), entry.id, "text/plain; charset=utf-8");
}

async function uploadSharePdfToRemoteStorage(localPath, entry) {
  if (!SHARE_STORAGE_IS_GCS) return;
  await gcsShareBucket.upload(localPath, {
    destination: entry.path,
    resumable: false,
    metadata: {
      contentType: "application/pdf",
      cacheControl: "private, max-age=86400"
    }
  });
}

async function listRemoteShareEntries() {
  if (!SHARE_STORAGE_IS_GCS) {
    return Array.from(sharedFiles.values());
  }
  const [files] = await gcsShareBucket.getFiles({ prefix: `${SHARE_GCS_PREFIX}/meta/` });
  const entries = [];
  for (const file of files) {
    try {
      const [buffer] = await file.download();
      const entry = normalizeShareEntry(JSON.parse(buffer.toString("utf8")));
      if (entry) entries.push(entry);
    } catch (_) {
      // ignore broken metadata objects
    }
  }
  return entries;
}

async function removeShareEntry(id, options = {}) {
  const { removeFile = true, reason = "removed" } = options;
  let entry = sharedFiles.get(id);
  if (!entry && SHARE_STORAGE_IS_GCS) {
    entry = await fetchRemoteShareEntryById(id);
  }
  if (!entry) return;

  sharedFiles.delete(id);
  if (entry.shortCode) shortCodeToId.delete(entry.shortCode);
  addCleanupHistory(entry, reason);
  if (removeFile) {
    if (entry.storageBackend === "gcs") {
      await deleteGcsObject(entry.path);
    } else {
      await safeRm(entry.path);
    }
  }
  if (entry.storageBackend === "gcs") {
    await deleteGcsObject(getShareMetaObjectPath(entry.id));
    await deleteGcsObject(getShareShortCodeObjectPath(entry.shortCode));
  }
}

async function hydrateShareIndex() {
  if (SHARE_STORAGE_IS_GCS) {
    sharedFiles.clear();
    shortCodeToId.clear();
    cleanupHistory.length = 0;
    return;
  }
  if (!fssync.existsSync(SHARE_INDEX_FILE)) return;
  let parsed = null;
  try {
    const raw = await fs.readFile(SHARE_INDEX_FILE, "utf8");
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return;

  sharedFiles.clear();
  shortCodeToId.clear();
  cleanupHistory.length = 0;

  if (Array.isArray(parsed.cleanupHistory)) {
    for (const item of parsed.cleanupHistory) {
      const at = String(item?.at || "").trim();
      const reason = String(item?.reason || "removed").trim() || "removed";
      cleanupHistory.push({
        id: item?.id ? String(item.id) : null,
        shortCode: item?.shortCode ? String(item.shortCode) : null,
        filename: item?.filename ? String(item.filename) : null,
        reason,
        at: at || nowIso()
      });
      if (cleanupHistory.length >= MAX_CLEANUP_HISTORY) break;
    }
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];

  const now = Date.now();
  let changed = !Array.isArray(parsed.items);
  for (const item of items) {
    const entry = normalizeShareEntry({ ...item, storageBackend: item?.storageBackend || "local" });
    if (!entry) {
      changed = true;
      continue;
    }
    const { id, shortCode, path: filePath, filename, expiresAt, createdAt, sizeBytes } = entry;
    if (!fssync.existsSync(filePath)) {
      changed = true;
      continue;
    }
    if (expiresAt <= now) {
      await safeRm(filePath);
      addCleanupHistory({ id, shortCode, filename }, "expired_on_boot");
      changed = true;
      continue;
    }
    if (shortCodeToId.has(shortCode) || sharedFiles.has(id)) {
      changed = true;
      continue;
    }
    sharedFiles.set(id, entry);
    shortCodeToId.set(shortCode, id);
  }

  if (changed) {
    await persistShareIndexSafe("hydrate");
  }
}

function runSoffice(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`LibreOffice timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`LibreOffice failed (code ${code}). ${stderr || stdout}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runWordDocxToPdf(inputPath, outputPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("MS Word engine is only available on Windows."));
      return;
    }

    const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const script = `
$ErrorActionPreference = 'Stop'
$inPath = ${psLiteral(inputPath)}
$outPath = ${psLiteral(outputPath)}
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($inPath, $false, $true)
  $doc.ExportAsFixedFormat($outPath, 17)
}
finally {
  if ($doc -ne $null) {
    $doc.Close($false) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
  }
  if ($word -ne $null) {
    $word.Quit() | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded
    ];
    const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`MS Word conversion timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`MS Word conversion failed (code ${code}). ${stderr || stdout}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getSofficeBaseArgs(profileDir) {
  const args = [
    "--headless",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--nolockcheck",
    "--norestore"
  ];

  // Windows builds can fail with code 1 when UserInstallation points to temp profiles.
  // Use isolated profile on non-Windows for safety, and default profile on Windows for reliability.
  if (process.platform !== "win32" && profileDir) {
    const profileUri = pathToFileURL(profileDir).href;
    // LibreOffice expects single-dash -env:UserInstallation (double-dash breaks on some builds).
    args.push(`-env:UserInstallation=${profileUri}`);
  }

  return args;
}

function getDashboardTokenFromReq(req) {
  return String(req.query.token || req.headers["x-dashboard-token"] || "").trim();
}

function ensureDashboardAccess(req, res) {
  if (!SHARE_DASHBOARD_TOKEN) return true;
  const provided = getDashboardTokenFromReq(req);
  if (provided && provided === SHARE_DASHBOARD_TOKEN) return true;
  if (req.accepts("html")) {
    res.status(401).type("text/plain").send("Dashboard access denied.");
  } else {
    res.status(401).json({ error: "Dashboard access denied." });
  }
  return false;
}

async function getShareSnapshot(req) {
  const baseUrl = getPublicBaseUrl(req);
  const sourceEntries = SHARE_STORAGE_IS_GCS
    ? await listRemoteShareEntries()
    : Array.from(sharedFiles.values());
  const active = sourceEntries
    .sort((a, b) => Number(a.expiresAt || 0) - Number(b.expiresAt || 0))
    .map((entry) => ({
      id: entry.id,
      shortCode: entry.shortCode,
      filename: entry.filename,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      sizeBytes: entry.sizeBytes || null,
      shortUrl: `${baseUrl}/s/${entry.shortCode}`,
      directUrl: `${baseUrl}/share/files/${entry.id}`
    }));

  return {
    generatedAt: nowIso(),
    activeCount: active.length,
    expiredRecentCount: cleanupHistory.length,
    active,
    expiredRecent: cleanupHistory
  };
}

async function getActiveShareEntry(id, expireReason) {
  let entry = sharedFiles.get(id);
  if (!entry && SHARE_STORAGE_IS_GCS) {
    entry = await fetchRemoteShareEntryById(id);
  }
  if (!entry) {
    return { notFound: true };
  }
  if (Date.now() > Number(entry.expiresAt || 0)) {
    await removeShareEntry(id, { reason: expireReason || "expired_on_access" });
    await persistShareIndexSafe("expired_access");
    return { expired: true };
  }
  if (entry.storageBackend === "gcs") {
    const [exists] = await gcsShareBucket.file(entry.path).exists();
    if (!exists) {
      await removeShareEntry(id, { reason: "missing_file", removeFile: false });
      await persistShareIndexSafe("missing_file");
      return { notFound: true };
    }
  } else if (!fssync.existsSync(entry.path)) {
    await removeShareEntry(id, { reason: "missing_file", removeFile: false });
    await persistShareIndexSafe("missing_file");
    return { notFound: true };
  }
  return { entry };
}

async function sendSharedPdf(res, entry) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${entry.filename}"`);
  if (entry.storageBackend === "gcs") {
    await new Promise((resolve, reject) => {
      const stream = gcsShareBucket.file(entry.path).createReadStream();
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
    return;
  }
  await new Promise((resolve, reject) => {
    res.sendFile(entry.path, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "libreoffice-converter",
    docxToPdfEngine: DOCX_TO_PDF_ENGINE,
    serveStaticSite: SERVE_STATIC_SITE,
    allowedCorsOrigins: ALLOWED_CORS_ORIGINS || ["*"],
    soffice: SOFFICE_BIN,
    maxFileMb: MAX_FILE_MB,
    siteRoot: SITE_ROOT,
    shareFileTtlMs: SHARE_FILE_TTL_MS,
    shareCleanupIntervalMs: SHARE_CLEANUP_INTERVAL_MS,
    sharePublicBaseUrl: SHARE_PUBLIC_BASE_URL || null,
    shareDashboardProtected: Boolean(SHARE_DASHBOARD_TOKEN),
    shareStorageBackend: EFFECTIVE_SHARE_STORAGE_BACKEND,
    shareGcsBucket: SHARE_GCS_BUCKET || null,
    localLanIpv4: LOCAL_LAN_IPV4 || null,
    activeSharedFiles: sharedFiles.size
  });
});

app.post("/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
  const uploadedFilePath = req.file?.path;
  let jobDir;

  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use form field: file" });
      return;
    }
    if (!isAllowedDocx(req.file)) {
      await safeRm(uploadedFilePath);
      res.status(400).json({ error: "Only .docx files are allowed." });
      return;
    }

    const jobId = randomUUID();
    jobDir = path.join(TMP_ROOT, jobId);
    const inDir = path.join(jobDir, "in");
    const outDir = path.join(jobDir, "out");
    const profileDir = path.join(jobDir, "profile");

    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });

    const baseName = sanitizeBaseName(req.file.originalname);
    const inputPath = path.join(inDir, `${baseName}.docx`);
    const outputPath = path.join(outDir, `${baseName}.pdf`);

    await fs.rename(req.file.path, inputPath);

    const sofficeArgs = [
      ...getSofficeBaseArgs(profileDir),
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      outDir,
      inputPath
    ];
    const attemptErrors = [];
    let converted = false;

    const tryWord = DOCX_TO_PDF_ENGINE !== "soffice" && process.platform === "win32";
    const allowSofficeFallback = DOCX_TO_PDF_ENGINE !== "word-only";

    if (tryWord) {
      try {
        await runWordDocxToPdf(inputPath, outputPath, CONVERT_TIMEOUT_MS);
        converted = fssync.existsSync(outputPath);
      } catch (error) {
        attemptErrors.push(`word: ${error.message || String(error)}`);
      }
    }

    if (!converted && allowSofficeFallback) {
      try {
        await runSoffice(sofficeArgs, CONVERT_TIMEOUT_MS);
      } catch (error) {
        attemptErrors.push(`soffice: ${error.message || String(error)}`);
      }
      converted = fssync.existsSync(outputPath);
    }

    if (!converted) {
      const reason = attemptErrors.length ? ` ${attemptErrors.join(" | ")}` : "";
      throw new Error(`Converted PDF not found after conversion attempts.${reason}`.trim());
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.pdf"`);
    res.sendFile(outputPath, async (err) => {
      await safeRm(jobDir);
      if (err) {
        // response might already be partially sent
      }
    });
  } catch (error) {
    await safeRm(jobDir);
    if (uploadedFilePath) {
      await safeRm(uploadedFilePath);
    }
    res.status(500).json({ error: error.message || "DOCX to PDF conversion failed." });
  }
});

app.post("/convert/pdf-to-docx", upload.single("file"), async (req, res) => {
  const uploadedFilePath = req.file?.path;
  let jobDir;

  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use form field: file" });
      return;
    }
    if (!isAllowedPdf(req.file)) {
      await safeRm(uploadedFilePath);
      res.status(400).json({ error: "Only .pdf files are allowed." });
      return;
    }

    const jobId = randomUUID();
    jobDir = path.join(TMP_ROOT, jobId);
    const inDir = path.join(jobDir, "in");
    const outDir = path.join(jobDir, "out");
    const profileDir = path.join(jobDir, "profile");

    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });

    const baseName = sanitizeBaseName(req.file.originalname);
    const inputPath = path.join(inDir, `${baseName}.pdf`);
    const outputPath = path.join(outDir, `${baseName}.docx`);

    await fs.rename(req.file.path, inputPath);

    const baseArgs = getSofficeBaseArgs(profileDir);
    const attempts = [
      [...baseArgs, "--infilter=writer_pdf_import", "--convert-to", "docx:\"Office Open XML Text\"", "--outdir", outDir, inputPath],
      [...baseArgs, "--convert-to", "docx:\"Office Open XML Text\"", "--outdir", outDir, inputPath],
      [...baseArgs, "--convert-to", "docx", "--outdir", outDir, inputPath]
    ];

    let lastError = null;
    for (const args of attempts) {
      try {
        await runSoffice(args, CONVERT_TIMEOUT_MS);
      } catch (error) {
        lastError = error;
      }
      if (fssync.existsSync(outputPath)) break;
    }

    if (!fssync.existsSync(outputPath)) {
      throw new Error(`Converted DOCX not found after LibreOffice run. ${lastError?.message || ""}`.trim());
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.docx"`);
    res.sendFile(outputPath, async (err) => {
      await safeRm(jobDir);
      if (err) {
        // response might already be partially sent
      }
    });
  } catch (error) {
    await safeRm(jobDir);
    if (uploadedFilePath) {
      await safeRm(uploadedFilePath);
    }
    res.status(500).json({ error: error.message || "PDF to DOCX conversion failed." });
  }
});

app.post("/convert/pdf-to-pptx", upload.single("file"), async (req, res) => {
  const uploadedFilePath = req.file?.path;
  let jobDir;

  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use form field: file" });
      return;
    }
    if (!isAllowedPdf(req.file)) {
      await safeRm(uploadedFilePath);
      res.status(400).json({ error: "Only .pdf files are allowed." });
      return;
    }

    const jobId = randomUUID();
    jobDir = path.join(TMP_ROOT, jobId);
    const inDir = path.join(jobDir, "in");
    const outDir = path.join(jobDir, "out");
    const profileDir = path.join(jobDir, "profile");

    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });

    const baseName = sanitizeBaseName(req.file.originalname);
    const inputPath = path.join(inDir, `${baseName}.pdf`);
    const outputPath = path.join(outDir, `${baseName}.pptx`);

    await fs.rename(req.file.path, inputPath);

    const baseArgs = getSofficeBaseArgs(profileDir);
    const attempts = [
      [...baseArgs, "--infilter=impress_pdf_import", "--convert-to", "pptx:Impress MS PowerPoint 2007 XML", "--outdir", outDir, inputPath],
      [...baseArgs, "--convert-to", "pptx:Impress MS PowerPoint 2007 XML", "--outdir", outDir, inputPath],
      [...baseArgs, "--convert-to", "pptx", "--outdir", outDir, inputPath]
    ];

    let lastError = null;
    for (const args of attempts) {
      try {
        await runSoffice(args, CONVERT_TIMEOUT_MS);
      } catch (error) {
        lastError = error;
      }
      if (fssync.existsSync(outputPath)) break;
    }

    if (!fssync.existsSync(outputPath)) {
      throw new Error(`Converted PPTX not found after LibreOffice run. ${lastError?.message || ""}`.trim());
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.pptx"`);
    res.sendFile(outputPath, async (err) => {
      await safeRm(jobDir);
      if (err) {
        // response might already be partially sent
      }
    });
  } catch (error) {
    await safeRm(jobDir);
    if (uploadedFilePath) {
      await safeRm(uploadedFilePath);
    }
    res.status(500).json({ error: error.message || "PDF to PPTX conversion failed." });
  }
});

app.post("/convert/ppt-to-pdf", upload.single("file"), async (req, res) => {
  const uploadedFilePath = req.file?.path;
  let jobDir;

  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use form field: file" });
      return;
    }
    if (!isAllowedPowerPoint(req.file)) {
      await safeRm(uploadedFilePath);
      res.status(400).json({ error: "Only .ppt/.pptx/.pps/.ppsx/.pot/.potx files are allowed." });
      return;
    }

    const jobId = randomUUID();
    jobDir = path.join(TMP_ROOT, jobId);
    const inDir = path.join(jobDir, "in");
    const outDir = path.join(jobDir, "out");
    const profileDir = path.join(jobDir, "profile");

    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });

    const baseName = sanitizeBaseName(req.file.originalname);
    const originalExt = path.extname(req.file.originalname || "").toLowerCase();
    const safeExt = [".ppt", ".pptx", ".pps", ".ppsx", ".pot", ".potx"].includes(originalExt)
      ? originalExt
      : ".pptx";
    const inputPath = path.join(inDir, `${baseName}${safeExt}`);
    const outputPath = path.join(outDir, `${baseName}.pdf`);

    await fs.rename(req.file.path, inputPath);

    const baseArgs = getSofficeBaseArgs(profileDir);
    const attempts = [
      [...baseArgs, "--convert-to", "pdf:impress_pdf_Export", "--outdir", outDir, inputPath],
      [...baseArgs, "--convert-to", "pdf", "--outdir", outDir, inputPath]
    ];

    let lastError = null;
    for (const args of attempts) {
      try {
        await runSoffice(args, CONVERT_TIMEOUT_MS);
      } catch (error) {
        lastError = error;
      }
      if (fssync.existsSync(outputPath)) break;
    }

    if (!fssync.existsSync(outputPath)) {
      throw new Error(`Converted PDF not found after LibreOffice run. ${lastError?.message || ""}`.trim());
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.pdf"`);
    res.sendFile(outputPath, async (err) => {
      await safeRm(jobDir);
      if (err) {
        // response might already be partially sent
      }
    });
  } catch (error) {
    await safeRm(jobDir);
    if (uploadedFilePath) {
      await safeRm(uploadedFilePath);
    }
    res.status(500).json({ error: error.message || "PPT to PDF conversion failed." });
  }
});

app.post("/share/pdf-to-url", upload.single("file"), async (req, res) => {
  const uploadedFilePath = req.file?.path;
  let finalPath = null;
  let idForRollback = "";

  try {
    await pruneExpiredSharedFiles();

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use form field: file" });
      return;
    }
    if (!isAllowedPdf(req.file)) {
      await safeRm(uploadedFilePath);
      res.status(400).json({ error: "Only .pdf files are allowed." });
      return;
    }

    const requestedShortCode = normalizeShortCode(req.body?.shortCode || "");
    if (requestedShortCode && !isValidShortCode(requestedShortCode)) {
      await safeRm(uploadedFilePath);
      res.status(400).json({ error: "Invalid shortCode. Use 3-32 chars: a-z, 0-9, hyphen." });
      return;
    }

    const shortCode = requestedShortCode || generateShortCode();
    const existingId = shortCodeToId.get(shortCode);
    if (existingId && sharedFiles.has(existingId)) {
      await safeRm(uploadedFilePath);
      res.status(409).json({ error: "Requested shortCode is already in use." });
      return;
    }

    const id = randomUUID().replace(/-/g, "");
    idForRollback = id;
    const originalBase = sanitizeBaseName(req.file.originalname);
    const expiresAt = Date.now() + SHARE_FILE_TTL_MS;
    const entry = {
      id,
      shortCode,
      path: SHARE_STORAGE_IS_GCS ? getSharePdfObjectPath(id) : path.join(SHARE_DIR, `${id}.pdf`),
      filename: `${originalBase}.pdf`,
      expiresAt,
      createdAt: nowIso(),
      sizeBytes: Number(req.file.size || 0),
      storageBackend: SHARE_STORAGE_IS_GCS ? "gcs" : "local"
    };

    finalPath = entry.path;
    if (SHARE_STORAGE_IS_GCS) {
      await uploadSharePdfToRemoteStorage(req.file.path, entry);
      await safeRm(req.file.path);
      await writeRemoteShareEntry(entry);
    } else {
      await fs.rename(req.file.path, finalPath);
    }
    sharedFiles.set(id, entry);
    shortCodeToId.set(shortCode, id);

    const baseUrl = getPublicBaseUrl(req);
    if (isLoopbackLikeBaseUrl(baseUrl)) {
      await removeShareEntry(id, { reason: "loopback_rejected" });
      res.status(400).json({
        error: "Share public URL is localhost/loopback. Set SHARE_PUBLIC_BASE_URL to a phone-accessible domain or LAN IP."
      });
      return;
    }

    const shortUrl = `${baseUrl}/s/${shortCode}`;
    const directUrl = `${baseUrl}/share/files/${id}`;
    await persistShareIndexStrict("create_share");
    res.json({
      ok: true,
      url: shortUrl,
      shortUrl,
      directUrl,
      shortCode,
      expiresAt,
      createdAt: entry.createdAt
    });
  } catch (error) {
    if (idForRollback) {
      await removeShareEntry(idForRollback, { reason: "create_failed" });
    } else {
      await safeRm(finalPath);
    }
    if (uploadedFilePath) {
      await safeRm(uploadedFilePath);
    }
    res.status(500).json({ error: error.message || "Failed to create shareable PDF URL." });
  }
});

app.get("/share/files/:id", async (req, res) => {
  try {
    await pruneExpiredSharedFiles();

    const id = String(req.params.id || "").trim();
    if (!/^[a-f0-9]{20,64}$/i.test(id)) {
      res.status(400).json({ error: "Invalid file id." });
      return;
    }

    const resolved = await getActiveShareEntry(id, "expired_on_access");
    if (resolved.notFound) {
      res.status(404).json({ error: "File not found or expired." });
      return;
    }
    if (resolved.expired) {
      res.status(410).json({ error: "File link expired." });
      return;
    }

    await sendSharedPdf(res, resolved.entry);
  } catch (error) {
    res.status(500).json({ error: error.message || "Unexpected share file error." });
  }
});

app.get("/s/:shortCode", async (req, res) => {
  try {
    await pruneExpiredSharedFiles();
    const shortCode = normalizeShortCode(req.params.shortCode || "");
    if (!isValidShortCode(shortCode)) {
      res.status(400).json({ error: "Invalid short code." });
      return;
    }

    const id = await resolveShareEntryByShortCode(shortCode);
    if (!id) {
      res.status(404).json({ error: "Short URL not found or expired." });
      return;
    }

    const resolved = await getActiveShareEntry(id, "expired_short_access");
    if (resolved.notFound) {
      shortCodeToId.delete(shortCode);
      await persistShareIndexSafe("short_not_found");
      res.status(404).json({ error: "Short URL not found or expired." });
      return;
    }
    if (resolved.expired) {
      res.status(410).json({ error: "Short URL expired." });
      return;
    }
    await sendSharedPdf(res, resolved.entry);
  } catch (error) {
    res.status(500).json({ error: error.message || "Unexpected short URL error." });
  }
});

app.get("/share/dashboard.json", async (req, res) => {
  try {
    if (!ensureDashboardAccess(req, res)) return;
    await pruneExpiredSharedFiles();
    res.json(await getShareSnapshot(req));
  } catch (error) {
    res.status(500).json({ error: error.message || "Dashboard JSON failed." });
  }
});

app.get("/share/dashboard", async (req, res) => {
  try {
    if (!ensureDashboardAccess(req, res)) return;
    await pruneExpiredSharedFiles();

    const token = SHARE_DASHBOARD_TOKEN ? encodeURIComponent(getDashboardTokenFromReq(req)) : "";
    const tokenQuery = token ? `?token=${token}` : "";
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Share Dashboard</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:20px;background:#f7f9fc;color:#0f172a}
    .card{background:#fff;border:1px solid #dfe7f3;border-radius:12px;padding:14px;margin-bottom:14px}
    .muted{color:#64748b}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e8edf5;padding:8px;text-align:left;vertical-align:top}
    code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .pill{padding:4px 10px;border-radius:999px;background:#eef4ff;color:#2563eb;font-weight:700}
  </style>
</head>
<body>
  <div class="card">
    <div class="row">
      <div class="pill">Share Dashboard</div>
      <div class="muted">Auto refresh: 20s</div>
    </div>
    <div id="summary" class="muted" style="margin-top:8px">Loading...</div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px">Active Shared PDFs</h3>
    <div style="overflow:auto">
      <table id="activeTable">
        <thead><tr><th>Short</th><th>File</th><th>Created</th><th>Expires</th><th>Size</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px">Recent Cleanup</h3>
    <div style="overflow:auto">
      <table id="cleanupTable">
        <thead><tr><th>Time</th><th>Reason</th><th>Short</th><th>File</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script>
    function appendCell(tr, value) {
      const td = document.createElement('td');
      td.textContent = value == null ? '' : String(value);
      tr.appendChild(td);
      return td;
    }

    async function loadDashboard() {
      const res = await fetch('/share/dashboard.json${tokenQuery}', { cache: 'no-store' });
      if (!res.ok) throw new Error('Dashboard fetch failed: ' + res.status);
      const data = await res.json();
      document.getElementById('summary').textContent =
        'Active: ' + data.activeCount + ' | Recent expired/cleaned: ' + data.expiredRecentCount + ' | Updated: ' + data.generatedAt;

      const activeBody = document.querySelector('#activeTable tbody');
      activeBody.innerHTML = '';
      (data.active || []).forEach((x) => {
        const tr = document.createElement('tr');
        const shortTd = document.createElement('td');
        const a = document.createElement('a');
        a.href = String(x.shortUrl || '#');
        a.target = '_blank';
        a.rel = 'noopener';
        const code = document.createElement('code');
        code.textContent = '/' + String(x.shortCode || '-');
        a.appendChild(code);
        shortTd.appendChild(a);
        tr.appendChild(shortTd);

        appendCell(tr, x.filename || '');
        appendCell(tr, x.createdAt || '');
        appendCell(tr, new Date(Number(x.expiresAt || 0)).toLocaleString());
        appendCell(tr, x.sizeBytes ? (Math.round(Number(x.sizeBytes) / 1024) + ' KB') : '-');
        activeBody.appendChild(tr);
      });

      const cleanupBody = document.querySelector('#cleanupTable tbody');
      cleanupBody.innerHTML = '';
      (data.expiredRecent || []).forEach((x) => {
        const tr = document.createElement('tr');
        appendCell(tr, x.at || '');
        appendCell(tr, x.reason || '');
        const shortTd = document.createElement('td');
        const code = document.createElement('code');
        code.textContent = String(x.shortCode || '-');
        shortTd.appendChild(code);
        tr.appendChild(shortTd);
        appendCell(tr, x.filename || '-');
        cleanupBody.appendChild(tr);
      });
    }

    async function tick() {
      try { await loadDashboard(); } catch (e) { console.error(e); }
    }
    tick();
    setInterval(tick, 20000);
  </script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: error.message || "Dashboard page failed." });
  }
});

if (SERVE_STATIC_SITE) {
  // Optional: enable only for local all-in-one mode.
  app.use(express.static(SITE_ROOT, { extensions: ["html"] }));
}

app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB} MB.` });
    return;
  }
  res.status(500).json({ error: "Unexpected server error." });
});

async function startServer() {
  try {
    await hydrateShareIndex();
    await pruneExpiredSharedFiles();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Startup preload failed: ${error?.message || error}`);
    process.exit(1);
    return;
  }

  const cleanupTimer = setInterval(() => {
    pruneExpiredSharedFiles().catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`Periodic cleanup failed: ${error?.message || error}`);
    });
  }, SHARE_CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`LibreOffice conversion service running on :${PORT}`);
  });

  server.on("error", (error) => {
    const reason = error?.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Set a different PORT environment variable.`
      : error?.message || String(error);
    // eslint-disable-next-line no-console
    console.error(`Server failed to start: ${reason}`);
    process.exit(1);
  });

  const gracefulShutdown = (signal) => {
    clearInterval(cleanupTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref?.();
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
  };
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

startServer();
