// Κοινός κώδικας: ρωτάει live το Roblox API, φέρνει Continue games, Server Hop και Direct Join.
const RB = {
  csrf: "",
  avatarCache: new Map(),
  nameCache: new Map(),

  async req(url, opts = {}) {
    const go = () =>
      fetch(url, {
        credentials: "include",
        ...opts,
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": RB.csrf,
          ...(opts.headers || {})
        }
      });
    let r = await go();
    if (r.status === 403 && r.headers.get("x-csrf-token")) {
      RB.csrf = r.headers.get("x-csrf-token");
      r = await go();
    }
    return r;
  },

  async getUserId() {
    const { userId } = await chrome.storage.local.get("userId");
    if (userId) return userId;
    const r = await RB.req("https://users.roblox.com/v1/users/authenticated");
    if (!r.ok) throw new Error("not-logged-in");
    const j = await r.json();
    await chrome.storage.local.set({ userId: j.id });
    return j.id;
  },

  async getIcon(placeId) {
    const { iconCache = {} } = await chrome.storage.local.get("iconCache");
    if (iconCache[placeId]) return iconCache[placeId];
    try {
      const u = await (await RB.req(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)).json();
      const t = await (await RB.req(
        `https://thumbnails.roblox.com/v1/games/icons?universeIds=${u.universeId}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`
      )).json();
      const url = t.data?.[0]?.imageUrl || "";
      if (url) {
        iconCache[placeId] = url;
        await chrome.storage.local.set({ iconCache });
      }
      return url;
    } catch {
      return "";
    }
  },

  async getIconsByUniverseIds(universeIds) {
    const map = new Map();
    if (!universeIds.length) return map;
    try {
      const unique = [...new Set(universeIds)].slice(0, 50);
      const r = await RB.req(
        `https://thumbnails.roblox.com/v1/games/icons?universeIds=${unique.join(",")}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`
      );
      if (r.ok) {
        const j = await r.json();
        (j.data || []).forEach((d) => {
          if (d.imageUrl) map.set(d.targetId, d.imageUrl);
        });
      }
    } catch {}
    return map;
  },

  async getPresences(userIds) {
    const r = await RB.req("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      body: JSON.stringify({ userIds })
    });
    if (!r.ok) throw new Error("presence-" + r.status);
    return (await r.json()).userPresences || [];
  },

  // Η δική σου κατάσταση
  async getState() {
    const userId = await RB.getUserId();
    const p = (await RB.getPresences([userId]))[0];
    if (!p) throw new Error("no-presence");

    const state = {
      status: "offline",
      isPlaying: false,
      gameName: "",
      placeId: null,
      gameUrl: "",
      iconUrl: "",
      gameId: null
    };

    if (p.userPresenceType === 2) {
      state.status = "playing";
      state.isPlaying = true;
      state.gameName = p.lastLocation || "Roblox Game";
      state.placeId = p.rootPlaceId || p.placeId || null;
      state.gameId = p.gameId || null;
      if (state.placeId) {
        state.gameUrl = `https://www.roblox.com/games/${state.placeId}`;
        state.iconUrl = await RB.getIcon(state.placeId);
      }
    } else if (p.userPresenceType === 3) {
      state.status = "studio";
      state.gameName = p.lastLocation || "Roblox Studio";
    } else if (p.userPresenceType === 1) {
      state.status = "online";
    }

    await chrome.storage.local.set({ lastState: state });
    return state;
  },

  // Αυτόματο ιστορικό από την ενότητα "Continue" του Roblox API
  async getContinueGames() {
    await RB.getUserId();
    let games = [];

    try {
      const rOmni = await RB.req("https://apis.roblox.com/discovery-api/omni-recommendation", {
        method: "POST",
        body: JSON.stringify({
          pageType: "Home",
          sessionId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
          supportedTreatmentTypes: ["SortlessGrid"]
        })
      });
      if (rOmni.ok) {
        const data = await rOmni.json();
        const sorts = data.sorts || [];
        const continueSort = sorts.find(
          (s) =>
            (s.topic && s.topic.toLowerCase().includes("continue")) ||
            s.topicId === 100000003
        );
        const gameMeta = data.contentMetadata?.Game || {};
        if (continueSort && Array.isArray(continueSort.recommendationList)) {
          games = continueSort.recommendationList
            .map((item) => gameMeta[String(item.contentId)])
            .filter(Boolean)
            .map((g) => ({
              placeId: g.rootPlaceId,
              universeId: g.universeId,
              name: g.name || "Roblox Game"
            }));
        }
      }
    } catch {}

    if (!games.length) {
      const rList = await RB.req(
        "https://games.roblox.com/v1/games/list?model.sortToken=Continue&model.maxRows=40"
      );
      if (!rList.ok) throw new Error("continue-blocked-" + rList.status);
      const j = await rList.json();
      games = (j.games || []).map((g) => ({
        placeId: g.placeId,
        universeId: g.universeId,
        name: g.name || "Roblox Game"
      }));
    }

    if (!games.length) throw new Error("continue-empty");

    const universeIds = games.map((g) => g.universeId).filter(Boolean);
    const iconsMap = await RB.getIconsByUniverseIds(universeIds);

    const { iconCache = {} } = await chrome.storage.local.get("iconCache");
    let cacheUpdated = false;

    const result = games
      .filter((g) => g.placeId)
      .map((g) => {
        const iconUrl = iconsMap.get(g.universeId) || iconCache[g.placeId] || "";
        if (iconUrl && !iconCache[g.placeId]) {
          iconCache[g.placeId] = iconUrl;
          cacheUpdated = true;
        }
        return {
          placeId: g.placeId,
          name: g.name,
          url: `https://www.roblox.com/games/${g.placeId}`,
          iconUrl
        };
      });

    if (cacheUpdated) {
      await chrome.storage.local.set({ iconCache });
    }

    return result;
  },

  // Φίλοι online: [{ id, name, displayName, type, location, placeId, gameId, avatar }]
  async getFriendsOnline() {
    const userId = await RB.getUserId();
    const r = await RB.req(`https://friends.roblox.com/v1/users/${userId}/friends/online`);
    if (!r.ok) throw new Error("friends-" + r.status);
    const list = (await r.json()).data || [];
    if (!list.length) return [];

    const ids = list.map((f) => f.id).slice(0, 100);
    const presences = await RB.getPresences(ids);
    const byId = new Map(presences.map((p) => [p.userId, p]));

    await Promise.all([RB.loadAvatars(ids), RB.loadNames(ids)]);

    return list
      .filter((f) => ids.includes(f.id))
      .map((f) => {
        const p = byId.get(f.id) || {};
        const n = RB.nameCache.get(f.id) || {};
        return {
          id: f.id,
          name: f.name || n.name || "",
          displayName: f.displayName || n.displayName || f.name || n.name || "",
          type: p.userPresenceType ?? 1,
          location: p.lastLocation || "",
          placeId: p.rootPlaceId || p.placeId || null,
          gameId: p.gameId || null,
          avatar: RB.avatarCache.get(f.id) || ""
        };
      })
      .sort((a, b) => (b.type === 2) - (a.type === 2));
  },

  // Το friends/online δεν επιστρέφει ονόματα, οπότε τα φέρνουμε από το users API
  async loadNames(ids) {
    const missing = ids.filter((id) => !RB.nameCache.has(id));
    if (!missing.length) return;
    try {
      const r = await RB.req("https://users.roblox.com/v1/users", {
        method: "POST",
        body: JSON.stringify({ userIds: missing, excludeBannedUsers: false })
      });
      if (!r.ok) return;
      const j = await r.json();
      (j.data || []).forEach((u) =>
        RB.nameCache.set(u.id, { name: u.name, displayName: u.displayName || u.name })
      );
    } catch {}
  },

  async loadAvatars(ids) {
    const missing = ids.filter((id) => !RB.avatarCache.has(id));
    if (!missing.length) return;
    try {
      const r = await RB.req(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${missing.join(",")}&size=48x48&format=Png&isCircular=true`
      );
      const j = await r.json();
      (j.data || []).forEach((d) => RB.avatarCache.set(d.targetId, d.imageUrl || ""));
    } catch {}
  },

  // Server Hop: mode = "empty" (λιγότεροι παίκτες) | "lowping" (χαμηλότερο ping)
  async serverHop(placeId, mode = "empty", excludeGameId = null) {
    if (!placeId) return;
    const sortOrder = mode === "empty" ? "Asc" : "Desc";
    const r = await RB.req(
      `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=${sortOrder}&limit=50&excludeFullGames=true`
    );
    if (!r.ok) {
      throw new Error("Δεν βρέθηκε λίστα servers (" + r.status + ")");
    }
    const j = await r.json();
    let servers = (j.data || []).filter((s) => s.id && s.playing < s.maxPlayers);

    if (excludeGameId) {
      const filtered = servers.filter((s) => s.id !== excludeGameId);
      if (filtered.length) servers = filtered;
    }

    if (!servers.length) {
      throw new Error("Δεν βρέθηκαν διαθέσιμοι public servers.");
    }

    let chosen = servers[0];
    if (mode === "lowping") {
      // Ταξινόμηση με βάση το χαμηλότερο ping (αν επιστρέφεται από το API)
      const withPing = servers.filter((s) => typeof s.ping === "number" && s.ping > 0);
      if (withPing.length) {
        withPing.sort((a, b) => a.ping - b.ping);
        chosen = withPing[0];
      }
    } else {
      // "empty": παίρνουμε τον server με τους λιγότερους παίκτες (τουλάχιστον 1 ενεργό)
      servers.sort((a, b) => a.playing - b.playing);
      chosen = servers[0];
    }

    await RB.launchGame(placeId, null, chosen.id);
    return chosen;
  },

  // Εκκίνηση παιχνιδιού απευθείας στον Roblox Client μέσω roblox-player: protocol με έγκυρο ticket
  async launchGame(placeId, followUserId = null, gameInstanceId = null) {
    if (!placeId) return;

    const r = await RB.req("https://auth.roblox.com/v1/authentication-ticket", {
      method: "POST",
      body: "{}"
    });

    const authTicket = r.headers.get("rbx-authentication-ticket") || "";

    if (!authTicket) {
      alert("Δεν ήταν δυνατή η λήψη Authentication Ticket (Error 403). Βεβαιώσου ότι είσαι συνδεδεμένος στο roblox.com και κάνε Reload το extension.");
      return;
    }

    const launchTime = Date.now();
    const browserTrackerId = Math.floor(100000000 + Math.random() * 900000000);

    let requestType = "RequestGame";
    let extraParams = `&placeId=${placeId}&isPlayTogetherGame=false`;

    if (followUserId) {
      requestType = "RequestFollowUser";
      extraParams = `&userId=${followUserId}`;
    } else if (gameInstanceId) {
      requestType = "RequestGameJob";
      extraParams = `&placeId=${placeId}&gameId=${gameInstanceId}`;
    }

    const fullLauncherUrl = `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=${requestType}&browserTrackerId=${browserTrackerId}${extraParams}`;

    const protocolUrl =
      `roblox-player:1+launchmode:play` +
      `+gameinfo:${encodeURIComponent(authTicket)}` +
      `+launchtime:${launchTime}` +
      `+placelauncherurl:${encodeURIComponent(fullLauncherUrl)}` +
      `+browsertrackerid:${browserTrackerId}` +
      `+robloxLocale:en_us+gameLocale:en_us`;

    let iframe = document.getElementById("rb-protocol-launcher");
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.id = "rb-protocol-launcher";
      iframe.style.display = "none";
      document.body.appendChild(iframe);
    }
    iframe.src = protocolUrl;
  }
};