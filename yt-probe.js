/* ChannelOnly — main-world probe
 * Runs in YouTube's own JS context to read the player and page data, then hands the
 * result to the extension as a JSON string (plain objects can arrive empty when
 * crossing from the page into an extension's isolated world).
 */
(function () {
  function handleFromUrl(u) {
    const m = String(u || "").match(/\/(@[^/?#"]+)/);
    return m ? m[1] : null;
  }

  // Current video's channel. videoId lets the extension ignore ads / the previous video.
  function watchInfo() {
    try {
      const p = document.getElementById("movie_player");
      if (p && typeof p.getPlayerResponse === "function") {
        const vd = p.getPlayerResponse() && p.getPlayerResponse().videoDetails;
        if (vd && vd.channelId) return { channelId: vd.channelId, videoId: vd.videoId || "", author: vd.author || "" };
      }
    } catch (e) {}
    try {
      const vd = window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails;
      if (vd && vd.channelId) return { channelId: vd.channelId, videoId: vd.videoId || "", author: vd.author || "" };
    } catch (e) {}
    return null;
  }

  // Channel page identity. The live element's data stays correct after in-app
  // navigation; ytInitialData only describes the page you first loaded.
  function channelInfo() {
    try {
      const browse = document.querySelector("ytd-browse:not([hidden])");
      const md = browse && browse.data && browse.data.metadata && browse.data.metadata.channelMetadataRenderer;
      if (md && md.externalId) return { channelId: md.externalId, handle: handleFromUrl(md.vanityChannelUrl), title: md.title || "" };
    } catch (e) {}
    try {
      const md = window.ytInitialData && window.ytInitialData.metadata && window.ytInitialData.metadata.channelMetadataRenderer;
      if (md && md.externalId) return { channelId: md.externalId, handle: handleFromUrl(md.vanityChannelUrl), title: md.title || "" };
    } catch (e) {}
    return null;
  }

  function respond() {
    const detail = JSON.stringify({ watch: watchInfo(), channel: channelInfo(), href: location.href });
    window.dispatchEvent(new CustomEvent("FL_channel", { detail }));
  }

  window.addEventListener("FL_request_channel", respond);
  document.addEventListener("yt-navigate-finish", () => setTimeout(respond, 0));
  window.addEventListener("load", () => setTimeout(respond, 0));
})();
