/*
 * Build script – creates a self-contained, per-browser extension bundle from
 * the single Firefox-oriented source tree (no second project):
 *
 *   dist/firefox/  – Firefox/AMO build (event-page background, no polyfill)
 *   dist/chrome/   – Chrome Web Store build:
 *                      * background.service_worker = background/service-worker.js
 *                      * `browser.*` polyfill (lib/browser-polyfill.min.js) is
 *                        added to every context that uses it
 *                      * browser_specific_settings is removed
 *
 * Usage:  node tools/build.mjs   (or: npm run build)
 *
 * No third-party build dependencies (Node.js >= 16).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

// Files/folders that are never part of a store package.
const COMMON_EXCLUDE = new Set([
  ".git",
  ".gitignore",
  ".DS_Store",
  ".venv",
  "node_modules",
  "web-ext-artifacts",
  "dist",
  "tools",
  "package.json",
]);

// Chrome-only artifacts that must NOT end up in the Firefox package.
const FIREFOX_EXCLUDE = new Set([
  ...COMMON_EXCLUDE,
  "lib", // browser.* polyfill (not needed – Firefox has a native `browser`)
  "background/service-worker.js", // Chrome service-worker entry
]);

/** Copies `src` into `dest`, skipping every path in `exclude` (root-relative). */
function copyTree(src, dest, exclude, rel = "") {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (exclude.has(relPath)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, exclude, relPath);
    } else {
      copyFileSync(from, to);
    }
  }
}

/** Adds the polyfill <script> tag to an HTML page (Chrome only). */
function injectPolyfillIntoHtml(filePath) {
  const needle = '<script src="../i18n/locale.js"></script>';
  let html = readFileSync(filePath, "utf8");
  if (!html.includes(needle)) {
    throw new Error(
      `Cannot inject polyfill into ${filePath}: anchor not found.`,
    );
  }
  html = html.replace(
    needle,
    '<script src="../lib/browser-polyfill.min.js"></script>\n    ' + needle,
  );
  writeFileSync(filePath, html);
}

/** Builds dist/firefox – essentially the source tree without Chrome-only files. */
function buildFirefox() {
  const out = join(distDir, "firefox");
  rmSync(out, { recursive: true, force: true });
  copyTree(root, out, FIREFOX_EXCLUDE);
  return out;
}

/** Builds dist/chrome – polyfilled MV3 with a service-worker background. */
function buildChrome() {
  const out = join(distDir, "chrome");
  rmSync(out, { recursive: true, force: true });
  copyTree(root, out, COMMON_EXCLUDE);

  // --- manifest -----------------------------------------------------
  const manifestPath = join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Firefox-specific block is not needed/not wanted by the Chrome Web Store.
  delete manifest.browser_specific_settings;

  // Chrome only supports a single service-worker background script.
  manifest.background = { service_worker: "background/service-worker.js" };

  // The polyfill must run first in every content script (same isolated world).
  manifest.content_scripts = (manifest.content_scripts || []).map((cs) => ({
    ...cs,
    js: ["lib/browser-polyfill.min.js", ...(cs.js || [])],
  }));

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // --- HTML pages (options / popup / history) ----------------------
  for (const page of [
    "options/options.html",
    "popup/popup.html",
    "history/history.html",
  ]) {
    injectPolyfillIntoHtml(join(out, page));
  }

  // --- dynamic content-script injection (history.js) ---------------
  // When a Netflix tab was already open and the content script is injected
  // on demand, the polyfill must be injected first as well.
  const historyJs = join(out, "background/history.js");
  let hjs = readFileSync(historyJs, "utf8");
  const anchor = 'files: [\n          "content/netflix/netflix-inject.js",';
  if (!hjs.includes(anchor)) {
    throw new Error(
      "Cannot inject polyfill into background/history.js: anchor not found.",
    );
  }
  hjs = hjs.replace(
    anchor,
    'files: [\n          "lib/browser-polyfill.min.js",\n          "content/netflix/netflix-inject.js",',
  );
  writeFileSync(historyJs, hjs);

  return out;
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const targetArg = process.argv.indexOf("--target");
const target = targetArg >= 0 ? process.argv[targetArg + 1] || "all" : "all";

const results = [];
if (target === "firefox" || target === "all") {
  results.push(["Firefox", buildFirefox()]);
}
if (target === "chrome" || target === "all") {
  results.push(["Chrome", buildChrome()]);
}

console.log("Build finished:");
for (const [name, dir] of results) {
  console.log(`  ${name}: ${dir}`);
}
if (target === "chrome" || target === "all") {
  console.log(
    "  → Chrome testen: chrome://extensions → „Entwicklermodus“ → „Entpackte Erweiterung laden“ → dist/chrome",
  );
}
if (target === "firefox" || target === "all") {
  console.log(
    "  → Firefox: dieser Quellbaum selbst (npm run lint / run), Verpacken z. B. mit web-ext build",
  );
}
