const { randomBytes, randomUUID } = require("node:crypto");

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const MAX_DRAW_COUNT = 6;

class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

class RoomManager {
  constructor({ skills, random = Math.random, graceMs = 15000 } = {}) {
    if (!Array.isArray(skills) || skills.length === 0) {
      throw new TypeError("A non-empty skill catalog is required");
    }

    this.skillsById = new Map(skills.map((skill) => [skill.id, skill]));
    this.random = random;
    this.graceMs = graceMs; // 全员离线后房间销毁前的宽限期（毫秒）
    this.rooms = new Map();
    this.sessions = new Map();
    // 房间被销毁时回调，参数为剩余玩家的 sessionToken 列表（用于通知对端）
    this.onRoomClosed = null;
  }

  createRoom({ name, skillIds, drawCount }) {
    const playerName = normalizeName(name);
    if (!playerName) throw new RoomError("INVALID_NAME", "请输入有效昵称");
    if (!Array.isArray(skillIds) || skillIds.length === 0) {
      throw new RoomError("INVALID_POOL", "技能池不能为空");
    }

    const uniqueIds = new Set(skillIds);
    if (uniqueIds.size !== skillIds.length || [...uniqueIds].some((id) => !this.skillsById.has(id))) {
      throw new RoomError("INVALID_POOL", "技能池包含无效或重复的技能");
    }
    if (!Number.isInteger(drawCount) || drawCount < 1 || drawCount > MAX_DRAW_COUNT || drawCount > skillIds.length) {
      throw new RoomError("INVALID_DRAW_COUNT", "每人抽牌数量必须为 1–6 且不超过技能池数量");
    }

    const roomCode = this.createRoomCode();
    const room = {
      roomCode,
      hostPlayerId: null,
      skillIds: [...skillIds],
      drawCount,
      round: 1,
      started: false, // 房主点「开始游戏」后才允许抽卡
      players: new Map(),
      publicCards: [],
      _cleanupTimer: null,
    };
    const player = this.createPlayer(room, playerName, true);
    room.hostPlayerId = player.id;
    room.players.set(player.id, player);
    this.rooms.set(roomCode, room);

    return this.resultFor(room, player);
  }

  joinRoom({ roomCode, name }) {
    const room = this.findRoom(roomCode);
    const playerName = normalizeName(name);
    if (!playerName) throw new RoomError("INVALID_NAME", "请输入有效昵称");

    const lower = playerName.toLocaleLowerCase();
    const existing = [...room.players.values()].find(
      (player) => player.name.toLocaleLowerCase() === lower,
    );
    // 同名但已离线：视为原玩家重连，复用其座位（重新签发令牌使旧令牌失效）
    if (existing) {
      if (existing.online) {
        throw new RoomError("DUPLICATE_NAME", "房间内已有相同昵称的玩家在线");
      }
      existing.online = true;
      this.sessions.delete(existing.sessionToken);
      existing.sessionToken = randomBytes(32).toString("base64url");
      this.sessions.set(existing.sessionToken, { room, player: existing });
      this.cancelRoomCleanup(room);
      return this.resultFor(room, existing);
    }

    if (room.players.size >= MAX_PLAYERS) throw new RoomError("ROOM_FULL", "房间人数已满");

    const player = this.createPlayer(room, playerName, false);
    room.players.set(player.id, player);
    this.cancelRoomCleanup(room);
    return this.resultFor(room, player);
  }

  resume(sessionToken) {
    const { room, player } = this.resolveSession(sessionToken);
    player.online = true;
    this.cancelRoomCleanup(room); // 有人回来，取消待销毁
    return this.snapshotForPlayer(room, player);
  }

  // 被动断线（WebSocket 关闭）。仅标记离线；若房间已无人在线，则进入宽限期，超时销毁。
  disconnect(sessionToken) {
    const session = this.sessions.get(sessionToken);
    if (!session) return null;
    const { room, player } = session;
    player.online = false;
    const anyOnline = [...room.players.values()].some((p) => p.online);
    if (!anyOnline && this.rooms.has(room.roomCode)) {
      this.scheduleRoomCleanup(room);
    }
    return null;
  }

  drawCard(sessionToken) {
    const { room, player } = this.resolveSession(sessionToken);
    if (!room.started) throw new RoomError("NOT_STARTED", "请等待房主开始游戏");
    const available = room.skillIds.filter((id) => !player.cards.has(id));
    if (player.cards.size >= room.drawCount || available.length === 0) {
      throw new RoomError("DRAW_LIMIT_REACHED", "本局可抽卡数量已用完");
    }

    const cardId = available[this.randomIndex(available.length)];
    player.cards.set(cardId, false);
    return this.snapshotForPlayer(room, player);
  }

  // 一次性抽取至本局上限（最多 drawCount 张，且互不重复）
  drawCards(sessionToken) {
    const { room, player } = this.resolveSession(sessionToken);
    if (!room.started) throw new RoomError("NOT_STARTED", "请等待房主开始游戏");
    const need = room.drawCount - player.cards.size;
    if (need <= 0) throw new RoomError("DRAW_LIMIT_REACHED", "本局可抽卡数量已用完");
    const available = room.skillIds.filter((id) => !player.cards.has(id));
    if (available.length === 0) throw new RoomError("NO_CARDS", "技能池已无可抽卡牌");
    const picked = this.shuffle(available).slice(0, Math.min(need, available.length));
    picked.forEach((id) => player.cards.set(id, false));
    return this.snapshotForPlayer(room, player);
  }

  // 房主点击「开始游戏」：开启对局，之后方可抽卡
  startGame(sessionToken) {
    const { room, player } = this.resolveSession(sessionToken);
    if (player.id !== room.hostPlayerId) throw new RoomError("FORBIDDEN", "只有房主可以开始游戏");
    if (room.started) throw new RoomError("ALREADY_STARTED", "游戏已经开始");
    if (room.players.size < MIN_PLAYERS) {
      throw new RoomError("NOT_ENOUGH_PLAYERS", `至少需要 ${MIN_PLAYERS} 名玩家才能开始`);
    }
    room.started = true;
    return this.snapshotForPlayer(room, player);
  }

  useCard(sessionToken, cardId) {
    const { room, player } = this.resolveSession(sessionToken);
    if (!player.cards.has(cardId)) throw new RoomError("CARD_NOT_OWNED", "这张卡不属于你");
    if (player.cards.get(cardId)) throw new RoomError("CARD_ALREADY_USED", "这张卡已经使用过");

    player.cards.set(cardId, true);
    room.publicCards.push({
      id: cardId,
      ownerId: player.id,
      ownerName: player.name,
      usedAt: Date.now(),
    });
    return this.snapshotForPlayer(room, player);
  }

  resetRoom(sessionToken) {
    const { room, player } = this.resolveSession(sessionToken);
    if (player.id !== room.hostPlayerId) throw new RoomError("FORBIDDEN", "只有房主可以重置本局");

    for (const member of room.players.values()) member.cards.clear();
    room.publicCards = [];
    room.started = false; // 新一局需房主再次「开始游戏」
    room.round += 1;
    return this.snapshotForPlayer(room, player);
  }

  // 主动离开：房主离开则解散房间；普通玩家离开仅移除自己，若房间已空也解散。
  leaveRoom(sessionToken) {
    const session = this.sessions.get(sessionToken);
    if (!session) return { destroyed: false, left: false };
    const { room, player } = session;
    if (player.isHost) {
      const remaining = this.destroyRoom(room.roomCode).filter((t) => t !== player.sessionToken);
      if (this.onRoomClosed) this.onRoomClosed(remaining);
      return { destroyed: true, left: true };
    }
    room.players.delete(player.id);
    this.sessions.delete(player.sessionToken);
    const anyOnline = [...room.players.values()].some((p) => p.online);
    if (room.players.size === 0 || !anyOnline) {
      const remaining = this.destroyRoom(room.roomCode);
      if (this.onRoomClosed) this.onRoomClosed(remaining);
      return { destroyed: true, left: true };
    }
    return { destroyed: false, left: true };
  }

  destroyRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    this.cancelRoomCleanup(room);
    const tokens = [...room.players.values()].map((p) => p.sessionToken);
    for (const t of tokens) this.sessions.delete(t);
    this.rooms.delete(roomCode);
    return tokens;
  }

  scheduleRoomCleanup(room) {
    if (room._cleanupTimer) return;
    room._cleanupTimer = setTimeout(() => {
      room._cleanupTimer = null;
      if (!this.rooms.has(room.roomCode)) return;
      const tokens = this.destroyRoom(room.roomCode);
      if (this.onRoomClosed) this.onRoomClosed(tokens);
    }, this.graceMs);
  }

  cancelRoomCleanup(room) {
    if (room._cleanupTimer) {
      clearTimeout(room._cleanupTimer);
      room._cleanupTimer = null;
    }
  }

  // 测试/关闭时清理所有宽限定时器，避免进程挂起
  stop() {
    for (const room of this.rooms.values()) this.cancelRoomCleanup(room);
  }

  snapshotFor(sessionToken) {
    const { room, player } = this.resolveSession(sessionToken);
    return this.snapshotForPlayer(room, player);
  }

  // 返回房间内每位玩家各自专属（含私牌）的快照，用于按 token 定向广播
  snapshotsForRoom(roomCode) {
    const room = this.findRoom(roomCode);
    return [...room.players.values()].map((player) => ({
      token: player.sessionToken,
      snapshot: this.snapshotForPlayer(room, player),
    }));
  }

  // 列出本服务上的房间（仅公开信息，绝不含有任何卡牌内容；无人在线的房间不展示）
  listRooms() {
    return [...this.rooms.values()]
      .filter((room) => [...room.players.values()].some((player) => player.online))
      .map((room) => {
        const host = [...room.players.values()].find((player) => player.isHost);
        return {
          roomCode: room.roomCode,
          hostName: host ? host.name : "",
          playerCount: room.players.size,
          drawCount: room.drawCount,
          maxPlayers: MAX_PLAYERS,
        };
      });
  }

  createRoomCode() {
    let candidate = this.randomIndex(1_000_000);
    for (let attempts = 0; attempts < 1_000_000; attempts += 1) {
      const code = String(candidate).padStart(6, "0");
      if (!this.rooms.has(code)) return code;
      candidate = (candidate + 1) % 1_000_000;
    }
    throw new RoomError("SERVER_BUSY", "暂时无法创建新房间");
  }

  createPlayer(room, name, isHost) {
    const player = {
      id: randomUUID(),
      name,
      isHost,
      online: true,
      cards: new Map(),
      sessionToken: randomBytes(32).toString("base64url"),
    };
    this.sessions.set(player.sessionToken, { room, player });
    return player;
  }

  resultFor(room, player) {
    return {
      roomCode: room.roomCode,
      sessionToken: player.sessionToken,
      snapshot: this.snapshotForPlayer(room, player),
    };
  }

  findRoom(roomCode) {
    if (typeof roomCode !== "string" || !/^\d{6}$/.test(roomCode)) {
      throw new RoomError("ROOM_NOT_FOUND", "房间码无效或房间不存在");
    }
    const room = this.rooms.get(roomCode);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "房间码无效或房间不存在");
    return room;
  }

  resolveSession(sessionToken) {
    if (typeof sessionToken !== "string" || sessionToken.length < 32) {
      throw new RoomError("INVALID_SESSION", "玩家会话无效");
    }
    const session = this.sessions.get(sessionToken);
    if (!session) throw new RoomError("INVALID_SESSION", "玩家会话无效或已失效");
    return session;
  }

  snapshotForPlayer(room, player) {
    return {
      roomCode: room.roomCode,
      round: room.round,
      started: room.started,
      drawCount: room.drawCount,
      skillCount: room.skillIds.length,
      poolSkillIds: [...room.skillIds],
      me: { id: player.id, name: player.name, isHost: player.isHost },
      players: [...room.players.values()].map((member) => ({
        id: member.id,
        name: member.name,
        isHost: member.isHost,
        online: member.online,
        drawnCount: member.cards.size,
      })),
      privateCards: [...player.cards.entries()].map(([id, used]) => ({ ...this.skillsById.get(id), used })),
      publicCards: room.publicCards.map((usedCard) => ({
        ...this.skillsById.get(usedCard.id),
        ownerId: usedCard.ownerId,
        ownerName: usedCard.ownerName,
        usedAt: usedCard.usedAt,
      })),
    };
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.min(i, Math.floor(this.random() * (i + 1)));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  randomIndex(limit) {
    return Math.min(limit - 1, Math.floor(this.random() * limit));
  }
}

function normalizeName(name) {
  if (typeof name !== "string") return "";
  return name.trim().slice(0, 20);
}

module.exports = { RoomManager, RoomError, MIN_PLAYERS, MAX_PLAYERS, MAX_DRAW_COUNT };
