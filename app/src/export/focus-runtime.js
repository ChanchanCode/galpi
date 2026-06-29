/* 자립형 내보내기 HTML 의 리더 런타임 (바닐라). 앱의 FocusMode + splitSentences + 점프를 옮긴 것.
   - 우상단 ◎ 버튼: 누르면 읽기/문단/문장 메뉴 열고 닫기.
   - 포커스(문단/문장) 중: 화면 좌측 탭=이전, 우측 탭=다음 단위(버튼 없음).
   - 각주/수식/정리 등(.fn-ref/.refl) 탭: 해당 위치로 이동 + 좌하단 "돌아가기" 버튼. */
(function () {
  "use strict";
  var SCROLL_SEL = ".reader-scroll";
  var CONTENT_SEL = ".reader-content";
  var HL_KEY = "focus-line";

  var ABBR = new Set([
    "e.g","i.e","cf","vs","fig","figs","eq","eqs","tab","sec","secs","no","nos","al",
    "dr","mr","mrs","ms","prof","vol","pp","ch","approx","resp","ca","viz","etc",
    "st","inc","ltd","co","jr","sr","ed","eds","cor","prop","thm","def","lem"
  ]);

  function splitSentences(text) {
    var res = [], start = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (c !== "." && c !== "?" && c !== "!") continue;
      var j = i + 1;
      while (j < text.length && /[)\]"'’”]/.test(text[j])) j++;
      var rest = text.slice(j);
      var ends = j >= text.length || /^\s*[A-Z([“"'\d]/.test(rest);
      if (!ends) continue;
      if (c === ".") {
        if (/\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "")) continue;
        var before = text.slice(start, i);
        var mw = before.match(/(\S+)$/);
        var wordRaw = mw ? mw[1] : "";
        var word = wordRaw.replace(/^[("'“[]+/, "").toLowerCase();
        if (ABBR.has(word)) continue;
        if (/^[A-Za-z]$/.test(wordRaw)) continue;
      }
      var k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      res.push(text.slice(start, k));
      start = k; i = k - 1;
    }
    if (start < text.length) res.push(text.slice(start));
    return res;
  }

  function supported() {
    return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
  }
  function scroller() { return document.querySelector(SCROLL_SEL); }
  function content() { return document.querySelector(CONTENT_SEL); }

  function visibleTextNodes(el) {
    var out = [];
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!n.nodeValue || !p) return NodeFilter.FILTER_REJECT;
        if (p.closest(".katex, .katex-display, script, style")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  function rangeForSpan(el, start, end) {
    var nodes = visibleTextNodes(el), acc = 0;
    var sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], len = node.nodeValue.length;
      if (!sNode && acc + len > start) { sNode = node; sOff = start - acc; }
      if (acc + len >= end) { eNode = node; eOff = end - acc; break; }
      acc += len;
    }
    if (!sNode || !eNode) return null;
    var r = document.createRange();
    try {
      r.setStart(sNode, Math.max(0, Math.min(sOff, sNode.nodeValue.length)));
      r.setEnd(eNode, Math.max(0, Math.min(eOff, eNode.nodeValue.length)));
    } catch (e) { return null; }
    return r;
  }

  function buildUnits(mode, el) {
    var blocks = Array.prototype.slice.call(el.querySelectorAll(":scope > [data-block-id]"));
    if (mode === "paragraph") return blocks.map(function (b) { return { el: b }; });
    var units = [];
    blocks.forEach(function (b) {
      var nodes = visibleTextNodes(b);
      if (!nodes.length) return;
      var full = nodes.map(function (n) { return n.nodeValue; }).join("");
      if (full.trim().length < 2) return;
      var off = 0;
      splitSentences(full).forEach(function (s) {
        if (s.trim().length >= 1) units.push({ el: b, start: off, end: off + s.length });
        off += s.length;
      });
    });
    return units;
  }

  function rectOf(u) {
    if (u.start == null) return u.el.getBoundingClientRect();
    var r = rangeForSpan(u.el, u.start, u.end);
    return r ? r.getBoundingClientRect() : u.el.getBoundingClientRect();
  }
  function inView(rect, sc) {
    if (!rect) return false;
    var s = sc.getBoundingClientRect();
    return rect.bottom > s.top + 8 && rect.top < s.bottom - 8;
  }

  var mode = "off", units = [], idx = -1, prevEl = null, lastMove = 0;
  // 활성 문장 하이라이트는 객체 하나를 유지하며 범위만 교체한다.
  // (WebKit/Safari 은 레지스트리 항목을 새 Highlight 로 교체하면 이전 칠한 영역을 다시 안 그리는 버그가 있어,
  //  같은 객체의 clear()/add() 로 갱신해야 이전 문장이 제대로 흐려진다.)
  var focusHl = null;

  function setFocusRange(r) {
    if (!supported()) return;
    if (!focusHl) { focusHl = new Highlight(); CSS.highlights.set(HL_KEY, focusHl); }
    focusHl.clear();
    focusHl.add(r);
  }

  function clearMarks() {
    if (prevEl) { prevEl.classList.remove("is-focus"); prevEl = null; }
    if (focusHl) focusHl.clear();
    if (supported()) CSS.highlights.delete(HL_KEY);
    focusHl = null;
  }

  function apply(i, scroll) {
    var u = units[i];
    if (!u) return;
    idx = i;
    if (mode === "paragraph") {
      if (prevEl && prevEl !== u.el) prevEl.classList.remove("is-focus");
      u.el.classList.add("is-focus");
      prevEl = u.el;
      if (scroll) u.el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      var r = rangeForSpan(u.el, u.start, u.end);
      if (r) setFocusRange(r);
      if (scroll && r) {
        var sc = scroller();
        if (sc) {
          var rect = r.getBoundingClientRect(), sRect = sc.getBoundingClientRect();
          var top = rect.top - sRect.top + sc.scrollTop - sc.clientHeight / 2 + rect.height / 2;
          sc.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      }
    }
  }

  function nearestIdx() {
    var sc = scroller();
    if (!units.length || !sc) return 0;
    var center = sc.getBoundingClientRect().top + sc.clientHeight / 2;
    if (mode === "sentence") {
      var bestEl = null, bestD = Infinity, seen = new Set();
      units.forEach(function (u) {
        if (seen.has(u.el)) return; seen.add(u.el);
        var rc = u.el.getBoundingClientRect();
        var d = Math.abs(rc.top + rc.height / 2 - center);
        if (d < bestD) { bestD = d; bestEl = u.el; }
      });
      var k = units.findIndex(function (u) { return u.el === bestEl; });
      return k < 0 ? 0 : k;
    }
    var best = 0, bd = Infinity;
    units.forEach(function (u, i) {
      var rc = u.el.getBoundingClientRect();
      var d = Math.abs(rc.top + rc.height / 2 - center);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function setMode(m) {
    mode = m;
    var menu = document.querySelector(".gx-menu");
    if (menu) Array.prototype.forEach.call(menu.querySelectorAll("[data-mode]"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-mode") === m);
    });
    var toggle = document.querySelector(".gx-toggle");
    if (toggle) toggle.classList.toggle("active", m !== "off");
    var c = content();
    if (m === "off" || !c) {
      delete document.body.dataset.focus;
      clearMarks();
      idx = -1;
      return;
    }
    document.body.dataset.focus = m;
    clearMarks();
    requestAnimationFrame(function () {
      units = buildUnits(m, c);
      apply(nearestIdx(), false);
    });
  }

  function step(dir, repeat) {
    if (mode === "off" || !units.length) return;
    if (repeat) {
      var now = performance.now();
      if (now - lastMove < 80) return;
      lastMove = now;
    } else lastMove = performance.now();
    var sc = scroller(), cur = idx;
    if (!repeat && (cur < 0 || (sc && !inView(rectOf(units[cur]), sc)))) cur = nearestIdx();
    else if (cur < 0) cur = nearestIdx();
    apply(Math.max(0, Math.min(units.length - 1, cur + dir)), true);
  }

  // ── 점프(각주/참조) + 돌아가기 ──────────────────────────────────
  var backStack = [];
  function showBack() {
    var b = document.querySelector(".gx-back");
    if (b) b.hidden = false;
  }
  function hideBack() {
    var b = document.querySelector(".gx-back");
    if (b) b.hidden = true;
  }
  function jumpToEl(target) {
    var sc = scroller();
    if (!sc || !target) return;
    backStack.push(sc.scrollTop);
    target.classList.add("ref-target-flash");
    setTimeout(function () { target.classList.remove("ref-target-flash"); }, 1400);
    target.scrollIntoView({ block: "center" }); // 즉시 이동(스크롤 애니메이션 없음)
    showBack();
  }
  function goBack() {
    var sc = scroller();
    if (!sc || !backStack.length) return;
    sc.scrollTop = backStack.pop();
    if (!backStack.length) hideBack();
  }
  function handleRefClick(el) {
    // 교차참조: data-ref-target → 같은 block-id 로 이동
    var refl = el.closest(".refl[data-ref-target]");
    if (refl) {
      var id = refl.getAttribute("data-ref-target");
      var tgt = document.querySelector('[data-block-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (tgt) jumpToEl(tgt);
      return true;
    }
    // 각주: data-fn-ref → 하단 각주 목록 항목으로 이동(접힌 <details> 펼침)
    var fn = el.closest(".fn-ref[data-fn-ref]");
    if (fn) {
      var label = fn.getAttribute("data-fn-ref");
      var item = document.querySelector('[data-fn-item="' + (window.CSS && CSS.escape ? CSS.escape(label) : label) + '"]');
      if (item) {
        var det = item.closest("details");
        if (det) det.open = true;
        jumpToEl(item);
      }
      return true;
    }
    return false;
  }

  function hasSelection() {
    var s = window.getSelection();
    return s && !s.isCollapsed && String(s).length > 0;
  }

  function onDocClick(e) {
    var t = e.target;
    // 컨트롤(토글/메뉴/목차/돌아가기)은 각자 핸들러가 처리
    if (t.closest(".gx-toggle, .gx-menu, .gx-toc, .gx-toc-toggle, .gx-back")) return;
    // 각주/참조 점프 우선
    if (handleRefClick(t)) { e.preventDefault(); return; }
    // 일반 링크는 그대로
    if (t.closest("a")) return;
    // 포커스 모드: 화면 좌/우 어디든(여백 포함) 탭하면 이전/다음 단위로 이동
    if (mode !== "off") {
      if (hasSelection()) return; // 텍스트 선택 중엔 이동 안 함
      step(e.clientX < window.innerWidth / 2 ? -1 : 1, false);
    }
  }

  function onKey(e) {
    if (mode === "off") {
      if (e.key === "Escape" && backStack.length) { e.preventDefault(); goBack(); }
      return;
    }
    var fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
    var back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (e.key === "Escape" && backStack.length) { e.preventDefault(); goBack(); return; }
    if (!fwd && !back) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!units.length) return;
    e.preventDefault();
    step(fwd ? 1 : -1, e.repeat);
  }

  // 목차 — 본문의 heading 들로 섹션 목록 생성, 클릭하면 즉시 이동.
  function buildToc() {
    var toc = document.querySelector(".gx-toc");
    var tocToggle = document.querySelector(".gx-toc-toggle");
    var c = content();
    if (!toc || !c) return;
    var heads = Array.prototype.slice.call(c.querySelectorAll(":scope > .blk-heading"));
    if (!heads.length) { if (tocToggle) tocToggle.hidden = true; return; }
    heads.forEach(function (h) {
      var lvl = parseInt(h.tagName.slice(1), 10) || 2;
      var btn = document.createElement("button");
      btn.className = "gx-toc-item lvl" + Math.min(lvl, 4);
      btn.textContent = (h.textContent || "").trim();
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        toc.hidden = true;
        jumpToEl(h);
      });
      toc.appendChild(btn);
    });
  }

  function init() {
    var toggle = document.querySelector(".gx-toggle");
    var menu = document.querySelector(".gx-menu");
    var tocToggle = document.querySelector(".gx-toc-toggle");
    var toc = document.querySelector(".gx-toc");
    if (tocToggle && toc) {
      buildToc();
      tocToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        toc.hidden = !toc.hidden;
        if (menu) menu.hidden = true;
        if (toggle) toggle.classList.remove("open");
      });
      document.addEventListener("click", function (e) {
        if (!toc.hidden && !toc.contains(e.target) && e.target !== tocToggle && !tocToggle.contains(e.target)) toc.hidden = true;
      });
    }
    if (toggle && menu) {
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        toggle.classList.toggle("open", !menu.hidden);
      });
      menu.addEventListener("click", function (e) {
        var b = e.target.closest("[data-mode]");
        if (!b) return;
        setMode(b.getAttribute("data-mode"));
        menu.hidden = true;
        toggle.classList.remove("open");
      });
      // 바깥 클릭 시 메뉴 닫기
      document.addEventListener("click", function (e) {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
          menu.hidden = true;
          toggle.classList.remove("open");
        }
      });
    }
    var back = document.querySelector(".gx-back");
    if (back) back.addEventListener("click", function (e) { e.stopPropagation(); goBack(); });

    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", function () {
      if (mode !== "off") units = buildUnits(mode, content());
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
