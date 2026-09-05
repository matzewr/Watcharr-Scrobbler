/*
 * Service registry (shared by background, popup and history page).
 *
 * Central list of all streaming services the extension can scrobble. The
 * per-service content scripts do the actual work (playback detection +
 * history); this file only describes each service so that the UI and the
 * background can find open tabs and (re-)inject the right content scripts.
 *
 * This file is loaded in three places:
 *   - background (manifest "background.scripts" / Chrome service-worker
 *     importScripts, before history.js & background.js),
 *   - popup / history / options pages (plain <script> tag).
 *
 * NOTE for the Chrome build (tools/build.mjs): "lib/browser-polyfill.min.js"
 * is prepended to every `contentScripts` array in this file, so that content
 * scripts that are injected on demand (into tabs that were already open)
 * also run the polyfill first. Firefox does not need the polyfill.
 *
 * Service names are proper nouns and therefore identical in every locale.
 */
(function () {
  "use strict";

  const list = [
    {
      id: "netflix",
      name: "Netflix",
      // Matches a tab URL to decide whether this service is open in it.
      urlTest: /(^|\.)netflix\.com$/i,
      // Pattern used with browser.tabs.query({ url: … }).
      urlPattern: "*://*.netflix.com/*",
      // Content scripts to (re-)inject into a tab that was opened before the
      // extension was loaded (order matters – same as the manifest entry).
      contentScripts: [
        "content/netflix/netflix-inject.js",
        "content/netflix/netflix-content.js",
      ],
      hasHistory: true,
    },
    {
      id: "primevideo",
      name: "Amazon Prime Video",
      urlTest: /(^|\.)primevideo\.com$/i,
      urlPattern: "*://*.primevideo.com/*",
      contentScripts: [
        "content/primevideo/primevideo-content.js",
      ],
      hasHistory: true,
    },
  ];

  /** Returns the service descriptor for an id, or null. */
  function byId(id) {
    if (!id) return null;
    return list.find((s) => s.id === id) || null;
  }

  /** Extracts the hostname from a (tab) URL – used for service matching. */
  function host(url) {
    if (!url) return "";
    try {
      return new URL(url).hostname;
    } catch (_) {
      return String(url);
    }
  }

  /** Returns the service descriptor matching a tab URL, or null. */
  function byUrl(url) {
    if (!url) return null;
    const h = host(url);
    return list.find((s) => s.urlTest.test(h)) || null;
  }

  const api = { list, byId, byUrl, host };

  // Expose on whatever global object this file is loaded into (extension
  // page window, Firefox event page, Chrome service worker).
  const root =
    typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
  root.WatcharrServices = api;
})();
