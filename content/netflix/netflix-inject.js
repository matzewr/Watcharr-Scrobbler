/*
 * Netflix – Injection Script (Content Script, isolated world).
 *
 * Netflix has no official DOM selectors for the running player.
 * Therefore we load a small "probe" file (content/netflix/netflix-probe.js) as
 * an external <script src> tag into the MAIN world of the page. The probe reads
 * Netflix' internal player state and reports it back to us (the Content Script)
 * via CustomEvent.
 *
 * NOTE: The probe is loaded from a real file, NOT injected as inline text.
 * Netflix' Content-Security-Policy forbids inline scripts (no 'unsafe-inline',
 * no hash/nonce present), so `script.textContent` is blocked. Netflix' CSP
 * does, however, allow the extension's own origin (Chrome appends
 * chrome-extension://<id>/ to the page CSP automatically), so an external
 * <script src> from the extension is permitted. The probe file is declared in
 * web_accessible_resources so the page may load it.
 */
"use strict";

(function () {
  const PROBE_ID = "watcharr-netflix-probe";
  const PROBE_SRC = browser.runtime.getURL(
    "content/netflix/netflix-probe.js"
  );

  function inject() {
    if (document.getElementById(PROBE_ID)) return;
    const script = document.createElement("script");
    script.id = PROBE_ID;
    script.src = PROBE_SRC;
    (document.head || document.documentElement).appendChild(script);
  }

  // Netflix is an SPA – the Content Script may run before DOMContentLoaded.
  if (document.documentElement) {
    inject();
  } else {
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  }
})();
