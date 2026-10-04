/* ChannelOnly — background
 * - Seeds storage on install.
 * - Opens the settings page when the toolbar icon is clicked.
 * - Fetches the latest uploads from your channels through YouTube's public RSS feeds.
 * It never fetches YouTube pages and never sends data anywhere else.
 */

chrome.runtime.onInstalled.addListener(async () => {
  const { allowed, enabled } = await chrome.storage.local.get(["allowed", "enabled"]);
  const patch = {};
  if (!allowed) patch.allowed = [];
  if (enabled === undefined) patch.enabled = true;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

function decodeXml(s) {
  return String(s || "")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function getText(url) {
  try {
    const r = await fetch(url, { credentials: "omit" });
    return r.ok ? await r.text() : null;
  } catch (e) { return null; }
}

let cache = { key: "", at: 0, data: [] };

async function latestUploads() {
  const { allowed = [] } = await chrome.storage.local.get("allowed");
  const chans = allowed.filter(c => c.id);    // channels saved by handle get their id the first time you open them
  const key = chans.map(c => c.id).sort().join(",");
  if (cache.key === key && Date.now() - cache.at < 10 * 60 * 1000) return cache.data;

  const out = [];
  await Promise.all(chans.map(async c => {
    const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(c.id)}`);
    if (!xml) return;
    const author = decodeXml((xml.match(/<author>\s*<name>([^<]+)<\/name>/) || [])[1] || "");
    xml.split("<entry>").slice(1).forEach(e => {
      const vid = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
      const link = (e.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || "";
      if (!vid || /\/shorts\//.test(link)) return;                       // no Shorts
      out.push({
        vid,
        title: decodeXml((e.match(/<title>([^<]*)<\/title>/) || [])[1] || ""),
        pub: (e.match(/<published>([^<]+)<\/published>/) || [])[1] || "",
        views: Number((e.match(/<media:statistics views="(\d+)"/) || [])[1] || 0),
        channel: author || c.name || ""
      });
    });
  }));
  out.sort((a, b) => (a.pub < b.pub ? 1 : -1));
  cache = { key, at: Date.now(), data: out.slice(0, 60) };
  return cache.data;
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.action === "approvedVideos") {
    latestUploads().then(videos => sendResponse({ ok: true, videos })).catch(() => sendResponse({ ok: false, videos: [] }));
    return true;
  }
  return false;
});
