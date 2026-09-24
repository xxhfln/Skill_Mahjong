const test = require("node:test");
const assert = require("node:assert/strict");
const skills = require("../js/skills.js");
const { RoomManager, RoomError } = require("../server/room-manager.js");

const availableSkills = skills.slice(0, 4);

function createManager() {
  return new RoomManager({ skills: availableSkills, random: () => 0 });
}

function createTwoPlayerRoom(manager, drawCount = 2) {
  const host = manager.createRoom({
    name: "房主",
    skillIds: availableSkills.map((skill) => skill.id),
    drawCount,
  });
  const guest = manager.joinRoom({ roomCode: host.roomCode, name: "玩家二" });
  return { host, guest };
}

test("creates a six-digit room with validated shared pool and draw limit", () => {
  const manager = createManager();
  const created = manager.createRoom({
    name: "房主",
    skillIds: [availableSkills[0].id, availableSkills[1].id],
    drawCount: 2,
  });

  assert.match(created.roomCode, /^\d{6}$/);
  assert.equal(created.snapshot.round, 1);
  assert.equal(created.snapshot.drawCount, 2);
  assert.equal(created.snapshot.skillCount, 2);
  assert.equal(created.snapshot.players.length, 1);

  assert.throws(
    () => manager.createRoom({ name: "错误卡池", skillIds: ["not-a-skill"], drawCount: 1 }),
    (error) => error instanceof RoomError && error.code === "INVALID_POOL",
  );
  assert.throws(
    () => manager.createRoom({ name: "张数超限", skillIds: [availableSkills[0].id], drawCount: 2 }),
    (error) => error instanceof RoomError && error.code === "INVALID_DRAW_COUNT",
  );
});

test("allows four distinct players and rejects a fifth or duplicate name", () => {
  const manager = createManager();
  const { host } = createTwoPlayerRoom(manager);
  manager.joinRoom({ roomCode: host.roomCode, name: "玩家三" });
  manager.joinRoom({ roomCode: host.roomCode, name: "玩家四" });

  assert.throws(
    () => manager.joinRoom({ roomCode: host.roomCode, name: "玩家五" }),
    (error) => error.code === "ROOM_FULL",
  );
  assert.throws(
    () => manager.joinRoom({ roomCode: host.roomCode, name: " 房主 " }),
    (error) => error.code === "DUPLICATE_NAME",
  );
});

test("draws different cards for one player without preventing another player drawing the same skill", () => {
  const manager = createManager();
  const { host, guest } = createTwoPlayerRoom(manager, 2);
  manager.startGame(host.sessionToken);

  const hostFirst = manager.drawCard(host.sessionToken);
  const hostSecond = manager.drawCard(host.sessionToken);
  const guestFirst = manager.drawCard(guest.sessionToken);

  assert.notEqual(hostFirst.privateCards[0].id, hostSecond.privateCards[1].id);
  assert.deepEqual(guestFirst.privateCards.map((card) => card.id), [hostFirst.privateCards[0].id]);
  assert.throws(() => manager.drawCard(host.sessionToken), (error) => error.code === "DRAW_LIMIT_REACHED");
});

test("never includes an opponent's unplayed card name or rule in a player's snapshot", () => {
  const sequence = [0, 0.2, 0.8];
  let pick = 0;
  const manager = new RoomManager({
    skills: availableSkills,
    random: () => sequence[pick++ % sequence.length],
  });
  const { host, guest } = createTwoPlayerRoom(manager);
  manager.startGame(host.sessionToken);
  const hostState = manager.drawCard(host.sessionToken);
  const guestState = manager.drawCard(guest.sessionToken);
  const hostCard = hostState.privateCards[0];
  const guestCard = guestState.privateCards[0];
  const guestSnapshotJson = JSON.stringify(guestState);

  assert.notEqual(hostCard.id, guestCard.id);
  assert.equal(guestSnapshotJson.includes(hostCard.name), false);
  assert.equal(guestSnapshotJson.includes(hostCard.rule), false);
  assert.equal(guestState.privateCards[0].name, guestCard.name);
});

test("use publishes only the used card name and rule to every player", () => {
  const manager = createManager();
  const { host, guest } = createTwoPlayerRoom(manager);
  manager.startGame(host.sessionToken);
  const card = manager.drawCard(host.sessionToken).privateCards[0];

  const published = manager.useCard(host.sessionToken, card.id);
  const guestSnapshot = manager.snapshotFor(guest.sessionToken);

  assert.deepEqual(guestSnapshot.publicCards.map(({ id, name, rule }) => ({ id, name, rule })), [
    { id: card.id, name: card.name, rule: card.rule },
  ]);
  assert.equal(published.publicCards.length, 1);
  assert.equal(published.privateCards[0].used, true);
  assert.throws(
    () => manager.useCard(guest.sessionToken, card.id),
    (error) => error.code === "CARD_NOT_OWNED",
  );
});

test("only the host can reset, preserving room settings and players while clearing every card", () => {
  const manager = createManager();
  const { host, guest } = createTwoPlayerRoom(manager, 2);
  manager.startGame(host.sessionToken);
  manager.drawCard(host.sessionToken);
  manager.drawCard(guest.sessionToken);
  const before = manager.snapshotFor(host.sessionToken);

  assert.throws(
    () => manager.resetRoom(guest.sessionToken),
    (error) => error.code === "FORBIDDEN",
  );

  const after = manager.resetRoom(host.sessionToken);

  assert.equal(after.round, before.round + 1);
  assert.equal(after.drawCount, before.drawCount);
  assert.deepEqual(after.players.map((player) => player.name), before.players.map((player) => player.name));
  assert.deepEqual(after.privateCards, []);
  assert.deepEqual(after.publicCards, []);
  assert.deepEqual(after.poolSkillIds, before.poolSkillIds);
  assert.deepEqual(manager.snapshotFor(guest.sessionToken).privateCards, []);
});

test("restores a disconnected player's original seat using only their session token", () => {
  const manager = createManager();
  const { host, guest } = createTwoPlayerRoom(manager);
  manager.startGame(host.sessionToken);
  manager.drawCard(host.sessionToken);
  const playerId = manager.snapshotFor(host.sessionToken).me.id;

  manager.disconnect(host.sessionToken);
  const offlineSnap = manager.snapshotFor(host.sessionToken);
  const restored = manager.resume(guest.sessionToken);
  const hostRestored = manager.resume(host.sessionToken);

  assert.equal(offlineSnap.players.find((player) => player.id === playerId).online, false);
  assert.equal(hostRestored.me.id, playerId);
  assert.equal(hostRestored.privateCards.length, 1);
  assert.equal(hostRestored.players.find((player) => player.id === playerId).online, true);
  assert.equal(restored.me.name, "玩家二");
});

test("未开始游戏禁止抽牌；房主开始后开放，重置后回到未开始", () => {
  const manager = createManager();
  const { host, guest } = createTwoPlayerRoom(manager, 2);
  assert.equal(host.snapshot.started, false, "创建后默认未开始");
  assert.throws(() => manager.drawCard(host.sessionToken), (e) => e.code === "NOT_STARTED");

  // 仅 1 人无法开始
  const solo = manager.createRoom({
    name: "独狼",
    skillIds: availableSkills.map((s) => s.id),
    drawCount: 1,
  });
  assert.throws(() => manager.startGame(solo.sessionToken), (e) => e.code === "NOT_ENOUGH_PLAYERS");

  const started = manager.startGame(host.sessionToken);
  assert.equal(started.started, true);
  assert.throws(() => manager.startGame(host.sessionToken), (e) => e.code === "ALREADY_STARTED");
  assert.throws(() => manager.startGame(guest.sessionToken), (e) => e.code === "FORBIDDEN");

  const drawn = manager.drawCard(host.sessionToken);
  assert.equal(drawn.privateCards.length, 1);

  const reset = manager.resetRoom(host.sessionToken);
  assert.equal(reset.started, false, "重置后回到未开始");
  assert.throws(() => manager.drawCard(host.sessionToken), (e) => e.code === "NOT_STARTED");
});

test("断线玩家以相同昵称重连复用座位，而非报重复", () => {
  const manager = createManager();
  const host = manager.createRoom({
    name: "房主",
    skillIds: availableSkills.map((s) => s.id),
    drawCount: 2,
  });
  const guest = manager.joinRoom({ roomCode: host.roomCode, name: "小明" });
  manager.disconnect(guest.sessionToken); // 小明离线

  const rejoined = manager.joinRoom({ roomCode: host.roomCode, name: " 小明 " });
  assert.equal(rejoined.snapshot.me.id, guest.snapshot.me.id, "应复用原座位");
  assert.notEqual(rejoined.sessionToken, guest.sessionToken, "应重新签发令牌");
  assert.equal(rejoined.snapshot.privateCards.length, 0);

  // 在线同名仍报错
  assert.throws(
    () => manager.joinRoom({ roomCode: host.roomCode, name: " 房主 " }),
    (e) => e.code === "DUPLICATE_NAME",
  );
});

test("默认按 南东北西 顺序分配方位；玩家可改坐空位，开始后锁定", () => {
  const manager = createManager();
  const host = manager.createRoom({
    name: "房主",
    skillIds: availableSkills.map((s) => s.id),
    drawCount: 2,
  });
  // 房主默认坐南（SEAT_ORDER 首位）
  assert.equal(host.snapshot.me.direction, "S", "房主默认坐南");

  const e = manager.joinRoom({ roomCode: host.roomCode, name: "东家" });
  const n = manager.joinRoom({ roomCode: host.roomCode, name: "北家" });
  const w = manager.joinRoom({ roomCode: host.roomCode, name: "西家" });
  assert.equal(e.snapshot.me.direction, "E", "第二位坐东");
  assert.equal(n.snapshot.me.direction, "N", "第三位坐北");
  assert.equal(w.snapshot.me.direction, "W", "第四位坐西");

  // 等待阶段可改坐空位（即使满员这种场景下改去他人空位需对方先离开，这里测空位占用）
  // 东家改坐北：北此时被占 → 应拒绝
  assert.throws(
    () => manager.chooseDirection(e.sessionToken, "N"),
    (err) => err.code === "SEAT_TAKEN",
  );

  // 北家离开后，东家可改坐北（空位）
  manager.leaveRoom(n.sessionToken);
  const moved = manager.chooseDirection(e.sessionToken, "N");
  assert.equal(moved.me.direction, "N", "改坐空位成功");

  // 游戏开始后再选座应被拒
  manager.joinRoom({ roomCode: host.roomCode, name: "北家2" });
  manager.startGame(host.sessionToken);
  assert.throws(
    () => manager.chooseDirection(e.sessionToken, "W"),
    (err) => err.code === "GAME_STARTED",
  );
});

test("房主离开即销毁房间并通知其余玩家；断线进入宽限期，超时才销毁", async () => {
  const manager = new RoomManager({ skills: availableSkills, random: () => 0 });
  const { host, guest } = createTwoPlayerRoom(manager);
  let closedTokens = null;
  manager.onRoomClosed = (tokens) => {
    closedTokens = tokens;
  };

  const left = manager.leaveRoom(host.sessionToken);
  assert.equal(left.destroyed, true, "房主离开应解散房间");
  assert.equal(manager.rooms.has(host.roomCode), false, "房间应被销毁");
  assert.ok(closedTokens && closedTokens.includes(guest.sessionToken), "应通知其余玩家");

  // 断线宽限期：房间仅一名玩家且全员离线 → 安排清理；
  // 宽限内重连可恢复，超时则销毁
  const m2 = new RoomManager({ skills: availableSkills, random: () => 0, graceMs: 40 });
  const solo = m2.createRoom({
    name: "独狼",
    skillIds: availableSkills.map((s) => s.id),
    drawCount: 1,
  });
  const pid = solo.snapshot.me.id;
  m2.disconnect(solo.sessionToken); // 无人在线 → 安排清理
  assert.equal(m2.rooms.has(solo.roomCode), true, "宽限期内房间仍在");
  const resumed = m2.resume(solo.sessionToken);
  assert.equal(
    resumed.players.find((p) => p.id === pid).online,
    true,
    "宽限内重连可恢复",
  );
  m2.disconnect(solo.sessionToken); // 再次断线，等超时
  let destroyed = false;
  m2.onRoomClosed = () => {
    destroyed = true;
  };
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(m2.rooms.has(solo.roomCode), false, "超时后房间销毁");
  assert.equal(destroyed, true);
});
