/*
 * History Workspace (Background).
 *
 * Loads the viewing history of the currently selected service (Netflix /
 * Amazon Prime Video) through its Content Script, builds a comparison list
 * "Service ↔ Watcharr" from it (with TMDB resolution via Watcharr search),
 * allows correcting individual matches, and imports selected titles into
 * Watcharr.
 *
 * Loaded as a classic script BEFORE background.js and provides the
 * global `WatcharrHistory` object (uses `WatcharrClient` from
 * watcharr-client.js and the service registry from services.js).
 */
"use strict";

const WatcharrHistory = (() => {
  // Incremental loading: EVERY view of the service is a separate entry (NO
  // grouping by series). BATCH_SIZE elements are always fetched from the
  // service, matched, and then displayed on the page.
  const BATCH_SIZE = 20;
  // Safety cap for "oldest first" mode: the services normally end with an
  // empty page much earlier – this only guards against an endless loop.
  const MAX_HISTORY_PAGES = 500;

  let items = []; // all entries loaded so far (1 service view = 1 row)
  const itemMap = new Map(); // lookup for fast item.key -> item; important for larger histories
  let page = 0; // next service page to load
  let total = 0; // number of entries loaded so far
  let done = false; // complete service history loaded?
  let loading = false; // currently loading a batch?
  let loadError = null; // last error when loading
  let loadErrorCode = null; // stable i18n code of the last load error
  let seq = 0; // sequential key for stable item keys
  // Session display order: show the history OLDEST first? The services return
  // the newest entry first (page 0 = top of the list), so this mode loads the
  // COMPLETE history once and serves it to the UI starting with the oldest
  // entry (oldest at the very top).
  let oldestFirst = false;
  // oldest-first mode: how many entries have already been handed to the UI.
  // After the full load `items` is stored oldest -> newest.
  let delivered = 0;
  // Set while a (long) "oldest first" full-history load is running so that
  // the user can abort it via the button on the history page.
  let cancelRequested = false;

  // Service whose history is currently being loaded (id from WatcharrServices).
  let serviceId = "netflix";
  // Identifies one fresh history load. It is passed to the content scripts so
  // that paged services (Amazon Prime Video) can reset their internal history
  // buffer when a new load starts. Netflix ignores it.
  let historyLoadId = 0;

  function refreshItemMap() {
    itemMap.clear();
    for (const it of items) itemMap.set(it.key, it);
  }

  const log = (...a) => console.log("[watcharr-bg]", ...a);
  const logErr = (...a) => console.error("[watcharr-bg]", ...a);

  /** Builds a user-facing Error carrying a stable i18n code + params. The UI
   *  translates these codes (see history/history.js), so extension-authored
   *  error copy is localized instead of shown raw. */
  function userError(code, message, params) {
    const e = new Error(message);
    e.userCode = code;
    e.userParams = params || {};
    return e;
  }

  const normTitle = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

  async function getSettings() {
    const d = await browser.storage.local.get("settings");
    return d.settings || {};
  }

  /** Sets the display order for the next load / more (session-only). */
  function setOldestFirst(v) {
    oldestFirst = !!v;
  }

  /** Selects the service whose history is loaded (id from WatcharrServices). */
  function setService(id) {
    if (WatcharrServices.byId(id)) serviceId = id;
  }

  /** Requests that a running "oldest first" full-history load be aborted. */
  function cancelHistoryLoad() {
    cancelRequested = true;
  }

  /**
   * Finds a tab of the current service where the Content Script is running.
   * If no Content Script is reachable in any tab (e.g., because the tab was
   * already open when the extension was loaded), it is injected afterwards
   * via browser.scripting. Returns the tab ID or throws an error.
   */
  async function ensureServiceTab() {
    const svc = WatcharrServices.byId(serviceId) || WatcharrServices.list[0];
    log("ensureServiceTab: searching for open", svc.name, "tabs …");
    const tabs = await browser.tabs.query({ url: svc.urlPattern });
    const candidates = tabs.filter((t) => t.id != null);
    log(
      "ensureServiceTab: tabs found:",
      tabs.length,
      "| with id:",
      candidates.length,
      "|",
      candidates.map((t) => t.id + ":" + (t.url || "?")).join(", "),
    );
    if (!candidates.length) {
      logErr("ensureServiceTab: no open", svc.name, "tab found");
      throw userError(
        "no_service_tab",
        "No open " + svc.name + " tab found. Open " + svc.name + " and log in.",
        { service: svc.name },
      );
    }

    for (const tab of candidates) {
      try {
        await browser.tabs.sendMessage(tab.id, { type: "watcharr:ping" });
        log("ensureServiceTab: Content Script running in tab", tab.id);
        return tab.id;
      } catch (e) {
        // No Content Script in this tab -> try next tab.
      }
    }

    // No tab with running Content Script: inject afterwards.
    const www =
      candidates.find((t) =>
        svc.urlTest.test(WatcharrServices.host(t.url || "")),
      ) || candidates[0];
    log(
      "ensureServiceTab: injecting Content Script in tab",
      www.id,
      www.url || "",
    );
    try {
      await browser.scripting.executeScript({
        target: { tabId: www.id },
        files: svc.contentScripts,
      });
    } catch (e) {
      logErr("ensureServiceTab: Injection failed:", e.message);
      throw userError(
        "service_tab_prepare",
        svc.name +
          " tab could not be prepared. Please reload the " +
          svc.name +
          " page and try again. (" +
          (e.message || String(e)) +
          ")",
        { service: svc.name, reason: e.message || String(e) },
      );
    }
    // Wait briefly so that injected scripts (and, for Netflix, the probe in
    // the MAIN world) have initialised.
    await new Promise((r) => setTimeout(r, 800));
    return www.id;
  }

  /** Fetches a single page of the service history through the Content Script. */
  async function historyPage(pageIndex) {
    const tabId = await ensureServiceTab();
    log(
      "historyPage: fetching",
      serviceId,
      "page",
      pageIndex,
      "from tab",
      tabId,
    );
    const resp = await browser.tabs.sendMessage(tabId, {
      type: "watcharr:fetchHistoryPage",
      page: pageIndex,
      loadId: historyLoadId,
    });
    if (!resp || resp.status !== "ok") {
      // A real reason from the service/content script (e.g. "please log in")
      // is surfaced through the translated generic wrapper in the UI; the
      // generic code is only used when there is genuinely no reply.
      const reason = (resp && resp.error) || "";
      if (reason) throw new Error(reason);
      throw userError(
        "no_service_response",
        "No response from the service tab received.",
      );
    }
    const entries = resp.entries || [];
    log(
      "historyPage: page",
      pageIndex,
      "->",
      entries.length,
      "entries, done:",
      !!resp.done,
    );
    return { entries, done: !!resp.done };
  }

  /**
   * Normalizes a watched date coming from the content script to an ISO-8601
   * string. Never assume a `Date` instance survives the message channel:
   * depending on the browser (Firefox vs Chrome) it may already be a string
   * or a number – so we never call `.toISOString()` on the raw value.
   */
  function toIsoDateString(v) {
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    const d = new Date(v); // ISO-8601 string or numeric ms
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Returns an ISO-8601 string that is `minutes` before the given ISO-8601
   * string (or null if no usable date is given).
   */
  function subtractMinutes(iso, minutes) {
    if (iso == null) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() - minutes * 60000).toISOString();
  }

  /** Builds a separate list entry from a Netflix view (no grouping). */
  function entryToItem(entry) {
    return {
      key: "h" + seq++,
      isTv: !!entry.isTv,
      title: entry.title,
      year: entry.year || null,
      date: toIsoDateString(entry.date),
      season: entry.isTv ? (entry.season != null ? entry.season : null) : null,
      episode: entry.isTv
        ? entry.episode != null
          ? entry.episode
          : null
        : null,
      match: null,
      matchError: null,
      matchErrorCode: null,
      // Status of the specific episode in Watcharr (null | "FINISHED" | "WATCHING" | ...)
      episodeStatus: null,
      // false = unknown (fetch failed / no episode info)
      episodeStatusKnown: false,
      // True only when Watcharr records this exact episode as FINISHED at the
      // same date+time as this Netflix row (activity customDate = watchedDate).
      episodeDateMatched: false,
      selected: false,
      status: "pending",
      error: null,
      errorCode: null,
      resolved: false,
    };
  }

  async function searchWatcharr(title, year) {
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token)
      throw userError("not_configured", "Watcharr is not configured.");
    const c = new WatcharrClient(s);
    const query = year ? title + " year:" + year : title;
    const data = await c.search(query, "multi");
    return (data && data.results) || [];
  }

  function pickBest(results, title, isTv) {
    const wantType = isTv ? "tmdb_tv" : "tmdb_movie";
    let pool = results.filter((r) => r.type === wantType);
    if (!pool.length) pool = results.slice();
    const norm = (s) => (s || "").toLowerCase().trim();
    // exact title match first
    for (const r of pool) if (norm(r.name) === norm(title)) return r;
    return pool[0] || null;
  }

  function resultToMatch(result) {
    if (!result || !result.ids) return null;
    // IDs can come as string depending on Watcharr version – convert safely to number.
    const tmdbId = Number(result.ids.tmdb);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    return {
      tmdbId,
      contentType: result.type === "tmdb_movie" ? "movie" : "tv",
      name: result.name || null,
      posterPath: result.extPosterPath || result.poster_path || null,
      year: result.releaseDate
        ? String(result.releaseDate).slice(0, 4)
        : result.year
          ? String(result.year)
          : null,
      watchedId: (result.watched && result.watched.id) || null,
      watchedStatus: (result.watched && result.watched.status) || null,
    };
  }

  /** "season:episode" lookup key for per-episode maps. */
  function epKey(season, episode) {
    return Number(season) + ":" + Number(episode);
  }

  /** Whole seconds of an ISO date (tolerates server-side ms truncation). */
  function toEpochSeconds(iso) {
    if (iso == null) return null;
    const t = new Date(iso).getTime();
    return isNaN(t) ? null : Math.floor(t / 1000);
  }

  /**
   * Episode status cache per TMDB ID: Many history lines belong to the same
   * series, so each series is queried only once. The value is a Promise
   * for { ok, episodes, finishedByEp } – so parallel resolutions share the
   * same request.
   */
  const watchedEpisodesCache = new Map();

  async function getWatchedEpisodes(tmdbId) {
    if (watchedEpisodesCache.has(tmdbId))
      return watchedEpisodesCache.get(tmdbId);
    const p = (async () => {
      const s = await getSettings();
      const c = new WatcharrClient(s);
      const data = await c.getWatchedShow(tmdbId);
      const w = data && data.watched;
      const raw =
        w && Array.isArray(w.watchedEpisodes) ? w.watchedEpisodes : [];
      const episodes = raw.map((e) => ({
        seasonNumber: Number(e.seasonNumber),
        episodeNumber: Number(e.episodeNumber),
        status: e.status || "FINISHED",
      }));
      // Exact watch events per episode: FINISHED activities (EPISODE_ADDED /
      // EPISODE_STATUS_CHANGED) whose data.status is FINISHED and whose
      // customDate is set (= the watchedDate we passed to the API). This is
      // the exact Netflix date+time the episode was recorded as finished.
      const finishedByEp = new Map(); // epKey -> Set<epoch seconds>
      const acts = w && Array.isArray(w.activity) ? w.activity : [];
      for (const a of acts) {
        if (
          !a ||
          (a.type !== "EPISODE_ADDED" && a.type !== "EPISODE_STATUS_CHANGED")
        ) {
          continue;
        }
        if (!a.customDate) continue; // only exact-dated events count
        let d = null;
        try {
          d = JSON.parse(a.data || "");
        } catch (_) {
          continue;
        }
        if (!d || d.status !== "FINISHED") continue;
        if (d.season == null || d.episode == null) continue;
        const sec = toEpochSeconds(a.customDate);
        if (sec == null) continue;
        const key = epKey(d.season, d.episode);
        if (!finishedByEp.has(key)) finishedByEp.set(key, new Set());
        finishedByEp.get(key).add(sec);
      }
      return { ok: true, episodes, finishedByEp };
    })().catch((err) => {
      logErr("getWatchedEpisodes: Error for tmdbId", tmdbId, "->", err.message);
      return {
        ok: false,
        episodes: [],
        finishedByEp: new Map(),
        error: err.message,
      };
    });
    watchedEpisodesCache.set(tmdbId, p);
    return p;
  }

  /**
   * Determines whether the specific episode (it.season / it.episode) of the
   * matched series is already recorded in Watcharr at THIS exact Netflix
   * date+time. Sets:
   *  - it.episodeStatus: current status of the episode (or null),
   *  - it.episodeDateMatched: true when a FINISHED activity (EPISODE_ADDED /
   *    EPISODE_STATUS_CHANGED, data.status = FINISHED) has a customDate equal
   *    to the row's date+time (customDate = watchedDate when it was passed),
   *  - it.episodeStatusKnown (false = unknown).
   */
  async function resolveItemEpisodeStatus(it) {
    it.episodeStatus = null;
    it.episodeDateMatched = false;
    it.episodeStatusKnown = false;
    if (!(
      it.isTv &&
      it.match &&
      it.match.watchedId &&
      it.season != null &&
      it.episode != null
    )) {
      return;
    }
    const res = await getWatchedEpisodes(it.match.tmdbId);
    if (!res.ok) return; // unknown -> UI shows fallback
    const ep = res.episodes.find(
      (e) => e.seasonNumber === it.season && e.episodeNumber === it.episode,
    );
    it.episodeStatus = ep ? ep.status : null; // null = episode not yet watched
    const rowSec = toEpochSeconds(it.date);
    const set = res.finishedByEp.get(epKey(it.season, it.episode));
    it.episodeDateMatched = !!(rowSec != null && set && set.has(rowSec));
    it.episodeStatusKnown = true;
  }

  function serializeItem(it) {
    return {
      key: it.key,
      isTv: it.isTv,
      title: it.title,
      year: it.year,
      date: it.date,
      season: it.season,
      episode: it.episode,
      match: it.match,
      matchError: it.matchError,
      matchErrorCode: it.matchErrorCode || null,
      episodeStatus: it.episodeStatus,
      episodeStatusKnown: it.episodeStatusKnown,
      episodeDateMatched: it.episodeDateMatched,
      selected: it.selected,
      status: it.status,
      error: it.error,
      errorCode: it.errorCode || null,
    };
  }

  /**
   * Starts a fresh history load: loads the FIRST BATCH_SIZE entries
   * from the selected service, resolves their matches and returns them
   * immediately. Further entries come later via `more()` when scrolling.
   */
  async function load() {
    log("load: starting history load for", serviceId);
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token) {
      logErr(
        "load: Watcharr not configured (url:",
        !!s.watcharrUrl,
        "| token:",
        !!s.token,
        ")",
      );
      throw userError(
        "not_configured",
        "Watcharr is not configured. Please log in through settings first.",
      );
    }
    // Reset state (clear episode cache so a "reload"
    // provides fresh Watcharr status, e.g., after imports).
    items = [];
    itemMap.clear();
    page = 0;
    total = 0;
    done = false;
    loading = false;
    loadError = null;
    seq = 0;
    delivered = 0;
    cancelRequested = false;
    watchedEpisodesCache.clear();
    // New load -> new loadId so paged content scripts (Amazon Prime Video)
    // know that a fresh history starts and reset their internal buffer.
    historyLoadId++;

    const res = oldestFirst
      ? await loadEntireHistory()
      : await fetchMore(BATCH_SIZE);
    log("load: first page loaded, total", res.total, "done", res.done);
    return {
      items: res.items,
      total: res.total,
      done: res.done,
      cancelled: !!res.cancelled,
    };
  }

  /** Loads the next BATCH from the service, resolves the matches, returns it. */
  async function fetchMore(limit) {
    if (loading || done) return { items: [], total, done };
    loading = true;
    loadError = null;
    loadErrorCode = null;
    log("fetchMore: loading", serviceId, "page", page);
    try {
      const { entries, done: d } = await historyPage(page);
      if (d) {
        done = true;
        log("fetchMore: last page reached, total", total, "entries");
        return { items: [], total, done };
      }
      const newItems = entries.slice(0, limit).map(entryToItem);
      log("fetchMore: resolving matches for", newItems.length, "entries …");
      await Promise.all(newItems.map((it) => resolveItem(it)));
      items.push(...newItems);
      for (const it of newItems) itemMap.set(it.key, it);
      total = items.length;
      page++;
      log("fetchMore: +" + newItems.length + " entries (total " + total + ")");
      return { items: newItems.map(serializeItem), total, done };
    } finally {
      loading = false;
    }
  }

  /**
   * Oldest-first mode: loads the COMPLETE history of the selected service
   * (every page), then hands it to the UI starting with the oldest entry.
   * Metadata enrichment happens per page in the Content Script; the Watcharr
   * match lookup is done lazily per delivered chunk (same amount of requests
   * as in the normal incremental mode – just when the rows are actually shown).
   */
  async function loadEntireHistory() {
    if (loading) return { items: [], total, done };
    loading = true;
    loadError = null;
    try {
      log("loadEntireHistory: loading complete", serviceId, "history …");
      let pages = 0;
      while (!done && pages < MAX_HISTORY_PAGES && !cancelRequested) {
        const { entries, done: d } = await historyPage(page);
        if (cancelRequested) break; // user aborted while the page was fetched
        if (d || !entries.length) {
          done = true;
          break;
        }
        for (const entry of entries) {
          const it = entryToItem(entry);
          items.push(it);
          itemMap.set(it.key, it);
        }
        page++;
        pages++;
      }
      if (cancelRequested) {
        log("loadEntireHistory: aborted by user");
        return { cancelled: true, items: [], total, done: false };
      }
      // Page 0 = newest entry, so `items` is newest -> oldest right now.
      // Flip it: items[0] = OLDEST entry -> the UI gets oldest first.
      items.reverse();
      total = items.length;
      log(
        "loadEntireHistory: complete history loaded (",
        total,
        "entries), serving oldest first",
      );
      return await deliverBatch();
    } finally {
      loading = false;
    }
  }

  /** Oldest-first: returns the next chunk of the loaded history (oldest first). */
  async function deliverBatch() {
    const chunk = items.slice(delivered, delivered + BATCH_SIZE);
    delivered += chunk.length;
    log(
      "deliverBatch: delivering",
      chunk.length,
      "entries (delivered",
      delivered,
      "/",
      total,
      ")",
    );
    await Promise.all(chunk.map((it) => resolveItem(it)));
    return {
      items: chunk.map(serializeItem),
      total,
      done: delivered >= items.length,
    };
  }

  /** Number of Netflix entries fetched so far (for the load-progress display). */
  function getLoadProgress() {
    return items.length;
  }

  /** For the history page: load next batch (inline errors instead of throw). */
  async function more() {
    try {
      if (oldestFirst) {
        if (loading)
          return {
            items: [],
            total,
            done: delivered >= items.length,
            error: loadError,
            errorCode: loadErrorCode,
          };
        if (delivered >= items.length)
          return {
            items: [],
            total,
            done: true,
            error: loadError,
            errorCode: loadErrorCode,
          };
        const res = await deliverBatch();
        return {
          items: res.items,
          total: res.total,
          done: res.done,
          error: loadError,
          errorCode: loadErrorCode,
        };
      }
      const res = await fetchMore(BATCH_SIZE);
      return {
        items: res.items,
        total: res.total,
        done: res.done,
        error: loadError,
        errorCode: loadErrorCode,
      };
    } catch (err) {
      logErr("more: Error:", err.message);
      loadError = err.message;
      loadErrorCode = (err && err.userCode) || null;
      return {
        items: [],
        total,
        done,
        error: err.message,
        errorCode: loadErrorCode,
      };
    }
  }

  /** Resolves an entry against Watcharr (TMDB search + episode status). */
  async function resolveItem(it) {
    if (it.resolved) return;
    try {
      const results = await searchWatcharr(it.title, it.year);
      it.match = resultToMatch(pickBest(results, it.title, it.isTv));
      it.matchError = it.match ? null : "no match in Watcharr";
      it.matchErrorCode = it.match ? null : "no_match";
      // Series: check if exactly THIS episode is already watched in Watcharr.
      await resolveItemEpisodeStatus(it);
    } catch (e) {
      it.matchError = e.message;
      it.matchErrorCode = (e && e.userCode) || null;
    }
    // On load, nothing is pre-selected – the user chooses
    // manually what to import (or uses "Select all").
    it.selected = false;
    it.resolved = true;
  }

  /** Returns already loaded entries (for compatibility). */
  async function getItems(offset, limit) {
    const slice = items.slice(offset, offset + limit);
    return { items: slice.map(serializeItem), total };
  }

  /** Override an item's match with a search result chosen by the user. */
  async function rematch(key, result) {
    const it = itemMap.get(key) || items.find((x) => x.key === key);
    if (!it) return null;
    if (it.key && !itemMap.has(it.key)) itemMap.set(it.key, it);
    it.match = resultToMatch(result);
    it.matchError = it.match ? null : "no match";
    it.matchErrorCode = it.match ? null : "no_match";
    // Determine episode status for the new match (display only).
    await resolveItemEpisodeStatus(it);
    // New match = new state: discard old import status so the
    // row becomes selectable again if the new match is not yet in Watcharr.
    it.status = "pending";
    it.error = null;
    it.errorCode = null;
    // Manually selected matches remain selected (as before).
    it.selected = !!it.match;
    return serializeItem(it);
  }

  async function importOne(c, it) {
    if (!it.match)
      return { status: "skipped", error: "no match", code: "no_match" };
    const { tmdbId, watchedId, watchedStatus } = it.match;
    const watchedDate = it.date || null;

    // ---- Series – single watched episode ----
    if (it.isTv) {
      // Does the series already exist in Watcharr? A matched/rematched row or
      // a series created earlier in this run already carries a watchedId.
      let wid = watchedId;
      if (!wid) {
        // No watchedId known – check explicitly whether the series is on the
        // watchlist before creating it (a duplicate would be an error).
        try {
          const show = await c.getWatchedShow(tmdbId);
          const existing = show && show.watched && Number(show.watched.id);
          if (existing) wid = existing;
        } catch (_) {
          // Check unavailable -> treat as new; creating a duplicate would
          // surface as an error from Watcharr.
        }
      }
      if (wid) {
        // Series already exists: only mark the specific episode as FINISHED.
        // The exact Netflix date is always passed along.
        if (it.season != null && it.episode != null) {
          try {
            await c.addWatchedEpisode(
              wid,
              it.season,
              it.episode,
              "FINISHED",
              watchedDate,
            );
            return { status: "updated", episodes: 1 };
          } catch (e) {
            return {
              status: "error",
              error: e.message,
              code: (e && e.userCode) || null,
            };
          }
        }
        return { status: "updated", episodes: 0 };
      }
      // Series does NOT exist yet (only /watched endpoints, never /import):
      // 1. add the series as WATCHING and pass the WATCHED date of the
      //    episode we are about to add MINUS 1 minute as its "date added" –
      //    so the series creation always precedes the episode being finished,
      // 2. as soon as it is WATCHING, mark exactly this episode as FINISHED,
      //    again passing the original watched date.
      try {
        const seriesDate = subtractMinutes(watchedDate, 1);
        const created = await c.addWatched(
          tmdbId,
          "tv",
          "WATCHING",
          seriesDate,
        );
        const newWid = created && Number(created.id);
        if (!newWid) {
          return {
            status: "error",
            error: "Create failed (no watchedId in response)",
            code: "create_failed",
          };
        }
        if (it.season != null && it.episode != null) {
          await c.addWatchedEpisode(
            newWid,
            it.season,
            it.episode,
            "FINISHED",
            watchedDate,
          );
        }
        return {
          status: "imported",
          watchedId: newWid,
          episodes: it.season != null && it.episode != null ? 1 : 0,
        };
      } catch (e) {
        return {
          status: "error",
          error: e.message,
          code: (e && e.userCode) || null,
        };
      }
    }

    // ---- Movie ----
    if (watchedId) {
      if (watchedStatus !== "FINISHED") {
        try {
          await c.updateWatched(watchedId, { status: "FINISHED" });
        } catch (e) {
          return {
            status: "error",
            error: e.message,
            code: (e && e.userCode) || null,
          };
        }
      }
      return { status: "updated" };
    }
    // New movie: create directly as FINISHED via /watched. The exact Netflix
    // date is passed as watchedDate (-> Watcharr sets "date added" to it).
    try {
      const created = await c.addWatched(
        tmdbId,
        "movie",
        "FINISHED",
        watchedDate,
      );
      const wid = created && Number(created.id);
      if (!wid) {
        return {
          status: "error",
          error: "Create failed (no watchedId in response)",
          code: "create_failed",
        };
      }
      return { status: "imported", watchedId: wid };
    } catch (e) {
      return {
        status: "error",
        error: e.message,
        code: (e && e.userCode) || null,
      };
    }
  }

  /**
   * Imports the selected titles into Watcharr.
   *
   * The selected entries are always sent to Watcharr ordered by their watch
   * date in ASCENDING order (oldest first) – INDEPENDENT of the order in
   * which the keys arrive and of the current display order (works the same
   * for "newest first" and "oldest first" views). That way a series that is
   * imported in this run is created in Watcharr with its oldest (original)
   * watch date. Entries without a usable date are sent last.
   */
  async function importItems(keys) {
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token)
      throw userError("not_configured", "Watcharr is not configured.");
    const c = new WatcharrClient(s);
    const results = [];

    // Resolve the selected items and sort them oldest -> newest.
    // Items without a usable date are sent last (order between them stays
    // as passed in).
    const ordered = [];
    for (const key of keys) {
      const it = itemMap.get(key) || items.find((x) => x.key === key);
      if (!it) continue;
      if (it.key && !itemMap.has(it.key)) itemMap.set(it.key, it);
      ordered.push(it);
    }
    ordered.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : Infinity;
      const db = b.date ? new Date(b.date).getTime() : Infinity;
      return da - db;
    });

    // When several episodes of a series that does NOT exist in Watcharr yet
    // are imported in one run, only the first one may create the series
    // (POST /watched). Every further episode of the SAME series must reuse the
    // newly created watched ID – otherwise the series would be added twice.
    const createdSeries = new Map(); // tmdbId -> watchedId (created in this run)

    for (const it of ordered) {
      // Episode of a series that was just created above -> mark the specific
      // episode on the existing watched entry (addWatchedEpisode) instead of
      // trying to add the series a second time.
      if (
        it.isTv &&
        it.match &&
        !it.match.watchedId &&
        createdSeries.has(it.match.tmdbId)
      ) {
        it.match.watchedId = createdSeries.get(it.match.tmdbId);
      }
      const r = await importOne(c, it);
      it.status = r.status;
      it.error = r.error || null;
      it.errorCode = r.code || null;
      if (r.watchedId && it.match) {
        it.match.watchedId = r.watchedId;
        if (it.isTv) createdSeries.set(it.match.tmdbId, r.watchedId);
      }
      results.push({
        key: it.key,
        title: it.title,
        status: r.status,
        error: r.error,
        code: r.code || null,
        episodes: r.episodes,
        watchedId: r.watchedId || null,
      });
    }
    return results;
  }

  return {
    load,
    more,
    getItems,
    rematch,
    importItems,
    setOldestFirst,
    setService,
    cancelHistoryLoad,
    getLoadProgress,
  };
})();
