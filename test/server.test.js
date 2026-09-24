"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const skills = require("../js/skills.js");
const { startServer, getWss, getManager } = require("../server/index.js");

const PORT = 3199;
const URL = `ws://localhost:${PORT}/ws`;
const ALL_IDS = skills.map((s) => s.id);

let server;

function makeClient() {
  const ws = new WebSocket(URL);
  let seq = 0;
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    msg.__seq = seq++;
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.check(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
        break;
      }
    }
  });
  const open = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return {
    ws,
    open,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    clear() {
      inbox.length = 0;
    },
    // 等待匹配谓词的消息（先查历史，再等未来）
    waitFor(check) {
      const found = inbox.find(check);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ check, resolve }));
    },
    // 清空历史后发送消息，并等待结果快照满足谓词（谓词接收完整消息）
    act(msg, check) {
      this.clear();
      this.send(msg);
      return this.waitFor((m) => m.type === "state" && check(m));
    },
    // 不清空发送方，仅等待本方收到满足条件的快照（用于「他人操作→我方可见」）
    awaitState(check) {
      this.clear();
      return this.waitFor((m) => m.type === "state" && check(m));
    },
    last(type) {
      for (let i = inbox.length - 1; i >= 0; i -= 1) {
        if (inbox[i].type === type) return inbox[i];
      }
      return undefined;
    },
    close() {
      ws.close();
    },
  };
}

test.before(() => {
  server = startServer(PORT);
});

test.after(() => {
  getManager()?.stop?.();
  getWss()?.close();
  server.close();
});

test("health 端点返回 200", async () => {
  const res = await fetch(`http://localhost:${PORT}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});

test("首页注入 WS 地址占位符被替换", async () => {
  const res = await fetch(`http://localhost:${PORT}/`);
  const html = await res.text();
  assert.ok(!html.includes("__MJ_WS_URL__"), "占位符应已被替换（不应残留）");
  assert.ok(
    html.includes('window.__WS_URL__ = "ws://localhost:3199/ws"'),
    "应注入真实 ws 地址，且必须带 /ws 路径（缺路径前端握手会被拒，表现为点创建房间没反应）",
  );
});

test("建房/加入并各自抽到互不重复卡；保密性成立", async () => {
  const a = makeClient();
  const b = makeClient();
  await Promise.all([a.open, b.open]);

  const created = await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 2 },
    (m) => !!m.token,
  );
  assert.match(created.snapshot.roomCode, /^\d{6}$/);
  assert.ok(created.token, "建房响应应携带会话令牌");
  const roomCode = created.snapshot.roomCode;
  assert.equal(created.snapshot.players.length, 1);

  await b.act(
    { type: "join", roomCode, name: "玩家二" },
    (m) => m.snapshot.players.length === 2,
  );

  // 房主开始游戏后，玩家方可抽牌
  await a.act({ type: "start", token: created.token }, (m) => m.snapshot.started === true);

  const aDrawn = await a.act(
    { type: "draw", token: created.token },
    (m) => m.snapshot.privateCards.length === 2,
  );
  const aCards = aDrawn.snapshot.privateCards;
  assert.equal(aCards.length, 2);
  assert.notEqual(aCards[0].id, aCards[1].id, "同一玩家手牌互不重复");

  // 玩家二收到的快照不得包含房主未公开卡牌的内容
  const bSnap = b.last("state");
  assert.ok(bSnap, "玩家二应收到广播快照");
  const bJson = JSON.stringify(bSnap.snapshot);
  assert.equal(bSnap.snapshot.privateCards.length, 0, "玩家二尚未抽牌，无私牌");
  assert.ok(!bJson.includes(aCards[0].name), "对手快照不应含房主未公开卡名");
  assert.ok(!bJson.includes(aCards[0].rule), "对手快照不应含房主未公开卡效果");

  a.close();
  b.close();
});

test("使用卡牌后全员可见；不同玩家可抽到相同技能", async () => {
  const a = makeClient();
  const b = makeClient();
  await Promise.all([a.open, b.open]);

  const created = await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 1 },
    (m) => !!m.token,
  );
  const roomCode = created.snapshot.roomCode;

  await b.act(
    { type: "join", roomCode, name: "玩家二" },
    (m) => m.snapshot.players.length === 2,
  );

  await a.act({ type: "start", token: created.token }, (m) => m.snapshot.started === true);

  const aDrawn = await a.act(
    { type: "draw", token: created.token },
    (m) => m.snapshot.privateCards.length === 1,
  );
  const card = aDrawn.snapshot.privateCards[0];

  a.send({ type: "use", token: created.token, cardId: card.id });
  const bSees = await b.awaitState((m) => m.snapshot.publicCards.some((c) => c.id === card.id));
  const pub = bSees.snapshot.publicCards.find((c) => c.id === card.id);
  assert.ok(pub, "玩家二应看到公开卡");
  assert.equal(pub.ownerName, "房主");
  assert.equal(pub.name, card.name);

  a.close();
  b.close();
});

test("仅房主可重置；重置清空手牌并保留配置与成员，局数加一", async () => {
  const a = makeClient();
  const b = makeClient();
  await Promise.all([a.open, b.open]);

  const created = await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 2 },
    (m) => !!m.token,
  );
  const roomCode = created.snapshot.roomCode;

  await b.act(
    { type: "join", roomCode, name: "玩家二" },
    (m) => m.snapshot.players.length === 2,
  );

  // 房主开始游戏，否则抽牌会被拒
  await a.act({ type: "start", token: created.token }, (m) => m.snapshot.started === true);

  // 非房主重置应被拒
  b.send({ type: "reset", token: b.last("state") ? b.last("state").token : null });
  const denied = await b.waitFor((m) => m.type === "error" && m.code === "FORBIDDEN");
  assert.equal(denied.code, "FORBIDDEN");

  await a.act(
    { type: "draw", token: created.token },
    (m) => m.snapshot.privateCards.length === 2,
  );
  const reset = await a.act(
    { type: "reset", token: created.token },
    (m) => m.snapshot.round === 2,
  );

  assert.equal(reset.snapshot.round, 2);
  assert.equal(reset.snapshot.drawCount, 2);
  assert.equal(reset.snapshot.privateCards.length, 0);
  assert.equal(reset.snapshot.publicCards.length, 0);
  assert.equal(reset.snapshot.players.length, 2);

  a.close();
  b.close();
});

test("持令牌重连可恢复原座位", async () => {
  const a = makeClient();
  await a.open;
  const created = await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 2 },
    (m) => !!m.token,
  );
  const token = created.token;
  const roomCode = created.snapshot.roomCode;

  // 至少 2 人才能开始游戏
  const b = makeClient();
  await b.open;
  await b.act({ type: "join", roomCode, name: "玩家二" }, (m) => m.snapshot.players.length === 2);
  await a.act({ type: "start", token }, (m) => m.snapshot.started === true);

  await a.act(
    { type: "draw", token },
    (m) => m.snapshot.privateCards.length === 2,
  );
  const idBefore = created.snapshot.me.id;

  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 150));

  const a2 = makeClient();
  await a2.open;
  const resumed = await a2.act(
    { type: "resume", token, roomCode },
    (m) => m.snapshot.me && m.snapshot.round === 1,
  );
  assert.equal(resumed.snapshot.me.id, idBefore, "重连后应恢复同一座位");
  assert.equal(resumed.snapshot.privateCards.length, 2, "重连后应恢复已抽手牌");
  assert.equal(resumed.snapshot.round, 1);

  a2.close();
});

test("list_rooms 仅返回公开信息，不含任何卡牌内容", async () => {
  const a = makeClient();
  await a.open;
  await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 3 },
    (m) => !!m.token,
  );

  const probe = new WebSocket(URL);
  await new Promise((r) => probe.on("open", r));
  const listMsg = await new Promise((resolve) => {
    probe.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "rooms") resolve(m);
    });
    probe.send(JSON.stringify({ type: "list_rooms" }));
  });
  probe.close();

  assert.ok(Array.isArray(listMsg.list));
  assert.ok(listMsg.list.length >= 1);
  const room = listMsg.list[0];
  assert.ok("roomCode" in room && "hostName" in room && "playerCount" in room);
  assert.ok(!("privateCards" in room) && !("publicCards" in room));
  const json = JSON.stringify(room);
  assert.ok(!json.includes(skills[0].name), "房间列表不得泄露卡牌名");

  a.close();
});

test("无效消息被拒绝且不崩溃", async () => {
  const a = makeClient();
  await a.open;
  a.ws.send("not-json");
  a.ws.send(JSON.stringify({ type: "bogus" }));
  const err = await a.waitFor((m) => m.type === "error");
  assert.equal(err.type, "error");
  a.close();
});

test("未开始游戏时抽牌被拒；房主开始后开放", async () => {
  const a = makeClient();
  const b = makeClient();
  await Promise.all([a.open, b.open]);

  const created = await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 2 },
    (m) => !!m.token,
  );
  const roomCode = created.snapshot.roomCode;

  await b.act(
    { type: "join", roomCode, name: "玩家二" },
    (m) => m.snapshot.players.length === 2,
  );

  // 未开始抽牌被拒
  a.send({ type: "draw", token: created.token });
  const denied = await a.waitFor((m) => m.type === "error" && m.code === "NOT_STARTED");
  assert.equal(denied.code, "NOT_STARTED");

  // 房主开始游戏
  const started = await a.act(
    { type: "start", token: created.token },
    (m) => m.snapshot.started === true,
  );
  assert.equal(started.snapshot.started, true);

  // 现在可以抽牌
  const drawn = await a.act(
    { type: "draw", token: created.token },
    (m) => m.snapshot.privateCards.length === 2,
  );
  assert.equal(drawn.snapshot.privateCards.length, 2);

  a.close();
  b.close();
});

test("房主离开销毁房间，其余玩家收到 room_closed", async () => {
  const a = makeClient();
  const b = makeClient();
  await Promise.all([a.open, b.open]);

  const created = await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 2 },
    (m) => !!m.token,
  );
  const roomCode = created.snapshot.roomCode;
  const joined = await b.act(
    { type: "join", roomCode, name: "玩家二" },
    (m) => m.snapshot.players.length === 2,
  );

  // 房主离开
  a.send({ type: "leave", token: created.token });
  const closed = await b.waitFor((m) => m.type === "room_closed");
  assert.ok(closed, "其余玩家应收到 room_closed");

  // 房间已不存在：房主再 resume 应失败（房间销毁即会话失效）
  const a2 = makeClient();
  await a2.open;
  a2.send({ type: "resume", token: created.token, roomCode });
  const err = await a2.waitFor(
    (m) => m.type === "error" && (m.code === "ROOM_NOT_FOUND" || m.code === "INVALID_SESSION"),
  );
  assert.ok(err.code === "ROOM_NOT_FOUND" || err.code === "INVALID_SESSION");

  a.close();
  b.close();
  a2.close();
});

test("玩家可在开始游戏前改坐空位，且开始后座位锁定", async () => {
  const a = makeClient();
  const b = makeClient();
  const c = makeClient();
  await Promise.all([a.open, b.open, c.open]);

  const created = await a.act(
    { type: "create", name: "房主", skillIds: ALL_IDS, drawCount: 2 },
    (m) => !!m.token,
  );
  const roomCode = created.snapshot.roomCode;
  assert.equal(created.snapshot.me.direction, "S", "房主默认坐南");

  await b.act({ type: "join", roomCode, name: "玩家二" }, (m) => m.snapshot.players.length === 2);
  await c.act({ type: "join", roomCode, name: "玩家三" }, (m) => m.snapshot.players.length === 3);

  // 房主改坐空位（西），应成功，且其余玩家同步可见
  const moved = await a.act(
    { type: "sit", token: created.token, direction: "W" },
    (m) => m.snapshot.me.direction === "W",
  );
  assert.equal(moved.snapshot.me.direction, "W");

  const bSees = await b.waitFor(
    (m) =>
      m.type === "state" &&
      m.snapshot.players.find((p) => p.name === "房主")?.direction === "W",
  );
  const aInB = bSees.snapshot.players.find((p) => p.name === "房主");
  assert.equal(aInB.direction, "W", "其余玩家应看到房主改坐西");

  // 开始游戏后，再改座应被拒
  await a.act({ type: "start", token: created.token }, (m) => m.snapshot.started === true);
  a.send({ type: "sit", token: created.token, direction: "E" });
  const denied = await a.waitFor((m) => m.type === "error" && m.code === "GAME_STARTED");
  assert.equal(denied.code, "GAME_STARTED");

  a.close();
  b.close();
  c.close();
});

