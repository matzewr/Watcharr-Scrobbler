/*
 * Watcharr API client.
 *
 * Talks to the user's self-hosted Watcharr instance. The token is sent as a
 * raw JWT in the `Authorization` header (Watcharr does NOT expect a "Bearer "
 * prefix).
 *
 * Base URL example: https://watcharr.example.com  (the /api prefix is added here)
 */
"use strict";

class WatcharrClient {
  constructor(settings) {
    this.url = (settings.watcharrUrl || "").replace(/\/+$/, "");
    this.token = settings.token || "";
  }

  get configured() {
    return !!(this.url && this.token);
  }

  async _request(method, path, body) {
    if (!this.url) throw new Error("Watcharr URL is not configured.");
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = this.token;

    let resp;
    try {
      resp = await fetch(this.url + "/api" + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
      });
    } catch (err) {
      throw new Error("Connection to Watcharr failed: " + err.message);
    }

    if (resp.status === 401 || resp.status === 403) {
      const e = new Error("Authentication failed – please log in again.");
      e.authRequired = true;
      throw e;
    }

    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (_) {
        /* no json body */
      }
      throw new Error(msg);
    }

    if (resp.status === 204) return null;
    return resp.json();
  }

  /**
   * Which login providers the server has enabled.
   * GET /auth/available -> { available: ["jellyfin"|"plex"], useEmby, ... }
   */
  getAvailableAuth() {
    return this._request("GET", "/auth/available");
  }

  /**
   * Log in with Watcharr (default) or Jellyfin credentials and return the
   * Watcharr JWT token.
   * `method` is "" (Watcharr) or "jellyfin". Jellyfin must be enabled on the
   * server (JELLYFIN_HOST) – Watcharr validates the credentials against it.
   */
  async login(username, password, method) {
    if (!this.url) throw new Error("Watcharr URL is not configured.");
    const path = method === "jellyfin" ? "/auth/jellyfin" : "/auth/";
    let resp;
    try {
      resp = await fetch(this.url + "/api" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "omit",
      });
    } catch (err) {
      throw new Error("Connection to Watcharr failed: " + err.message);
    }
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (_) {
        /* no json body */
      }
      throw new Error("Login failed: " + msg);
    }
    const data = await resp.json();
    if (!data || !data.token)
      throw new Error("Login failed: no token in response.");
    return data.token;
  }

  /**
   * Finish a Plex OAuth login: send the plex.tv auth token + client
   * identifier to Watcharr, which verifies access and returns the JWT token.
   */
  async loginPlex(authToken, clientIdentifier) {
    if (!this.url) throw new Error("Watcharr URL is not configured.");
    let resp;
    try {
      resp = await fetch(this.url + "/api/auth/plex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: authToken, clientIdentifier }),
        credentials: "omit",
      });
    } catch (err) {
      throw new Error("Connection to Watcharr failed: " + err.message);
    }
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (_) {
        /* no json body */
      }
      throw new Error("Login failed: " + msg);
    }
    const data = await resp.json();
    if (!data || !data.token)
      throw new Error("Login failed: no token in response.");
    return data.token;
  }

  /** Master search (TMDB multi search). Returns the raw search response. */
  search(query, type = "multi") {
    const params = new URLSearchParams({ query, type });
    return this._request("GET", "/search?" + params.toString());
  }

  /** Add a movie/tv show to the watched list. */
  addWatched(tmdbId, contentType, status, watchedDate) {
    const body = {
      contentType, // "movie" | "tv"
      // Watcharr expects an integer. Depending on the version, search
      // can return the TMDB ID as a string – otherwise the server returns HTTP 400.
      tmdbId: Number(tmdbId),
      status, // "PLANNED" | "WATCHING" | "FINISHED" | ...
    };
    if (watchedDate) body.watchedDate = watchedDate;
    return this._request("POST", "/watched", body);
  }

  /** Update a watched entry (status, rating, thoughts, pinned). */
  updateWatched(id, patch) {
    return this._request("PUT", "/watched/" + Number(id), patch);
  }

  /** Mark a specific episode as watched (auto-updates the show status on Watcharr). */
  addWatchedEpisode(
    watchedId,
    seasonNumber,
    episodeNumber,
    status,
    watchedDate,
  ) {
    const body = {
      watchedId: Number(watchedId),
      seasonNumber: Number(seasonNumber),
      episodeNumber: Number(episodeNumber),
      status,
    };
    // Exact watch date (RFC3339). Watcharr with the "addActivityDate"
    // PR will use it; older versions simply ignore this
    // field (Gin: unknown JSON fields are discarded).
    if (watchedDate) body.addActivityDate = watchedDate;
    return this._request("POST", "/watched/episode", body);
  }

  /** Mark a whole season as watched. */
  addWatchedSeason(watchedId, seasonNumber, status) {
    return this._request("POST", "/watched/season", {
      watchedId: Number(watchedId),
      seasonNumber: Number(seasonNumber),
      status,
    });
  }

  /**
   * Fetches the TV detail page including the `watched` entry with all watched
   * episodes (`watched.watchedEpisodes`). This is the only Watcharr API that
   * provides episode-level granularity (search / /watched list only have
   * `watchingSeason`, i.e., the *last* watched episode).
   */
  getWatchedShow(tmdbId) {
    return this._request("GET", "/content/tv/" + Number(tmdbId));
  }

  /**
   * Import with exact data (POST /api/import).
   * Watcharr sets the "date added" (CreatedAt/UpdatedAt) to watchedDate
   * for `datesWatched` and creates episodes with exact date (createdAt).
   * Returns the raw ImportResponse: { type, watchedEntry }.
   */
  async importMedia({ tmdbId, type, status, datesWatched, watchedEpisodes }) {
    const body = {
      tmdbId: Number(tmdbId),
      type, // "movie" | "tv"
      status,
    };
    if (Array.isArray(datesWatched) && datesWatched.length) {
      body.datesWatched = datesWatched;
    }
    if (Array.isArray(watchedEpisodes) && watchedEpisodes.length) {
      body.watchedEpisodes = watchedEpisodes.map((e) => ({
        seasonNumber: Number(e.seasonNumber),
        episodeNumber: Number(e.episodeNumber),
        status: e.status || "FINISHED",
        ...(e.createdAt ? { createdAt: e.createdAt } : {}),
      }));
    }
    return this._request("POST", "/import", body);
  }
}

/**
 * Minimal client for plex.tv's pin-based OAuth flow (v2 API).
 * Mirrors the flow Watcharr's own web UI uses (src/lib/util/plex.ts).
 */
const PlexTvAuth = {
  baseHeaders(clientId) {
    return {
      Accept: "application/json",
      "X-Plex-Product": "Watcharr Scrobbler",
      "X-Plex-Client-Identifier": clientId,
      "X-Plex-Version": "1.0.0",
      "X-Plex-Model": "Plex OAuth",
      "X-Plex-Platform": "Firefox",
      "X-Plex-Platform-Version": "Plex OAuth",
      "X-Plex-Device": "Firefox",
      "X-Plex-Device-Name": "Watcharr Scrobbler",
    };
  },

  /** Create a (strong) pin and return { id, code }. */
  async createPin(clientId) {
    let resp;
    try {
      resp = await fetch("https://plex.tv/api/v2/pins?strong=true", {
        method: "POST",
        headers: this.baseHeaders(clientId),
        credentials: "omit",
      });
    } catch (err) {
      throw new Error("Connection to plex.tv failed: " + err.message);
    }
    if (!resp.ok) {
      throw new Error("plex.tv pin request failed (HTTP " + resp.status + ").");
    }
    const data = await resp.json();
    if (!data || !data.id || !data.code)
      throw new Error("plex.tv returned an invalid pin.");
    return { id: data.id, code: data.code };
  },

  /**
   * Poll a pin. Returns the auth token once the user has approved the login
   * in the popup, or null while it is still pending.
   */
  async pollPin(clientId, pinId, pinCode) {
    let resp;
    try {
      resp = await fetch("https://plex.tv/api/v2/pins/" + pinId, {
        method: "GET",
        headers: { ...this.baseHeaders(clientId), code: pinCode },
        credentials: "omit",
      });
    } catch (err) {
      throw new Error("Connection to plex.tv failed: " + err.message);
    }
    if (!resp.ok) {
      throw new Error("plex.tv pin poll failed (HTTP " + resp.status + ").");
    }
    const data = await resp.json();
    return (data && data.authToken) || null;
  },

  /** URL for the plex.tv popup where the user logs in and grants access. */
  authUrl(clientId, pinCode) {
    return (
      "https://app.plex.tv/auth/#!?" +
      "clientID=" +
      clientId +
      "&code=" +
      pinCode +
      "&context=Watcharr" +
      "&context[device][device]=" +
      encodeURIComponent("Firefox") +
      "&context[device][deviceName]=" +
      encodeURIComponent("Watcharr Scrobbler") +
      "&context[device][platform]=" +
      encodeURIComponent("Firefox") +
      "&context[device][platformVersion]=" +
      "&context[device][product]=" +
      encodeURIComponent("Watcharr Scrobbler")
    );
  },
};
