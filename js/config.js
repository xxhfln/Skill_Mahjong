/* 部署配置（公网 / 纯静态托管用）
 *
 * 三种运行方式下 "前端该连哪个 WebSocket 服务" 的推断顺序：
 *   1. Node 服务自己托管页面时，server/index.js 会把真实地址注入 window.__WS_URL__
 *      —— 本机、局域网、Render 一条龙部署都走这条路，无需任何配置。
 *   2. 页面由纯静态托管（Netlify / Pages / 对象存储）提供时，注入不会发生，
 *      此时读本文件的 window.MJ_PUBLIC_WS_URL —— 只需要在这里填一次后端地址。
 *   3. 都没配：回退到同源 /ws 或本机 ws://<域名>:3000/ws。
 *
 * 用法：把下面引号里换成你的后端地址即可，例如
 *   window.MJ_PUBLIC_WS_URL = "wss://skill-mahjong-xxxx.onrender.com/ws";
 *
 * 注意两点：
 *   - 必须是 wss://（页面是 https 时，浏览器禁止连接明文 ws://）——结尾的 /ws 不能少。
 *   - 改完本文件记得同步 bump index.html 里资源链接的 ?v= 版本号，否则用户端还在吃缓存。
 */
window.MJ_PUBLIC_WS_URL = "";
