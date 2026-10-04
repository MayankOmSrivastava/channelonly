/* ChannelOnly — settings page. Everything here works offline: no network requests. */
const $ = s => document.querySelector(s);
const store = () => chrome.storage.local.get(["allowed", "enabled"]);
const setAllowed = a => chrome.storage.local.set({ allowed: a });
const setEnabled = v => chrome.storage.local.set({ enabled: v });

let allowed = [];
let enabled = true;

init();
async function init() {
  const s = await store();
  allowed = s.allowed || [];
  enabled = s.enabled !== false;
  render();
  $("#addChannel").onclick = add;
  $("#channelInput").addEventListener("keydown", e => { if (e.key === "Enter") add(); });
  $("#enabledSwitch").onclick = async () => { enabled = !enabled; await setEnabled(enabled); render(); };
  // Stay in sync when a channel is added from a YouTube page.
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.allowed) allowed = c.allowed.newValue || [];
    if (c.enabled) enabled = c.enabled.newValue !== false;
    if (c.allowed || c.enabled) render();
  });
}

function render() {
  $("#enabledSwitch").dataset.on = enabled ? "true" : "false";
  $("#stateLine").textContent = !enabled
    ? "Off. YouTube shows everything, and you can add channels from any channel or video page."
    : allowed.length === 0
      ? "On, but no channels yet, so YouTube shows everything until you add one."
      : `On. Only your ${allowed.length} channel${allowed.length > 1 ? "s are" : " is"} shown.`;

  const ul = $("#channels");
  ul.innerHTML = "";
  $("#empty").classList.toggle("hidden", allowed.length > 0);
  allowed.forEach(c => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    const name = document.createElement("span");
    name.textContent = c.name || c.handle || c.id;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = " " + (c.handle || c.id || "") + (c.id ? "" : " · finishes setting up when you open this channel once");
    label.append(name, tag);
    const rm = document.createElement("button");
    rm.className = "btn ghost small";
    rm.textContent = "Remove";
    rm.setAttribute("aria-label", `Remove ${name.textContent}`);
    rm.onclick = async () => { allowed = allowed.filter(x => x !== c); await setAllowed(allowed); render(); };
    li.append(label, rm);
    ul.appendChild(li);
  });
}

// Read a channel link, @handle, or UC… id locally.
function parse(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (/^UC[\w-]{20,}$/.test(s)) return { id: s, handle: null };
  if (s.startsWith("@")) {
    const h = s.split(/[/?#\s]/)[0];
    return h.length > 1 ? { id: null, handle: h.toLowerCase() } : null;
  }
  if (/youtube\.com/i.test(s)) {
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try {
      const p = new URL(s).pathname;
      let m;
      if ((m = p.match(/^\/channel\/(UC[\w-]{20,})/))) return { id: m[1], handle: null };
      if ((m = p.match(/^\/(@[^/?#]+)/))) {
        let h = m[1];
        try { h = decodeURIComponent(h); } catch (e) {}
        return { id: null, handle: h.toLowerCase() };
      }
    } catch (e) {}
  }
  return null;
}

async function add() {
  const ch = parse($("#channelInput").value);
  if (!ch) {
    $("#addStatus").textContent = "Paste a channel link like youtube.com/@name, an @handle, or a UC… channel ID. Video links and names don't work here; use the Add to ChannelOnly button on YouTube instead.";
    return;
  }
  const norm = h => String(h || "").replace(/^@+/, "").toLowerCase();
  if (allowed.some(c => (ch.id && c.id === ch.id) || (ch.handle && norm(c.handle) === norm(ch.handle)))) {
    $("#addStatus").textContent = "That channel is already on your list.";
    return;
  }
  const label = ch.handle || ch.id;
  allowed.push({ id: ch.id, handle: ch.handle, name: label });
  await setAllowed(allowed);
  $("#channelInput").value = "";
  $("#addStatus").textContent = ch.id
    ? `Added ${label}. Its name fills in when you open the channel.`
    : `Added ${label}. Open the channel once so its name and latest videos can load.`;
  render();
}
