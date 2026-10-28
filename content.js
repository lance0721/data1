/**
 * 超星刷课助手 v2 - content script
 *
 * 架构（v2 重写，postMessage 消息总线，跨域 iframe 也能工作）：
 *  - 脚本注入所有 frame（all_frames: true）。
 *  - 顶层页面是「调度器」，每 2 秒广播 PING。
 *  - 含 <video> 的 frame 收到 PING 后向父级回 PONG（携带 token + 播放状态）。
 *  - PONG / ENDED 消息沿父链向上转发，每一层用自己文档里的任务点图标
 *    （.ans-job-icon）给消息打上「完成状态」注解 —— 视频的直接父级
 *    （知识卡片 frame）正是图标所在处，即使跨域也能把信息传上去。
 *  - 调度器按 token 定向下发 play / pause 命令，保证同时只有一个视频在播。
 *  - 播完（ended 或时长走满）→ 标记完成 → 下一个未完成视频 → 全部完成
 *    → 广播 CLICK_NEXT，「下一章」按钮在哪个 frame 里就由那个 frame 点击。
 */

(() => {
  if (!/chaoxing\.com$/i.test(location.hostname)) return;
  if (window.__CX_AUTO_V2__) return;
  window.__CX_AUTO_V2__ = true;

  const IS_TOP = (window === window.top);
  const TOKEN = Math.random().toString(36).slice(2, 10);
  const LS_RUN = 'cxAutoRunning';
  const LS_SPEED = 'cxAutoSpeed';
  const TICK_MS = 2000;

  /* ================================================================
     所有 frame 公共部分（视频节点 + 消息中继）
     ================================================================ */

  const me = {
    armed: false,          // 收到 play 命令后为 true，负责自动恢复播放
    bound: new WeakSet()
  };

  function myVideos() {
    try { return [...document.querySelectorAll('video')]; } catch (e) { return []; }
  }

  function visible(el) {
    try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch (e) { return false; }
  }

  // 本 frame 文档里的任务点图标类名（用于完成状态注解）
  function myJobInfo() {
    try {
      return [...document.querySelectorAll('.ans-job-icon')]
        .map(e => e.className).join('|');
    } catch (e) { return ''; }
  }

  function videoInfo() {
    const vs = myVideos();
    if (!vs.length) return null;
    const v = vs[0];
    return {
      n: vs.length,
      src: (v.currentSrc || v.src || '').slice(0, 120),
      duration: isFinite(v.duration) ? v.duration : 0,
      currentTime: v.currentTime || 0,
      paused: !!v.paused,
      ended: !!v.ended,
      muted: !!v.muted,
      rate: v.playbackRate || 0
    };
  }

  function bindVideos() {
    myVideos().forEach(v => {
      if (me.bound.has(v)) return;
      me.bound.add(v);
      v.addEventListener('ended', () => {
        if (me.armed) {
          me.armed = false;
          console.info('[CX刷课] 视频 ended，上报', location.href.slice(0, 80));
          sendUp({ cx: 'ENDED', token: TOKEN });
        }
      });
      // 播放中被意外暂停 → 自动恢复
      v.addEventListener('pause', () => {
        setTimeout(() => {
          if (me.armed && !v.ended && v.paused) cmdPlay();
        }, 1000);
      });
    });
  }

  function cmdPlay(speed) {
    me.armed = true;
    const vs = myVideos();
    if (!vs.length) return;
    const rate = speed || 1;
    vs.forEach(v => {
      try { v.muted = true; v.volume = 0; v.playbackRate = rate; } catch (e) {}
    });
    const v = vs[0];
    try {
      const p = v.play();
      if (p && p.catch) p.catch(() => {
        // 直接调用 play 失败时，尝试点击播放器自身的播放按钮
        ['.vjs-big-play-button', '.xgplayer-play', '.xgplayer-start',
         '.prism-big-play-btn', '.dplayer-play-icon', '[class*="playIcon"]'
        ].forEach(sel => {
          try { const b = document.querySelector(sel); if (b) b.click(); } catch (e) {}
        });
        setTimeout(() => { try { v.play(); } catch (e) {} }, 800);
      });
      console.info('[CX刷课] cmdPlay', location.href.slice(0, 80));
    } catch (e) {}
  }

  function cmdPause() {
    me.armed = false;
    myVideos().forEach(v => { try { v.pause(); } catch (e) {} });
  }

  // 向父级发送消息。
  // 注意：不在子 frame 预设 jobInfo（否则中间层会误以为已注解而跳过）。
  // jobInfo 只由「实际持有 .ans-job-icon 的 frame」在转发时补上。
  function sendUp(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }

  function forwardDown(msg) {
    let frames;
    try { frames = [...document.querySelectorAll('iframe')]; } catch (e) { return; }
    frames.forEach(f => {
      try { f.contentWindow.postMessage(msg, '*'); } catch (e) {}
    });
  }

  // 自动点掉弹窗里的确认按钮（每个 frame 处理自己的文档）
  function clickConfirmsLocal() {
    let btns;
    try {
      btns = document.querySelectorAll('button, a, .popbtn, .btn, input[type="button"]');
    } catch (e) { return; }
    btns.forEach(b => {
      let t = '';
      try { t = (b.value || b.textContent || '').trim(); } catch (e) { return; }
      if (!/^(确定|确认|继\s*续|继续播放)$/.test(t)) return;
      let box = null;
      try {
        box = b.closest('[class*="pop"],[class*="dialog"],[class*="mask"],[class*="layer"],[class*="window"],[class*="modal"]');
      } catch (e) {}
      if (box && visible(b)) { try { b.click(); } catch (e) {} }
    });
  }

  // 在本 frame 的文档里找并点击「下一章/下一节」
  // 优先级：1) 官方按钮 #prevNextFocusNext  2) 文字匹配  3) 左侧目录树定位下一小节
  function tryClickNext() {
    // 1) 官方「下一节」按钮（新版泛雅固定 id）
    const sels = ['#prevNextFocusNext', '[title="下一章"]', '[title="下一节"]',
                  '.orientationh', '#prevNextFocus', '.nextChapter', '.posCatalog_next'];
    for (const s of sels) {
      try {
        const el = document.querySelector(s);
        if (el && visible(el)) { el.click(); console.info('[CX刷课] 下一节按钮:', s); return true; }
      } catch (e) {}
    }
    // 2) 文字匹配
    try {
      const all = document.querySelectorAll('a, div, span, button, li, p');
      for (const el of all) {
        const t = ((el.title || '') + ' ' + (el.textContent || '')).trim();
        if ((t === '下一章' || t === '下一节' || t === '下一个' || (el.title || '').includes('下一章') || (el.title || '').includes('下一节')) && visible(el)) {
          el.click(); console.info('[CX刷课] 下一节按钮(文字):', t.slice(0, 20));
          return true;
        }
      }
    } catch (e) {}
    // 3) 目录树兜底：定位当前小节(.posCatalog_active)，点击下一小节/下一章第一节
    return navByCatalog();
  }

  // 目录树结构：#coursetree > ul > li(章节) > .posCatalog_select(小节，.firstLayer 为章标题)
  // 当前小节带 .posCatalog_active，可点击元素为 .posCatalog_name
  function navByCatalog() {
    try {
      const tree = document.querySelector('#coursetree');
      if (!tree) return false;
      const chapters = tree.querySelectorAll(':scope > ul > li');
      for (let ci = 0; ci < chapters.length; ci++) {
        const sections = chapters[ci].querySelectorAll('.posCatalog_select:not(.firstLayer)');
        for (let si = 0; si < sections.length; si++) {
          if (!sections[si].classList.contains('posCatalog_active')) continue;
          // 找到当前小节 → 先试同章下一节，再试后续章节的第一节
          let target = sections[si + 1];
          if (!target) {
            for (let cj = ci + 1; cj < chapters.length; cj++) {
              const secs = chapters[cj].querySelectorAll('.posCatalog_select:not(.firstLayer)');
              if (secs.length) { target = secs[0]; break; }
            }
          }
          if (!target) {
            console.info('[CX刷课] 已是课程最后一个小节');
            return false;
          }
          const name = target.querySelector('.posCatalog_name');
          if (name) {
            name.click();
            console.info('[CX刷课] 目录树切节:',
              (name.getAttribute('title') || name.textContent || '').slice(0, 30));
            return true;
          }
        }
      }
    } catch (e) { console.warn('[CX刷课] 目录树导航失败', e); }
    return false;
  }

  /* ---------------- 非顶层 frame：中继 + 视频节点 ---------------- */

  if (!IS_TOP) {
    window.addEventListener('message', ev => {
      const m = ev.data;
      if (!m || typeof m !== 'object' || !m.cx) return;

      if (m.cx === 'PING') {
        forwardDown(m);                       // 继续向下传
        bindVideos();
        if (myVideos().length) {              // 视频节点回 PONG
          sendUp({ cx: 'PONG', token: TOKEN, info: videoInfo() });
        }
      } else if (m.cx === 'CMD') {
        if (m.token === TOKEN || m.token === '*') {
          // token='*' 为全局广播（如「停止」）
          if (m.action === 'play') cmdPlay(m.speed); else cmdPause();
        } else {
          forwardDown(m);                     // 不是给我的，继续向下传
        }
      } else if (m.cx === 'CLICK_NEXT') {
        tryClickNext();
        forwardDown(m);
      } else if (m.cx === 'PONG' || m.cx === 'ENDED' || m.cx === 'DIAG') {
        // 向上转发：若本 frame 有任务点图标且消息还没注解，补上（只有最近一层生效）
        if (m.jobInfo === undefined) {
          const ji = myJobInfo();
          if (ji) m.jobInfo = ji;
        }
        if (m.cx === 'DIAG') {
          m.frames = (m.frames || []);
          m.frames.push({
            href: location.href.slice(0, 160),
            videos: myVideos().length,
            jobIcons: myJobInfo()
          });
        }
        try { window.parent.postMessage(m, '*'); } catch (e) {}
      }
    });

    // 视频可能晚于 PING 出现：video 元素挂载后主动广播一次（1.5s 节流）
    let lastPong = 0;
    const mo = new MutationObserver(() => {
      if (myVideos().length && Date.now() - lastPong > 1500) {
        lastPong = Date.now();
        bindVideos();
        sendUp({ cx: 'PONG', token: TOKEN, info: videoInfo() });
      }
    });
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

    return; // 非顶层到此为止
  }

  /* ================================================================
     顶层 frame：调度器 + 悬浮面板
     ================================================================ */

  const top = {
    running: false,
    timer: null,
    registry: new Map(),   // token -> {token, info, jobInfo, seen}（最近活跃）
    everSeen: new Map(),   // token -> 最新条目快照（本章节见过的所有视频，不清理）
    done: new Set(),       // 本页已播完的 token
    current: null,         // 当前在播的 token
    cooldownUntil: 0,
    emptyTicks: 0,
    nextAttempts: 0,
    lastNote: '',
    chapterId: null,       // 当前章节 id（URL 里的 chapterId）
    lastNewTokenAt: 0      // 最近一次发现新视频 token 的时间
  };

  function parseChapterId(href) {
    const m = /chapterId=(\d+)/.exec(href || '');
    return m ? m[1] : null;
  }

  // 章节切换后重置本页状态
  function onChapterChanged(newId) {
    console.info('[CX刷课] 章节切换:', top.chapterId, '->', newId);
    top.chapterId = newId;
    top.registry = new Map();
    top.everSeen = new Map();
    top.done = new Set();
    top.current = null;
    top.nextAttempts = 0;
    top.emptyTicks = 0;
    top.stableChecks = 0;
    top.lastNewTokenAt = Date.now();
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object' || !m.cx) return;
    if (m.cx === 'PONG') {
      const prev = top.registry.get(m.token) || {};
      const entry = {
        token: m.token,
        info: m.info || prev.info,
        jobInfo: m.jobInfo || prev.jobInfo || '',
        seen: Date.now()
      };
      top.registry.set(m.token, entry);
      if (!top.everSeen.has(m.token)) {
        top.everSeen.set(m.token, entry);
        top.lastNewTokenAt = Date.now();
        top.stableChecks = 0;   // 发现新视频，重置稳定期
        console.info('[CX刷课] 发现新视频:', m.token, '本页累计', top.everSeen.size, '个');
      } else {
        top.everSeen.set(m.token, entry);  // 更新快照
      }
    } else if (m.cx === 'ENDED') {
      console.info('[CX刷课] 收到 ENDED:', m.token);
      top.done.add(m.token);
      if (top.current === m.token) top.current = null;
    } else if (m.cx === 'DIAG') {
      m.topHref = location.href;
      m.registry = [...top.registry.values()];
      m.everSeen = top.everSeen.size;
      m.done = [...top.done];
      m.current = top.current;
      showDiag(m);
    }
  });

  function isFinishedEntry(e) {
    // 1) 任务点图标已变绿/带 finish 类
    if (e.jobInfo && /finish|jobfinish|green/i.test(e.jobInfo)) return true;
    // 2) 视频时长基本走满（含上次看到结尾的情况）
    const i = e.info;
    if (i && i.duration > 0 && i.currentTime >= i.duration - 1.5) return true;
    return false;
  }

  function sendCmd(token, action) {
    forwardDown({ cx: 'CMD', token, action, speed: getSpeed() });
  }

  function gotoNextChapter() {
    top.nextAttempts++;
    if (top.nextAttempts > 8) {
      setNote('多次尝试跳转无变化，已停止。请手动检查（可能需要答题或已是最后一章）');
      stopAll();
      return;
    }
    setNote('本页视频全部完成，跳转下一节…(第' + top.nextAttempts + '次)');
    let clicked = tryClickNext();      // 顶层自己找
    if (!clicked) forwardDown({ cx: 'CLICK_NEXT' });  // 找不到就让子 frame 找
    top.cooldownUntil = Date.now() + 8000;
  }

  // 本页（本章节）所有视频是否全部完成
  function allSeenDone() {
    for (const [token, entry] of top.everSeen) {
      if (top.done.has(token)) continue;
      const live = top.registry.get(token) || entry;
      if (!isFinishedEntry(live)) return false;
    }
    return top.everSeen.size > 0;
  }

  function tick() {
    if (!top.running) return;
    clickConfirmsLocal();

    // 章节变更检测（SPA 切章不会重载页面，靠 URL 的 chapterId 判断）
    const cid = parseChapterId(location.href);
    if (cid && cid !== top.chapterId) onChapterChanged(cid);

    forwardDown({ cx: 'PING' });

    if (Date.now() < top.cooldownUntil) { updatePanel(); return; }

    const entries = [...top.registry.values()].filter(e => e.info && e.info.n > 0);

    // 维护当前视频
    if (top.current) {
      const e = top.registry.get(top.current);
      if (!e) {
        top.current = null;
      } else if (e.info.ended ||
                 (e.info.duration > 0 && e.info.currentTime >= e.info.duration - 1.5)) {
        top.done.add(top.current);
        top.current = null;
      } else if (e.info.paused) {
        // 卡住检测：暂停且进度 15 秒无变化（播放器不触发 ended / 拒绝恢复）→ 判定完成
        if (e.lastTime === e.info.currentTime) {
          e.stallMs = (e.stallMs || 0) + TICK_MS;
          if (e.stallMs >= 15000 && e.info.currentTime > 0) {
            console.info('[CX刷课] 进度停滞 15s，判定完成:', top.current);
            top.done.add(top.current);
            top.current = null;
          } else {
            sendCmd(top.current, 'play'); // 意外暂停自动恢复
          }
        } else {
          e.stallMs = 0;
          sendCmd(top.current, 'play');
        }
        e.lastTime = e.info.currentTime;
      } else {
        e.stallMs = 0;
        e.lastTime = e.info.currentTime;
        top.nextAttempts = 0;
        updatePanel();
        return;                          // 正常播放中
      }
    }

    // 找下一个未完成的视频
    if (top.current === null) {
      const cand = entries.find(e => !top.done.has(e.token) && !isFinishedEntry(e));
      if (cand) {
        entries.forEach(e => { if (e.token !== cand.token) sendCmd(e.token, 'pause'); });
        top.current = cand.token;
        top.nextAttempts = 0;
        top.emptyTicks = 0;
        sendCmd(cand.token, 'play');
        console.info('[CX刷课] 开始播放:', cand.token, cand.info && cand.info.src);
      } else if (allSeenDone()) {
        // 本页所有见过的视频都完成 → 稳定期确认后再跳（防止懒加载视频还没报上名）
        const quietFor = Date.now() - top.lastNewTokenAt;
        if (quietFor < 10000) {
          setNote('视频已播完，' + Math.ceil((10000 - quietFor) / 1000) + 's 后确认切节…');
        } else {
          top.stableChecks = (top.stableChecks || 0) + 1;
          if (top.stableChecks >= 2) {   // 连续 2 次确认（约 4 秒）无新视频
            top.stableChecks = 0;
            gotoNextChapter();
          } else {
            setNote('确认无新视频任务点…');
          }
        }
      } else if (top.everSeen.size > 0) {
        // 本页还有未播完的视频，但当前 iframe 里找不到可播的（可能被页面移除）→ 等待
        top.emptyTicks++;
        if (top.emptyTicks >= 10) {      // 20 秒仍无法播放才跳节
          top.emptyTicks = 0;
          setNote('部分视频无法播放，尝试跳下一节');
          gotoNextChapter();
        } else {
          setNote('等待视频加载… (' + top.emptyTicks + '/10)');
        }
      } else {
        top.emptyTicks++;
        if (top.emptyTicks >= 5) {       // 连续 10 秒无任何视频 → 本章无视频任务
          top.emptyTicks = 0;
          gotoNextChapter();
        } else {
          setNote('等待视频加载… (' + top.emptyTicks + '/5)');
        }
      }
    }
    updatePanel();
  }

  /* ---------------- 启停 ---------------- */

  function startAll() {
    if (top.running) return;
    top.running = true;
    localStorage.setItem(LS_RUN, '1');
    top.cooldownUntil = Date.now() + 3000;
    top.emptyTicks = 0;
    top.nextAttempts = 0;
    if (!top.timer) top.timer = setInterval(tick, TICK_MS);
    setNote('已启动');
    updateBtns();
  }

  function stopAll() {
    top.running = false;
    localStorage.setItem(LS_RUN, '0');
    forwardDown({ cx: 'CMD', token: '*', action: 'pause' });
    updateBtns();
  }

  /* ---------------- 悬浮面板 ---------------- */

  let panel, noteEl, countEl, btnStart, btnStop, speedSel;

  function getSpeed() { return parseFloat(speedSel && speedSel.value) || 1; }

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'top:80px', 'right:16px', 'z-index:2147483647',
      'width:230px', 'padding:12px', 'border-radius:10px',
      'background:rgba(30,30,34,0.92)', 'color:#eee',
      'font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'user-select:none'
    ].join(';');
    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">📚 超星刷课助手 v2</div>
      <div id="cx-count" style="margin-bottom:4px;color:#9fd49f;">-</div>
      <div id="cx-note" style="margin-bottom:8px;word-break:break-all;">未开始</div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button id="cx-start" style="flex:1;padding:5px 0;border:0;border-radius:6px;background:#4caf50;color:#fff;cursor:pointer;">开始</button>
        <button id="cx-stop" style="flex:1;padding:5px 0;border:0;border-radius:6px;background:#e53935;color:#fff;cursor:pointer;">停止</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <select id="cx-speed" style="flex:1;padding:3px;border-radius:5px;border:0;">
          <option value="1">1x（默认，最稳）</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x（有风控风险）</option>
        </select>
        <button id="cx-diag" style="padding:4px 8px;border:0;border-radius:6px;background:#42a5f5;color:#fff;cursor:pointer;">诊断</button>
      </div>`;
    document.documentElement.appendChild(panel);

    countEl = panel.querySelector('#cx-count');
    noteEl = panel.querySelector('#cx-note');
    btnStart = panel.querySelector('#cx-start');
    btnStop = panel.querySelector('#cx-stop');
    speedSel = panel.querySelector('#cx-speed');
    speedSel.value = localStorage.getItem(LS_SPEED) || '1';
    speedSel.addEventListener('change', () => {
      localStorage.setItem(LS_SPEED, speedSel.value);
    });
    panel.querySelector('#cx-diag').addEventListener('click', runDiag);
    btnStart.addEventListener('click', startAll);
    btnStop.addEventListener('click', stopAll);
    updateBtns();
  }

  function setNote(t) { top.lastNote = t; if (noteEl) noteEl.textContent = t; }

  function updatePanel() {
    if (!countEl) return;
    let finished = 0;
    for (const [token, entry] of top.everSeen) {
      if (top.done.has(token) || isFinishedEntry(top.registry.get(token) || entry)) finished++;
    }
    let cur = '-';
    if (top.current) {
      const e = top.registry.get(top.current);
      if (e && e.info) {
        cur = (e.info.paused ? '⏸' : '▶') +
          ' ' + Math.floor(e.info.currentTime) + '/' + Math.floor(e.info.duration) + 's';
      }
    }
    countEl.textContent = `本页视频 ${finished}/${top.everSeen.size} · ${cur}`;
    if (!top.running) setNote(top.lastNote || '已停止');
  }

  function updateBtns() {
    btnStart.disabled = top.running;
    btnStop.disabled = !top.running;
    btnStart.style.opacity = top.running ? '.5' : '1';
    btnStop.style.opacity = top.running ? '1' : '.5';
  }

  /* ---------------- 诊断 ---------------- */

  function collectIframes() {
    const out = [];
    (function walk(win, depth) {
      if (depth > 6) return;
      let doc;
      try { doc = win.document; } catch (e) { return; }
      try {
        doc.querySelectorAll('iframe').forEach(f => {
          out.push(f.src);
          if (f.contentWindow) {
            try { void f.contentWindow.document; walk(f.contentWindow, depth + 1); }
            catch (e) { /* 跨域，仅记录 src */ }
          }
        });
      } catch (e) {}
    })(window, 0);
    return out;
  }

  function runDiag() {
    forwardDown({ cx: 'PING' });
    setTimeout(() => {
      window.postMessage({ cx: 'DIAG', frames: [] }, '*');
    }, 600);
  }

  function showDiag(m) {
    const report = {
      页面: m.topHref,
      顶层视频数: document.querySelectorAll('video').length,
      顶层任务点图标: myJobInfo(),
      iframe列表: collectIframes(),
      各frame情况: m.frames || [],
      视频节点: m.registry,
      已完成token: m.done,
      当前播放: m.current,
      下一章按钮顶层可见: !!tryProbeNext()
    };
    const text = JSON.stringify(report, null, 2);
    console.info('[CX刷课] 诊断报告：', report);
    try { navigator.clipboard.writeText(text); } catch (e) {}
    window.prompt('诊断信息已复制到剪贴板（若无请手动复制），发给 AI 即可：', text);
  }

  function tryProbeNext() {
    const sels = ['#prevNextFocusNext', '[title="下一章"]', '[title="下一节"]',
                  '.orientationh', '#prevNextFocus', '.nextChapter'];
    for (const s of sels) {
      try { const el = document.querySelector(s); if (el && visible(el)) return s; } catch (e) {}
    }
    try {
      const tree = document.querySelector('#coursetree');
      if (tree && tree.querySelector('.posCatalog_active')) return '#coursetree目录树(有当前节点)';
    } catch (e) {}
    return null;
  }

  /* ---------------- 初始化 ---------------- */

  top.chapterId = parseChapterId(location.href);
  top.lastNewTokenAt = Date.now();
  buildPanel();
  if (localStorage.getItem(LS_RUN) === '1') {
    setNote('3 秒后自动继续…');
    setTimeout(() => { startAll(); }, 3000);
  }
})();
