/* ChannelOnly — YouTube channel filter (isolated world)
 * When ON and at least one channel is chosen:
 *  - Home shows the latest uploads from your channels (the native feed is hidden).
 *  - Watch page: the sidebar shows more from your channels; a video from a channel
 *    not on your list sends you back home.
 *  - Search and playlist pages show only items from your channels.
 *  - Approved channel pages work normally; other channel pages send you home.
 *  - Subscriptions, history, trending, Shorts, etc. redirect home.
 * When OFF or with no channels, YouTube is completely normal, and channel and video
 * pages show an "Add to ChannelOnly" button so you can pick channels.
 */
(function () {
  "use strict";
  if (!/^(www\.)?youtube\.com$/i.test(location.hostname)) return;

  const HOME = "https://www.youtube.com/";
  // Utility pages that must keep working (external links, account settings, embeds…).
  const PASSTHROUGH = /^\/(redirect|account|embed|logout|signin|premium|paid_memberships|t|about|live_chat)(\/|$)/;

  let allowed = [];
  let enabled = true;
  let enforcer = null;
  let observer = null;
  let rafId = 0;
  let decisionToken = 0;
  let homeShelf = null;
  let sideShelf = null;

  /* ---------- config ---------- */
  async function load() {
    try {
      const s = await chrome.storage.local.get(["allowed", "enabled"]);
      allowed = s.allowed || [];
      enabled = s.enabled !== false;
    } catch (e) {}
  }
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.allowed) { allowed = c.allowed.newValue || []; resetShelves(); }
    if (c.enabled) enabled = c.enabled.newValue !== false;
    if (c.allowed || c.enabled) route();
  });
  const isActive = () => enabled && allowed.length > 0;

  /* ---------- matching ---------- */
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function normHandle(h) {
    return safeDecode(String(h || ""))
      .replace(/^https?:\/\/(www\.)?youtube\.com\//i, "")
      .replace(/^\/+/, "").replace(/^@+/, "")
      .split(/[/?#]/)[0].trim().toLowerCase();
  }
  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  function entryFor(k) {
    if (!k) return null;
    const h = normHandle(k.handle);
    return allowed.find(c =>
      (k.channelId && c.id && c.id === k.channelId) ||
      (h && c.handle && normHandle(c.handle) === h)) || null;
  }
  const isAllowed = k => !!entryFor(k);

  function keyFromHref(href) {
    href = href || "";
    return {
      channelId: (href.match(/\/channel\/(UC[\w-]{20,})/) || [])[1] || null,
      handle: (href.match(/\/(@[^/?#"]+)/) || [])[1] || null
    };
  }
  function channelKeyForItem(el) {
    const a = el.querySelector('a[href^="/@"], a[href^="/channel/"], a[href*="youtube.com/@"], a[href*="youtube.com/channel/"]');
    return a ? keyFromHref(a.getAttribute("href")) : { channelId: null, handle: null };
  }

  // When one field of a saved channel is confirmed on the page, fix the other one
  // (e.g. a missing or wrong saved id). This is what stops repeat false redirects.
  function healEntry(e, id, handle, name) {
    if (!e) return;
    const patch = {};
    if (id && e.id !== id) patch.id = id;
    if (handle && normHandle(e.handle) !== normHandle(handle)) patch.handle = "@" + normHandle(handle);
    if (name && (!e.name || e.name === e.handle || e.name === e.id)) patch.name = name;
    if (!Object.keys(patch).length) return;
    allowed = allowed.map(c => (c === e ? { ...c, ...patch } : c));
    try { chrome.storage.local.set({ allowed }); } catch (x) {}
  }

  /* ---------- talking to the main-world probe ---------- */
  function parseDetail(e) {
    let d = e && e.detail;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch (x) { d = null; } }
    return d && typeof d === "object" ? d : null;
  }
  const askProbe = () => window.dispatchEvent(new CustomEvent("FL_request_channel"));

  /* ---------- watch page ---------- */
  function currentVideoId() {
    try { return new URLSearchParams(location.search).get("v") || ""; } catch (e) { return ""; }
  }

  // The channel shown under the video — but only if the page is already showing
  // THIS video (YouTube keeps the previous video's details on screen for a moment).
  function readWatchOwner(vid) {
    const flexy = document.querySelector("ytd-watch-flexy");
    if (!flexy) return null;
    const fv = flexy.getAttribute("video-id") || "";
    if (fv && vid && fv !== vid) return null;
    const owner = flexy.querySelector("ytd-video-owner-renderer") || flexy.querySelector("#owner");
    if (!owner) return null;
    let channelId = null, handle = null;
    owner.querySelectorAll("a[href]").forEach(a => {
      const k = keyFromHref(a.getAttribute("href"));
      channelId = channelId || k.channelId;
      handle = handle || k.handle;
    });
    if (!channelId && !handle) return null;
    const nameEl = owner.querySelector("ytd-channel-name #text, ytd-channel-name a, #channel-name");
    return { channelId, handle, name: nameEl ? nameEl.textContent : "", verified: !!(fv && fv === vid) };
  }

  function resolveWatchDecision(token, timeoutMs = 15000) {
    return new Promise(resolve => {
      const vid = currentVideoId();
      const start = Date.now();
      let done = false;
      let player = null;   // { channelId, author } for THIS video only (ads / previous video ignored)

      const settle = v => {
        if (done) return;
        done = true;
        clearInterval(iv);
        clearTimeout(to);
        window.removeEventListener("FL_channel", onProbe);
        resolve(v);
      };

      const check = () => {
        if (done) return;
        if (token !== decisionToken) return settle("gone");
        if (!player) return;                                   // wait for the definitive reading
        if (isAllowed({ channelId: player.channelId })) return settle("allow");

        const dom = readWatchOwner(vid);
        if (dom) {
          const sameChannel = !!(dom.name && player.author && norm(dom.name) === norm(player.author));
          if (sameChannel || dom.verified) {
            const e = entryFor(dom);
            if (e) {
              if (sameChannel) healEntry(e, player.channelId, dom.handle, player.author);
              return settle("allow");
            }
            if (sameChannel) return settle("block");           // confirmed: not one of your channels
          }
        }
        // The page's channel link hasn't appeared yet — give it a moment before
        // trusting the player alone (longer if some saved channels lack an id).
        const grace = allowed.some(c => !c.id) ? 12000 : 5000;
        if (Date.now() - start > grace) settle("block");
      };

      const onProbe = e => {
        const d = parseDetail(e);
        const w = d && d.watch;
        if (w && w.channelId && (!vid || !w.videoId || w.videoId === vid)) player = w;
        check();
      };
      window.addEventListener("FL_channel", onProbe);
      const iv = setInterval(() => { askProbe(); check(); }, 250);
      // No usable player reading at all: decide from the page alone; never block on uncertainty.
      const to = setTimeout(() => {
        const dom = readWatchOwner(vid);
        settle(dom && dom.verified && !isAllowed(dom) ? "block" : "allow");
      }, timeoutMs);
      askProbe();
    });
  }

  /* ---------- channel pages ---------- */
  function askChannelId(token, urlKey, timeoutMs = 5000) {
    return new Promise(resolve => {
      let done = false;
      // Only accept data that matches the URL (skips the previous page's data).
      const consistent = ch => {
        if (!ch || !(ch.channelId || ch.handle)) return false;
        if (urlKey.channelId && ch.channelId && ch.channelId !== urlKey.channelId) return false;
        if (urlKey.handle && ch.handle && normHandle(ch.handle) !== normHandle(urlKey.handle)) return false;
        return true;
      };
      const finish = v => {
        if (done) return;
        done = true;
        clearInterval(iv);
        clearTimeout(to);
        window.removeEventListener("FL_channel", onProbe);
        resolve(v);
      };
      const onProbe = e => { const d = parseDetail(e); if (d && consistent(d.channel)) finish(d.channel); };
      window.addEventListener("FL_channel", onProbe);
      const iv = setInterval(() => { if (token !== decisionToken) return finish(null); askProbe(); }, 250);
      const to = setTimeout(() => finish(null), timeoutMs);
      askProbe();
    });
  }

  /* ---------- filtering lists ---------- */
  const ITEMS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "yt-lockup-view-model",
    "ytd-reel-item-renderer",
    "ytd-playlist-renderer",
    "ytd-playlist-video-renderer",
    "ytd-radio-renderer",
    "ytd-channel-renderer"
  ].join(",");
  const hide = el => el.style.setProperty("display", "none", "important");
  const unhide = el => el.style.removeProperty("display");
  const isNested = el => !!(el.parentElement && el.parentElement.closest(ITEMS));

  // Search & playlists: keep only cards confirmed to be from your channels.
  function filterStrict() {
    document.querySelectorAll(ITEMS).forEach(el => {
      if (isNested(el)) return;
      const k = channelKeyForItem(el);
      ((k.channelId || k.handle) && isAllowed(k)) ? unhide(el) : hide(el);
    });
  }
  // Your channel's own page: its cards often have no channel link, so only hide
  // cards that clearly belong to another channel.
  function filterLenient() {
    document.querySelectorAll(ITEMS).forEach(el => {
      if (isNested(el)) return;
      const k = channelKeyForItem(el);
      if (k.channelId || k.handle) isAllowed(k) ? unhide(el) : hide(el);
    });
  }

  /* ---------- "From your channels" shelves ---------- */
  let vids = null, vidsAt = 0, vidsReq = null;
  function getApprovedVideos() {
    if (vids && Date.now() - vidsAt < 10 * 60 * 1000) return Promise.resolve(vids);
    if (!vidsReq) {
      try {
        vidsReq = chrome.runtime.sendMessage({ action: "approvedVideos" })
          .then(r => { vids = (r && r.videos) || []; vidsAt = Date.now(); return vids; })
          .catch(() => vids || [])
          .finally(() => { vidsReq = null; });
      } catch (e) { return Promise.resolve(vids || []); }
    }
    return vidsReq;
  }
  function resetShelves() {
    vids = null; vidsAt = 0;
    if (homeShelf) homeShelf.remove();
    if (sideShelf) sideShelf.remove();
    homeShelf = sideShelf = null;
  }

  function node(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!t) return "";
    const s = Math.max(1, (Date.now() - t) / 1000);
    const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
    for (const [u, n] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? "s" : ""} ago`; }
    return "just now";
  }
  function fmtViews(n) {
    if (!n) return "";
    const f = (x, d) => x.toFixed(d).replace(/\.0$/, "");
    if (n >= 1e6) return f(n / 1e6, n >= 1e7 ? 0 : 1) + "M views";
    if (n >= 1e3) return f(n / 1e3, n >= 1e4 ? 0 : 1) + "K views";
    return n + " views";
  }
  function card(v) {
    const a = node("a", "fl-card");
    a.href = "/watch?v=" + encodeURIComponent(v.vid);
    const thumb = node("div", "fl-thumb");
    const img = node("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = "https://i.ytimg.com/vi/" + encodeURIComponent(v.vid) + "/mqdefault.jpg";
    thumb.append(img);
    const info = node("div", "fl-info");
    info.append(
      node("div", "fl-title", v.title),
      node("div", "fl-meta", [v.channel, fmtViews(v.views), timeAgo(v.pub)].filter(Boolean).join(" • "))
    );
    a.append(thumb, info);
    return a;
  }
  function makeShelf(layout) {
    const box = node("div", "fl-shelf fl-" + layout);
    box.append(node("div", "fl-head", "From your channels"), node("div", "fl-body"));
    return box;
  }
  async function fillShelf(box, skipVid, limit) {
    const body = box.querySelector(".fl-body");
    body.replaceChildren(node("div", "fl-msg", "Loading…"));
    const list = (await getApprovedVideos()).filter(v => v.vid !== skipVid).slice(0, limit);
    body.replaceChildren(...(list.length ? list.map(card) : [node("div", "fl-msg", "No recent uploads from your channels yet.")]));
  }
  function ensureHomeShelf() {
    const grid = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
    if (!grid || !grid.parentNode) return;
    if (!homeShelf) { homeShelf = makeShelf("grid"); fillShelf(homeShelf, "", 36); }
    if (homeShelf.parentNode !== grid.parentNode || homeShelf.nextSibling !== grid) grid.parentNode.insertBefore(homeShelf, grid);
  }
  function ensureSidebarShelf() {
    const related = document.querySelector("ytd-watch-flexy #related");
    if (!related || !related.parentNode) return;
    if (!sideShelf) sideShelf = makeShelf("list");
    if (sideShelf.parentNode !== related.parentNode || sideShelf.nextSibling !== related) related.parentNode.insertBefore(sideShelf, related);
    const vid = currentVideoId();
    if (sideShelf.dataset.vid !== vid) { sideShelf.dataset.vid = vid; fillShelf(sideShelf, vid, 20); }
  }

  /* ---------- "Add to ChannelOnly" button (only while filtering is off) ---------- */
  let pill = null, pillKey = "";
  const dismissed = new Set();

  function askProbeOnce(timeoutMs = 700) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; clearTimeout(t); window.removeEventListener("FL_channel", on); resolve(v); };
      const on = e => finish(parseDetail(e));
      const t = setTimeout(() => finish(null), timeoutMs);
      window.addEventListener("FL_channel", on);
      askProbe();
    });
  }

  // Which channel is this page about? Read from YouTube's own page data — no network requests.
  async function pageChannel() {
    const path = location.pathname;
    const d = await askProbeOnce();
    if (!d) return null;
    if (/^\/watch/.test(path)) {
      const vid = currentVideoId(), w = d.watch;
      if (!w || !w.channelId || (vid && w.videoId && w.videoId !== vid)) return null;
      const dom = readWatchOwner(vid);
      const same = !!(dom && dom.name && w.author && norm(dom.name) === norm(w.author));
      return { id: w.channelId, handle: same && dom.handle ? "@" + normHandle(dom.handle) : null, name: w.author || "" };
    }
    const urlId = (path.match(/^\/channel\/(UC[\w-]{20,})/) || [])[1] || null;
    const urlHandle = (path.match(/^\/(@[^/?#]+)/) || [])[1] || null;
    const ch = d.channel;
    if (!ch || !ch.channelId) return null;
    if (urlId && ch.channelId !== urlId) return null;
    if (urlHandle && ch.handle && normHandle(ch.handle) !== normHandle(urlHandle)) return null;
    const h = ch.handle || urlHandle;
    return { id: ch.channelId, handle: h ? "@" + normHandle(h) : null, name: ch.title || "" };
  }

  function removePill() { if (pill) pill.remove(); pill = null; pillKey = ""; }

  function showPill(who) {
    if (pill && pill.isConnected && pillKey === who.id) return;
    removePill();
    pillKey = who.id;
    const label = who.name || who.handle || "this channel";
    pill = node("div", "fl-pill");
    pill.setAttribute("role", "region");
    pill.setAttribute("aria-label", "ChannelOnly");
    const add = node("button", "fl-pill-add");
    add.type = "button";
    const text = node("span", "fl-pill-text", `Add ${label} to ChannelOnly`);
    add.append(node("span", "fl-pill-dot"), text);
    add.addEventListener("click", async () => {
      add.disabled = true;
      const list = allowed.slice();
      if (!entryFor({ channelId: who.id, handle: who.handle })) {
        list.push({ id: who.id, handle: who.handle, name: who.name || who.handle || who.id });
      }
      try { await chrome.storage.local.set({ allowed: list }); text.textContent = `Added ${label}`; }
      catch (e) { text.textContent = "Couldn't save. Reload the page and try again."; add.disabled = false; return; }
      setTimeout(removePill, 1600);
    });
    const close = node("button", "fl-pill-close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Hide for this channel");
    close.addEventListener("click", () => { dismissed.add(who.id); removePill(); });
    pill.append(add, close);
    (document.body || document.documentElement).appendChild(pill);
  }

  let pillBusy = false;
  async function updatePill() {
    if (pillBusy) return;
    if (isActive() || !/^\/(watch|channel\/|@|c\/|user\/)/.test(location.pathname)) return removePill();
    pillBusy = true;
    try {
      const who = await pageChannel();
      if (isActive() || !who || dismissed.has(who.id) || isAllowed({ channelId: who.id, handle: who.handle })) removePill();
      else showPill(who);
    } finally { pillBusy = false; }
  }
  setInterval(updatePill, 1500);

  /* ---------- routing ---------- */
  async function route() {
    updatePill();
    if (!isActive()) { deactivate(); return; }
    document.documentElement.classList.add("fl-on");
    const token = ++decisionToken;
    const path = location.pathname || "/";

    if (PASSTHROUGH.test(path)) return setEnforcer(null);
    if (path === "/") return setEnforcer(ensureHomeShelf);
    if (/^\/(results|playlist)(\/|$)/.test(path)) return setEnforcer(filterStrict);

    if (/^\/watch/.test(path)) {
      setEnforcer(ensureSidebarShelf);
      const verdict = await resolveWatchDecision(token);
      if (token === decisionToken && verdict === "block") location.replace(HOME);
      return;
    }

    if (/^\/(channel\/|@|c\/|user\/)/.test(path)) {
      const urlKey = {
        channelId: (path.match(/^\/channel\/(UC[\w-]{20,})/) || [])[1] || null,
        handle: (path.match(/^\/(@[^/?#]+)/) || [])[1] || null
      };
      if (isAllowed(urlKey)) {
        setEnforcer(filterLenient);
        // Fill in anything missing from the saved entry (e.g. added by @handle, so no id yet).
        askChannelId(token, urlKey).then(info => { const e = entryFor(urlKey); if (info && e) healEntry(e, info.channelId, info.handle, info.title); });
        return;
      }
      const info = await askChannelId(token, urlKey);
      if (token !== decisionToken) return;
      const e = entryFor(info);
      if (e) { healEntry(e, info.channelId, info.handle, info.title); return setEnforcer(filterLenient); }
      location.replace(HOME);
      return;
    }

    // Subscriptions, history, trending, Shorts, explore… -> home.
    location.replace(HOME);
  }

  function setEnforcer(fn) { enforcer = fn; startObserver(); }

  function deactivate() {
    decisionToken++;
    enforcer = null;
    if (observer) { observer.disconnect(); observer = null; }
    document.documentElement.classList.remove("fl-on");
    resetShelves();
    document.querySelectorAll(ITEMS).forEach(unhide);
  }

  /* ---------- observer (debounced to one pass per frame) ---------- */
  function tick() {
    rafId = 0;
    if (!isActive()) return;
    document.documentElement.classList.add("fl-on");
    if (enforcer) enforcer();
  }
  function startObserver() {
    if (!observer) {
      observer = new MutationObserver(() => { if (!rafId) rafId = requestAnimationFrame(tick); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    tick();
  }

  /* ---------- in-app navigation (one route per URL change) ---------- */
  let lastHref = location.href;
  document.addEventListener("yt-navigate-finish", () => { lastHref = location.href; route(); });
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; route(); } }, 400);

  load().then(route);
})();
