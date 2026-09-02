/*
 * Watcharr Scrobbler – Popup.
 * Shows connection status and the currently scrobbled item.
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

const els = {
  connStatus: $("#connStatus"),
  nowPlaying: $("#nowPlaying"),
  npType: $("#npType"),
  npTitle: $("#npTitle"),
  npEpisode: $("#npEpisode"),
  npBar: $("#npBar"),
  npProgress: $("#npProgress"),
  npStatus: $("#npStatus"),
  noNetflix: $("#noNetflix"),
  notConfigured: $("#notConfigured"),
  enabled: $("#enabled"),
  enabledLabel: $("#enabledLabel"),
  optionsBtn: $("#optionsBtn"),
  foot: $("#foot"),
  historyBtn: $("#historyBtn"),
};

async function t(key, params = {}) {
  return I18NApi.translate(key, currentLanguage, params);
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "–";
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function setStatusClass(el, cls) {
  el.classList.remove("ok", "pending");
  if (cls) el.classList.add(cls);
}

async function applyLanguage(lang) {
  currentLanguage = I18NApi.resolveLanguage(lang);
  await I18NApi.applyTranslations(currentLanguage, document);
  document.documentElement.lang = currentLanguage;
}

async function refresh() {
  const stateResp = await browser.runtime.sendMessage({
    type: "watcharr:getState",
  });
  const s = stateResp && stateResp.ok ? stateResp.settings : null;
  if (!s) return;

  const lang = I18NApi.resolveLanguage(s.language || "");
  await applyLanguage(lang);

  if (s.configured) {
    els.connStatus.textContent = await t("popup.connected", {
      username: s.username || "Watcharr",
    });
  } else {
    els.connStatus.textContent = await t("popup.notConfigured");
  }

  els.enabled.checked = s.enabled !== false;
  els.enabledLabel.textContent =
    s.enabled !== false
      ? await t("popup.scrobblingActive")
      : await t("popup.scrobblingPaused");
  setStatusClass(els.enabledLabel, s.enabled !== false ? "ok" : "pending");

  if (!s.configured) {
    els.nowPlaying.classList.add("hidden");
    els.noNetflix.classList.add("hidden");
    els.notConfigured.classList.remove("hidden");
    els.foot.textContent = await t("toolbar.openSettings");
    return;
  }

  const tab = (
    await browser.tabs.query({ active: true, currentWindow: true })
  )[0];
  let item = null;
  if (tab && tab.url && /netflix\.com/.test(tab.url)) {
    try {
      item = await browser.tabs.sendMessage(tab.id, {
        type: "watcharr:getCurrentItem",
      });
    } catch (_) {
      item = null;
    }
  }

  els.notConfigured.classList.add("hidden");

  if (item && item.videoId) {
    els.nowPlaying.classList.remove("hidden");
    els.noNetflix.classList.add("hidden");

    els.npTitle.textContent = item.title || (await t("popup.unknownTitle"));
    els.npType.textContent =
      item.type === "movie"
        ? await t("popup.typeMovie")
        : item.type === "tv"
          ? await t("popup.typeSeries")
          : "—";

    if (
      item.type === "tv" &&
      item.seasonNumber != null &&
      item.episodeNumber != null
    ) {
      els.npEpisode.textContent =
        "S" +
        String(item.seasonNumber).padStart(2, "0") +
        " · E" +
        String(item.episodeNumber).padStart(2, "0");
    } else if (item.episodeTitle) {
      els.npEpisode.textContent = item.episodeTitle;
    } else {
      els.npEpisode.textContent = "";
    }

    const p = item.progress != null ? Math.min(100, item.progress) : 0;
    els.npBar.style.width = p + "%";
    els.npProgress.textContent =
      (item.isPaused ? "⏸ " : "") +
      Math.round(p) +
      " % · " +
      (await t("popup.playbackTime", { time: fmtTime(item.watchedSeconds) }));

    if (item.watchedStatus) {
      const label =
        {
          WATCHING: await t("popup.status.beingScrobbled"),
          FINISHED: await t("popup.status.finished"),
          PLANNED: await t("popup.status.planned"),
          HOLD: await t("popup.status.hold"),
          DROPPED: await t("popup.status.dropped"),
        }[item.watchedStatus] || item.watchedStatus;
      els.npStatus.textContent = label;
      setStatusClass(
        els.npStatus,
        item.watchedStatus === "FINISHED" ? "ok" : "pending",
      );
    } else if (
      item.watchedSeconds != null &&
      item.watchingAfterSeconds != null &&
      item.watchedSeconds < item.watchingAfterSeconds
    ) {
      els.npStatus.textContent = await t("popup.status.after", {
        time: fmtTime(item.watchingAfterSeconds),
      });
      setStatusClass(els.npStatus, "pending");
    } else {
      els.npStatus.textContent = await t("popup.status.resolving");
      setStatusClass(els.npStatus, "pending");
    }

    els.foot.textContent =
      item.type === "movie"
        ? await t("popup.status.movieThreshold", { threshold: item.threshold })
        : await t("popup.status.episodeThreshold", {
            threshold: item.threshold,
          });
  } else {
    els.nowPlaying.classList.add("hidden");
    els.noNetflix.classList.remove("hidden");
    els.foot.textContent = await t("toolbar.openNetflix");
  }
}

els.enabled.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "watcharr:saveSettings",
    settings: { enabled: els.enabled.checked },
  });
  refresh();
});

els.optionsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

els.historyBtn.addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("history/history.html") });
});

refresh();
setInterval(refresh, 2000);
