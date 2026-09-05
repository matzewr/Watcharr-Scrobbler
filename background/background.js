/*
 * Watcharr Scrobbler – background script.
 *
 * Central place that stores the Watcharr connection (url + username + JWT token)
 * in `browser.storage.local` and routes messages from the content script,
 * the popup and the options page to the Watcharr API.
 */
"use strict";

const DEFAULT_SETTINGS = {
  watcharrUrl: "",
  username: "",
  token: "",
  plexClientId: "", // stable plex.tv OAuth client identifier
  enabled: true,
  threshold: 90, // % of a title watched before it counts as "finished"
  // "" = no explicit choice yet -> UIs resolve to the browser language.
  language: "",
};

async function getSettings() {
  const data = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveSettings(settings) {
  await browser.storage.local.set({ settings });
}

/** plex.tv OAuth flow in progress (pin awaiting authorization). */
let plexFlow = null;

/** Decode the `username`/`type` claims out of a Watcharr JWT (no validation). */
function decodeJwtClaims(token) {
  try {
    const b64 = String(token)
      .split(".")[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split("")
        .map((ch) => "%" + ("00" + ch.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
    return JSON.parse(json) || {};
  } catch (_) {
    return {};
  }
}

/** RFC 4122 v4 UUID with a fallback for contexts without crypto.randomUUID. */
function uuid() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Build a client from stored settings and run `fn`.
 * Catches errors and turns them into a friendly response so callers (content
 * script / popup) always get `{ ok, data?, error?, authRequired? }`.
 */
async function withClient(fn) {
  const s = await getSettings();
  if (!s.watcharrUrl || !s.token) {
    return {
      ok: false,
      error: "Watcharr is not configured.",
      authRequired: true,
    };
  }
  try {
    const data = await fn(new WatcharrClient(s));
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      authRequired: !!err.authRequired,
    };
  }
}

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case "watcharr:login": {
      const settings = await getSettings();
      settings.watcharrUrl = (msg.url || settings.watcharrUrl || "").trim();
      const client = new WatcharrClient(settings);
      const method = msg.method === "jellyfin" ? "jellyfin" : "";
      const token = await client.login(msg.username, msg.password, method);
      const claims = decodeJwtClaims(token);
      settings.username = claims.username || msg.username || "";
      settings.token = token;
      await saveSettings(settings);
      return { ok: true, username: settings.username };
    }

    // Which login methods has this server enabled? The UI shows only those
    // (plus the always-available Watcharr login).
    case "watcharr:auth:available": {
      const s = await getSettings();
      const url = (msg.url || s.watcharrUrl || "").trim();
      if (!url) return { ok: false, error: "Watcharr URL is not configured." };
      const data = await new WatcharrClient({
        watcharrUrl: url,
      }).getAvailableAuth();
      return {
        ok: true,
        available: Array.isArray(data.available) ? data.available : [],
        useEmby: !!data.useEmby,
      };
    }

    // Begin the Plex OAuth flow: create a plex.tv pin and return the popup URL.
    case "watcharr:plex:begin": {
      const s = await getSettings();
      s.watcharrUrl = (msg.url || s.watcharrUrl || "").trim();
      if (!s.watcharrUrl)
        return { ok: false, error: "Watcharr URL is not configured." };
      s.plexClientId = s.plexClientId || uuid();
      await saveSettings(s);
      const pin = await PlexTvAuth.createPin(s.plexClientId);
      plexFlow = { pinId: pin.id, pinCode: pin.code };
      return {
        ok: true,
        authUrl: PlexTvAuth.authUrl(s.plexClientId, pin.code),
        clientId: s.plexClientId,
      };
    }

    // Poll the plex.tv pin; `authToken` is set once the user approved it.
    case "watcharr:plex:poll": {
      if (!plexFlow) return { ok: false, error: "No active Plex login flow." };
      const s = await getSettings();
      const authToken = await PlexTvAuth.pollPin(
        s.plexClientId || "",
        plexFlow.pinId,
        plexFlow.pinCode,
      );
      if (authToken) {
        plexFlow = null; // consumed -> options finishes via watcharr:loginPlex
        return { ok: true, authToken };
      }
      return { ok: true, authToken: null };
    }

    // Finish Plex login: exchange the plex.tv token for a Watcharr JWT.
    case "watcharr:loginPlex": {
      const settings = await getSettings();
      settings.watcharrUrl = (msg.url || settings.watcharrUrl || "").trim();
      const client = new WatcharrClient(settings);
      const token = await client.loginPlex(
        msg.token,
        settings.plexClientId || "",
      );
      const claims = decodeJwtClaims(token);
      settings.username = claims.username || "";
      settings.token = token;
      await saveSettings(settings);
      plexFlow = null;
      return { ok: true, username: settings.username };
    }

    case "watcharr:getState": {
      const s = await getSettings();
      return {
        ok: true,
        settings: {
          watcharrUrl: s.watcharrUrl,
          username: s.username,
          enabled: s.enabled !== false,
          threshold: s.threshold || DEFAULT_SETTINGS.threshold,
          // "" = no explicit language -> caller falls back to browser language.
          language: s.language || "",
          configured: !!(s.watcharrUrl && s.token),
        },
      };
    }

    case "watcharr:saveSettings": {
      const s = await getSettings();
      const next = { ...s };
      if (msg.settings) {
        if (typeof msg.settings.enabled === "boolean")
          next.enabled = msg.settings.enabled;
        if (
          typeof msg.settings.threshold === "number" &&
          msg.settings.threshold > 0 &&
          msg.settings.threshold <= 100
        ) {
          next.threshold = msg.settings.threshold;
        }
        if (["en", "de", "fr"].includes(msg.settings.language)) {
          next.language = msg.settings.language;
        }
      }
      await saveSettings(next);
      return { ok: true };
    }

    case "watcharr:logout": {
      const s = await getSettings();
      s.token = "";
      s.username = "";
      await saveSettings(s);
      return { ok: true };
    }

    case "watcharr:search":
      return withClient((c) =>
        c.search(msg.query || "", msg.searchType || "multi"),
      );

    case "watcharr:addWatched":
      return withClient((c) =>
        c.addWatched(
          msg.tmdbId,
          msg.contentType,
          msg.status || "WATCHING",
          msg.watchedDate,
        ),
      );

    case "watcharr:updateWatched":
      return withClient((c) => c.updateWatched(msg.id, msg.patch || {}));

    case "watcharr:addEpisode":
      return withClient((c) =>
        c.addWatchedEpisode(
          msg.watchedId,
          msg.seasonNumber,
          msg.episodeNumber,
          msg.status || "FINISHED",
          msg.watchedDate,
        ),
      );

    case "watcharr:addSeason":
      return withClient((c) =>
        c.addWatchedSeason(
          msg.watchedId,
          msg.seasonNumber,
          msg.status || "FINISHED",
        ),
      );

    // -- History page (Comparison Service ↔ Watcharr) ---------------
    case "watcharr:history:load":
      try {
        WatcharrHistory.setService(msg.service);
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.load();
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          cancelled: !!data.cancelled,
        };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }

    case "watcharr:history:more":
      try {
        WatcharrHistory.setService(msg.service);
        WatcharrHistory.setOldestFirst(msg.oldestFirst === true);
        const data = await WatcharrHistory.more();
        return {
          ok: true,
          items: data.items,
          total: data.total,
          done: data.done,
          error: data.error || null,
        };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }

    case "watcharr:history:rematch":
      try {
        const item = await WatcharrHistory.rematch(msg.key, msg.result);
        return { ok: true, item };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }

    case "watcharr:history:import":
      try {
        const results = await WatcharrHistory.importItems(msg.keys || []);
        return { ok: true, results };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }

    case "watcharr:history:cancel":
      // Abort a running "oldest first" full-history load.
      WatcharrHistory.cancelHistoryLoad();
      return { ok: true };

    case "watcharr:history:progress":
      // Entries fetched so far while the "oldest first" full load is running.
      return { ok: true, loaded: WatcharrHistory.getLoadProgress() };

    // Amazon Prime Video history API calls. They are routed through the
    // background because the content script's own fetch is bound by the page's
    // CORS (the Amazon API hosts are cross-origin to primevideo.com and would
    // otherwise fail with "NetworkError"). The background fetch is not subject
    // to that CORS and – thanks to the <all_urls> host permission – sends the
    // user's Prime Video session cookies.
    case "watcharr:primevideo:api": {
      try {
        const resp = await fetch(msg.url || "", {
          method: "GET",
          credentials: "include",
          headers: { "x-requested-with": "XMLHttpRequest" },
        });
        if (!resp.ok) {
          return { ok: false, status: resp.status };
        }
        return { ok: true, text: await resp.text() };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }

    default:
      return { ok: false, error: "Unknown message type: " + (msg && msg.type) };
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error("[watcharr-scrobbler] background error:", err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true; // keep the message channel open for the async response
});
