const POLL_MS = 10000;            // diki sou katastasi (kathe 10s)
const FRIENDS_COOLDOWN_SEC = 30;  // cooldown ananeosis filon (se deuterolepta)
const MAX_HISTORY = 100;          // megista paixnidia xoris ⭐

const DEFAULT_PROMPT = `Search the web for all currently active promo codes for the Roblox game "{gameName}" (ID: "{gameId}"). 

Organize the output into a clean, punchy bulleted list strictly categorized into the following three sections (in this exact order):

1. **New Codes** (The latest, recently released active codes)
2. **Active Codes** (Older codes that are still confirmed working)
3. **Unverified / Potentially Active** (Very recent codes that are not yet 100% confirmed—briefly note that they might not work)

Rules:
- For each code, clearly state the **Code** (in bold or code blocks) and its exact **Reward**.
- Strictly EXCLUDE any codes that are confirmed expired.
- If a category has no codes, omit that section entirely.
- **Language Rule:** Detect the language of the user's request or browser locale context, and write the entire response (headings, rewards, and notes) in that exact same language. Keep the actual Roblox promo codes in their original exact spelling/casing.`;

const main = document.getElementById("main");
let view = location.hash.slice(1) || "home";
let cur = null;                // trexousa katastasi
let curError = "";
let friends = null;            // null = den fortothike akoma
let friendsError = false;
let friendsLoading = false;
let friendsCooldown = 0;       // ypoloipa deuterolepta cooldown
let friendsCooldownTimer = null;
let continueSyncStatus = "";   // "api" | "fallback" | ""
let searchTerm = "";
let sortBy = "recent";         // "recent" | "oldest" | "playtime" | "count" | "name_asc" | "name_desc" | "fav_first"
let listEl = null;

let autoRejoin = false;
let autoRejoinAttempts = 0;
let lastPlayingGame = null;    // { placeId, gameId, name }
let openNotePlaceId = null;    // poio paixnidi exei anoixto to panel VIP/Note
let iconFetchInProgress = false;

// Katagrafi xronou paixnidiou & eidopoiiseon
let lastTickTime = Date.now();
let sessionStartTime = null;
let sessionNotified = false;

// ---------- helpers ----------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else e[k] = v;
  }
  kids.flat().forEach((c) => c && e.append(c));
  return e;
}

function showToast(text, duration = 4500) {
  const existing = document.getElementById("rb-toast");
  if (existing) existing.remove();
  const t = h("div", { id: "rb-toast", class: "toast", textContent: text });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

let q = Promise.resolve();
const enqueue = (fn) => (q = q.then(fn).catch((e) => console.warn(e)));

function formatPlaytime(ms) {
  const totalMin = Math.floor((ms || 0) / 60000);
  if (totalMin < 1) return "<1m";
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins}m`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// Eksagogi Place ID apo Roblox URL (p.x. https://www.roblox.com/games/2753915549/Blox-Fruits)
function extractPlaceIdFromUrl(input) {
  const str = (input || "").trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return Number(str);
  const match = str.match(/roblox\.com\/(?:[a-z]{2}\/)?games\/(\d+)/i);
  if (match && match[1]) return Number(match[1]);
  const paramMatch = str.match(/[?&]placeId=(\d+)/i);
  if (paramMatch && paramMatch[1]) return Number(paramMatch[1]);
  return null;
}

async function copyPrompt(name, placeId, btn) {
  const { customPrompt } = await chrome.storage.local.get("customPrompt");
  const text = (customPrompt || DEFAULT_PROMPT)
    .replace(/{gameName}/g, name)
    .replace(/{gameId}/g, placeId || "Unknown");
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = "Copied! ✔";
  setTimeout(() => (btn.textContent = old), 1800);
}

function makeCopyLinkBtn(url) {
  const btn = h("button", {
    class: "btn primary",
    type: "button",
    textContent: "📋 Copy link"
  });

  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      const oldText = btn.textContent;
      const oldClass = btn.className;

      btn.textContent = "Copied! ✔";
      btn.className = "btn";

      setTimeout(() => {
        btn.textContent = oldText;
        btn.className = oldClass;
      }, 1800);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  return btn;
}

function makeDirectJoinBtn(placeId, followUserId = null, gameInstanceId = null, label = "▶ Join") {
  const btn = h("button", { class: "btn green", textContent: label, title: "Launch directly in the Roblox Client" });
  btn.addEventListener("click", async () => {
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳...";
    try {
      await RB.launchGame(placeId, followUserId, gameInstanceId);
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = oldText;
      }, 2000);
    }
  });
  return btn;
}

function makeServerHopBtn(placeId, mode = "empty", excludeGameId = null) {
  const isEmpty = mode === "empty";
  const label = isEmpty ? "⚡ Empty" : "📶 Low Ping";
  const title = isEmpty
    ? "Server hop to the public server with the fewest players"
    : "Server hop to the public server with the lowest ping";

  const btn = h("button", {
    class: "btn " + (isEmpty ? "purple" : "teal"),
    textContent: label,
    title
  });

  btn.addEventListener("click", async () => {
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳...";
    try {
      const srv = await RB.serverHop(placeId, mode, excludeGameId);
      if (srv) {
        const info = srv.ping ? ` (${srv.playing}/${srv.maxPlayers} players · ${srv.ping}ms)` : ` (${srv.playing}/${srv.maxPlayers} players)`;
        showToast(`🚀 Joining server${info}`);
      }
    } catch (err) {
      showToast("⚠️ " + (err.message || "Server hop failed"));
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = oldText;
      }, 2500);
    }
  });

  return btn;
}

function makeAvatarThumb(avatarUrl, name = "?") {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  const placeholder = h("div", {
    style: "width:40px; height:40px; border-radius:50%; background:#2e3134; color:#aaa; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:bold; flex:none;",
    textContent: initial || "👤"
  });

  if (!avatarUrl) return placeholder;

  const img = h("img", {
    class: "round",
    src: avatarUrl,
    alt: "",
    loading: "lazy",
    style: "opacity:0; transition: opacity 0.25s ease;"
  });

  let retries = 0;
  img.addEventListener("load", () => {
    img.style.opacity = "1";
  });

  img.addEventListener("error", () => {
    if (retries < 2) {
      retries++;
      setTimeout(() => {
        const sep = avatarUrl.includes("?") ? "&" : "?";
        img.src = `${avatarUrl}${sep}retry=${retries}`;
      }, 2000 * retries);
    } else {
      img.replaceWith(placeholder);
    }
  });

  return img;
}

function makeGameThumb(iconUrl) {
  const placeholder = h("div", {
    style: "width:40px; height:40px; border-radius:8px; background:#2e3134; display:flex; align-items:center; justify-content:center; font-size:18px; flex:none;",
    textContent: "🎮"
  });

  if (!iconUrl) return placeholder;

  const img = h("img", {
    src: iconUrl,
    alt: "",
    loading: "lazy",
    style: "opacity:0; transition: opacity 0.25s ease;"
  });

  let retries = 0;
  img.addEventListener("load", () => {
    img.style.opacity = "1";
  });

  img.addEventListener("error", () => {
    if (retries < 2) {
      retries++;
      setTimeout(() => {
        const sep = iconUrl.includes("?") ? "&" : "?";
        img.src = `${iconUrl}${sep}retry=${retries}`;
      }, 2000 * retries);
    } else {
      img.replaceWith(placeholder);
    }
  });

  return img;
}

const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

// ---------- history, Playtime & Notifications ----------
let lastRecorded = null;

async function fillMissingIcons(retryRound = 0) {
  if (iconFetchInProgress && retryRound === 0) return;
  iconFetchInProgress = true;

  try {
    const { history = [] } = await chrome.storage.local.get("history");
    const missing = history.filter((x) => !x.iconUrl && x.placeId);
    if (!missing.length) {
      iconFetchInProgress = false;
      return;
    }

    let updated = false;
    let hasPending = false;

    for (let i = 0; i < missing.length; i += 25) {
      const batch = missing.slice(i, i + 25);
      const ids = batch.map((x) => x.placeId).join(",");

      const res = await fetch(
        `https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${ids}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`
      );
      if (!res.ok) continue;

      const json = await res.json();
      if (!json.data) continue;

      for (const d of json.data) {
        if (d.state === "Completed" && d.imageUrl) {
          const item = history.find((x) => Number(x.placeId) === Number(d.targetId));
          if (item && !item.iconUrl) {
            item.iconUrl = d.imageUrl;
            updated = true;
          }
        } else if (d.state === "Pending") {
          hasPending = true;
        }
      }

      if (i + 25 < missing.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (updated) {
      await chrome.storage.local.set({ history });
      if (listEl) refreshList();
    }

    if (hasPending && retryRound < 3) {
      setTimeout(() => fillMissingIcons(retryRound + 1), 2500);
      return;
    }
  } catch (err) {
    console.warn("Error loading icons:", err);
  }

  iconFetchInProgress = false;
}

async function syncContinueHistory() {
  try {
    const apiGames = await RB.getContinueGames();
    continueSyncStatus = "api";

    enqueue(async () => {
      const { history = [] } = await chrome.storage.local.get("history");
      const now = Date.now();

      apiGames.forEach((g, idx) => {
        const existing = history.find((x) => Number(x.placeId) === Number(g.placeId));
        const syntheticTimestamp = now - idx * 1000;
        if (existing) {
          existing.name = g.name || existing.name;
          existing.url = g.url || existing.url;
          if (g.iconUrl) existing.iconUrl = g.iconUrl;
          if (typeof existing.playTimeMs !== "number") existing.playTimeMs = 0;
          if (idx === 0 && existing.lastPlayed < now - 60000) {
            existing.lastPlayed = syntheticTimestamp;
          }
        } else {
          history.push({
            placeId: g.placeId,
            name: g.name,
            url: g.url,
            iconUrl: g.iconUrl || "",
            fav: false,
            count: 1,
            playTimeMs: 0,
            lastPlayed: syntheticTimestamp
          });
        }
      });

      history.sort((a, b) => b.lastPlayed - a.lastPlayed);
      let n = 0;
      const out = history.filter((x) => x.fav || n++ < MAX_HISTORY);
      await chrome.storage.local.set({ history: out });
      if (listEl) refreshList();
      fillMissingIcons();
    });
  } catch (e) {
    console.warn("Continue API unavailable, using local fallback:", e.message);
    continueSyncStatus = "fallback";
  }
}

async function checkPlaytimeNotification(gameName, iconUrl) {
  if (!sessionStartTime || sessionNotified) return;
  const { notifyEnabled = false, notifyMinutes = 60 } = await chrome.storage.local.get([
    "notifyEnabled",
    "notifyMinutes"
  ]);

  if (!notifyEnabled || !notifyMinutes || notifyMinutes <= 0) return;

  const elapsedMs = Date.now() - sessionStartTime;
  const limitMs = notifyMinutes * 60 * 1000;

  if (elapsedMs >= limitMs) {
    sessionNotified = true;
    const msgText = `You've been playing for ${formatPlaytime(elapsedMs)} straight (${gameName}). You've reached your limit of ${notifyMinutes} minutes!`;
    showToast("⏰ " + msgText, 8000);
    chrome.runtime.sendMessage({
      type: "NOTIFY_PLAYTIME",
      text: msgText,
      iconUrl: iconUrl || ""
    });
  }
}

function recordPlay(s, deltaMs) {
  if (s.status !== "playing" || !s.placeId) {
    lastRecorded = null;
    sessionStartTime = null;
    sessionNotified = false;
    return;
  }

  if (!sessionStartTime) {
    sessionStartTime = Date.now();
    sessionNotified = false;
  }

  const safeDelta = deltaMs > 0 && deltaMs < 60000 ? deltaMs : 0;

  enqueue(async () => {
    const { history = [] } = await chrome.storage.local.get("history");
    const now = Date.now();
    let e = history.find((x) => Number(x.placeId) === Number(s.placeId));
    if (!e) {
      e = {
        placeId: s.placeId,
        name: s.gameName,
        url: s.gameUrl,
        iconUrl: s.iconUrl,
        fav: false,
        count: 0,
        playTimeMs: 0,
        lastPlayed: now
      };
      history.push(e);
    }
    if (lastRecorded !== s.placeId) {
      e.count++;
      lastRecorded = s.placeId;
    }
    e.playTimeMs = (e.playTimeMs || 0) + safeDelta;
    e.lastPlayed = now;
    e.name = s.gameName;
    e.url = s.gameUrl;
    if (s.iconUrl) e.iconUrl = s.iconUrl;

    history.sort((a, b) => b.lastPlayed - a.lastPlayed);
    let n = 0;
    const out = history.filter((x) => x.fav || n++ < MAX_HISTORY);
    await chrome.storage.local.set({ history: out });
    if (listEl) refreshList();
  });

  checkPlaytimeNotification(s.gameName, s.iconUrl);
}

function toggleFav(placeId) {
  enqueue(async () => {
    const { history = [] } = await chrome.storage.local.get("history");
    const e = history.find((x) => Number(x.placeId) === Number(placeId));
    if (e) e.fav = !e.fav;
    await chrome.storage.local.set({ history });
    if (listEl) refreshList();
  });
}

function updateGameMeta(placeId, data) {
  enqueue(async () => {
    const { history = [] } = await chrome.storage.local.get("history");
    const e = history.find((x) => Number(x.placeId) === Number(placeId));
    if (e) {
      Object.assign(e, data);
      await chrome.storage.local.set({ history });
      if (listEl) refreshList();
    }
  });
}

async function playRandomFromHistory(onlyFav = false) {
  const { history = [] } = await chrome.storage.local.get("history");
  const pool = history.filter((e) => (!onlyFav || e.fav) && e.placeId);
  if (!pool.length) {
    showToast(onlyFav ? "⚠️ No favorite games to pick from." : "⚠️ Your history is empty.");
    return;
  }
  const picked = pool[Math.floor(Math.random() * pool.length)];
  showToast(`🎲 Random pick: ${picked.name}`);
  await RB.launchGame(picked.placeId);
}

// ---------- friends cooldown & manual refresh ----------
function startFriendsCooldown() {
  friendsCooldown = FRIENDS_COOLDOWN_SEC;
  if (friendsCooldownTimer) clearInterval(friendsCooldownTimer);
  friendsCooldownTimer = setInterval(() => {
    friendsCooldown--;
    if (friendsCooldown <= 0) {
      friendsCooldown = 0;
      clearInterval(friendsCooldownTimer);
      friendsCooldownTimer = null;
    }
    updateRefreshBtnUI();
  }, 1000);
  updateRefreshBtnUI();
}

function updateRefreshBtnUI() {
  const btn = document.getElementById("refresh-friends-btn");
  if (!btn) return;
  if (friendsLoading) {
    btn.disabled = true;
    btn.textContent = "⏳ Loading...";
  } else if (friendsCooldown > 0) {
    btn.disabled = true;
    btn.textContent = `🔄 Refresh (${friendsCooldown}s)`;
  } else {
    btn.disabled = false;
    btn.textContent = "🔄 Refresh";
  }
}

async function manualRefreshFriends(isInitial = false) {
  if (friendsLoading) return;
  if (!isInitial && friendsCooldown > 0) return;

  friendsLoading = true;
  updateRefreshBtnUI();

  try {
    friends = await RB.getFriendsOnline();
    friendsError = false;
  } catch {
    friendsError = true;
  } finally {
    friendsLoading = false;
    startFriendsCooldown();
    if (view === "home") updateHomeFriends();
  }
}

// ---------- views ----------
function quickLaunchBar() {
  const input = h("input", {
    type: "text",
    placeholder: "Paste a Roblox game URL, or leave empty to open Roblox"
  });
  const goBtn = h("button", { class: "btn green", textContent: "🚀 Open Roblox" });

  const updateBtnLabel = () => {
    if (goBtn.disabled) return;
    goBtn.textContent = input.value.trim() ? "▶ Quick Join" : "🚀 Open Roblox";
  };

  input.addEventListener("input", updateBtnLabel);

  const launchFromInput = async () => {
    const raw = input.value.trim();

    if (!raw) {
      goBtn.disabled = true;
      goBtn.textContent = "⏳...";
      try {
        showToast("🚀 Opening Roblox Client...");
        window.open("roblox://", "_self");
      } finally {
        setTimeout(() => {
          goBtn.disabled = false;
          updateBtnLabel();
        }, 2000);
      }
      return;
    }

    const placeId = extractPlaceIdFromUrl(raw);
    if (!placeId) {
      showToast("⚠️ Invalid Roblox URL. Paste a game link like roblox.com/games/...");
      return;
    }
    goBtn.disabled = true;
    goBtn.textContent = "⏳...";
    try {
      showToast(`🚀 Launching game (ID: ${placeId})...`);
      await RB.launchGame(placeId);
      input.value = "";
    } finally {
      setTimeout(() => {
        goBtn.disabled = false;
        updateBtnLabel();
      }, 2000);
    }
  };

  goBtn.addEventListener("click", launchFromInput);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") launchFromInput();
  });

  return h("div", { class: "bar", style: "margin-bottom: 16px;" }, input, goBtn);
}

function currentCard() {
  const s = cur;
  const card = h("div", { class: "card " + (curError ? "error" : s ? s.status : "") });

  const rejoinBtn = h("button", {
    class: "btn " + (autoRejoin ? "green" : ""),
    style: "align-self: flex-start; margin-left: auto;",
    textContent: autoRejoin ? "🔁 Auto-Rejoin: ON" : "🔁 Auto-Rejoin: OFF",
    title: "Automatically rejoin if you get disconnected (disconnect/AFK)"
  });
  rejoinBtn.addEventListener("click", () => {
    autoRejoin = !autoRejoin;
    autoRejoinAttempts = 0;
    if (autoRejoin && s && s.status === "playing" && s.placeId) {
      lastPlayingGame = { placeId: s.placeId, gameId: s.gameId, name: s.gameName };
    }
    showToast(autoRejoin ? "🔁 Auto-Rejoin enabled!" : "⏹️ Auto-Rejoin disabled.");
    updateHomeCurrent();
  });

  if (curError) {
    card.append(
      h("div", { class: "txt" },
        h("span", { class: "name", textContent: curError }),
        h("span", { class: "status" }, h("span", { class: "dot" }), "Log in to roblox.com and try again")),
      rejoinBtn
    );
    return card;
  }
  if (!s) {
    card.append(
      h("div", { class: "txt" }, h("span", { class: "name", textContent: "Loading…" })),
      rejoinBtn
    );
    return card;
  }

  const sessionText = s.status === "playing" && sessionStartTime
    ? ` · Session: ${formatPlaytime(Date.now() - sessionStartTime)}`
    : "";

  const label = {
    playing: "Live now" + sessionText,
    online: "Not playing a game",
    studio: s.gameName || "In Studio",
    offline: "Not connected"
  }[s.status];

  const title = { playing: s.gameName, online: "Online", studio: "Roblox Studio", offline: "Offline" }[s.status];

  if (s.status === "playing" && s.iconUrl) card.append(h("img", { class: "icon", src: s.iconUrl, alt: "" }));
  const txt = h("div", { class: "txt" },
    h("span", { class: "name", textContent: title }),
    h("span", { class: "status" }, h("span", { class: "dot" }), label));

  if (s.status === "playing") {
    const btns = h("div", { class: "btns" });
    if (s.placeId) {
      btns.append(makeDirectJoinBtn(s.placeId, null, s.gameId, "▶ Join"));
      btns.append(makeServerHopBtn(s.placeId, "empty", s.gameId));
      btns.append(makeServerHopBtn(s.placeId, "lowping", s.gameId));
    }
    if (s.gameUrl) {
      btns.append(makeCopyLinkBtn(s.gameUrl));
    }
    const copy = h("button", { class: "btn", textContent: "📋 Prompt" });
    copy.addEventListener("click", () => copyPrompt(s.gameName, s.placeId, copy));
    btns.append(copy);
    txt.append(btns);
  }
  card.append(txt, rejoinBtn);
  return card;
}

function friendRow(f) {
  const inGame = f.type === 2;
  const gameUrl = f.placeId ? `https://www.roblox.com/games/${f.placeId}` : null;
  const friendName = f.displayName || f.name || f.username || "Player";

  const sub = inGame
    ? (gameUrl
        ? h("a", { href: gameUrl, target: "_blank", textContent: "🎮 " + (f.location || "Playing") })
        : h("span", { textContent: "🎮 " + (f.location || "Playing") }))
    : f.type === 3 ? "🛠 Studio" : "🔵 Online";

  const row = h("div", { class: "row" },
    makeAvatarThumb(f.avatar, friendName),
    h("div", { class: "txt" },
      h("a", { href: `https://www.roblox.com/users/${f.id}/profile`, target: "_blank", textContent: friendName }),
      h("span", { class: "sub" }, sub)));

  if (inGame && f.placeId) {
    row.append(
      makeDirectJoinBtn(f.placeId, f.id, f.gameId, "▶ Join"),
      makeCopyLinkBtn(gameUrl)
    );
  }

  return row;
}

function updateHomeCurrent() {
  const slot = document.getElementById("home-current-slot");
  if (slot) slot.replaceChildren(currentCard());
}

function updateHomeFriends() {
  const box = document.getElementById("home-friends-list");
  if (!box) return;
  if (friendsError) box.replaceChildren(h("div", { class: "empty", textContent: "Couldn't load friends. Press Refresh to try again." }));
  else if (friends === null) box.replaceChildren(h("div", { class: "empty", textContent: "Loading…" }));
  else if (!friends.length) box.replaceChildren(h("div", { class: "empty", textContent: "No friends online right now." }));
  else box.replaceChildren(...friends.map(friendRow));
}

function renderHome() {
  listEl = null;

  const refreshBtn = h("button", {
    id: "refresh-friends-btn",
    class: "btn",
    textContent: "🔄 Refresh"
  });
  refreshBtn.addEventListener("click", () => manualRefreshFriends(false));

  main.replaceChildren(
    h("h2", { textContent: "Home" }),
    quickLaunchBar(),
    h("div", { id: "home-current-slot" }),
    h("div", { class: "section-header" },
      h("h3", { textContent: "Friends online" }),
      refreshBtn
    ),
    h("div", { id: "home-friends-list", class: "list" })
  );

  updateRefreshBtnUI();
  updateHomeCurrent();
  updateHomeFriends();
}

function historyRow(e) {
  const isFavView = view === "favorites";
  const hasVip = Boolean(e.vipUrl && e.vipUrl.trim());
  const hasNote = Boolean(e.note && e.note.trim());

  const star = h("button", {
    class: "star" + (e.fav ? " on" : ""),
    title: e.fav ? "Remove from favorites" : "Add to favorites",
    textContent: e.fav ? "★" : "☆"
  });
  star.addEventListener("click", () => toggleFav(e.placeId));

  const copy = h("button", { class: "btn", textContent: "📋", title: "Copy AI Prompt" });
  copy.addEventListener("click", () => copyPrompt(e.name, e.placeId, copy));

  const joinBtn = makeDirectJoinBtn(e.placeId, null, null, "▶ Join");
  const hopEmptyBtn = makeServerHopBtn(e.placeId, "empty", null);
  const hopPingBtn = makeServerHopBtn(e.placeId, "lowping", null);

  const timeStr = e.playTimeMs && e.playTimeMs > 0 ? ` · ⏱ ${formatPlaytime(e.playTimeMs)}` : "";

  const txtCol = h("div", { class: "txt" },
    h("a", { href: e.url, target: "_blank", textContent: e.name }),
    h("span", { class: "sub", textContent: `${fmtDate(e.lastPlayed)} · ${e.count}× played${timeStr}` })
  );

  if (isFavView && hasNote) {
    txtCol.append(
      h("span", {
        class: "sub",
        style: "color:#81d4fa; white-space:normal; margin-top:2px;",
        textContent: "📝 " + e.note
      })
    );
  }

  const topRow = h("div", { style: "display:flex; align-items:center; gap:10px; width:100%;" },
    makeGameThumb(e.iconUrl),
    txtCol
  );

  if (isFavView && hasVip) {
    const vipJoinBtn = h("a", {
      class: "btn purple",
      href: e.vipUrl,
      target: "_blank",
      textContent: "🔒 VIP Join",
      title: "Open Private Server link"
    });
    topRow.append(vipJoinBtn);
  }

  topRow.append(joinBtn, hopEmptyBtn, hopPingBtn);

  if (isFavView) {
    const noteToggleBtn = h("button", {
      class: "btn " + (hasNote || hasVip ? "primary" : ""),
      textContent: hasNote || hasVip ? "📝 VIP/Note" : "📝+",
      title: "Add/Edit Private Server & Note"
    });
    noteToggleBtn.addEventListener("click", () => {
      openNotePlaceId = Number(openNotePlaceId) === Number(e.placeId) ? null : e.placeId;
      refreshList();
    });
    topRow.append(noteToggleBtn);
  }

  topRow.append(copy, star);

  const wrapper = h("div", { class: "row", style: "flex-direction:column; align-items:stretch;" }, topRow);

  if (isFavView && Number(openNotePlaceId) === Number(e.placeId)) {
    const vipInput = h("input", {
      type: "text",
      placeholder: "Private Server URL (e.g. https://www.roblox.com/games/...?privateServerLinkCode=...)",
      value: e.vipUrl || ""
    });
    const noteInput = h("input", {
      type: "text",
      placeholder: "Note (e.g. Nick's VIP, AFK farming, codes...)",
      value: e.note || ""
    });

    const saveBtn = h("button", { class: "btn green", textContent: "💾 Save" });
    saveBtn.addEventListener("click", () => {
      updateGameMeta(e.placeId, {
        vipUrl: vipInput.value.trim(),
        note: noteInput.value.trim()
      });
      openNotePlaceId = null;
      showToast("✅ VIP / Note saved!");
    });

    const copyVipBtn = h("button", { class: "btn", textContent: "📋 Copy VIP Link" });
    copyVipBtn.addEventListener("click", async () => {
      if (!vipInput.value.trim()) {
        showToast("⚠️ No VIP link to copy.");
        return;
      }
      await navigator.clipboard.writeText(vipInput.value.trim());
      copyVipBtn.textContent = "Copied! ✔";
      setTimeout(() => (copyVipBtn.textContent = "📋 Copy VIP Link"), 1800);
    });

    const panel = h("div", {
      style: "display:flex; flex-direction:column; gap:8px; margin-top:8px; padding-top:8px; border-top:1px solid #333;"
    },
      vipInput,
      noteInput,
      h("div", { class: "btns" }, saveBtn, copyVipBtn)
    );

    wrapper.append(panel);
  }

  return wrapper;
}

function sortGames(items) {
  return [...items].sort((a, b) => {
    switch (sortBy) {
      case "oldest":
        return (a.lastPlayed || 0) - (b.lastPlayed || 0);
      case "playtime":
        return (b.playTimeMs || 0) - (a.playTimeMs || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0);
      case "count":
        return (b.count || 0) - (a.count || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0);
      case "name_asc":
        return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
      case "name_desc":
        return (b.name || "").localeCompare(a.name || "", undefined, { sensitivity: "base" });
      case "fav_first":
        return Number(Boolean(b.fav)) - Number(Boolean(a.fav)) || (b.lastPlayed || 0) - (a.lastPlayed || 0);
      case "recent":
      default:
        return (b.lastPlayed || 0) - (a.lastPlayed || 0);
    }
  });
}

async function refreshList() {
  if (!listEl) return;
  const { history = [] } = await chrome.storage.local.get("history");
  const onlyFav = view === "favorites";
  const t = searchTerm.trim().toLowerCase();
  const filtered = history.filter((e) => (!onlyFav || e.fav) && (!t || e.name.toLowerCase().includes(t)));
  const items = sortGames(filtered);

  listEl.replaceChildren(...(items.length
    ? items.map(historyRow)
    : [h("div", { class: "empty", textContent: onlyFav ? "No favorites yet. Tap ☆ in History." : "History is empty. It will fill automatically from Continue, or as you play." })]));
}

async function renderHistoryLike() {
  const onlyFav = view === "favorites";
  const { history = [] } = await chrome.storage.local.get("history");
  const totalMs = history.reduce((sum, item) => sum + (item.playTimeMs || 0), 0);

  const headerRow = h("div", { style: "display:flex; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap;" },
    h("h2", { style: "margin:0;", textContent: onlyFav ? "Favorites" : "History" })
  );

  if (totalMs > 0) {
    headerRow.append(
      h("span", {
        class: "badge time",
        textContent: `⏱ Total: ${formatPlaytime(totalMs)}`
      })
    );
  }

  if (!onlyFav && continueSyncStatus) {
    headerRow.append(
      h("span", {
        class: "badge" + (continueSyncStatus === "fallback" ? " fallback" : ""),
        textContent: continueSyncStatus === "api" ? "⚡ Synced from Roblox Continue" : "💾 Local history"
      })
    );
  }
  main.replaceChildren(headerRow);

  const search = h("input", { type: "text", placeholder: "Search…", value: searchTerm });
  search.addEventListener("input", () => { searchTerm = search.value; refreshList(); });

  const sortOptions = [
    { value: "recent", label: "🕒 Recent" },
    { value: "oldest", label: "⏳ Oldest" },
    { value: "playtime", label: "⏱ Most playtime" },
    { value: "count", label: "🔥 Most played" },
    { value: "name_asc", label: "🔤 Name (A → Z)" },
    { value: "name_desc", label: "🔠 Name (Z → A)" }
  ];
  if (!onlyFav) {
    sortOptions.push({ value: "fav_first", label: "⭐ Favorites first" });
  } else if (sortBy === "fav_first") {
    sortBy = "recent";
  }

  const sortSelect = h(
    "select",
    {
      title: "Sort list",
      on: {
        change: (ev) => {
          sortBy = ev.target.value;
          refreshList();
        }
      }
    },
    ...sortOptions.map((opt) =>
      h("option", { value: opt.value, textContent: opt.label, selected: opt.value === sortBy })
    )
  );

  const bar = h("div", { class: "bar" }, search, sortSelect);

  if (!onlyFav) {
    const syncBtn = h("button", { class: "btn", textContent: "🔄 Sync Continue" });
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = "⏳...";
      await syncContinueHistory();
      syncBtn.disabled = false;
      syncBtn.textContent = "🔄 Sync Continue";
      renderHistoryLike();
    });
    bar.append(syncBtn);
  }

  const randomBtn = h("button", {
    class: "btn primary",
    textContent: "🎲 Random Game",
    title: onlyFav ? "Launch a random favorite game" : "Launch a random game from your history"
  });
  randomBtn.addEventListener("click", () => playRandomFromHistory(onlyFav));
  bar.append(randomBtn);

  main.append(bar);

  listEl = h("div", { class: "list" });
  main.append(listEl);
  refreshList();
  fillMissingIcons();
}

async function renderSettings() {
  listEl = null;
  const {
    customPrompt,
    notifyEnabled = false,
    notifyMinutes = 60
  } = await chrome.storage.local.get(["customPrompt", "notifyEnabled", "notifyMinutes"]);

  // Enotita 1: Eidopoiisi Oriou Xronou Gaming
  const chkNotify = h("input", { type: "checkbox", checked: notifyEnabled });
  const inpMins = h("input", { type: "number", min: "1", max: "1440", value: String(notifyMinutes) });
  const saveNotifyBtn = h("button", { class: "btn green", textContent: "💾 Save Limit" });
  const testNotifyBtn = h("button", { class: "btn", textContent: "🔔 Test Notification" });

  saveNotifyBtn.addEventListener("click", async () => {
    const mins = Math.max(1, parseInt(inpMins.value, 10) || 60);
    inpMins.value = String(mins);
    await chrome.storage.local.set({
      notifyEnabled: chkNotify.checked,
      notifyMinutes: mins
    });
    sessionNotified = false;
    saveNotifyBtn.textContent = "Saved! ✔";
    setTimeout(() => (saveNotifyBtn.textContent = "💾 Save Limit"), 1500);
  });

  testNotifyBtn.addEventListener("click", () => {
    const mins = Math.max(1, parseInt(inpMins.value, 10) || 60);
    const msgText = `Test notification: You've played for ${mins} minutes straight!`;
    showToast("⏰ " + msgText, 5000);
    chrome.runtime.sendMessage({
      type: "NOTIFY_PLAYTIME",
      text: msgText
    });
  });

  const notifyBox = h("div", { class: "setting-box" },
    h("h3", { style: "margin-top:0;", textContent: "⏰ Playtime Reminder" }),
    h("div", { class: "note", textContent: "Notify me when a continuous play session exceeds the minutes below:" }),
    h("div", { class: "setting-row" },
      h("label", {}, chkNotify, "Enable notification"),
      inpMins,
      h("span", { style: "font-size:13px; color:#ccc;", textContent: "minutes" })
    ),
    h("div", { class: "btns", style: "margin-top:12px;" }, saveNotifyBtn, testNotifyBtn)
  );

  // Enotita 2: Custom AI Prompt
  const ta = h("textarea", { value: customPrompt || DEFAULT_PROMPT });
  const savePromptBtn = h("button", { class: "btn green", textContent: "💾 Save Prompt" });
  const resetPromptBtn = h("button", { class: "btn", textContent: "Reset to default" });

  savePromptBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({ customPrompt: ta.value.trim() });
    savePromptBtn.textContent = "Saved! ✔";
    setTimeout(() => (savePromptBtn.textContent = "💾 Save Prompt"), 1500);
  });

  resetPromptBtn.addEventListener("click", async () => {
    ta.value = DEFAULT_PROMPT;
    await chrome.storage.local.remove("customPrompt");
  });

  const promptBox = h("div", { class: "setting-box" },
    h("h3", { style: "margin-top:0;", textContent: "🤖 Custom AI Prompt" }),
    h("div", { class: "note", textContent: "Use {gameName} and {gameId} where you want them inserted." }),
    ta,
    h("div", { class: "btns", style: "margin-top:10px" }, savePromptBtn, resetPromptBtn)
  );

  main.replaceChildren(
    h("h2", { textContent: "Settings" }),
    notifyBox,
    promptBox
  );
}

function renderView() {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "home") renderHome();
  else if (view === "history" || view === "favorites") renderHistoryLike();
  else renderSettings();
}

document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    view = b.dataset.view;
    location.hash = view;
    renderView();
    if (view === "history") {
      syncContinueHistory();
    }
  }));

// ---------- title ----------
function updateTitle() {
  if (curError || !cur) { document.title = "Roblox Lite"; return; }
  document.title = { playing: "🟢 " + cur.gameName, online: "🔵 Online", studio: "🛠 Studio", offline: "⚪ Offline" }[cur.status];
}

// ---------- loops ----------
async function tick() {
  const now = Date.now();
  const deltaMs = now - lastTickTime;
  lastTickTime = now;

  try {
    const prevStatus = cur ? cur.status : null;
    cur = await RB.getState();
    curError = "";
    recordPlay(cur, deltaMs);

    if (cur.status === "playing" && cur.placeId) {
      lastPlayingGame = {
        placeId: cur.placeId,
        gameId: cur.gameId,
        name: cur.gameName
      };
      autoRejoinAttempts = 0;
    } else if (
      autoRejoin &&
      prevStatus === "playing" &&
      cur.status === "online" &&
      lastPlayingGame &&
      autoRejoinAttempts < 3
    ) {
      autoRejoinAttempts++;
      const target = { ...lastPlayingGame };
      showToast(`🔁 Disconnected from ${target.name}! Auto-Rejoin in 4s (${autoRejoinAttempts}/3)...`, 5000);

      setTimeout(async () => {
        if (!autoRejoin || (cur && cur.status === "playing")) return;
        const { history = [] } = await chrome.storage.local.get("history");
        const saved = history.find((x) => Number(x.placeId) === Number(target.placeId));
        if (saved && saved.vipUrl) {
          window.open(saved.vipUrl, "_blank");
        } else {
          await RB.launchGame(target.placeId, null, null);
        }
      }, 4000);
    }
  } catch (e) {
    curError = e.message === "not-logged-in" ? "Not logged in" : "Connection error";
  }
  updateTitle();
  if (view === "home") updateHomeCurrent();
  setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
}

// ---------- start ----------
chrome.storage.local.get("lastState", ({ lastState }) => {
  if (lastState && !cur) { cur = lastState; updateTitle(); if (view === "home") updateHomeCurrent(); }
});
renderView();
tick();
syncContinueHistory();
manualRefreshFriends(true);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    const now = Date.now();
    const deltaMs = now - lastTickTime;
    lastTickTime = now;
    RB.getState().then((s) => {
      cur = s;
      curError = "";
      recordPlay(s, deltaMs);
      updateTitle();
      if (view === "home") updateHomeCurrent();
    }).catch(() => {});
  }
});