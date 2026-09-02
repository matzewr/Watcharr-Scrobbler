/*
 * Netflix – "Probe" (runs in the MAIN world of the Netflix page).
 *
 * This file is loaded by content/netflix/netflix-inject.js via an external
 * <script src="…netflix-probe.js"> tag (not inline text!) and therefore runs
 * in the page's main world, where Netflix' internal player state lives.
 *
 * Why an external file instead of inline code:
 *   Netflix' Content-Security-Policy forbids inline scripts ('unsafe-inline'
 *   is absent), so a <script> with textContent is blocked by the browser.
 *   The page CSP *does* allow the extension's own origin (Chrome appends
 *   chrome-extension://<id>/ to the page CSP automatically), so an external
 *   script from the extension passes. The file is listed in
 *   web_accessible_resources for netflix.com.
 *
 * The probe reads Netflix' player/account state and reports it back to the
 * Content Script (isolated world) via a CustomEvent on `document`.
 */
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
