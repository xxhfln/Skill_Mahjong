(() => {
  const STORAGE_KEY = "skill-mahjong-pool";
  const N_KEY = "skill-mahjong-n";
  const skills = window.MAHJONG_SKILLS;

  // 微信内置浏览器 100vh 常含地址栏高度，用可视高度修正
  function setAppHeight() {
    const h = window.innerHeight || document.documentElement.clientHeight;
    document.documentElement.style.setProperty("--app-height", `${h}px`);
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", () => {
    setTimeout(setAppHeight, 120);
  });

  const els = {
    drawBtn: document.getElementById("drawBtn"),
    resetBtn: document.getElementById("resetBtn"),
    poolBtn: document.getElementById("poolBtn"),
    poolMeta: document.getElementById("poolMeta"),
    deck: document.getElementById("deck"),
    deckHint: document.getElementById("deckHint"),
    deckText: document.getElementById("deckText"),
    nMinus: document.getElementById("nMinus"),
    nPlus: document.getElementById("nPlus"),
    nValue: document.getElementById("nValue"),
    hand: document.getElementById("hand"),
    played: document.getElementById("played"),
    playedList: document.getElementById("playedList"),
    // 技能池弹窗
    poolSheet: document.getElementById("poolSheet"),
    skillList: document.getElementById("skillList"),
    selectAllBtn: document.getElementById("selectAllBtn"),
    clearAllBtn: document.getElementById("clearAllBtn"),
    sheetCount: document.getElementById("sheetCount"),
    confirmPool: document.getElementById("confirmPool"),
    closePool: document.getElementById("closePool"),
    sheetBackdrop: document.getElementById("sheetBackdrop"),
    sparkLayer: document.getElementById("sparkLayer"),
  };

  let selectedIds = loadSelectedIds();
  let draftIds = new Set(selectedIds);
  let drawing = false;
  let spinTimer = null;
  let hand = []; // 当前手牌（未打出的技能对象）
  let played = []; // 已打出的技能对象
  let nValue = loadN();

  /* ---------------- 技能池（保留原逻辑） ---------------- */

  function loadSelectedIds() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set(skills.map((s) => s.id));
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return new Set(skills.map((s) => s.id));
      }
      const valid = parsed.filter((id) => skills.some((s) => s.id === id));
      return valid.length ? new Set(valid) : new Set(skills.map((s) => s.id));
    } catch (e) {
      return new Set(skills.map((s) => s.id));
    }
  }

  function saveSelectedIds() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...selectedIds]));
    } catch (e) {
      // 微信隐私模式可能禁用 localStorage，忽略即可
    }
  }

  function poolSkills() {
    return skills.filter((s) => selectedIds.has(s.id));
  }

  function updatePoolMeta() {
    const n = selectedIds.size;
    els.poolMeta.textContent = `候选池 · ${n} / ${skills.length}`;
  }

  function formatRuleText(rule) {
    return String(rule || "")
      .replace(/([。；])/g, "$1\n")
      .replace(/\n+$/g, "");
  }

  function updateSheetCount() {
    els.sheetCount.textContent = `已选 ${draftIds.size}`;
  }

  function syncCheckedClass(li, checked) {
    if (checked) li.classList.add("is-checked");
    else li.classList.remove("is-checked");
  }

  function renderPoolList() {
    els.skillList.innerHTML = "";
    const frag = document.createDocumentFragment();

    skills.forEach((skill) => {
      const li = document.createElement("li");
      li.className = "skill-item";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `skill-${skill.id}`;
      input.checked = draftIds.has(skill.id);
      syncCheckedClass(li, input.checked);
      input.addEventListener("change", () => {
        if (input.checked) draftIds.add(skill.id);
        else draftIds.delete(skill.id);
        syncCheckedClass(li, input.checked);
        updateSheetCount();
      });

      const body = document.createElement("label");
      body.className = "skill-item__body";
      body.htmlFor = input.id;

      const name = document.createElement("p");
      name.className = "skill-item__name";
      name.textContent = skill.name;

      const rule = document.createElement("p");
      rule.className = "skill-item__rule";
      rule.textContent = formatRuleText(skill.rule);

      body.appendChild(name);
      body.appendChild(rule);
      li.appendChild(input);
      li.appendChild(body);
      frag.appendChild(li);
    });

    els.skillList.appendChild(frag);
    updateSheetCount();
  }

  function openPool() {
    if (drawing) return;
    draftIds = new Set(selectedIds);
    renderPoolList();
    els.poolSheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closePool() {
    els.poolSheet.hidden = true;
    document.body.style.overflow = "";
  }

  function confirmPool() {
    if (draftIds.size === 0) {
      alert("至少保留一条技能");
      return;
    }
    selectedIds = new Set(draftIds);
    saveSelectedIds();
    updatePoolMeta();
    // 候选数变化后，重新约束 N
    setN(nValue);
    closePool();
  }

  /* ---------------- 数量步进器 ---------------- */

  function clampN(v) {
    const max = Math.max(1, selectedIds.size);
    if (v < 1) v = 1;
    if (v > max) v = max;
    return v;
  }

  function setN(v) {
    nValue = clampN(v);
    els.nValue.textContent = nValue;
    els.nMinus.disabled = nValue <= 1;
    els.nPlus.disabled = nValue >= selectedIds.size;
    try {
      localStorage.setItem(N_KEY, String(nValue));
    } catch (e) {
      // 忽略隐私模式写入失败
    }
  }

  function loadN() {
    try {
      const raw = localStorage.getItem(N_KEY);
      if (raw) return clampN(parseInt(raw, 10) || 3);
    } catch (e) {
      // 忽略
    }
    return clampN(3);
  }

  /* ---------------- 抽牌 / 打出 / 重置 ---------------- */

  function pickDistinct(pool, n) {
    const arr = pool.slice();
    // Fisher–Yates 洗牌
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr.slice(0, Math.min(n, arr.length));
  }

  function drawCards() {
    if (drawing) return;
    const pool = poolSkills();
    if (pool.length === 0) {
      alert("请先在技能池中至少勾选一条技能");
      openPool();
      return;
    }

    const n = clampN(nValue);
    drawing = true;
    setControlsDisabled(true);
    els.deck.classList.add("is-spinning");
    els.deckHint.textContent = "发牌中";
    els.deckText.textContent = "牌堆翻腾…";

    // 牌堆文字高速滚动
    spinTimer = setInterval(() => {
      const s = pool[Math.floor(Math.random() * pool.length)];
      els.deckText.textContent = s.name;
    }, 60);

    setTimeout(() => {
      clearInterval(spinTimer);
      spinTimer = null;
      drawing = false;
      setControlsDisabled(false);
      els.deck.classList.remove("is-spinning");

      hand = pickDistinct(pool, n);
      played = [];
      els.deckHint.textContent = "本局手牌";
      els.deckText.textContent = `已发 ${hand.length} 张`;
      renderHand();
      renderPlayed();
      burstSparks();
    }, 850);
  }

  function playCard(id) {
    const idx = hand.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const [skill] = hand.splice(idx, 1);
    played.unshift(skill);
    renderHand();
    renderPlayed();
    els.deckText.textContent = `手牌剩 ${hand.length} 张`;
  }

  function resetAll() {
    if (spinTimer) {
      clearInterval(spinTimer);
      spinTimer = null;
    }
    drawing = false;
    hand = [];
    played = [];
    els.deck.classList.remove("is-spinning");
    els.deckHint.textContent = "牌堆就绪";
    els.deckText.textContent = "点击下方「抽牌」发牌";
    setControlsDisabled(false);
    renderHand();
    renderPlayed();
  }

  function setControlsDisabled(disabled) {
    els.drawBtn.disabled = disabled;
    els.resetBtn.disabled = disabled;
    els.nMinus.disabled = disabled || nValue <= 1;
    els.nPlus.disabled = disabled || nValue >= selectedIds.size;
  }

  function renderHand() {
    els.hand.innerHTML = "";
    if (hand.length === 0) {
      els.hand.innerHTML = '<p class="empty">尚未抽牌</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    hand.forEach((skill, i) => {
      const card = document.createElement("article");
      card.className = "mcard";
      card.style.animationDelay = `${i * 70}ms`;

      const top = document.createElement("div");
      top.className = "mcard__top";
      const code = document.createElement("span");
      code.className = "mcard__code";
      code.textContent = skill.code;
      const group = document.createElement("span");
      group.className = "mcard__group";
      group.textContent = skill.group;
      top.appendChild(code);
      top.appendChild(group);

      const name = document.createElement("h3");
      name.className = "mcard__name";
      name.textContent = skill.name;

      const rule = document.createElement("p");
      rule.className = "mcard__rule";
      rule.textContent = formatRuleText(skill.rule);

      const play = document.createElement("button");
      play.type = "button";
      play.className = "mcard__play";
      play.textContent = "打出";
      play.dataset.id = skill.id;
      play.addEventListener("click", () => playCard(skill.id));

      card.appendChild(top);
      card.appendChild(name);
      card.appendChild(rule);
      card.appendChild(play);
      frag.appendChild(card);
    });
    els.hand.appendChild(frag);
  }

  function renderPlayed() {
    els.playedList.innerHTML = "";
    if (played.length === 0) {
      els.played.hidden = true;
      return;
    }
    els.played.hidden = false;
    const frag = document.createDocumentFragment();
    played.forEach((skill) => {
      const el = document.createElement("div");
      el.className = "effect";

      const head = document.createElement("div");
      head.className = "effect__head";
      const tag = document.createElement("span");
      tag.className = "effect__tag";
      tag.textContent = "已发动";
      const name = document.createElement("span");
      name.className = "effect__name";
      name.textContent = skill.name;
      const code = document.createElement("span");
      code.className = "effect__code";
      code.textContent = `${skill.code} · ${skill.group}`;
      head.appendChild(tag);
      head.appendChild(name);
      head.appendChild(code);

      const rule = document.createElement("p");
      rule.className = "effect__rule";
      rule.textContent = formatRuleText(skill.rule);

      el.appendChild(head);
      el.appendChild(rule);
      frag.appendChild(el);
    });
    els.playedList.appendChild(frag);
  }

  function burstSparks() {
    const rect = els.deck.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    for (let i = 0; i < 14; i++) {
      const spark = document.createElement("span");
      spark.className = "spark";
      const angle = (Math.PI * 2 * i) / 14 + Math.random() * 0.4;
      const dist = 60 + Math.random() * 90;
      spark.style.left = `${cx}px`;
      spark.style.top = `${cy}px`;
      spark.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      spark.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
      els.sparkLayer.appendChild(spark);
      const remove = () => {
        if (spark.parentNode) spark.parentNode.removeChild(spark);
      };
      spark.addEventListener("animationend", remove);
      spark.addEventListener("webkitAnimationEnd", remove);
      setTimeout(remove, 1000);
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  els.drawBtn.addEventListener("click", drawCards);
  els.resetBtn.addEventListener("click", resetAll);
  els.nMinus.addEventListener("click", () => setN(nValue - 1));
  els.nPlus.addEventListener("click", () => setN(nValue + 1));

  els.poolBtn.addEventListener("click", openPool);
  els.closePool.addEventListener("click", closePool);
  els.sheetBackdrop.addEventListener("click", closePool);
  els.confirmPool.addEventListener("click", confirmPool);

  els.selectAllBtn.addEventListener("click", () => {
    draftIds = new Set(skills.map((s) => s.id));
    renderPoolList();
  });

  els.clearAllBtn.addEventListener("click", () => {
    draftIds.clear();
    renderPoolList();
  });

  /* ---------------- 初始化 ---------------- */

  setN(nValue);
  updatePoolMeta();
  renderHand();
  renderPlayed();
})();
