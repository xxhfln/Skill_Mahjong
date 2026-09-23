/* 房间服务的端到端冒烟测试：完全模拟浏览器行为，验证「建房 → 加入 → 抽牌 → 保密 → 使用公开」。
 *
 * 用法：
 *   npm start                       # 另开一个终端先起服务
 *   node scripts/smoke-room.cjs     # 默认探测 http://127.0.0.1:3000
 *   BASE_URL=https://你的域名 node scripts/smoke-room.cjs   # 验证公网部署
 *
 * 退出码 0 表示全部通过，1 表示失败。
 */
"use strict";

const WebSocket = require("ws");
const skills = require("../js/skills.js");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const PLACEHOLDER = "__MJ_WS_URL__";

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextState(ws, predicate, label, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("超时未收到: " + label)), timeout);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "state" && predicate(m)) {
        clearTimeout(t);
        resolve(m);
      }
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (msg) => console.log("  ✅ " + msg);
const fail = (msg) => {
  console.error("  ❌ " + msg);
  process.exitCode = 1;
};

(async () => {
  console.log("目标服务:", BASE_URL);

  // 1. 像浏览器一样：从首页拿 WS 地址（注入值优先，其次 js/config.js 里的 MJ_PUBLIC_WS_URL）
  const html = await (await fetch(BASE_URL + "/")).text();
  const injected = html.match(/window\.__WS_URL__ = "([^"]*)"/);
  let wsUrl = injected && injected[1] !== PLACEHOLDER ? injected[1] : null;

  if (!wsUrl) {
    const cfg = await fetch(BASE_URL + "/js/config.js")
      .then((r) => r.text())
      .catch(() => "");
    const m = cfg.match(/MJ_PUBLIC_WS_URL\s*=\s*"([^"]*)"/);
    wsUrl = m ? m[1] : "";
  }
  if (!wsUrl) {
    // 纯 http 静态托管时按 rooms.js 的兜底规则推断
    const scheme = BASE_URL.startsWith("https") ? "wss" : "ws";
    wsUrl = `${scheme}://${new URL(BASE_URL).host}/ws`;
  }
  if (!wsUrl.endsWith("/ws")) {
    fail("WS 地址缺少 /ws 路径，握手必被拒：" + wsUrl);
    return;
  }
  ok("页面解析出的 WS 地址: " + wsUrl);

  const a = await open(wsUrl);
  a.send(
    JSON.stringify({
      type: "create",
      name: "房主甲",
      skillIds: skills.map((s) => s.id),
      drawCount: 3,
    }),
  );
  const created = await nextState(a, (m) => m.token, "建房响应");
  ok(`建房成功 · 房间码 ${created.snapshot.roomCode} · 身份 ${created.snapshot.me.isHost ? "房主" : "玩家"}`);

  // 建房后记录房主收到的全部广播，用于检查是否泄露他人手牌
  const aSeen = [];
  a.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "state") aSeen.push(m);
  };

  const b = await open(wsUrl);
  b.send(JSON.stringify({ type: "join", roomCode: created.snapshot.roomCode, name: "玩家乙" }));
  const joined = await nextState(b, (m) => m.token, "加入响应");
  const playerCount = joined.snapshot.players.length;
  playerCount === 2 ? ok("第二人加入成功 · 房间 2 人") : fail(`加入后人数异常: ${playerCount}`);

  b.send(JSON.stringify({ type: "draw", token: joined.token }));
  const drawn = await nextState(b, (m) => m.snapshot.privateCards.length > 0, "抽牌结果");
  const names = drawn.snapshot.privateCards.map((c) => c.name);
  const drawOk = drawn.snapshot.privateCards.length === 3;
  drawOk ? ok(`抽牌成功 · ${names.length} 张: ${names.join("、")}`) : fail(`抽牌数量不符: ${names.length}`);

  if (new Set(names).size !== names.length) fail("同一玩家抽到了重复卡牌");

  await sleep(500);
  const leak = aSeen.filter((m) => names.some((n) => JSON.stringify(m).includes(n)));
  leak.length === 0
    ? ok("保密性成立 · 房主侧看不到对方未使用的手牌")
    : fail(`保密失效，泄露 ${leak.length} 条广播`);

  const cardId = drawn.snapshot.privateCards[0].id;
  b.send(JSON.stringify({ type: "use", token: joined.token, cardId }));
  await sleep(600);
  const pub = (aSeen[aSeen.length - 1] || {}).snapshot?.publicCards || [];
  const publicOk = pub.some((c) => c.cardId === cardId || c.id === cardId);
  publicOk
    ? ok(`使用卡牌已公开 · 房主侧公共区 ${pub.length} 张: ${pub.map((c) => c.name).join("、")}`)
    : fail("使用卡牌后房主未看到公开卡");

  a.close();
  b.close();
  if (!process.exitCode) console.log("\n全部通过 ✅");
})().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
