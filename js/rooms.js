/* 房间模式客户端：连接 WebSocket 服务，创建/加入房间，抽牌/使用/重置。
 * 所有玩法状态以服务端快照为准；未使用的卡牌绝不下发到其他玩家。 */
(() => {
  "use strict";

  const skills = window.MAHJONG_SKILLS || [];
  const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
  const MAX_DRAW = 6;
  const MIN_PLAYERS = 2; // 必须与 server/room-manager.js 中 MIN_PLAYERS 保持一致
  // 座位方位，索引与 server/room-manager.js 的 DIRECTIONS 保持一致：N=0, E=1, S=2, W=3
  const DIRECTIONS = ["N", "E", "S", "W"];
  const DIR_LABEL = { N: "北", E: "东", S: "南", W: "西" };

  const LS = { token: "mj-room-token", code: "mj-room-code", url: "mj-server-url" };
  const $ = (id) => document.getElementById(id);

  const el = {
    modeSolo: $("modeSolo"),
    modeRoom: $("modeRoom"),
    screenSolo: $("screenSolo"),
    screenRoom: $("screenRoom"),
    // 大厅
    lobby: $("roomLobby"),
    serverUrl: $("serverUrl"),
    createName: $("createName"),
    roomNMinus: $("roomNMinus"),
    roomNValue: $("roomNValue"),
    roomNPlus: $("roomNPlus"),
    roomPoolBtn: $("roomPoolBtn"),
    createBtn: $("createBtn"),
    joinCode: $("joinCode"),
    joinName: $("joinName"),
    joinBtn: $("joinBtn"),
    searchBtn: $("searchBtn"),
    roomList: $("roomList"),
    roomStatus: $("roomStatus"),
    // 房间内
    roomView: $("roomView"),
    roomCode: $("roomCode"),
    roomRound: $("roomRound"),
    roomRole: $("roomRole"),
    roomConn: $("roomConn"),
    leaveBtn: $("leaveBtn"),
    hostPanel: $("hostPanel"),
    startBtnRoom: $("startBtnRoom"),
    resetBtnRoom: $("resetBtnRoom"),
    seats: $("seats"),
    handSection: $("handSection"),
    boardSection: $("boardSection"),
    preGameHint: $("preGameHint"),
    roomHand: $("roomHand"),
    board: $("board"),
    // 房间技能池
    roomPoolSheet: $("roomPoolSheet"),
    roomPoolBackdrop: $("roomPoolBackdrop"),
    roomPoolClose: $("roomPoolClose"),
    roomSelectAll: $("roomSelectAll"),
    roomClearAll: $("roomClearAll"),
    roomPoolCount: $("roomPoolCount"),
    roomPoolList: $("roomPoolList"),
    roomPoolConfirm: $("roomPoolConfirm"),
    // 确认弹窗
    confirmModal: $("confirmModal"),
    confirmBackdrop: $("confirmBackdrop"),
    confirmText: $("confirmText"),
    confirmCancel: $("confirmCancel"),
    confirmOk: $("confirmOk"),
  };

  let ws = null;
  let token = localStorage.getItem(LS.token) || null;
  let roomCode = localStorage.getItem(LS.code) || null;
  let snapshot = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pendingAction = null; // 连接就绪后自动补发的动作（create/join）
  let intentionalClose = false; // 主动离开房间，不再自动重连

  let selectedPool = new Set(skills.map((s) => s.id));
  let draftPool = new Set(selectedPool);
  let roomN = 3;
  let pendingConfirm = null;

  /* ---------------- 工具 ---------------- */

  function fmtRule(rule) {
    return String(rule || "").replace(/([。；])/g, "$1\n").replace(/\n+$/g, "");
  }

  function dirIndex(d) {
    return DIRECTIONS.indexOf(d);
  }

  // 将某方位映射到屏幕槽位：0=上(北) 1=右(东) 2=下(南) 3=左(西)
  // 未开始时锚点固定为南(2)：所有人看到绝对方位（南在下、北在上）。
  // 开始后锚点=本人方位：本人座位旋转到下方，其余玩家相对位置不变。
  function dirToSlot(dir, anchor) {
    return ((dirIndex(dir) - anchor + 2) % 4 + 4) % 4;
  }

  /* 服务端只接管 /ws 路径。地址缺路径时握手会被拒(400)，
   * 表现为"网页打得开、但一点创建房间就没反应"，所以这里统一补齐。 */
  function normalizeWsUrl(raw) {
    let s = String(raw || "").trim();
    if (!s) return s;
    if (!/^wss?:\/\//i.test(s)) s = "ws://" + s; // 没写协议就补上
    try {
      const u = new URL(s);
      if (!u.pathname || u.pathname === "/") u.pathname = "/ws";
      return u.toString();
    } catch (e) {
      return s; // 实在解析不了就用原值，让 WebSocket 自己报错
    }
  }

  function defaultWsUrl() {
    // 1) Node 服务托管的页面：服务端已按访问地址注入真实 WS 地址（本机/局域网/整站云部署）
    const injected = window.__WS_URL__;
    if (injected && injected !== "__MJ_WS_URL__") return normalizeWsUrl(injected);
    // 2) 纯静态托管（Netlify 等）：用 js/config.js 里预置的后端地址
    const configured = window.MJ_PUBLIC_WS_URL;
    if (configured) return normalizeWsUrl(configured);
    // 3) 兜底：https 页面只能连 wss，走同源；http 页面假设本机 node 服务在 3000 端口
    if (location.protocol === "https:") {
      return normalizeWsUrl(`wss://${location.host}`);
    }
    return normalizeWsUrl(`ws://${location.hostname}:3000`);
  }

  function currentWsUrl() {
    const v = (el.serverUrl.value || "").trim();
    if (v) return normalizeWsUrl(v);
    const saved = localStorage.getItem(LS.url);
    if (saved) return normalizeWsUrl(saved);
    return defaultWsUrl();
  }

  function setStatus(msg) {
    el.roomStatus.textContent = msg || "";
  }

  function showToast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.classList.add("is-hide");
      setTimeout(() => t.remove(), 300);
    }, 2400);
  }

  function setConn(state) {
    const map = {
      online: ["已连接", "online", ""],
      connecting: ["连接中…", "connecting", "正在连接服务器…"],
      offline: ["已断开 · 重连中", "offline", "连接已断开，正在自动重试…"],
      error: [
        "连接失败",
        "offline",
        "连不上服务器：请确认地址正确，且电脑防火墙已放行 3000 端口入站",
      ],
      idle: ["未连接", "offline", ""],
    };
    const [txt, cls, tip] = map[state] || map.connecting;
    el.roomConn.dataset.state = cls;
    el.roomConn.querySelector(".txt").textContent = txt;
    // 大厅里看不到 roomConn 指示灯，把关键提示写进状态栏，避免"点了没反应"
    if (el.roomView.hidden) setStatus(tip);
  }

  /* ---------------- WebSocket ---------------- */

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    setConn("connecting");
    const url = currentWsUrl();
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setConn("error");
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      reconnectAttempts = 0;
      setConn("online");
      // 有排队动作（建房/加入）时先补发，命中后就不用再 resume
      if (pendingAction) {
        const act = pendingAction;
        pendingAction = null;
        send(act);
        return;
      }
      if (token && roomCode) {
        send({ type: "resume", token, roomCode });
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      handleServer(msg);
    };
    ws.onclose = () => {
      if (intentionalClose) {
        intentionalClose = false;
        return;
      }
      setConn("offline");
      // 即使从未进过房间（此时没有 token），只要停在房间模式就重试；
      // 否则首次连不上就永久卡死，再点"创建房间"只会静默失败。
      scheduleReconnect();
    };
    ws.onerror = () => setConn("error");
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (el.screenRoom.hidden) return; // 已切回单机模式，不必再连
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 8000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // 未连接时不能静默丢弃用户操作：先发起连接，连上后自动补发，并给出可见提示
  function sendOrQueue(obj, tip) {
    if (send(obj)) return true;
    pendingAction = obj;
    setStatus(tip || "正在连接服务器，连上后会自动继续…");
    connect();
    return false;
  }

  function handleServer(msg) {
    switch (msg.type) {
      case "state":
        if (msg.token) {
          token = msg.token;
          roomCode = msg.snapshot.roomCode;
          localStorage.setItem(LS.token, token);
          localStorage.setItem(LS.code, roomCode);
        }
        snapshot = msg.snapshot;
        showRoom();
        render();
        break;
      case "rooms":
        renderRoomList(msg.list);
        break;
      case "room_closed":
        // 房主离开导致房间解散
        showToast("房间已解散（房主已离开）");
        clearSession();
        showLobby();
        setConn("idle");
        setStatus("房间已解散，请重新创建或加入。");
        break;
      case "left":
        // 自己主动离开，已由本地逻辑处理；此处无需额外动作
        break;
      case "error":
        handleError(msg);
        break;
    }
  }

  function handleError(msg) {
    if (msg.code === "ROOM_NOT_FOUND" && token) {
      clearSession();
      showLobby();
      setStatus("房间已失效（可能服务已重启），请重新创建或加入。");
      return;
    }
    showToast(msg.message || "操作失败");
  }

  function clearSession() {
    token = null;
    roomCode = null;
    snapshot = null;
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.code);
  }

  /* ---------------- 视图切换 ---------------- */

  function showLobby() {
    el.roomView.hidden = true;
    el.lobby.hidden = false;
  }

  function showRoom() {
    el.lobby.hidden = true;
    el.roomView.hidden = false;
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!snapshot) return;
    const started = snapshot.started;
    el.roomCode.textContent = snapshot.roomCode;
    el.roomRound.textContent = `第 ${snapshot.round} 局`;
    el.roomRole.textContent = snapshot.me.isHost ? "房主" : "玩家";
    el.hostPanel.hidden = !snapshot.me.isHost;

    // 未开始阶段：隐藏「你的手牌」「已打出技能」与「重置本局」；仅显示座位与开始按钮
    el.handSection.hidden = !started;
    el.boardSection.hidden = !started;
    el.preGameHint.hidden = started;

    // 房主「开始游戏」按钮：仅未开始时显示；人数不足时禁用并提示
    if (snapshot.me.isHost && !started) {
      el.startBtnRoom.hidden = false;
      const enough = snapshot.players.length >= MIN_PLAYERS;
      el.startBtnRoom.disabled = !enough;
      if (!enough) setStatus(`至少需要 ${MIN_PLAYERS} 名玩家才能开始（当前 ${snapshot.players.length}）`);
    } else {
      el.startBtnRoom.hidden = true;
    }
    // 重置按钮：仅房主且已开始时可见
    el.resetBtnRoom.hidden = !(snapshot.me.isHost && started);

    renderSeats();
    renderHand();
    renderBoard();
  }

  // 东南西北罗盘座位：四个槽位 UI 固定（上=北 右=东 下=南 左=西），
  // 槽位本身不动，玩家在槽位间移动；开始后每位玩家视角旋转到自己位于下方。
  function renderSeats() {
    const started = snapshot.started;
    const anchor = started ? dirIndex(snapshot.me.direction) : 2; // 未开始锚点=南(2)，绝对方位；开始后锚点=本人
    const myId = snapshot.me.id;
    const playersByDir = new Map(snapshot.players.map((p) => [p.direction, p]));
    const container = el.seats;
    container.innerHTML = "";
    const frag = document.createDocumentFragment();

    const center = document.createElement("div");
    center.className = "seats__center";
    center.innerHTML = `<span class="seats__center-label">${started ? "进行中" : "等待开始"}</span>`;
    frag.appendChild(center);

    // 屏幕四个固定槽位：0=上(北) 1=右(东) 2=下(南) 3=左(西)
    for (let slot = 0; slot < 4; slot += 1) {
      const dir = DIRECTIONS[slot]; // 该槽位固定显示的方位角标
      const absDir = DIRECTIONS[((slot - 2 + anchor) % 4 + 4) % 4]; // 当前锚点下映射到该槽位的真实方位
      const player = playersByDir.get(absDir);
      const seat = document.createElement("div");
      seat.className = `seat seat--${dir}`;
      if (!player) {
        seat.classList.add("seat--empty");
        seat.innerHTML = `<div class="seat__empty">空位<br><span class="seat__dir">${DIR_LABEL[absDir]}</span></div>`;
        if (!started) {
          seat.classList.add("seat--pickable");
          seat.addEventListener("click", () => send({ type: "sit", token, direction: absDir }));
        }
      } else {
        const used = snapshot.publicCards.filter((c) => c.ownerId === player.id).length;
        if (player.id === myId) seat.classList.add("seat--me");
        if (!player.online) seat.classList.add("is-offline");
        seat.innerHTML =
          `<span class="seat__dir">${DIR_LABEL[player.direction]}</span>` +
          `<span class="seat__name">${escapeHtml(player.name)}${player.isHost ? ' <em class="seat__host">房主</em>' : ""}${player.id === myId ? ' <em class="seat__you">你</em>' : ""}</span>` +
          `<span class="seat__info">手牌 ${player.drawnCount} · 已打出 ${used}</span>`;
      }
      frag.appendChild(seat);
    }
    container.appendChild(frag);
  }

  function renderHand() {
    const cards = snapshot.privateCards || [];
    // 游戏尚未开始：本区块整体隐藏，这里仅做安全兜底
    if (!snapshot.started) {
      el.roomHand.innerHTML = "";
      return;
    }
    if (cards.length === 0) {
      el.roomHand.innerHTML = '<p class="empty">暂无手牌</p>';
      return;
    }
    el.roomHand.innerHTML = "";
    const frag = document.createDocumentFragment();
    cards.forEach((skill, i) => {
      const card = document.createElement("article");
      card.className = "mcard";
      card.style.animationDelay = `${i * 60}ms`;
      const top = document.createElement("div");
      top.className = "mcard__top";
      top.innerHTML =
        `<span class="mcard__code">${escapeHtml(skill.code)}</span>` +
        `<span class="mcard__group">${escapeHtml(skill.group)}</span>`;
      const name = document.createElement("h3");
      name.className = "mcard__name";
      name.textContent = skill.name;
      const rule = document.createElement("p");
      rule.className = "mcard__rule";
      rule.textContent = fmtRule(skill.rule);
      const play = document.createElement("button");
      play.type = "button";
      play.className = "mcard__play";
      if (skill.used) {
        play.textContent = "已打出";
        play.disabled = true;
        card.classList.add("is-used");
      } else {
        play.textContent = "打出";
        play.dataset.id = skill.id;
        play.addEventListener("click", () => {
          if (send({ type: "use", token, cardId: skill.id })) play.disabled = true;
        });
      }
      card.appendChild(top);
      card.appendChild(name);
      card.appendChild(rule);
      card.appendChild(play);
      frag.appendChild(card);
    });
    el.roomHand.appendChild(frag);
  }

  function renderBoard() {
    const cards = snapshot.publicCards || [];
    if (cards.length === 0) {
      el.board.innerHTML = '<p class="empty">还没有人打出技能</p>';
      return;
    }
    el.board.innerHTML = "";
    const frag = document.createDocumentFragment();
    cards.forEach((skill) => {
      const e = document.createElement("div");
      e.className = "effect";
      e.innerHTML =
        `<div class="effect__head">` +
        `<span class="effect__tag">${escapeHtml(skill.ownerName || "某人")} 打出了</span>` +
        `<span class="effect__name">${escapeHtml(skill.name)}</span>` +
        `<span class="effect__code">${escapeHtml(skill.code)} · ${escapeHtml(skill.group)}</span>` +
        `</div>` +
        `<p class="effect__rule">${escapeHtml(fmtRule(skill.rule))}</p>`;
      frag.appendChild(e);
    });
    el.board.appendChild(frag);
  }

  function renderRoomList(list) {
    if (!list || list.length === 0) {
      el.roomList.hidden = false;
      el.roomList.innerHTML = '<p class="empty">本服务器上暂无房间</p>';
      return;
    }
    el.roomList.hidden = false;
    el.roomList.innerHTML = "";
    const frag = document.createDocumentFragment();
    list.forEach((r) => {
      const li = document.createElement("li");
      li.className = "room-list__item";
      li.innerHTML =
        `<div class="room-list__main">` +
        `<span class="room-list__code">${escapeHtml(r.roomCode)}</span>` +
        `<span class="room-list__sub">房主 ${escapeHtml(r.hostName || "—")} · ${r.playerCount}/${r.maxPlayers} 人 · 每人 ${r.drawCount} 张</span>` +
        `</div>` +
        `<button type="button" class="chip" data-code="${escapeHtml(r.roomCode)}">加入</button>`;
      frag.appendChild(li);
    });
    el.roomList.appendChild(frag);
    el.roomList.querySelectorAll("button[data-code]").forEach((b) => {
      b.addEventListener("click", () => {
        el.joinCode.value = b.dataset.code;
        el.joinName.focus();
        el.joinName.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- 大厅操作 ---------------- */

  function doCreate() {
    const name = (el.createName.value || "").trim();
    if (!name) return setStatus("请填写昵称");
    if (selectedPool.size === 0) return setStatus("技能池不能为空，请至少勾选一张");
    const drawCount = Math.min(roomN, selectedPool.size);
    if (drawCount < 1) return setStatus("每人抽数至少为 1");
    setStatus("");
    sendOrQueue(
      { type: "create", name, skillIds: [...selectedPool], drawCount },
      "正在连接服务器，连上后会自动创建房间…"
    );
  }

  function doJoin() {
    const code = (el.joinCode.value || "").trim().replace(/\D/g, "").padStart(6, "0").slice(-6);
    const name = (el.joinName.value || "").trim();
    if (!/^\d{6}$/.test(code)) return setStatus("请输入 6 位房间码");
    if (!name) return setStatus("请填写昵称");
    setStatus("");
    sendOrQueue({ type: "join", roomCode: code, name }, "正在连接服务器，连上后会自动加入房间…");
  }

  function doSearch() {
    if (!send({ type: "list_rooms" })) {
      setStatus("未连接到服务器，无法搜索");
    } else {
      setStatus("正在搜索本服务器上的房间…");
    }
  }

  /* ---------------- 房间技能池选择 ---------------- */

  function openRoomPool() {
    draftPool = new Set(selectedPool);
    renderRoomPool();
    el.roomPoolSheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeRoomPool() {
    el.roomPoolSheet.hidden = true;
    document.body.style.overflow = "";
  }

  function renderRoomPool() {
    el.roomPoolList.innerHTML = "";
    const frag = document.createDocumentFragment();
    skills.forEach((skill) => {
      const li = document.createElement("li");
      li.className = "skill-item" + (draftPool.has(skill.id) ? " is-checked" : "");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `rpool-${skill.id}`;
      input.checked = draftPool.has(skill.id);
      input.addEventListener("change", () => {
        if (input.checked) draftPool.add(skill.id);
        else draftPool.delete(skill.id);
        li.classList.toggle("is-checked", input.checked);
        updateRoomPoolCount();
      });
      const body = document.createElement("label");
      body.className = "skill-item__body";
      body.htmlFor = input.id;
      body.innerHTML =
        `<p class="skill-item__name">${escapeHtml(skill.name)}</p>` +
        `<p class="skill-item__rule">${escapeHtml(fmtRule(skill.rule))}</p>`;
      li.appendChild(input);
      li.appendChild(body);
      frag.appendChild(li);
    });
    el.roomPoolList.appendChild(frag);
    updateRoomPoolCount();
  }

  function updateRoomPoolCount() {
    el.roomPoolCount.textContent = `已选 ${draftPool.size}`;
    el.roomPoolBtn.textContent = `技能池 · 已选 ${draftPool.size}`;
  }

  /* ---------------- 确认弹窗 ---------------- */

  function askConfirm(text, onOk) {
    el.confirmText.textContent = text;
    pendingConfirm = onOk;
    el.confirmModal.hidden = false;
  }

  function closeConfirm() {
    el.confirmModal.hidden = true;
    pendingConfirm = null;
  }

  /* ---------------- 事件绑定 ---------------- */

  function clampRoomN(v) {
    if (v < 1) v = 1;
    if (v > MAX_DRAW) v = MAX_DRAW;
    roomN = v;
    el.roomNValue.textContent = roomN;
    el.roomNMinus.disabled = roomN <= 1;
    el.roomNPlus.disabled = roomN >= MAX_DRAW;
  }

  function bind() {
    el.modeSolo.addEventListener("click", () => {
      el.modeSolo.classList.add("is-active");
      el.modeRoom.classList.remove("is-active");
      el.screenSolo.hidden = false;
      el.screenRoom.hidden = true;
    });
    el.modeRoom.addEventListener("click", () => {
      el.modeRoom.classList.add("is-active");
      el.modeSolo.classList.remove("is-active");
      el.screenSolo.hidden = true;
      el.screenRoom.hidden = false;
      connect();
    });

    el.createBtn.addEventListener("click", doCreate);
    el.joinBtn.addEventListener("click", doJoin);
    el.searchBtn.addEventListener("click", doSearch);

    el.roomNMinus.addEventListener("click", () => clampRoomN(roomN - 1));
    el.roomNPlus.addEventListener("click", () => clampRoomN(roomN + 1));

    el.roomPoolBtn.addEventListener("click", openRoomPool);
    el.roomPoolClose.addEventListener("click", closeRoomPool);
    el.roomPoolBackdrop.addEventListener("click", closeRoomPool);
    el.roomSelectAll.addEventListener("click", () => {
      draftPool = new Set(skills.map((s) => s.id));
      renderRoomPool();
    });
    el.roomClearAll.addEventListener("click", () => {
      draftPool.clear();
      renderRoomPool();
    });
    el.roomPoolConfirm.addEventListener("click", () => {
      selectedPool = new Set(draftPool);
      updateRoomPoolCount();
      closeRoomPool();
    });

    el.startBtnRoom.addEventListener("click", () => {
      if (!snapshot || snapshot.started) return;
      if (snapshot.players.length < MIN_PLAYERS) {
        return setStatus(`至少需要 ${MIN_PLAYERS} 名玩家才能开始`);
      }
      sendOrQueue({ type: "start", token }, "正在连接服务器，连上后会开始游戏…");
    });
    el.resetBtnRoom.addEventListener("click", () => {
      askConfirm("确定重置本局？将清空所有玩家的手牌与公开记录，开始新一局（房间/成员/配置保留）。", () => {
        send({ type: "reset", token });
      });
    });

    el.leaveBtn.addEventListener("click", () => {
      // 主动离开：先通知服务端（房主离开会解散房间），再关闭连接、退回大厅、不再自动重连
      if (ws && ws.readyState === WebSocket.OPEN) {
        send({ type: "leave", token });
      }
      intentionalClose = true;
      pendingAction = null;
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
      }
      clearSession();
      showLobby();
      setConn("idle");
      setStatus("");
    });

    el.roomCode.addEventListener("click", () => {
      const code = snapshot ? snapshot.roomCode : "";
      if (!code) return;
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => showToast("房间码已复制"));
      else showToast(`房间码：${code}`);
    });

    el.confirmCancel.addEventListener("click", closeConfirm);
    el.confirmBackdrop.addEventListener("click", closeConfirm);
    el.confirmOk.addEventListener("click", () => {
      const fn = pendingConfirm;
      closeConfirm();
      if (fn) fn();
    });
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    el.serverUrl.value = localStorage.getItem(LS.url) || defaultWsUrl();
    el.serverUrl.addEventListener("change", () => {
      localStorage.setItem(LS.url, el.serverUrl.value.trim());
    });
    clampRoomN(roomN);
    updateRoomPoolCount();
    bind();
    setConn("idle"); // 还没进房间模式，先别显示"正在连接"
    // 若刷新前已在房间，进入房间模式并自动重连
    if (token && roomCode) {
      el.modeRoom.classList.add("is-active");
      el.modeSolo.classList.remove("is-active");
      el.screenSolo.hidden = true;
      el.screenRoom.hidden = false;
      connect();
    }
  }

  init();
})();
