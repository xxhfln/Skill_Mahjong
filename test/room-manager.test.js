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
  manager.drawCard(host.sessionToken);
  const playerId = manager.snapshotFor(host.sessionToken).me.id;

  const offline = manager.disconnect(host.sessionToken);
  const restored = manager.resume(guest.sessionToken);
  const hostRestored = manager.resume(host.sessionToken);

  assert.equal(offline.players.find((player) => player.id === playerId).online, false);
  assert.equal(hostRestored.me.id, playerId);
  assert.equal(hostRestored.privateCards.length, 1);
  assert.equal(hostRestored.players.find((player) => player.id === playerId).online, true);
  assert.equal(restored.me.name, "玩家二");
});
