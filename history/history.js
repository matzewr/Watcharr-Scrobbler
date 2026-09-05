/*
 * Watcharr Scrobbler – History page.
 *
 * Shows the viewing history of the selected streaming service (Netflix /
 * Amazon Prime Video) as a comparison "Service ↔ Watcharr", allows
 * correcting the matches (search in Watcharr) and selective import of
 * selected titles.
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
  orderBtn: $("#orderBtn"),
  matchModeBtn: $("#matchModeBtn"),
  confirmModal: $("#confirmModal"),
  orderOkBtn: $("#orderOkBtn"),
  orderCancelBtn: $("#orderCancelBtn"),
  serviceBtn: $("#serviceBtn"),
  pageTitle: $("#pageTitle"),
  pageSubtitle: $("#pageSubtitle"),
  list: $("#list"),
};

// Service whose history is currently shown (id from WatcharrServices).
let serviceId = "netflix";
let serviceAvailable = false;
// Services with an open tab (the header toggle switches between them).
let availableServices = [];

const TMDB_IMG = "https://image.tmdb.org/t/p/w185";

let items = []; // current (filtered) view
let allItems = []; // all loaded items
let filter = "";
const PREFETCH_THRESHOLD = 5; // reload when only this many rows are left at bottom
let total = 0; // number of titles loaded so far
let allLoaded = false; // complete Netflix history loaded?
let loadingMore = false; // currently loading more?
// Lock while an initial full load is running (e.g. switching to "oldest
// first"): blocks infinite scroll / parallel loads until it has finished.
let loadingInitial = false;
// Generation counter: incremented on every fresh load() so that a still
// pending "load more" response from an older list can be discarded.
let loadGen = 0;
// Session-only display order: false = newest first (default, incremental),
// true = oldest first (the complete history is loaded once, oldest on top).
let oldestFirst = false;
// Session-only matching mode: true = exact (a Netflix row only counts as
// "recorded" when the FINISHED activity matches date AND time), false =
// rough (only checks whether the episode is already watched/finished).
let exactMatch = true;

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Builds DOM nodes from an HTML string that was composed in this file with
// every dynamic value passed through escapeHtml(). DOMParser never executes
// scripts; the parsed nodes are attached directly instead of using innerHTML.
function replaceFromHtml(element, html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  element.replaceChildren();
  for (const node of Array.from(parsed.body.childNodes)) {
    element.appendChild(node);
  }
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

/** Rough check: is the episode already watched in Watcharr at all?
 * (FINISHED or WATCHING counts as watched.) */
function episodeSeen(status) {
  return status === "FINISHED" || status === "WATCHING";
}

/** The episode itself is FINISHED in Watcharr (independent of the date). */
function episodeFinished(it) {
  return !!(
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown &&
    it.episodeStatus === "FINISHED"
  );
}

/** True only when this Netflix row is already recorded in Watcharr at the
 * exact same date+time: the episode has a FINISHED activity (EPISODE_ADDED /
 * EPISODE_STATUS_CHANGED) whose customDate matches the row's date+time.
 * customDate is the watched date that was passed to the API. */
function episodeRecordedAtDate(it) {
  return !!(
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown &&
    it.episodeDateMatched
  );
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
  // Series with known episode: the decision depends on the matching mode.
  if (
    it.isTv &&
    it.season != null &&
    it.episode != null &&
    it.episodeStatusKnown
  ) {
    // Exact: only the identical watch (same date AND time) is transferred.
    // Rough: any watched/finished episode is transferred.
    return exactMatch
      ? episodeRecordedAtDate(it)
      : episodeSeen(it.episodeStatus);
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
    if (exactMatch) {
      // Exact mode: only the identical watch (date AND time) counts.
      if (episodeRecordedAtDate(it)) {
        // Recorded in Watcharr at the exact same date+time.
        return (
          '<span class="badge inwatcharr">' +
          label +
          " " +
          escapeHtml(ts("history.badgeWatched")) +
          "</span>"
        );
      }
      // Episode is already FINISHED in Watcharr, but not with THIS date.
      // Importing therefore simply adds another watched date.
      if (episodeFinished(it)) {
        return (
          '<span class="badge readd" title="' +
          escapeHtml(ts("history.badgeReaddTitle")) +
          '">' +
          label +
          " " +
          escapeHtml(ts("history.badgeReadd")) +
          "</span>"
        );
      }
      if (it.match.watchedId) {
        // Series in Watcharr, but this exact watch (date+time) is not recorded.
        return (
          '<span class="badge missing">' +
          label +
          " " +
          escapeHtml(ts("history.badgeMissing")) +
          "</span>"
        );
      }
    } else {
      // Rough mode: only check whether the episode is already watched.
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
  replaceFromHtml(wrap, rowHtml(it));
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
    replaceFromHtml(
      els.list,
      '<div class="list-hint">' + escapeHtml(emptyText) + "</div>",
    );
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

/** Updates the sort-order toggle in the toolbar (label = current order). */
function updateOrderBtn() {
  els.orderBtn.textContent = ts(
    oldestFirst ? "history.oldestFirst" : "history.newestFirst",
  );
  els.orderBtn.classList.toggle("active", oldestFirst);
  els.orderBtn.title = ts("history.switchOrder", {
    mode: ts(oldestFirst ? "history.newestFirst" : "history.oldestFirst"),
  });
}

/** Updates the matching-mode toggle (label/title = current mode).
 * "Exact" is shown in the normal (neutral) style, "rough" is highlighted
 * in red to signal the less strict matching. */
function updateMatchModeBtn() {
  els.matchModeBtn.textContent = ts(
    exactMatch ? "history.matchExact" : "history.matchRough",
  );
  els.matchModeBtn.title = ts(
    exactMatch ? "history.matchExactTitle" : "history.matchRoughTitle",
  );
  els.matchModeBtn.classList.toggle("active", !exactMatch);
}

// Toggle between exact (date+time must match) and rough (episode finished?)
// matching. Only affects the display/selection – the resolution already
// delivers both the episode status and the exact-date match.
els.matchModeBtn.addEventListener("click", () => {
  exactMatch = !exactMatch;
  updateMatchModeBtn();
  // Rows that are now "already recorded" must not stay selected.
  for (const it of allItems) {
    if (isTransferred(it)) it.selected = false;
  }
  render();
});

/** Clears the currently shown history so a stale list doesn't linger while a
 * new load runs. Shows `loadingText` as the only list hint; when `showCancel`
 * is set, a button is added to abort the running (long) load. */
function clearList(loadingText, showCancel) {
  items = [];
  allItems = [];
  scrollTriggers = [];
  els.list.innerHTML = "";
  hintEl = null;
  const cancel = showCancel
    ? '<div class="list-action">' +
      '<button type="button" class="ghost cancel-load-btn">' +
      escapeHtml(ts("history.cancelLoad")) +
      "</button></div>"
    : "";
  replaceFromHtml(
    els.list,
    '<div class="list-hint">' +
      escapeHtml(loadingText || "") +
      "</div>" +
      cancel,
  );
  hintEl = els.list.firstChild;
  updateImportButton();
}

async function load() {
  if (loadingInitial) return; // a load is already in progress
  loadingInitial = true; // lock infinite scroll until this load finishes
  const gen = ++loadGen; // supersede any in-flight "load more" / older loads
  clearStatus();
  updateOrderBtn();
  const loadingMsg = await t(
    oldestFirst ? "history.loadingHistoryOldest" : "history.loadingHistory",
  );
  setStatus("info", loadingMsg);
  // Remove the previously displayed history; for the long "oldest first"
  // load offer a button to abort it and show the fetch progress.
  clearList(loadingMsg, oldestFirst);
  if (oldestFirst) startProgressPolling();
  let ok = false;
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:load",
      oldestFirst,
      service: serviceId,
    });
    if (gen !== loadGen) return; // superseded – a newer load owns the state
    if (resp && resp.cancelled) {
      // User aborted the "oldest first" full load -> fall back to the
      // default (newest first) order and load normally again.
      oldestFirst = false;
      updateOrderBtn();
      loadingInitial = false; // release the lock so the reload can start
      load();
      return;
    }
    if (!resp || !resp.ok)
      throw new Error(
        (resp && resp.error) || (await t("history.loadingFailed")),
      );
    ok = true;
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
  } catch (err) {
    if (gen === loadGen) {
      setStatus("error", err.message);
      replaceFromHtml(
        els.list,
        '<div class="list-hint">' + escapeHtml(err.message) + "</div>",
      );
    }
  } finally {
    // Only the most recent load may release the lock / auto-fill.
    if (gen === loadGen) {
      stopProgressPolling();
      loadingInitial = false; // unlock infinite scroll again
      if (ok) maybeLoadMore();
    }
  }
}

/** Loads the next part of history (infinite scroll, 20-step increments). */
async function loadMore() {
  if (loadingMore || allLoaded || loadingInitial) return;
  loadingMore = true;
  const gen = loadGen;
  updateHint();
  try {
    const resp = await browser.runtime.sendMessage({
      type: "watcharr:history:more",
      oldestFirst,
      service: serviceId,
    });
    if (!resp || !resp.ok)
      throw new Error(
        (resp && resp.error) || (await t("history.loadingFailed")),
      );
    if (gen !== loadGen) return; // a fresh load replaced this list – discard
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
    if (gen === loadGen) setStatus("error", err.message);
  } finally {
    loadingMore = false;
    // If a fresh load replaced this list, don't touch its UI state/hint.
    if (gen === loadGen) {
      updateHint();
      maybeLoadMore();
    }
  }
}

/** Fills the visible area if there's still space (without scrolling). */
function maybeLoadMore() {
  if (loadingMore || allLoaded || loadingInitial) return;
  const doc = document.documentElement;
  if (doc.scrollHeight <= window.innerHeight + 200) {
    loadMore();
  }
}

// -- Load progress ("oldest first" full load) ------------------------------
// While the complete history is being fetched, the page polls the background
// once per second and shows how many entries have been fetched by then
// (e.g. "Already 340 entries loaded").
let progressTimer = null;
const PROGRESS_POLL_MS = 1000;

function stopProgressPolling() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function startProgressPolling() {
  stopProgressPolling();
  progressTimer = setInterval(async () => {
    if (!loadingInitial || !oldestFirst) {
      stopProgressPolling();
      return;
    }
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:history:progress",
      });
      if (resp && resp.ok && typeof resp.loaded === "number") {
        updateLoadingProgress(resp.loaded);
      }
    } catch (_) {
      /* transient – next tick retries */
    }
  }, PROGRESS_POLL_MS);
}

/** Shows how many entries have been fetched so far on the loading hint. */
function updateLoadingProgress(loaded) {
  if (!loaded) return; // keep the generic loading message until the first page
  const h = els.list.querySelector(".list-hint");
  if (h) h.textContent = ts("history.loadedSoFar", { count: loaded });
}

// -- Cancel a running ("oldest first") load ------------------------------
// Aborts the long full-history load in the background. The still-pending
// load() response then arrives with `cancelled: true` and automatically
// falls back to the default (newest first) order.
async function cancelLoad() {
  if (!loadingInitial || !oldestFirst) return;
  const btn = els.list.querySelector(".cancel-load-btn");
  if (btn) btn.disabled = true; // avoid duplicate clicks
  try {
    await browser.runtime.sendMessage({ type: "watcharr:history:cancel" });
  } catch (_) {
    /* ignore – the running load may already have finished */
  }
}

// Cancel button inside the loading placeholder (event delegation).
els.list.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".cancel-load-btn");
  if (btn) cancelLoad();
});

// -- Sort order (oldest first / newest first) --------------------------------
// Switching to "oldest first" loads the complete history once -> ask first.
function openOrderConfirm() {
  els.confirmModal.classList.remove("hidden");
  els.orderOkBtn.focus();
}

function closeOrderConfirm() {
  els.confirmModal.classList.add("hidden");
}

els.orderBtn.addEventListener("click", () => {
  if (loadingInitial) return; // ignore while a full load is running
  if (!oldestFirst) {
    openOrderConfirm(); // switching to oldest first needs confirmation
  } else {
    oldestFirst = false; // back to newest first is instant – no confirmation
    load();
  }
});

els.orderOkBtn.addEventListener("click", () => {
  closeOrderConfirm();
  oldestFirst = true;
  load(); // reloads the list in the new order (label/state is updated in load)
});

els.orderCancelBtn.addEventListener("click", closeOrderConfirm);

// Click on the backdrop closes the dialog; Esc works as well.
els.confirmModal.addEventListener("click", (e) => {
  if (e.target === els.confirmModal) closeOrderConfirm();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.confirmModal.classList.contains("hidden")) {
    closeOrderConfirm();
  }
});

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
  replaceFromHtml(
    panel,
    '<input type="search" placeholder="' +
      escapeHtml(ts("history.searchTitle")) +
      '" autocomplete="off" />' +
      '<div class="hint">' +
      escapeHtml(ts("history.searchHint")) +
      "</div>" +
      '<div class="rematch-results"></div>',
  );
  row.after(panel);
  const input = panel.querySelector("input");
  input.focus();

  const runSearch = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const resultsBox = panel.querySelector(".rematch-results");
    replaceFromHtml(
      resultsBox,
      '<div class="hint">' + escapeHtml(ts("history.searching")) + "</div>",
    );
    try {
      const resp = await browser.runtime.sendMessage({
        type: "watcharr:search",
        query: q,
        searchType: "multi",
      });
      const results =
        resp && resp.ok ? (resp.data && resp.data.results) || [] : [];
      if (!results.length) {
        replaceFromHtml(
          resultsBox,
          '<div class="hint">' + escapeHtml(ts("history.noResults")) + "</div>",
        );
        return;
      }
      resultsBox.innerHTML = "";
      for (const r of results.slice(0, 12)) {
        const item = document.createElement("div");
        item.className = "rematch-result";
        const poster = r.extPosterPath ? TMDB_IMG + r.extPosterPath : null;
        replaceFromHtml(
          item,
          (poster
            ? '<img class="poster" src="' + escapeHtml(poster) + '" alt="" />'
            : '<div class="poster ph"></div>') +
            '<div class="info"><div class="name">' +
            escapeHtml(r.name || "") +
            "</div>" +
            '<div class="meta">' +
            escapeHtml(
              (r.type || "").replace("tmdb_", "") +
                (r.releaseDate
                  ? " · " + String(r.releaseDate).slice(0, 4)
                  : ""),
            ) +
            "</div></div>",
        );
        item.addEventListener("click", () => {
          rematch(key, r);
          panel.remove();
        });
        resultsBox.appendChild(item);
      }
    } catch (err) {
      replaceFromHtml(
        resultsBox,
        '<div class="hint">' +
          escapeHtml(ts("history.searchFailed", { error: err.message })) +
          "</div>",
      );
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
  if (loadingMore || allLoaded || loadingInitial) return;
  if (!scrollTriggers.length) return;
  const rect = scrollTriggers[0].getBoundingClientRect();
  if (rect.top <= window.innerHeight) {
    loadMore();
  }
});

/** Sets the header title/subtitle to the selected service. */
async function applyServiceHeader() {
  const svc = WatcharrServices.byId(serviceId);
  const name = svc ? svc.name : "";
  if (els.pageTitle)
    els.pageTitle.textContent = await t("history.pageTitle", {
      service: name,
    });
  if (els.pageSubtitle)
    els.pageSubtitle.textContent = await t("history.pageSubtitle", {
      service: name,
    });
}

/**
 * Renders the provider button in the header: it always shows the service
 * whose history is currently displayed. When more than one service has an
 * open tab it becomes a toggle (click switches to the other provider).
 */
function renderServiceToggle(available) {
  availableServices = available || [];
  const btn = els.serviceBtn;
  if (!btn) return;
  const svc = WatcharrServices.byId(serviceId);
  if (!svc || !serviceAvailable || availableServices.length === 0) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  btn.textContent = svc.name;
  const toggleable = availableServices.length > 1;
  btn.classList.toggle("toggleable", toggleable);
  if (toggleable) {
    const target = availableServices.find((s) => s.id !== serviceId);
    btn.title = ts("history.switchProviderTitle", {
      service: svc.name,
      target: target ? target.name : "",
    });
  } else {
    btn.title = ts("history.pageTitle", { service: svc.name });
  }
}

/**
 * Determines which services have an open, usable tab and which one should be
 * selected: the currently focused service tab wins, otherwise the first
 * service that has an open tab.
 */
async function detectServices() {
  const available = [];
  for (const svc of WatcharrServices.list) {
    if (svc.hasHistory === false) continue;
    try {
      const tabs = await browser.tabs.query({ url: svc.urlPattern });
      if (tabs.some((t) => t.id != null)) available.push(svc);
    } catch (_) {
      /* ignore – no permission for this pattern */
    }
  }
  let preferred = null;
  try {
    const active = (
      await browser.tabs.query({ active: true, currentWindow: true })
    )[0];
    const activeSvc = active && WatcharrServices.byUrl(active.url);
    if (activeSvc) preferred = activeSvc;
  } catch (_) {
    /* ignore */
  }
  const chosen =
    preferred && available.some((s) => s.id === preferred.id)
      ? preferred
      : available[0] || null;
  return { available, chosen };
}

/** No service tab is open – the history cannot be loaded. */
async function showNoService() {
  const names = WatcharrServices.list
    .filter((s) => s.hasHistory !== false)
    .map((s) => s.name)
    .join(" / ");
  const msg = await t("history.noServiceTab", { services: names });
  setStatus("error", msg);
  replaceFromHtml(
    els.list,
    '<div class="list-hint">' + escapeHtml(msg) + "</div>",
  );
  updateImportButton();
}

/** Switches the history provider and reloads it (used by the toggle button). */
async function switchProvider(id) {
  serviceId = id;
  serviceAvailable = true;
  applyServiceHeader();
  renderServiceToggle(availableServices);
  // A different service = a completely different history.
  oldestFirst = false;
  updateOrderBtn();
  load();
}

/**
 * Re-checks which service tabs are open and reconciles the header toggle:
 *  - no service tab open at all               -> toggle is hidden,
 *  - the current provider's tab is gone, but another provider is open
 *    -> switch to it (and reload, unless an "oldest first" load is running),
 *  - otherwise only the toggle state is refreshed (e.g. a second provider's
 *    tab opened/closed -> becomes/ceases to be a toggle).
 */
async function refreshProviders() {
  const { available, chosen } = await detectServices();
  availableServices = available;
  const hadService = serviceAvailable;

  if (!chosen) {
    // No service tab is open – hide the toggle (keep the current view).
    renderServiceToggle(available);
    return;
  }

  const currentOpen = available.some((s) => s.id === serviceId);
  if (!serviceAvailable || !currentOpen) {
    // First detection or the current provider's tab was closed.
    serviceId = chosen.id;
    serviceAvailable = true;
    await applyServiceHeader();
    renderServiceToggle(available);
    if (hadService && !loadingInitial) {
      // Switch to the other provider and load its history.
      oldestFirst = false;
      updateOrderBtn();
      load();
    }
    return;
  }

  // Provider unchanged – just keep the toggle in sync with the open tabs.
  renderServiceToggle(available);
}

let providerRefreshTimer = null;

/** Debounced provider re-check – bursts of tab events trigger one run. */
function scheduleProviderRefresh() {
  if (providerRefreshTimer) clearTimeout(providerRefreshTimer);
  providerRefreshTimer = setTimeout(() => {
    providerRefreshTimer = null;
    refreshProviders();
  }, 400);
}

/**
 * Reacts to tab events so the toggle updates immediately when a tab is
 * opened/closed/navigated:
 *   - tabs.onCreated / onRemoved -> a service tab appeared or disappeared,
 *   - tabs.onActivated           -> the active tab changed,
 *   - tabs.onUpdated (url/complete) -> a tab navigated to/away from a service.
 */
function bindTabEvents() {
  try {
    browser.tabs.onCreated.addListener(scheduleProviderRefresh);
    browser.tabs.onRemoved.addListener(scheduleProviderRefresh);
    browser.tabs.onActivated.addListener(scheduleProviderRefresh);
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      // React when a tab finished loading or its URL changed; plain loading
      // status updates would be too noisy.
      if (changeInfo && (changeInfo.url || changeInfo.status === "complete")) {
        scheduleProviderRefresh();
      }
    });
  } catch (_) {
    /* tabs events not available in this context */
  }
}

async function initHistory() {
  const locale = window.watcharrI18nLocale
    ? await window.watcharrI18nLocale.fetchLocale()
    : "en";
  await applyLanguage(locale);

  updateOrderBtn();
  updateMatchModeBtn();

  // Header provider button: with a second service available it toggles
  // between the providers (otherwise it only shows the current one).
  if (els.serviceBtn) {
    els.serviceBtn.addEventListener("click", () => {
      if (availableServices.length < 2) return; // nothing to switch to
      const next = availableServices.find((s) => s.id !== serviceId);
      if (!next) return;
      switchProvider(next.id);
    });
  }

  // Keep the provider toggle in sync with the open tabs (event-driven).
  bindTabEvents();

  await refreshProviders();
  await applyServiceHeader();

  if (!serviceAvailable) {
    await showNoService();
    return;
  }
  load();
}

initHistory();
