/* 侧边信息面板（全局，单机/房间两个模式都可用）。
 * 同一个按钮反复按下：弹出 → 收回。 */
(() => {
  "use strict";

  const btn = document.getElementById("sideToggle");
  const panel = document.getElementById("sidePanel");
  const closeBtn = document.getElementById("sidePanelClose");
  if (!btn || !panel) return;

  function isOpen() {
    return panel.classList.contains("is-open");
  }

  function setOpen(open) {
    panel.classList.toggle("is-open", open);
    btn.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    panel.setAttribute("aria-hidden", open ? "false" : "true");
  }

  // 侧边按钮：按一次弹出，再按一次收回
  btn.addEventListener("click", () => setOpen(!isOpen()));
  if (closeBtn) closeBtn.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) setOpen(false);
  });
})();
