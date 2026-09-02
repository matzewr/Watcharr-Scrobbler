/*
 * History Workspace (Background).
 *
 * Loads the Netflix history through the Content Script, builds a
 * comparison list "Netflix ↔ Watcharr" from it (with TMDB resolution via
 * Watcharr search), allows correcting individual matches, and imports
 * selected titles into Watcharr.
 *
 * Loaded as a classic script BEFORE background.js and provides the
 * global `WatcharrHistory` object (uses `WatcharrClient` from
 * watcharr-client.js).
 */
"use strict";

const WatcharrHistory = (() => {
  // Incremental loading: EVERY Netflix view is a separate
  // entry (NO grouping by series). BATCH_SIZE elements are always fetched
  // from Netflix, matched, and then displayed on the page.
  const BATCH_SIZE = 20;

  let items = []; // all entries loaded so far (1 Netflix view = 1 row)
  const itemMap = new Map(); // lookup for fast item.key -> item; important for larger histories
  let page = 0; // next Netflix page to load
  let total = 0; // number of entries loaded so far
  let done = false; // complete Netflix history loaded?
  let loading = false; // currently loading a batch?
  let loadError = null; // last error when loading
  let seq = 0; // sequential key for stable item keys

  function refreshItemMap() {
    itemMap.clear();
    for (const it of items) itemMap.set(it.key, it);
  }

  const log = (...a) => console.log("[watcharr-bg]", ...a);
  const logErr = (...a) => console.error("[watcharr-bg]", ...a);

  const normTitle = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

  async function getSettings() {
    const d = await browser.storage.local.get("settings");
    return d.settings || {};
  }

  /**
   * Finds a Netflix tab where the Content Script is running. If no
   * Content Script is reachable in any tab (e.g., because the tab was already open
   * when the extension was loaded), it is injected afterwards via
   * browser.scripting. Returns the tab ID or throws an error.
   */
  async function ensureNetflixTab() {
    log("ensureNetflixTab: searching for open Netflix tabs …");
    const tabs = await browser.tabs.query({ url: "*://*.netflix.com/*" });
    const candidates = tabs.filter((t) => t.id != null);
    log(
      "ensureNetflixTab: tabs found:",
      tabs.length,
      "| with id:",
      candidates.length,
      "|",
      candidates.map((t) => t.id + ":" + (t.url || "?")).join(", "),
    );
    if (!candidates.length) {
      logErr("ensureNetflixTab: no open Netflix tab found");
      throw new Error(
        "No open Netflix tab found. Open Netflix in Firefox and log in.",
      );
    }

    for (const tab of candidates) {
      try {
        await browser.tabs.sendMessage(tab.id, { type: "watcharr:ping" });
        log("ensureNetflixTab: Content Script running in tab", tab.id);
        return tab.id;
      } catch (e) {
        // No Content Script in this tab -> try next tab.
      }
    }

    // No tab with running Content Script: inject afterwards.
    const www =
      candidates.find((t) =>
        /^https?:\/\/([^/]*\.)?netflix\.com\//.test(t.url || ""),
      ) || candidates[0];
    log(
      "ensureNetflixTab: injecting Content Script in tab",
      www.id,
      www.url || "",
    );
    try {
      await browser.scripting.executeScript({
        target: { tabId: www.id },
        files: [
          "content/netflix/netflix-inject.js",
          "content/netflix/netflix-content.js",
        ],
      });
    } catch (e) {
      logErr("ensureNetflixTab: Injection failed:", e.message);
      throw new Error(
        "Netflix tab could not be prepared. Please reload the Netflix page and try again. (" +
          (e.message || String(e)) +
          ")",
      );
    }
    // Wait briefly until the probe in the MAIN world has been initialised.
    await new Promise((r) => setTimeout(r, 800));
    return www.id;
  }

  /** Fetches a single page of the Netflix history through the Content Script. */
  async function netflixPage(pageIndex) {
    const tabId = await ensureNetflixTab();
    log("netflixPage: fetching Netflix page", pageIndex, "from tab", tabId);
    const resp = await browser.tabs.sendMessage(tabId, {
      type: "watcharr:fetchHistoryPage",
      page: pageIndex,
    });
    if (!resp || resp.status !== "ok") {
      throw new Error(
        (resp && resp.error) || "No response from Netflix tab received.",
      );
    }
    const entries = resp.entries || [];
    log(
      "netflixPage: page",
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
      // Status of the specific episode in Watcharr (null | "FINISHED" | "WATCHING" | ...)
      episodeStatus: null,
      // false = unknown (fetch failed / no episode info)
      episodeStatusKnown: false,
      selected: false,
      status: "pending",
      error: null,
      resolved: false,
    };
  }

  async function searchWatcharr(title, year) {
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token)
      throw new Error("Watcharr ist nicht konfiguriert.");
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

  /**
   * Episode status cache per TMDB ID: Many history lines belong to the same
   * series, so each series is queried only once. The value is a Promise
   * for { ok, episodes } – so parallel resolutions share the same request.
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
      return {
        ok: true,
        episodes: raw.map((e) => ({
          seasonNumber: Number(e.seasonNumber),
          episodeNumber: Number(e.episodeNumber),
          status: e.status || "FINISHED",
        })),
      };
    })().catch((err) => {
      logErr("getWatchedEpisodes: Error for tmdbId", tmdbId, "->", err.message);
      return { ok: false, episodes: [], error: err.message };
    });
    watchedEpisodesCache.set(tmdbId, p);
    return p;
  }

  /**
   * Determines whether the specific episode (it.season / it.episode) of the matched series
   * is marked as watched in Watcharr. Sets it.episodeStatus (status or
   * null) and it.episodeStatusKnown (false = unknown).
   */
  async function resolveItemEpisodeStatus(it) {
    it.episodeStatus = null;
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
      episodeStatus: it.episodeStatus,
      episodeStatusKnown: it.episodeStatusKnown,
      selected: it.selected,
      status: it.status,
      error: it.error,
    };
  }

  /**
   * Starts a fresh history load: loads the FIRST BATCH_SIZE entries
   * from Netflix, resolves their matches and returns them immediately.
   * Further entries come later via `more()` when scrolling.
   */
  async function load() {
    log("load: starting history load");
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token) {
      logErr(
        "load: Watcharr not configured (url:",
        !!s.watcharrUrl,
        "| token:",
        !!s.token,
        ")",
      );
      throw new Error(
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
    watchedEpisodesCache.clear();

    const res = await fetchMore(BATCH_SIZE);
    log("load: first page loaded, total", res.total, "done", res.done);
    return { items: res.items, total: res.total, done: res.done };
  }

  /** Loads the next BATCH from Netflix, resolves the matches, returns it. */
  async function fetchMore(limit) {
    if (loading || done) return { items: [], total, done };
    loading = true;
    loadError = null;
    log("fetchMore: loading Netflix page", page);
    try {
      const { entries, done: d } = await netflixPage(page);
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

  /** For the history page: load next batch (inline errors instead of throw). */
  async function more() {
    try {
      const res = await fetchMore(BATCH_SIZE);
      return {
        items: res.items,
        total: res.total,
        done: res.done,
        error: loadError,
      };
    } catch (err) {
      logErr("more: Error:", err.message);
      loadError = err.message;
      return { items: [], total, done, error: err.message };
    }
  }

  /** Resolves an entry against Watcharr (TMDB search + episode status). */
  async function resolveItem(it) {
    if (it.resolved) return;
    try {
      const results = await searchWatcharr(it.title, it.year);
      it.match = resultToMatch(pickBest(results, it.title, it.isTv));
      it.matchError = it.match ? null : "no match in Watcharr";
      // Series: check if exactly THIS episode is already watched in Watcharr.
      await resolveItemEpisodeStatus(it);
    } catch (e) {
      it.matchError = e.message;
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
    // Determine episode status for the new match (display only).
    await resolveItemEpisodeStatus(it);
    // New match = new state: discard old import status so the
    // row becomes selectable again if the new match is not yet in Watcharr.
    it.status = "pending";
    it.error = null;
    // Manually selected matches remain selected (as before).
    it.selected = !!it.match;
    return serializeItem(it);
  }

  async function importOne(c, it) {
    if (!it.match) return { status: "skipped", error: "no match" };
    const { tmdbId, watchedId, watchedStatus } = it.match;
    const watchedDate = it.date || null;

    // ---- Series – single watched episode ----
    if (it.isTv) {
      // Series already exists: just mark the episode. The exact date
      // is sent as addActivityDate – Watcharr with the
      // "addActivityDate" PR will use it; older versions ignore it.
      if (watchedId) {
        if (it.season != null && it.episode != null) {
          try {
            await c.addWatchedEpisode(
              watchedId,
              it.season,
              it.episode,
              "FINISHED",
              watchedDate,
            );
            return { status: "updated", episodes: 1 };
          } catch (e) {
            return { status: "error", error: e.message };
          }
        }
        return { status: "updated", episodes: 0 };
      }
      // New series: create via import endpoint -> "date added" = watchedDate,
      // the episode gets its exact date.
      try {
        const resp = await c.importMedia({
          tmdbId,
          type: "tv",
          status: "WATCHING",
          datesWatched: watchedDate ? [watchedDate] : [],
          watchedEpisodes:
            it.season != null && it.episode != null
              ? [
                  {
                    seasonNumber: it.season,
                    episodeNumber: it.episode,
                    status: "FINISHED",
                    createdAt: watchedDate,
                  },
                ]
              : [],
        });
        if (resp && resp.type === "IMPORT_SUCCESS") {
          const wid = resp.watchedEntry && Number(resp.watchedEntry.id);
          return {
            status: "imported",
            watchedId: wid || null,
            episodes: it.season != null && it.episode != null ? 1 : 0,
          };
        }
        if (resp && resp.type === "IMPORT_EXISTS") {
          return { status: "exists", error: "already in Watcharr" };
        }
        return {
          status: "error",
          error: "Import failed (" + (resp && resp.type) + ")",
        };
      } catch (e) {
        return { status: "error", error: e.message };
      }
    }

    // ---- Movie ----
    if (watchedId) {
      if (watchedStatus !== "FINISHED") {
        try {
          await c.updateWatched(watchedId, { status: "FINISHED" });
        } catch (e) {
          return { status: "error", error: e.message };
        }
      }
      return { status: "updated" };
    }
    // New movie: via import endpoint -> "date added" = watchedDate,
    // "date watched" (datesWatched) = exact date.
    try {
      const resp = await c.importMedia({
        tmdbId,
        type: "movie",
        status: "FINISHED",
        datesWatched: watchedDate ? [watchedDate] : [],
      });
      if (resp && resp.type === "IMPORT_SUCCESS") {
        const wid = resp.watchedEntry && Number(resp.watchedEntry.id);
        return { status: "imported", watchedId: wid || null };
      }
      if (resp && resp.type === "IMPORT_EXISTS") {
        return { status: "exists", error: "already in Watcharr" };
      }
      return {
        status: "error",
        error: "Import failed (" + (resp && resp.type) + ")",
      };
    } catch (e) {
      return { status: "error", error: e.message };
    }
  }

  /** Imports the selected titles into Watcharr. */
  async function importItems(keys) {
    const s = await getSettings();
    if (!s.watcharrUrl || !s.token)
      throw new Error("Watcharr is not configured.");
    const c = new WatcharrClient(s);
    const results = [];
    for (const key of keys) {
      const it = itemMap.get(key) || items.find((x) => x.key === key);
      if (!it) continue;
      if (it.key && !itemMap.has(it.key)) itemMap.set(it.key, it);
      const r = await importOne(c, it);
      it.status = r.status;
      it.error = r.error || null;
      if (r.watchedId && it.match) it.match.watchedId = r.watchedId;
      results.push({
        key,
        title: it.title,
        status: r.status,
        error: r.error,
        episodes: r.episodes,
        watchedId: r.watchedId || null,
      });
    }
    return results;
  }

  return { load, more, getItems, rematch, importItems };
})();
