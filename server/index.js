"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { WebSocketServer } = require("ws");

const skills = require("../js/skills.js");
const { RoomManager } = require("./room-manager.js");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname, "..");
const MAX_MESSAGE_BYTES = 16 * 1024; // 协议上限 16 KiB

const manager = new RoomManager({ skills });

// 房间被销毁（房主离开 / 全员离线超时）时，通知并关闭其余玩家的连接
function notifyRoomClosed(tokens) {
  for (const token of tokens) {
    const ws = tokenToWs.get(token);
    if (!ws) continue;
    send(ws, { type: "room_closed" });
    tokenToWs.delete(token);
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}
manager.onRoomClosed = notifyRoomClosed;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

/* ---------------- 静态文件服务 ---------------- */

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function serveIndex(req, res) {
  fs.readFile(path.join(ROOT, "index.html"), "utf8", (err, html) => {
    if (err) {
      res.writeHead(500);
      res.end("Server Error");
      return;
    }
    const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
    const scheme = secure ? "wss" : "ws";
    const host = req.headers.host || `localhost:${PORT}`;
    // 必须带 /ws：WebSocketServer 只接管该路径，缺路径的握手会被拒(400)
    const wsUrl = `${scheme}://${host}/ws`;
    // 把占位符替换为当前访问地址，前端据此自动连接（局域网/公网均可）
    html = html.replace(/__MJ_WS_URL__/g, wsUrl);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(html);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

function requestHandler(req, res) {
  if (req.url.split("?")[0] === "/health") {
    return sendJson(res, 200, { ok: true, rooms: manager.listRooms().length });
  }
  const urlPath = req.url.split("?")[0];
  const noExt = !path.extname(urlPath);
  // 首页与无扩展名的路由都走 index.html（并注入 WS 地址）；其余按静态资源处理
  if (urlPath === "/" || noExt) return serveIndex(req, res);
  return serveStatic(req, res);
}

/* ---------------- WebSocket 适配层 ---------------- */

let server = null;
let wss = null;
const tokenToWs = new Map(); // sessionToken -> ws

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function error(ws, code, message) {
  send(ws, { type: "error", code, message });
}

// 向房间内每位玩家推送其各自专属的快照（含私牌），保证保密性
function broadcastRoom(roomCode) {
  for (const { token, snapshot } of manager.snapshotsForRoom(roomCode)) {
    const ws = tokenToWs.get(token);
    if (ws) send(ws, { type: "state", snapshot });
  }
}

function handleMessage(ws, msg) {
  try {
    switch (msg.type) {
      case "create": {
        const result = manager.createRoom({
          name: msg.name,
          skillIds: msg.skillIds,
          drawCount: msg.drawCount,
        });
        ws.token = result.sessionToken;
        ws.roomCode = result.roomCode;
        tokenToWs.set(ws.token, ws);
        send(ws, { type: "state", token: result.sessionToken, snapshot: result.snapshot });
        broadcastRoom(ws.roomCode);
        return;
      }
      case "join": {
        const result = manager.joinRoom({ roomCode: msg.roomCode, name: msg.name });
        ws.token = result.sessionToken;
        ws.roomCode = result.roomCode;
        tokenToWs.set(ws.token, ws);
        send(ws, { type: "state", token: result.sessionToken, snapshot: result.snapshot });
        broadcastRoom(ws.roomCode);
        return;
      }
      case "resume": {
        if (!msg.token || !msg.roomCode) return error(ws, "BAD_MESSAGE", "缺少令牌或房间码");
        const snapshot = manager.resume(msg.token);
        ws.token = msg.token;
        ws.roomCode = msg.roomCode;
        tokenToWs.set(ws.token, ws);
        return send(ws, { type: "state", snapshot });
      }
      case "start": {
        if (!ws.token) return error(ws, "NO_SESSION", "请先加入房间");
        manager.startGame(ws.token);
        return broadcastRoom(ws.roomCode);
      }
      case "sit": {
        if (!ws.token) return error(ws, "NO_SESSION", "请先加入房间");
        if (typeof msg.direction !== "string") return error(ws, "BAD_MESSAGE", "缺少方位");
        manager.chooseDirection(ws.token, msg.direction);
        return broadcastRoom(ws.roomCode);
      }
      case "leave": {
        if (!ws.token) return error(ws, "NO_SESSION", "请先加入房间");
        const result = manager.leaveRoom(ws.token);
        if (result.destroyed) {
          // 房间已销毁，其余玩家由 notifyRoomClosed 通知；离开者本地已退到大厅
          return send(ws, { type: "left" });
        }
        tokenToWs.delete(ws.token);
        ws.token = null;
        send(ws, { type: "left" });
        return broadcastRoom(ws.roomCode);
      }
      case "list_rooms":
        return send(ws, { type: "rooms", list: manager.listRooms() });
      case "draw": {
        if (!ws.token) return error(ws, "NO_SESSION", "请先加入房间");
        manager.drawCards(ws.token);
        return broadcastRoom(ws.roomCode);
      }
      case "use": {
        if (!ws.token) return error(ws, "NO_SESSION", "请先加入房间");
        manager.useCard(ws.token, msg.cardId);
        return broadcastRoom(ws.roomCode);
      }
      case "reset": {
        if (!ws.token) return error(ws, "NO_SESSION", "请先加入房间");
        manager.resetRoom(ws.token);
        return broadcastRoom(ws.roomCode);
      }
      default:
        return error(ws, "UNKNOWN_TYPE", "未知消息类型");
    }
  } catch (e) {
    if (e && e.name === "RoomError") return error(ws, e.code, e.message);
    console.error("[ws] 处理消息出错:", e);
    return error(ws, "SERVER_ERROR", "服务器内部错误");
  }
}

function attachWebSocket(httpServer) {
  const wssInstance = new WebSocketServer({ server: httpServer, path: "/ws" });

  wssInstance.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (data, isBinary) => {
      let msg;
      try {
        if (isBinary) throw new Error("binary payload");
        const text = data.toString("utf8");
        if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
          return error(ws, "PAYLOAD_TOO_LARGE", "消息过大");
        }
        msg = JSON.parse(text);
      } catch (e) {
        return error(ws, "BAD_JSON", "消息格式错误");
      }
      if (!msg || typeof msg.type !== "string") {
        return error(ws, "BAD_MESSAGE", "缺少消息类型");
      }
      handleMessage(ws, msg);
    });

    ws.on("close", () => {
      if (ws.token) {
        try {
          manager.disconnect(ws.token);
        } catch (e) {
          /* 令牌可能已失效，忽略 */
        }
        const code = ws.roomCode;
        tokenToWs.delete(ws.token);
        if (code) {
          // 房间可能已被销毁（如房主先离开触发销毁），广播需容错
          try {
            broadcastRoom(code);
          } catch (e) {
            /* 房间不存在则忽略 */
          }
        }
      }
    });

    ws.on("error", () => {
      /* 连接级错误忽略，close 事件会清理 */
    });
  });

  // 心跳：剔除失活连接
  const heartbeat = setInterval(() => {
    wssInstance.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (e) {
        /* ignore */
      }
    });
  }, 30000);
  wssInstance.on("close", () => clearInterval(heartbeat));

  return wssInstance;
}

/* ---------------- 启动 ---------------- */

function logAddresses(port) {
  console.log(`技能麻将房间服务已启动`);
  console.log(`  本机:   http://localhost:${port}  (WebSocket: ws://localhost:${port}/ws)`);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) {
        console.log(`  局域网: ws://${ni.address}:${port}/ws`);
      }
    }
  }
}

function startServer(port = PORT) {
  server = http.createServer(requestHandler);
  wss = attachWebSocket(server);
  server.listen(port, "0.0.0.0", () => logAddresses(port));
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, manager, getManager: () => manager, getWss: () => wss };
