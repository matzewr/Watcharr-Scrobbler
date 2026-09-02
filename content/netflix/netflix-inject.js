/*
 * Netflix – Injection Script (Content Script, isolated world).
 *
 * Netflix has no official DOM selectors for the running player.
 * Therefore, we inject a small "probe" via <script> tag into the MAIN
 * world of the page that reads Netflix' internal player state and reports it back
 * to us (the Content Script) via CustomEvent.
 */
"use strict";

(function () {
  const PROBE_ID = "watcharr-netflix-probe";

  function probeSource() {
    return `
(function () {
  if (window.__watcharrNetflixProbeInstalled__) return;
  window.__watcharrNetflixProbeInstalled__ = true;

  function readPlayback() {
    try {
      var appState =
        window.netflix &&
        window.netflix.appContext &&
        window.netflix.appContext.state &&
        window.netflix.appContext.state.playerApp &&
        window.netflix.appContext.state.playerApp.getState();
      if (!appState || !appState.videoPlayer) return [];
      var sessions = appState.videoPlayer.playbackStateBySessionId;
      if (!sessions) return [];
      return Object.keys(sessions)
        .map(function (k) {
          var s = sessions[k];
          if (!s || !s.duration || s.duration <= 0) return null;
          return {
            currentTime: s.currentTime || 0,
            duration: s.duration,
            progress: Math.min(100, (s.currentTime / s.duration) * 100),
            isPaused: !!s.paused,
            playing: !!s.playing,
            videoId: s.videoId
          };
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // Session info (authURL, userGuid, BUILD_IDENTIFIER) – needed for
  // Netflix history (Viewing Activity).
  function readSession() {
    try {
      var r =
        window.netflix &&
        window.netflix.reactContext &&
        window.netflix.reactContext.models;
      var userInfo = r && r.userInfo && r.userInfo.data;
      if (!userInfo) return null;
      var serverDefs = r && r.serverDefs && r.serverDefs.data;
      var s = {
        authUrl: userInfo.authURL || null,
        profileName: userInfo.name || null,
        userGuid: userInfo.userGuid || null
      };
      if (serverDefs && serverDefs.BUILD_IDENTIFIER) {
        s.buildIdentifier = serverDefs.BUILD_IDENTIFIER;
      }
      return s;
    } catch (e) {
      return null;
    }
  }

  function dispatch() {
    var data = {
      sessions: readPlayback(),
      session: readSession()
    };
    document.dispatchEvent(
      new CustomEvent("watcharr:netflix:playback", { detail: data })
    );
  }

  setInterval(dispatch, 500);
  dispatch();
})();
`;
  }

  function inject() {
    if (document.getElementById(PROBE_ID)) return;
    const script = document.createElement("script");
    script.id = PROBE_ID;
    script.textContent = probeSource();
    (document.head || document.documentElement).appendChild(script);
  }

  // Netflix is an SPA – the Content Script may run before DOMContentLoaded.
  if (document.documentElement) {
    inject();
  } else {
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  }
})();
