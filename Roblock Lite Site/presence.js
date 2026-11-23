// Shared code: queries the Roblox API live (presence, friends, Continue games, Server Hop, Direct Join).
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

  // Your own status
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

  // Automatic history from the Roblox "Continue" section
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

  // Friends online: [{ id, name, displayName, type, location, placeId, gameId, avatar }]
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

  // friends/online doesn't return names, so we fetch them from the users API
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

  // Icons for several places at once: Map(placeId -> url). Cache first, then one batch request.
  async getIconsByPlaceIds(placeIds) {
    const out = new Map();
    const ids = [...new Set((placeIds || []).filter(Boolean).map(Number))];
    if (!ids.length) return out;
    const { iconCache = {} } = await chrome.storage.local.get("iconCache");
    const need = [];
    ids.forEach((id) => (iconCache[id] ? out.set(id, iconCache[id]) : need.push(id)));
    if (need.length) {
      try {
        const r = await RB.req(
          `https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${need.slice(0, 50).join(",")}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`
        );
        if (r.ok) {
          ((await r.json()).data || []).forEach((d) => {
            if (!d.imageUrl) return;
            out.set(Number(d.targetId), d.imageUrl);
            if (!d.state || d.state === "Completed") iconCache[d.targetId] = d.imageUrl;
          });
          await chrome.storage.local.set({ iconCache });
        }
      } catch {}
    }
    return out;
  },

  // Home page sections from the Roblox discovery API: "Recently Visited" and "Recommended For You".
  // Returns { recent: [...], recommended: [...], topics: [...] }
  async getHomeSorts() {
    await RB.getUserId();
    const makeBody = (types) =>
      JSON.stringify({
        pageType: "Home",
        sessionId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        supportedTreatmentTypes: types
      });

    let data = null;
    for (const types of [["Carousel", "SortlessGrid"], ["SortlessGrid"]]) {
      try {
        const r = await RB.req("https://apis.roblox.com/discovery-api/omni-recommendation", {
          method: "POST",
          body: makeBody(types)
        });
        if (r.ok) {
          data = await r.json();
          break;
        }
      } catch {}
    }
    if (!data) throw new Error("home-unavailable");

    const sorts = data.sorts || [];
    const meta = data.contentMetadata?.Game || {};
    const topics = sorts.map((s) => s.topic).filter(Boolean);
    console.info("[Lite] Home sorts found:", topics);

    const toGames = (sort) =>
      (sort?.recommendationList || [])
        .map((item) => meta[String(item.contentId)])
        .filter(Boolean)
        .map((g) => ({
          placeId: g.rootPlaceId,
          universeId: g.universeId,
          name: g.name || "Roblox Game",
          playerCount: typeof g.playerCount === "number" ? g.playerCount : null,
          upVotes: g.totalUpVotes,
          downVotes: g.totalDownVotes
        }))
        .filter((g) => g.placeId)
        .slice(0, 20);

    const find = (re) => sorts.find((s) => s.topic && re.test(s.topic));
    // Topic names come localized from Roblox (English, Greek...), so match both languages and the Continue topicId
    const recentSort =
      find(/recent|visited|πρόσφατ|επισκ/i) ||
      sorts.find((s) => s.topicId === 100000003) ||
      find(/continue|συνέχ/i);
    let recSort = find(/recommend|προτειν|προτάσ/i);
    if (!recSort) {
      // Fallback: first other sort that has enough games
      recSort = sorts.find((s) => s !== recentSort && (s.recommendationList || []).length >= 4);
    }

    const recent = toGames(recentSort);
    const recommended = toGames(recSort);

    const icons = await RB.getIconsByUniverseIds(
      [...recent, ...recommended].map((g) => g.universeId).filter(Boolean)
    );
    const decorate = (g) => ({
      ...g,
      url: `https://www.roblox.com/games/${g.placeId}`,
      iconUrl: icons.get(g.universeId) || ""
    });

    return { recent: recent.map(decorate), recommended: recommended.map(decorate), topics };
  },

  // Server Hop: mode = "empty" (fewest players) | "lowping" (lowest ping)
  async serverHop(placeId, mode = "empty", excludeGameId = null) {
    if (!placeId) return;
    const sortOrder = mode === "empty" ? "Asc" : "Desc";
    const r = await RB.req(
      `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=${sortOrder}&limit=50&excludeFullGames=true`
    );
    if (!r.ok) {
      throw new Error("Could not load the server list (" + r.status + ")");
    }
    const j = await r.json();
    let servers = (j.data || []).filter((s) => s.id && s.playing < s.maxPlayers);

    if (excludeGameId) {
      const filtered = servers.filter((s) => s.id !== excludeGameId);
      if (filtered.length) servers = filtered;
    }

    if (!servers.length) {
      throw new Error("No available public servers found.");
    }

    let chosen = servers[0];
    if (mode === "lowping") {
      // Sort by lowest ping (if the API returns it)
      const withPing = servers.filter((s) => typeof s.ping === "number" && s.ping > 0);
      if (withPing.length) {
        withPing.sort((a, b) => a.ping - b.ping);
        chosen = withPing[0];
      }
    } else {
      // "empty": pick the server with the fewest players
      servers.sort((a, b) => a.playing - b.playing);
      chosen = servers[0];
    }

    await RB.launchGame(placeId, null, chosen.id);
    return chosen;
  },

  // Launch a game directly in the Roblox Client via the roblox-player: protocol with a valid ticket
  async launchGame(placeId, followUserId = null, gameInstanceId = null) {
    if (!placeId) return;

    const r = await RB.req("https://auth.roblox.com/v1/authentication-ticket", {
      method: "POST",
      body: "{}"
    });

    const authTicket = r.headers.get("rbx-authentication-ticket") || "";

    if (!authTicket) {
      alert("Could not get an authentication ticket (error 403). Make sure you are logged in to roblox.com and reload the extension.");
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