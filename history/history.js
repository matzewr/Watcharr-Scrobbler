/*
 * Watcharr Scrobbler – History page.
 *
 * Shows the Netflix history as a comparison "Netflix ↔ Watcharr",
 * allows correcting the matches (search in Watcharr) and selective
 * import of selected titles.
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const I18NApi = window.i18n || {
  resolveLanguage: (lang) => (lang === "de" ? "de" : "en"),
  loadLanguage: async (lang) => (lang === "de" ? "de" : "en"),
  translate: async (key, lang, params = {}) => key,
  applyTranslations: async () => {},
};

let currentLanguage = I18NApi.resolveLanguage("en");

async function t(key, params = {}) {
  return I18NApi.translate
    ? I18NApi.translate(key, currentLanguage, params)
    : key;
}

// Synchronous translation for use while building HTML/status strings.
function ts(key, params) {
  return window.watcharrI18n && window.watcharrI18n.tSync
    ? window.watcharrI18n.tSync(key, params || {}, currentLanguage)
    : key;
}

async function applyLanguage(lang) {
  currentLanguage = I18NApi.resolveLanguage(lang);
  await I18NApi.applyTranslations(currentLanguage, document);
  document.documentElement.lang = currentLanguage;
}

const els = {
  reloadBtn: $("#reloadBtn"),
  statusBar: $("#statusBar"),
  selectAllBtn: $("#selectAllBtn"),
  selectNoneBtn: $("#selectNoneBtn"),
  filterBox: $("#filterBox"),
  importBtn: $("#importBtn"),
  list: $("#list"),
};

const TMDB_IMG = "https://image.tmdb.org/t/p/w185";

let items = []; // current (filtered) view
let allItems = []; // all loaded items
let filter = "";
const PREFETCH_THRESHOLD = 5; // reload when only this many rows are left at bottom
let total = 0; // number of titles loaded so far
let allLoaded = false; // complete Netflix history loaded?
let loadingMore = false; // currently loading more?

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let statusTimer = null; // Auto-hide timer for success popup

function setStatus(kind, text) {
  clearTimeout(statusTimer);
  els.statusBar.className = "status " + kind;
  els.statusBar.textContent = text;
  els.statusBar.classList.remove("hidden");
}

function clearStatus() {
  clearTimeout(statusTimer);
  els.statusBar.classList.add("hidden");
  els.statusBar.classList.remove("popup");
  els.statusBar.textContent = "";
}

/** Shows the status bar as a small popup above the toolbar, fades out after 4 s. */
function showStatusPopup(kind, text) {
  clearTimeout(statusTimer);
  els.statusBar.className = "status " + kind + " popup";
  els.statusBar.textContent = text;
  els.statusBar.classList.remove("hidden");
  statusTimer = setTimeout(hideStatusPopup, 4000);
}

/** Fades out the popup smoothly and removes it afterwards. */
function hideStatusPopup() {
  if (!els.statusBar.classList.contains("popup")) return;
  els.statusBar.classList.add("popup-hide"); // starts the fade-out
  statusTimer = setTimeout(() => {
    els.statusBar.classList.add("hidden");
    els.statusBar.classList.remove("popup", "popup-hide");
    els.statusBar.textContent = "";
  }, 300);
}

function posterUrl(it) {
  return it && it.match && it.match.posterPath
    ? TMDB_IMG + it.match.posterPath
    : null;
}

/** Is an episode considered "watched"? (WATCHING counts as watched.) */
function episodeSeen(status) {
  return status === "FINISHED" || status === "WATCHING";
}

/** Already transferred rows are not selectable. */
function isTransferred(it) {
  if (!it || !it.match) return false;
  // Successfully imported in this session.
  if (
    it.status === "imported" ||
    it.status === "updated" ||
    it.status === "exists"
  ) {
    return true;
  }
  // Failed/skipped import remains editable (e.g., retry import).
  if (it.status === "error" || it.status === "skipped") {
    return false;
  }
  // Match is not yet in Watcharr -> selectable.
  if (!it.match.watchedId) return false;
  // Series: only transferred when the specific episode is watched.
  if (
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown
  ) {
    return episodeSeen(it.episodeStatus);
  }
  // Movie or series without known episode / unknown status -> already in Watcharr.
  return true;
}

function matchBadge(it) {
  if (!it.match) {
    return (
      '<span class="badge nomatch">' +
      escapeHtml(ts("history.badgeNoMatch")) +
      "</span>"
    );
  }
  if (
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown
  ) {
    const label = "S" + it.season + "E" + it.episode;
    if (episodeSeen(it.episodeStatus)) {
      return (
        '<span class="badge inwatcharr">' +
        label +
        " " +
        escapeHtml(ts("history.badgeWatched")) +
        "</span>"
      );
    }
    if (it.match.watchedId) {
      return (
        '<span class="badge missing">' +
        label +
        " " +
        escapeHtml(ts("history.badgeMissing")) +
        "</span>"
      );
    }
  }
  if (it.match.watchedId) {
    return it.isTv
      ? '<span class="badge inwatcharr">' +
          escapeHtml(ts("history.badgeSeriesInWatcharr")) +
          "</span>"
      : '<span class="badge inwatcharr">' +
          escapeHtml(ts("history.badgeInWatcharr")) +
          "</span>";
  }
  return (
    '<span class="badge matched">' +
    escapeHtml(ts("history.badgeMatched")) +
    "</span>"
  );
}

function statusBadge(it) {
  const map = {
    imported:
      '<span class="badge imported">' +
      escapeHtml(ts("history.statusImported")) +
      "</span>",
    updated:
      '<span class="badge imported">' +
      escapeHtml(ts("history.statusUpdated")) +
      "</span>",
    error:
      '<span class="badge error">' +
      escapeHtml(ts("history.statusError")) +
      "</span>",
    skipped:
      '<span class="badge skipped">' +
      escapeHtml(ts("history.statusSkipped")) +
      "</span>",
    exists:
      '<span class="badge exists">' +
      escapeHtml(ts("history.statusExists")) +
      "</span>",
  };
  return it.status && map[it.status] ? map[it.status] : "";
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const localeTag =
    currentLanguage === "de"
      ? "de-DE"
      : currentLanguage === "fr"
        ? "fr-FR"
        : "en-US";
  return d.toLocaleDateString(localeTag);
}

function netflixMeta(it) {
  const parts = [
    it.isTv ? ts("history.metadataSeries") : ts("history.metadataMovie"),
  ];
  if (it.isTv && it.season != null && it.episode != null) {
    parts.push("S" + it.season + "E" + it.episode);
  }
  const date = formatDate(it.date);
  if (date) parts.push(ts("history.metadataOn", { date }));
  const year = it.match && it.match.year ? it.match.year : it.year;
  if (year) parts.push(year);
  return parts.join(" · ");
}

function rowHtml(it) {
  const url = posterUrl(it);
  const poster =
    url != null
      ? '<img class="poster" src="' +
        escapeHtml(url) +
        '" alt="" loading="lazy" />'
      : '<div class="poster ph">—</div>';
  const matchName = it.match ? it.match.name || it.title : "—";
  const matchMeta = it.match
    ? "TMDB " +
      it.match.tmdbId +
      (it.match.contentType === "movie"
        ? " · " + ts("history.metadataMovie")
        : " · " + ts("history.metadataSeries")) +
      (it.match.year ? " · " + it.match.year : "")
    : it.matchError || "—";

  const transferred = isTransferred(it);
  return (
    '<div class="row' +
    (transferred ? " transferred" : "") +
    '" data-key="' +
    escapeHtml(it.key) +
    '">' +
    '<label class="check"><input type="checkbox" class="sel" ' +
    (it.selected ? "checked" : "") +
    (transferred ? " disabled" : "") +
    " /></label>" +
    '<div class="netflix">' +
    '<div class="name">' +
    escapeHtml(it.title) +
    "</div>" +
    '<div class="meta">' +
    netflixMeta(it) +
    "</div>" +
    "</div>" +
    '<div class="arrow">→</div>' +
    '<div class="watcharr">' +
    poster +
    '<div class="info">' +
    '<div class="name">' +
    escapeHtml(matchName) +
    "</div>" +
    '<div class="meta">' +
    escapeHtml(matchMeta) +
    "</div>" +
    '<div class="badges">' +
    matchBadge(it) +
    statusBadge(it) +
    "</div>" +
    (it.error
      ? '<div class="row-error">' + escapeHtml(it.error) + "</div>"
      : "") +
    "</div>" +
    "</div>" +
    '<div class="row-actions">' +
    '<button class="ghost rematch-btn">' +
    escapeHtml(ts("history.changeMatch")) +
    "</button>" +
    "</div>" +
    "</div>"
  );
}

let hintEl = null; // Hint at list end (Infinite Scroll)
let scrollTriggers = []; // last PREFETCH_THRESHOLD .row elements

function ensureHint() {
  if (!hintEl || !hintEl.isConnected) {
    hintEl = document.createElement("div");
    hintEl.className = "list-hint";
    els.list.appendChild(hintEl);
  }
  return hintEl;
}

function updateHint() {
  const h = ensureHint();
  if (loadingMore) {
    h.textContent = ts("history.loadingMore");
  } else if (allLoaded) {
    h.textContent = ts("history.allLoaded", { total });
  } else {
    h.textContent = ts("history.scrollMore");
  }
}

function buildRow(it) {
  const wrap = document.createElement("div");
  wrap.innerHTML = rowHtml(it);
  return wrap.firstChild;
}

/** Remembers the last rows as triggers for loading more when scrolling. */
function refreshScrollTriggers() {
  const rows = els.list.querySelectorAll(".row");
  const start = Math.max(0, rows.length - PREFETCH_THRESHOLD);
  scrollTriggers = Array.prototype.slice.call(rows, start);
}

function render() {
  items = allItems.filter(
    (it) => !filter || it.title.toLowerCase().includes(filter),
  );
  els.list.innerHTML = "";
  hintEl = null;
  if (!items.length) {
    const emptyText = allItems.length
      ? ts("history.emptyFilter", { filter })
      : allLoaded
        ? ts("history.emptyHistory")
        : ts("history.reloadHint");
    els.list.innerHTML =
      '<div class="list-hint">' + escapeHtml(emptyText) + "</div>";
    updateImportButton();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(buildRow(it));
  els.list.appendChild(frag);
  updateHint();
  refreshScrollTriggers();
  updateImportButton();
}

/** Appends new items to end of list without re-rendering the whole list. */
function appendItems(newItems) {
  const filtered = newItems.filter(
    (it) => !filter || it.title.toLowerCase().includes(filter),
  );
  items.push(...filtered);
  if (!filtered.length) {
    updateHint();
    updateImportButton();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of filtered) frag.appendChild(buildRow(it));
  const hint = ensureHint();
  els.list.insertBefore(frag, hint);
  updateHint();
  refreshScrollTriggers();
  updateImportButton();
}

function updateImportButton() {
  const n = allItems.filter((it) => it.selected && !isTransferred(it)).length;
  els.importBtn.disabled = n === 0;
  els.importBtn.textContent = ts("history.importSelected", { count: n });
}

async function load() {
  clearStatus();
  setStatus("info", await t("history.loadingHistory"));
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:load",
    });
    if (!resp || !resp.ok)
      throw new Error(
        (resp && resp.error) || (await t("history.loadingFailed")),
      );
    allItems = resp.items || [];
    total = resp.total != null ? resp.total : allItems.length;
    allLoaded = !!resp.done;
    render();
    clearStatus();
    if (allLoaded) {
      setStatus(
        "success",
        total
          ? await t("history.titlesLoadedAll", { total })
          : await t("history.emptyHistory"),
      );
    } else {
      setStatus("info", await t("history.titlesLoaded", { total }));
    }
    maybeLoadMore();
  } catch (err) {
    setStatus("error", err.message);
    els.list.innerHTML =
      '<div class="list-hint">' + escapeHtml(err.message) + "</div>";
  }
}

/** Loads the next part of history (infinite scroll, 20-step increments). */
async function loadMore() {
  if (loadingMore || allLoaded) return;
  loadingMore = true;
  updateHint();
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:more",
    });
    if (!resp || !resp.ok)
      throw new Error(
        (resp && resp.error) || (await t("history.loadingFailed")),
      );
    const newItems = resp.items || [];
    allItems.push(...newItems);
    if (resp.total != null) total = resp.total;
    allLoaded = !!resp.done;
    appendItems(newItems);
    if (resp.error) {
      setStatus("error", resp.error);
    } else if (allLoaded) {
      clearStatus();
      setStatus("success", await t("history.titlesLoadedAll", { total }));
    } else {
      clearStatus();
      setStatus("info", await t("history.titlesLoaded", { total }));
    }
  } catch (err) {
    setStatus("error", err.message);
  } finally {
    loadingMore = false;
    updateHint();
    maybeLoadMore();
  }
}

/** Fills the visible area if there's still space (without scrolling). */
function maybeLoadMore() {
  if (loadingMore || allLoaded) return;
  const doc = document.documentElement;
  if (doc.scrollHeight <= window.innerHeight + 200) {
    loadMore();
  }
}

// -- Selection / Filter ---------------------------------------------------------
els.selectAllBtn.addEventListener("click", () => {
  for (const it of allItems) it.selected = !isTransferred(it);
  render();
});
els.selectNoneBtn.addEventListener("click", () => {
  for (const it of allItems) it.selected = false;
  render();
});

els.filterBox.addEventListener("input", () => {
  filter = els.filterBox.value.trim().toLowerCase();
  render();
});

// Checkbox changes (event delegation)
els.list.addEventListener("change", (e) => {
  if (e.target && e.target.classList.contains("sel")) {
    const row = e.target.closest(".row");
    const it = allItems.find((x) => x.key === row.dataset.key);
    if (it) it.selected = e.target.checked;
    updateImportButton();
  }
});

// -- Change match (popover with Watcharr search) --------------------------------
let searchTimer = null;

els.list.addEventListener("click", async (e) => {
  const btn = e.target.closest(".rematch-btn");
  if (!btn) return;
  const row = btn.closest(".row");
  const key = row.dataset.key;
  const existing = document.querySelector(
    '.rematch-panel[data-key="' + escapeHtml(key) + '"]',
  );
  if (existing) {
    existing.remove();
    return;
  }
  // Insert panel
  const panel = document.createElement("div");
  panel.className = "rematch-panel";
  panel.dataset.key = key;
  panel.innerHTML =
    '<input type="search" placeholder="' +
    escapeHtml(ts("history.searchTitle")) +
    '" autocomplete="off" />' +
    '<div class="hint">' +
    escapeHtml(ts("history.searchHint")) +
    "</div>" +
    '<div class="rematch-results"></div>';
  row.after(panel);
  const input = panel.querySelector("input");
  input.focus();

  const runSearch = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const resultsBox = panel.querySelector(".rematch-results");
    resultsBox.innerHTML =
      '<div class="hint">' + escapeHtml(ts("history.searching")) + "</div>";
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:search",
        query: q,
        searchType: "multi",
      });
      const results =
        resp && resp.ok ? (resp.data && resp.data.results) || [] : [];
      if (!results.length) {
        resultsBox.innerHTML =
          '<div class="hint">' + escapeHtml(ts("history.noResults")) + "</div>";
        return;
      }
      resultsBox.innerHTML = "";
      for (const r of results.slice(0, 12)) {
        const item = document.createElement("div");
        item.className = "rematch-result";
        const poster = r.extPosterPath ? TMDB_IMG + r.extPosterPath : null;
        item.innerHTML =
          (poster
            ? '<img class="poster" src="' + escapeHtml(poster) + '" alt="" />'
            : '<div class="poster ph"></div>') +
          '<div class="info"><div class="name">' +
          escapeHtml(r.name || "") +
          "</div>" +
          '<div class="meta">' +
          escapeHtml(
            (r.type || "").replace("tmdb_", "") +
              (r.releaseDate ? " · " + String(r.releaseDate).slice(0, 4) : ""),
          ) +
          "</div></div>";
        item.addEventListener("click", () => {
          rematch(key, r);
          panel.remove();
        });
        resultsBox.appendChild(item);
      }
    } catch (err) {
      resultsBox.innerHTML =
        '<div class="hint">' +
        escapeHtml(ts("history.searchFailed", { error: err.message })) +
        "</div>";
    }
  };

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch();
    }
  });
});

async function rematch(key, result) {
  const resp = await browser.runtime.sendMessage({
    type: "watcharr:history:rematch",
    key,
    result,
  });
  if (resp && resp.ok && resp.item) {
    const it = allItems.find((x) => x.key === key);
    if (it) {
      Object.assign(it, resp.item);
      if (isTransferred(it)) it.selected = false;
    }
    render();
    setStatus(
      "success",
      ts("history.matchUpdated", { title: resp.item.title || key }),
    );
  } else {
    setStatus(
      "error",
      (resp && resp.error) || ts("history.matchCouldNotBeUpdated"),
    );
  }
}

/** Summarizes an import result for the status line. */
function importSummary(results) {
  const st = {
    imported: ts("history.statusImported"),
    updated: ts("history.statusUpdated"),
    exists: ts("history.statusExists"),
    skipped: ts("history.statusSkipped"),
    error: ts("history.statusError"),
  };
  const parts = [];
  for (const s of ["imported", "updated", "exists", "skipped", "error"]) {
    const n = results.filter((r) => r.status === s).length;
    if (n) parts.push(n + " " + st[s]);
  }
  return parts.length ? parts.join(" · ") : ts("history.nothingToDo");
}

// -- Import -------------------------------------------------------------------
els.importBtn.addEventListener("click", async () => {
  const keys = allItems.filter((it) => it.selected).map((it) => it.key);
  if (!keys.length) return;
  els.importBtn.disabled = true;
  els.importBtn.textContent = ts("history.importing");
  setStatus("info", await t("history.importingTitles", { count: keys.length }));
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:import",
      keys,
    });
    if (!resp || !resp.ok)
      throw new Error(
        (resp && resp.error) || (await t("history.loadingFailed")),
      );
    const results = resp.results || [];
    const byKey = {};
    for (const r of results) byKey[r.key] = r;
    for (const it of allItems) {
      if (byKey[it.key]) {
        it.status = byKey[it.key].status;
        it.error = byKey[it.key].error || null;
        if (
          it.status === "imported" ||
          it.status === "updated" ||
          it.status === "exists"
        ) {
          it.selected = false;
          if (it.match) it.match.watchedId = byKey[it.key].watchedId || true;
        }
      }
    }
    render();
    const okCount = results.filter(
      (r) =>
        r.status === "imported" ||
        r.status === "updated" ||
        r.status === "exists",
    ).length;
    const errCount = results.filter((r) => r.status === "error").length;
    if (okCount > 0) {
      showStatusPopup(
        "success",
        await t("history.importCompleted", { summary: importSummary(results) }),
      );
    } else if (errCount > 0) {
      showStatusPopup(
        "error",
        await t("history.importFailed", { summary: importSummary(results) }),
      );
    } else {
      showStatusPopup(
        "info",
        await t("history.importCompleted", { summary: importSummary(results) }),
      );
    }
  } catch (err) {
    setStatus("error", err.message);
  } finally {
    els.importBtn.disabled = false;
    updateImportButton();
  }
});

els.reloadBtn.addEventListener("click", load);

// Infinite Scroll: load more as soon as only PREFETCH_THRESHOLD rows are
// left until the bottom of the viewport.
window.addEventListener("scroll", () => {
  if (loadingMore || allLoaded) return;
  if (!scrollTriggers.length) return;
  const rect = scrollTriggers[0].getBoundingClientRect();
  if (rect.top <= window.innerHeight) {
    loadMore();
  }
});

async function initHistory() {
  const locale = window.watcharrI18nLocale
    ? await window.watcharrI18nLocale.fetchLocale()
    : "en";
  await applyLanguage(locale);
  load();
}

initHistory();
