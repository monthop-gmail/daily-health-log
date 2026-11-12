'use strict';
/* บันทึกประจำวัน — frontend (vanilla JS, ไม่ต้อง build)
 * - บันทึกลงเครื่องก่อน (optimistic) แล้วค่อยส่งขึ้นเซิร์ฟเวอร์ผ่าน outbox → ใช้ได้แม้เน็ตหลุด
 * - ทุกรายการมี id จากฝั่งเครื่อง จึงส่งซ้ำได้ไม่เกิดรายการซ้อน
 */
(() => {
  const DAY = 86400000;
  const LEVELS = ['', 'น้อยมาก', 'น้อย', 'ปานกลาง', 'มาก', 'มากที่สุด'];
  const app = document.getElementById('app');
  const sheetEl = document.getElementById('sheet');
  const toastEl = document.getElementById('toast');

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage full / private mode */
      }
    },
    del(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };

  // ---------- วันที่ / เวลา ----------
  const startOfDay = (ts) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const addDays = (ts, n) => {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const fromDayKey = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  const fmtTime = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const toLocalInput = (ts) => `${dayKey(ts)}T${fmtTime(ts)}`;
  const F_LONG = new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const F_MED = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
  const F_DM = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' });
  const F_WDM = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
  const F_DMY = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
  const relDay = (ts) => {
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return 'วันนี้';
    if (k === dayKey(addDays(Date.now(), -1))) return 'เมื่อวาน';
    return '';
  };
  const lastSeen = (ts) => {
    const r = relDay(ts);
    if (r === 'วันนี้') return fmtTime(ts);
    if (r) return `${r} ${fmtTime(ts)}`;
    return F_DM.format(ts);
  };

  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  const svg = (inner) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    report: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 11h6M9 15h4"/>'),
    settings: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
    back: svg('<path d="M15 5l-7 7 7 7"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  };

  // ---------- state ----------
  const FALLBACK_CATS = [{ key: 'note', label: 'จดไว้', emoji: '📝', presets: [] }];
  const state = {
    authed: null,
    view: 'main',
    online: true,
    syncing: false,
    lastRefresh: 0,
    cats: store.get('dl_cats', FALLBACK_CATS),
    sugg: store.get('dl_sugg', {}),
    entries: new Map(store.get('dl_cache', []).map((e) => [e.id, e])),
    outbox: store.get('dl_outbox', []),
    seq: store.get('dl_seq', 0),
    touched: new Map(), // id → {at, entry|null} การแก้ไขล่าสุดในเครื่อง กันข้อมูลหายระหว่าง refresh
    windowStart: addDays(startOfDay(Date.now()), -6),
  };

  const catOf = (key) =>
    state.cats.find((c) => c.key === key) || { key, label: key, emoji: '📝', presets: [], unknown: true };

  // ---------- API ----------
  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      const err = new Error('network');
      err.network = true;
      throw err;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `http_${res.status}`);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  function handleErr(e) {
    if (e.status === 401) {
      showLogin();
      return true;
    }
    if (e.network) {
      state.online = false;
      updateSync();
      return true;
    }
    return false;
  }

  // ---------- outbox / sync ----------
  const opId = (o) => (o.type === 'put' ? o.entry.id : o.id);
  const persistOutbox = () => {
    store.set('dl_outbox', state.outbox);
    store.set('dl_seq', state.seq);
  };
  const pendingIds = () => new Set(state.outbox.filter((o) => o.type === 'put').map((o) => o.entry.id));

  function queue(op) {
    const id = opId(op);
    state.outbox = state.outbox.filter((o) => opId(o) !== id);
    op.seq = ++state.seq;
    state.outbox.push(op);
    persistOutbox();
    updateSync();
  }

  function applyOutbox(map, inRange = () => true) {
    for (const o of state.outbox) {
      if (o.type === 'put') {
        if (inRange(o.entry)) map.set(o.entry.id, o.entry);
        else map.delete(o.entry.id);
      } else map.delete(o.id);
    }
  }

  async function flush() {
    if (state.syncing || !state.outbox.length || state.authed === false) return;
    state.syncing = true;
    updateSync();
    const batch = state.outbox.slice(0, 200);
    let again = false;
    try {
      const r = await api('/api/sync', { method: 'POST', body: { ops: batch.map(({ seq, ...o }) => o) } });
      const sent = new Set(batch.map((o) => o.seq));
      state.outbox = state.outbox.filter((o) => !sent.has(o.seq));
      persistOutbox();
      state.online = true;
      if (r.rejected && r.rejected.length) toast(`มี ${r.rejected.length} รายการที่ระบบไม่รับ (ข้อมูลไม่ถูกต้อง)`);
      again = state.outbox.length > 0;
    } catch (e) {
      if (e.status === 400) {
        // ข้อมูลทั้งชุดเสีย — ทิ้งเพื่อไม่ให้ค้างตลอดไป
        const sent = new Set(batch.map((o) => o.seq));
        state.outbox = state.outbox.filter((o) => !sent.has(o.seq));
        persistOutbox();
        toast('ส่งข้อมูลบางส่วนไม่สำเร็จ');
      } else handleErr(e);
    } finally {
      state.syncing = false;
      updateSync();
      if (state.view === 'main') renderMain();
    }
    if (again) flush();
  }

  function cacheEntries() {
    const since = addDays(Date.now(), -45);
    store.set(
      'dl_cache',
      [...state.entries.values()].filter((e) => e.ts >= since).slice(0, 3000)
    );
  }

  function saveEntry(e) {
    const entry = {
      id: e.id,
      ts: e.ts,
      category: e.category,
      text: (e.text || '').trim(),
      level: e.level ?? null,
      updated_at: Date.now(),
    };
    state.entries.set(entry.id, entry);
    state.touched.set(entry.id, { at: entry.updated_at, entry });
    queue({ type: 'put', entry });
    if (entry.ts < state.windowStart) {
      state.windowStart = startOfDay(entry.ts);
      refreshEntries();
    }
    cacheEntries();
    if (state.view === 'main') renderMain();
    flush();
    return entry;
  }

  function deleteEntry(id) {
    const old = state.entries.get(id);
    if (!old) return;
    const at = Date.now();
    state.entries.delete(id);
    state.touched.set(id, { at, entry: null });
    queue({ type: 'del', id, updated_at: at });
    cacheEntries();
    if (state.view === 'main') renderMain();
    flush();
    toast('ลบแล้ว', { label: 'เลิกทำ', fn: () => saveEntry(old) });
  }

  // ---------- โหลดข้อมูล ----------
  async function refreshEntries() {
    const t0 = Date.now();
    const from = state.windowStart;
    try {
      const r = await api(`/api/entries?from=${from}&to=${Date.now() + 2 * DAY}`);
      const map = new Map(r.entries.map((e) => [e.id, e]));
      applyOutbox(map);
      for (const [id, t] of state.touched) {
        if (t.at >= t0 - 2000) t.entry ? map.set(id, t.entry) : map.delete(id);
        else if (Date.now() - t.at > 5 * 60000) state.touched.delete(id);
      }
      state.entries = map;
      state.online = true;
      cacheEntries();
      if (state.view === 'main') renderMain();
    } catch (e) {
      handleErr(e);
    }
  }

  async function refreshMeta() {
    try {
      const [c, s] = await Promise.all([api('/api/categories'), api('/api/suggestions')]);
      state.cats = c.categories;
      state.sugg = s.suggestions || {};
      store.set('dl_cats', state.cats);
      store.set('dl_sugg', state.sugg);
      if (state.view === 'main') renderMain();
    } catch (e) {
      handleErr(e);
    }
  }

  async function refreshAll() {
    state.lastRefresh = Date.now();
    await Promise.all([refreshMeta(), refreshEntries()]);
  }

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg, action) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
    toastEl.hidden = false;
    if (action) {
      $('button', toastEl).onclick = () => {
        toastEl.hidden = true;
        action.fn();
      };
    }
    toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 6000 : 2600);
  }

  function updateSync() {
    const n = state.outbox.length;
    let cls = '';
    let txt = '';
    if (!state.online) {
      cls = 'off';
      txt = n ? `ออฟไลน์ · รอส่ง ${n} รายการ (บันทึกไว้ในเครื่องแล้ว)` : 'ออฟไลน์ — ยังบันทึกได้ตามปกติ';
    } else if (n) {
      cls = 'wait';
      txt = state.syncing ? `กำลังส่ง ${n} รายการ…` : `รอส่ง ${n} รายการ`;
    }
    for (const el of $$('.sync')) {
      el.className = `sync ${cls}`;
      el.textContent = txt;
      el.hidden = !txt;
    }
    const p = $('#pending-count');
    if (p) p.textContent = String(n);
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function toCSV(list) {
    const rows = [['วันที่', 'เวลา', 'หมวด', 'รายละเอียด', 'ระดับ']];
    for (const e of [...list].sort((a, b) => a.ts - b.ts)) {
      rows.push([dayKey(e.ts), fmtTime(e.ts), catOf(e.category).label, e.text || '', e.level ?? '']);
    }
    const cell = (v) => {
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  }

  // ---------- หน้า: ล็อกอิน ----------
  function showLogin() {
    state.authed = false;
    if (sheetEl.open) sheetEl.close();
    renderLogin();
  }

  function renderLogin(msg = '') {
    app.innerHTML = `
      <main class="login">
        <div class="login-card">
          <img src="/icon.svg" alt="">
          <h1>บันทึกประจำวัน</h1>
          <p>ใส่รหัสผ่านเพื่อเข้าใช้งาน</p>
          <form id="login-form">
            <input class="in" type="password" name="password" autocomplete="current-password" placeholder="รหัสผ่าน" required autofocus>
            <button class="btn primary" type="submit">เข้าสู่ระบบ</button>
            <p class="err" id="login-err">${esc(msg)}</p>
          </form>
        </div>
      </main>`;
  }

  async function doLogin(form) {
    const btn = $('button', form);
    const err = $('#login-err');
    btn.disabled = true;
    err.textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: form.password.value } });
      state.authed = true;
      state.online = true;
      route();
      await refreshAll();
      flush();
      openDeepLink();
    } catch (e) {
      const m = {
        wrong_password: 'รหัสผ่านไม่ถูกต้อง',
        too_many_attempts: 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่',
        password_not_configured: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งรหัสผ่าน หรือรหัสผ่านสั้นเกินไป (APP_PASSWORD ต้องยาวอย่างน้อย 8 ตัว)',
      };
      err.textContent = e.network ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' : m[e.code] || 'เข้าสู่ระบบไม่สำเร็จ';
      btn.disabled = false;
      form.password.select();
    }
  }

  // ---------- หน้า: หลัก ----------
  function renderMain() {
    const now = Date.now();
    const last = {};
    for (const e of state.entries.values()) {
      if (e.ts <= now + 60000 && (!last[e.category] || e.ts > last[e.category])) last[e.category] = e.ts;
    }
    const visible = state.cats.filter((c) => !c.hidden);
    const pending = pendingIds();
    const y = window.scrollY;
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="eyebrow">${esc(F_LONG.format(now))}</div>
          <h1>บันทึกประจำวัน</h1>
        </div>
        <nav class="top-actions">
          <a class="icon-btn" href="#/summary" aria-label="สรุปสำหรับพบแพทย์" title="สรุปสำหรับพบแพทย์">${ICON.report}</a>
          <a class="icon-btn" href="#/settings" aria-label="ตั้งค่า" title="ตั้งค่า">${ICON.settings}</a>
        </nav>
      </header>
      <div class="sync" hidden></div>
      <section class="quick" aria-label="บันทึกด่วน">
        ${visible
          .map(
            (c) => `<button class="qbtn" type="button" data-action="add" data-cat="${esc(c.key)}">
              <span class="qemoji" aria-hidden="true">${esc(c.emoji || '•')}</span>
              <span class="qlabel">${esc(c.label)}</span>
              <span class="qlast">${last[c.key] ? esc(lastSeen(last[c.key])) : '&nbsp;'}</span>
            </button>`
          )
          .join('')}
      </section>
      <section class="timeline" aria-label="บันทึกล่าสุด">${renderDays(pending)}</section>
      <button class="btn ghost wide" type="button" data-action="more">ดูย้อนหลังเพิ่มอีก 7 วัน</button>
      <p class="window-note">แสดงตั้งแต่${esc(F_LONG.format(state.windowStart))}</p>`;
    window.scrollTo(0, y);
    updateSync();
  }

  function renderDays(pending) {
    const groups = new Map([[dayKey(Date.now()), []]]);
    const list = [...state.entries.values()].filter((e) => e.ts >= state.windowStart).sort((a, b) => b.ts - a.ts);
    for (const e of list) {
      const k = dayKey(e.ts);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    return [...groups.keys()]
      .sort()
      .reverse()
      .map((k) => {
        const items = groups.get(k);
        const ts = fromDayKey(k);
        const rel = relDay(ts);
        return `<div class="day">
          <h2 class="day-head"><span>${rel ? `<b>${rel}</b> · ` : ''}${esc(F_MED.format(ts))}</span>
            <span class="count">${items.length ? `${items.length} รายการ` : ''}</span></h2>
          ${
            items.length
              ? `<ul class="entries">${items.map((e) => entryRow(e, pending.has(e.id))).join('')}</ul>`
              : `<p class="empty">ยังไม่มีบันทึก — แตะปุ่มด้านบนได้เลย</p>`
          }
        </div>`;
      })
      .join('');
  }

  function entryRow(e, isPending) {
    const c = catOf(e.category);
    const main = e.text || c.label;
    const meta = [e.text ? c.label : '', e.level ? LEVELS[e.level] : ''].filter(Boolean).join(' · ');
    return `<li><button class="entry" type="button" data-action="edit" data-id="${esc(e.id)}">
      <time>${fmtTime(e.ts)}</time>
      <span class="eemoji" aria-hidden="true">${esc(c.emoji || '•')}</span>
      <span class="ebody"><span class="etext">${esc(main)}</span>${meta ? `<span class="emeta">${esc(meta)}</span>` : ''}</span>
      ${isPending ? '<span class="pending" title="รอส่งขึ้นเซิร์ฟเวอร์">⏳</span>' : '<span></span>'}
      ${e.level ? `<span class="lvl lv${e.level}" title="ระดับ ${e.level}">${e.level}</span>` : '<span></span>'}
    </button></li>`;
  }

  // ---------- แผ่นบันทึก (bottom sheet) ----------
  let S = null; // state ของแผ่นที่เปิดอยู่

  function openSheet({ entry, cat }) {
    S = entry
      ? { isNew: false, id: entry.id, category: entry.category, ts: entry.ts, text: entry.text || '', level: entry.level ?? null, timeTouched: false }
      : { isNew: true, id: uuid(), category: cat, ts: Date.now(), text: '', level: null, timeTouched: false };
    renderSheet();
    if (!sheetEl.open) sheetEl.showModal();
    // บนจอใหญ่ (มีคีย์บอร์ด) โฟกัสช่องพิมพ์ให้เลย; บนมือถือไม่ เพื่อไม่ให้คีย์บอร์ดบังปุ่ม
    if (S.isNew && matchMedia('(hover: hover) and (pointer: fine)').matches) $('#f-text', sheetEl)?.focus();
  }

  function closeSheet() {
    if (sheetEl.open) sheetEl.close();
    S = null;
  }

  function chipList(c) {
    const out = [];
    const seen = new Set();
    // คำแนะนำจากประวัติอาจเป็น "ปวดหัว, เวียนหัว" → แยกเป็นคำเดี่ยว
    const fromHistory = (state.sugg[c.key] || []).flatMap(textParts);
    for (const t of [...(c.presets || []), ...fromHistory]) {
      const k = t.trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= 12) break;
    }
    return out;
  }

  function textParts(v) {
    return v.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  }

  function renderSheet() {
    const c = catOf(S.category);
    const visible = state.cats.filter((x) => !x.hidden || x.key === S.category);
    const cats = visible.some((x) => x.key === S.category) ? visible : [...visible, c];
    const chips = chipList(c);
    const parts = new Set(textParts(S.text));
    const ph = c.presets && c.presets.length ? `เช่น ${c.presets.slice(0, 2).map((p) => p.trim()).join(', ')}` : 'พิมพ์รายละเอียด';
    sheetEl.innerHTML = `
      <form class="sheet-body" id="sheet-form" novalidate>
        <div class="grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <h2>${S.isNew ? 'บันทึกใหม่' : 'แก้ไขบันทึก'}</h2>
          <button type="button" class="icon-btn plain" data-sheet="close" aria-label="ปิด">${ICON.close}</button>
        </div>
        <div class="cat-row" role="radiogroup" aria-label="หมวด">
          ${cats
            .map(
              (x) => `<button type="button" role="radio" aria-checked="${x.key === S.category}"
                class="chip${x.key === S.category ? ' on' : ''}" data-sheet="cat" data-cat="${esc(x.key)}">${esc(x.emoji)} ${esc(x.label)}</button>`
            )
            .join('')}
        </div>
        <div class="field">
          <label for="f-ts">เวลา${S.isNew && !S.timeTouched ? ' <small>(ตอนกดบันทึก)</small>' : ''}</label>
          <input id="f-ts" type="datetime-local" value="${toLocalInput(S.ts)}">
          <div class="chips">
            <button type="button" class="chip soft" data-sheet="t" data-min="0">ตอนนี้</button>
            <button type="button" class="chip soft" data-sheet="t" data-min="15">15 นาทีก่อน</button>
            <button type="button" class="chip soft" data-sheet="t" data-min="30">30 นาทีก่อน</button>
            <button type="button" class="chip soft" data-sheet="t" data-min="60">1 ชม.ก่อน</button>
            <button type="button" class="chip soft" data-sheet="t" data-min="120">2 ชม.ก่อน</button>
            <button type="button" class="chip soft" data-sheet="yday">ย้อนไป 1 วัน</button>
          </div>
        </div>
        <div class="field">
          <label for="f-text">รายละเอียด <small>(ไม่ใส่ก็ได้)</small></label>
          <textarea id="f-text" rows="2" maxlength="4000" placeholder="${esc(ph)}">${esc(S.text)}</textarea>
          ${
            chips.length
              ? `<div class="chips" id="text-chips">${chips
                  .map(
                    (t) => `<button type="button" class="chip soft${parts.has(t.trim()) ? ' on' : ''}" data-sheet="chip" data-text="${esc(t)}">${esc(t.trim())}</button>`
                  )
                  .join('')}</div>`
              : ''
          }
        </div>
        ${
          c.scale || S.level
            ? `<div class="field"><span class="label">ระดับ <small>(แตะซ้ำเพื่อยกเลิก)</small></span>
                <div class="levels" role="radiogroup" aria-label="ระดับ">${[1, 2, 3, 4, 5]
                  .map(
                    (n) => `<button type="button" role="radio" aria-checked="${S.level === n}" class="lvbtn lv${n}${S.level === n ? ' on' : ''}"
                      data-sheet="level" data-level="${n}"><b>${n}</b><small>${LEVELS[n]}</small></button>`
                  )
                  .join('')}</div></div>`
            : ''
        }
        <div class="sheet-actions">
          ${
            S.isNew
              ? ''
              : `<button type="button" class="btn ghost danger" data-sheet="delete">ลบ</button>
                 <button type="button" class="btn ghost" data-sheet="again" title="สร้างรายการใหม่แบบเดียวกัน ณ เวลานี้">ซ้ำตอนนี้</button>`
          }
          <button type="submit" class="btn primary">บันทึก</button>
        </div>
      </form>`;
  }

  function readSheet() {
    if (!S) return;
    const ta = $('#f-text', sheetEl);
    if (ta) S.text = ta.value;
    const ti = $('#f-ts', sheetEl);
    if (ti && S.timeTouched) {
      const t = new Date(ti.value).getTime();
      if (Number.isFinite(t)) S.ts = t;
    }
  }

  function setTime(ts, touched) {
    S.ts = ts;
    S.timeTouched = touched;
    const ti = $('#f-ts', sheetEl);
    ti.value = toLocalInput(ts);
    const lbl = $('label[for="f-ts"]', sheetEl);
    lbl.innerHTML = `เวลา${S.isNew && !touched ? ' <small>(ตอนกดบันทึก)</small>' : ''}`;
  }

  function submitSheet() {
    readSheet();
    let ts;
    if (S.timeTouched) ts = new Date($('#f-ts', sheetEl).value).getTime();
    else ts = S.isNew ? Date.now() : S.ts;
    if (!Number.isFinite(ts)) return toast('กรุณาระบุวันเวลา');
    if (ts > Date.now() + 2 * DAY - 60000) return toast('เวลาอยู่ในอนาคตไกลเกินไป');
    const wasNew = S.isNew;
    saveEntry({ id: S.id, ts, category: S.category, text: S.text, level: S.level });
    closeSheet();
    const old = relDay(ts) ? '' : ` (${F_DMY.format(ts)})`;
    toast((wasNew ? 'บันทึกแล้ว' : 'แก้ไขแล้ว') + old);
  }

  sheetEl.addEventListener('click', (ev) => {
    if (ev.target === sheetEl) return closeSheet(); // แตะพื้นหลัง
    const b = ev.target.closest('[data-sheet]');
    if (!b || !S) return;
    readSheet();
    const act = b.dataset.sheet;
    if (act === 'close') closeSheet();
    else if (act === 'cat') {
      S.category = b.dataset.cat;
      if (!catOf(S.category).scale) S.level = null;
      renderSheet();
    } else if (act === 't') {
      const min = Number(b.dataset.min);
      setTime(Date.now() - min * 60000, !(S.isNew && min === 0));
    } else if (act === 'yday') {
      setTime(addDays(S.ts, -1), true);
    } else if (act === 'chip') {
      const ta = $('#f-text', sheetEl);
      const t = b.dataset.text;
      const key = t.trim();
      const parts = textParts(ta.value);
      if (t.endsWith(' ')) {
        // คำนำหน้าที่ต้องพิมพ์ค่าต่อ เช่น "ความดัน " → ใส่แล้ววางเคอร์เซอร์รอ
        ta.value = (ta.value.trim() ? ta.value.replace(/[\s,]+$/, '') + ', ' : '') + t;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else if (parts.includes(key)) {
        ta.value = parts.filter((p) => p !== key).join(', ');
      } else {
        ta.value = [...parts, key].join(', ');
      }
      S.text = ta.value;
      const now = new Set(textParts(ta.value));
      for (const ch of $$('[data-sheet="chip"]', sheetEl)) ch.classList.toggle('on', now.has(ch.dataset.text.trim()));
    } else if (act === 'level') {
      const n = Number(b.dataset.level);
      S.level = S.level === n ? null : n;
      for (const lb of $$('[data-sheet="level"]', sheetEl)) {
        const on = Number(lb.dataset.level) === S.level;
        lb.classList.toggle('on', on);
        lb.setAttribute('aria-checked', String(on));
      }
    } else if (act === 'delete') {
      const id = S.id;
      closeSheet();
      deleteEntry(id);
    } else if (act === 'again') {
      saveEntry({ id: uuid(), ts: Date.now(), category: S.category, text: S.text, level: S.level });
      closeSheet();
      toast('บันทึกซ้ำ ณ ตอนนี้แล้ว');
    }
  });
  sheetEl.addEventListener('input', (ev) => {
    if (ev.target.id === 'f-ts' && S) {
      S.timeTouched = true;
      $('label[for="f-ts"]', sheetEl).textContent = 'เวลา';
    }
  });
  sheetEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitSheet();
  });
  sheetEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      submitSheet();
    }
  });
  sheetEl.addEventListener('close', () => (S = null));

  // ---------- หน้า: สรุปสำหรับพบแพทย์ ----------
  const sum = {
    from: dayKey(addDays(Date.now(), -13)),
    to: dayKey(Date.now()),
    preset: 14,
    entries: null,
    loading: false,
    offline: false,
    mode: 'cat',
    hidden: new Set(),
  };

  function renderSummary() {
    app.innerHTML = `
      <header class="topbar sub">
        <a class="icon-btn plain" href="#/" aria-label="กลับ">${ICON.back}</a>
        <h1>สรุปสำหรับพบแพทย์</h1>
      </header>
      <div class="sync" hidden></div>
      <section class="card no-print">
        <div class="seg">
          ${[7, 14, 30, 90]
            .map((d) => `<button type="button" class="chip${sum.preset === d ? ' on' : ''}" data-action="sum-days" data-days="${d}">${d} วัน</button>`)
            .join('')}
        </div>
        <div class="range">
          <input class="in" type="date" id="sum-from" value="${sum.from}" aria-label="ตั้งแต่วันที่">
          <span>ถึง</span>
          <input class="in" type="date" id="sum-to" value="${sum.to}" aria-label="ถึงวันที่">
        </div>
        <div class="row">
          <button type="button" class="btn primary" data-action="print">พิมพ์ / PDF</button>
          <button type="button" class="btn" data-action="sum-csv">ดาวน์โหลด CSV</button>
        </div>
      </section>
      <div class="report" id="report"></div>`;
    renderReport();
    updateSync();
  }

  async function loadSummary() {
    const fromTs = fromDayKey(sum.from);
    const toTs = addDays(fromDayKey(sum.to), 1);
    const inRange = (e) => e.ts >= fromTs && e.ts < toTs;
    sum.loading = true;
    renderReport();
    try {
      const r = await api(`/api/entries?from=${fromTs}&to=${toTs}&limit=50000`);
      const map = new Map(r.entries.map((e) => [e.id, e]));
      applyOutbox(map, inRange);
      sum.entries = [...map.values()];
      sum.offline = false;
    } catch (e) {
      if (e.status === 401) return showLogin();
      sum.entries = [...state.entries.values()].filter(inRange);
      sum.offline = true;
    }
    sum.loading = false;
    if (state.view === 'summary') renderReport();
  }

  function renderReport() {
    const box = $('#report');
    if (!box) return;
    if (!sum.entries) {
      box.innerHTML = '<p class="muted">กำลังโหลด…</p>';
      return;
    }
    const all = [...sum.entries].sort((a, b) => a.ts - b.ts);
    const order = state.cats.map((c) => c.key);
    const used = [...new Set(all.map((e) => e.category))].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    const keys = used.filter((k) => !sum.hidden.has(k));
    const shown = all.filter((e) => !sum.hidden.has(e.category));
    const days = [];
    for (let t = fromDayKey(sum.from); t <= fromDayKey(sum.to); t = addDays(t, 1)) days.push(dayKey(t));
    const counts = {};
    for (const e of shown) {
      const k = dayKey(e.ts);
      (counts[k] ||= {})[e.category] = ((counts[k] || {})[e.category] || 0) + 1;
    }
    const totals = {};
    for (const e of shown) totals[e.category] = (totals[e.category] || 0) + 1;
    const cls = (n) => (!n ? 'z' : n === 1 ? 'n1' : n <= 3 ? 'n2' : 'n3');

    const matrix = `
      <div class="table-wrap"><table class="matrix">
        <thead><tr><th>วันที่</th>${keys
          .map((k) => `<th><span>${esc(catOf(k).emoji)}</span>${esc(catOf(k).label)}</th>`)
          .join('')}</tr></thead>
        <tbody>${days
          .map(
            (d) => `<tr><td>${esc(F_WDM.format(fromDayKey(d)))}</td>${keys
              .map((k) => {
                const n = (counts[d] || {})[k] || 0;
                return `<td class="${cls(n)}">${n || '·'}</td>`;
              })
              .join('')}</tr>`
          )
          .join('')}</tbody>
        <tfoot><tr><td>รวม</td>${keys.map((k) => `<td>${totals[k] || 0}</td>`).join('')}</tr></tfoot>
      </table></div>`;

    const lvl = (e) => (e.level ? `<span class="lvl lv${e.level}" title="${LEVELS[e.level]}">${e.level}</span>` : '');
    const row = (e) => `<tr>
        <td class="t">${esc(F_MED.format(e.ts))} ${fmtTime(e.ts)}</td>
        <td class="txt">${esc(e.text || '—')}</td>
        <td class="t">${lvl(e)}</td>
      </tr>`;

    let detail;
    if (sum.mode === 'cat') {
      detail = keys
        .map((k) => {
          const c = catOf(k);
          const list = shown.filter((e) => e.category === k);
          return `<h3>${esc(c.emoji)} ${esc(c.label)} <span class="muted">· ${list.length} ครั้ง</span></h3>
            <div class="table-wrap"><table class="detail"><tbody>${list.map(row).join('')}</tbody></table></div>`;
        })
        .join('');
    } else {
      detail = days
        .filter((d) => counts[d])
        .map((d) => {
          const list = shown.filter((e) => dayKey(e.ts) === d);
          return `<h3>${esc(F_LONG.format(fromDayKey(d)))}</h3>
            <div class="table-wrap"><table class="detail"><tbody>${list
              .map(
                (e) => `<tr><td class="t">${fmtTime(e.ts)}</td><td class="t">${esc(catOf(e.category).emoji)} ${esc(
                  catOf(e.category).label
                )}</td><td class="txt">${esc(e.text)}</td><td class="t">${lvl(e)}</td></tr>`
              )
              .join('')}</tbody></table></div>`;
        })
        .join('');
    }

    box.innerHTML = `
      <h2 class="print-only">บันทึกประจำวัน — สรุปสำหรับพบแพทย์</h2>
      <p class="range-label">${esc(F_DMY.format(fromDayKey(sum.from)))} – ${esc(F_DMY.format(fromDayKey(sum.to)))}
        · ${days.length} วัน · ${shown.length} รายการ${sum.loading ? ' · กำลังโหลด…' : ''}${sum.offline ? ' · (ออฟไลน์: แสดงเฉพาะที่มีในเครื่อง)' : ''}</p>
      ${
        used.length
          ? `<div class="chips no-print" aria-label="เลือกหมวดที่จะแสดง">${used
              .map(
                (k) => `<button type="button" class="chip${sum.hidden.has(k) ? ' off' : ''}" data-action="sum-toggle" data-cat="${esc(k)}"
                  aria-pressed="${!sum.hidden.has(k)}">${esc(catOf(k).emoji)} ${esc(catOf(k).label)}</button>`
              )
              .join('')}</div>`
          : ''
      }
      ${
        shown.length
          ? `<h2>จำนวนครั้งต่อวัน</h2>${matrix}
             <h2>รายละเอียด</h2>
             <div class="seg no-print">
               <button type="button" class="chip${sum.mode === 'cat' ? ' on' : ''}" data-action="sum-mode" data-mode="cat">แยกตามหมวด</button>
               <button type="button" class="chip${sum.mode === 'time' ? ' on' : ''}" data-action="sum-mode" data-mode="time">เรียงตามวัน</button>
             </div>
             ${detail}`
          : '<p class="empty">ไม่มีบันทึกในช่วงนี้</p>'
      }`;
  }

  // ---------- หน้า: ตั้งค่า ----------
  let edit = null;

  function renderSettings() {
    if (!edit) edit = JSON.parse(JSON.stringify(state.cats));
    app.innerHTML = `
      <header class="topbar sub">
        <a class="icon-btn plain" href="#/" aria-label="กลับ">${ICON.back}</a>
        <h1>ตั้งค่า</h1>
      </header>
      <div class="sync" hidden></div>
      <section class="card">
        <h2>ปุ่มบันทึกด่วน</h2>
        <p class="hint">แก้ไอคอน ชื่อ และคำที่ใช้บ่อย (คั่นด้วย ,) — คำที่ลงท้ายด้วยเว้นวรรค เช่น "ความดัน " แตะแล้วจะรอให้พิมพ์ค่าต่อ ·
          คำที่พิมพ์บ่อยจะขึ้นเป็นตัวเลือกให้เองอัตโนมัติ</p>
        <div id="cat-editor">${edit.map(catEditRow).join('')}</div>
        <div class="row">
          <button type="button" class="btn ghost" data-action="cat-add">+ เพิ่มหมวด</button>
        </div>
        <div class="row end">
          <button type="button" class="btn ghost" data-action="cat-reset">คืนค่าเริ่มต้น</button>
          <button type="button" class="btn primary" data-action="cat-save">บันทึกการตั้งค่า</button>
        </div>
      </section>
      <section class="card">
        <h2>ข้อมูล</h2>
        <p class="hint">รอส่งขึ้นเซิร์ฟเวอร์: <b id="pending-count">${state.outbox.length}</b> รายการ</p>
        <div class="row">
          <button type="button" class="btn" data-action="export-json">สำรองข้อมูล (JSON)</button>
          <button type="button" class="btn" data-action="export-csv">ส่งออก CSV ทั้งหมด</button>
          <label class="btn">นำเข้าข้อมูลสำรอง<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        </div>
      </section>
      <section class="card">
        <h2>บัญชี</h2>
        <p class="hint">ออกจากระบบจะล้างข้อมูลที่เก็บไว้ในเครื่องนี้ด้วย</p>
        <button type="button" class="btn danger" data-action="logout">ออกจากระบบ</button>
      </section>`;
    updateSync();
  }

  function catEditRow(c, i) {
    return `<div class="cat-edit${c.hidden ? ' is-hidden' : ''}" data-i="${i}">
      <input class="in emoji" data-f="emoji" value="${esc(c.emoji)}" maxlength="8" aria-label="ไอคอน">
      <input class="in label" data-f="label" value="${esc(c.label)}" maxlength="30" aria-label="ชื่อหมวด">
      <div class="mini-actions">
        <button type="button" class="icon-btn sm" data-action="cat-up" data-i="${i}" aria-label="เลื่อนขึ้น" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn sm" data-action="cat-down" data-i="${i}" aria-label="เลื่อนลง" ${i === edit.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
      <input class="in presets" data-f="presets" value="${esc((c.presets || []).join(', '))}" placeholder="คำที่ใช้บ่อย คั่นด้วย ,">
      <div class="check">
        <label><input type="checkbox" data-f="scale" ${c.scale ? 'checked' : ''}> มีระดับ 1–5</label>
        <label><input type="checkbox" data-f="hidden" ${c.hidden ? 'checked' : ''}> ซ่อนปุ่ม</label>
      </div>
    </div>`;
  }

  function readEditor() {
    for (const row of $$('.cat-edit')) {
      const c = edit[Number(row.dataset.i)];
      c.emoji = $('[data-f="emoji"]', row).value.trim();
      c.label = $('[data-f="label"]', row).value.trim();
      c.presets = $('[data-f="presets"]', row)
        .value.split(',')
        .map((s) => s.replace(/^\s+/, ''))
        .filter((s) => s.trim());
      c.scale = $('[data-f="scale"]', row).checked;
      c.hidden = $('[data-f="hidden"]', row).checked;
    }
  }

  async function fetchAllEntries() {
    const r = await api('/api/entries?from=0&limit=50000');
    const map = new Map(r.entries.map((e) => [e.id, e]));
    applyOutbox(map);
    return [...map.values()];
  }

  async function importBackup(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast('ไฟล์ไม่ใช่ JSON ที่ถูกต้อง');
    }
    const list = Array.isArray(data) ? data : data && data.entries;
    if (!Array.isArray(list) || !list.length) return toast('ไม่พบรายการในไฟล์');
    if (!confirm(`นำเข้า ${list.length} รายการ? (รายการเดิมที่ id ซ้ำจะถูกแทนถ้าไฟล์ใหม่กว่า)`)) return;
    let applied = 0;
    let rejected = 0;
    try {
      for (let i = 0; i < list.length; i += 200) {
        const ops = list.slice(i, i + 200).map((entry) => ({ type: 'put', entry }));
        const r = await api('/api/sync', { method: 'POST', body: { ops } });
        applied += r.applied;
        rejected += r.rejected.length;
      }
      if (data && Array.isArray(data.categories) && confirm('ในไฟล์มีการตั้งค่าหมวดด้วย ต้องการใช้ค่าจากไฟล์ไหม?')) {
        const r = await api('/api/categories', { method: 'PUT', body: { categories: data.categories } });
        state.cats = r.categories;
        store.set('dl_cats', state.cats);
        edit = null;
      }
      toast(`นำเข้าแล้ว ${applied} รายการ${rejected ? ` · ข้าม ${rejected}` : ''}`);
      refreshAll();
      if (state.view === 'settings') renderSettings();
    } catch (e) {
      if (!handleErr(e)) toast('นำเข้าไม่สำเร็จ');
    }
  }

  // ---------- actions ----------
  const actions = {
    add: (b) => openSheet({ cat: b.dataset.cat }),
    edit: (b) => {
      const e = state.entries.get(b.dataset.id);
      if (e) openSheet({ entry: e });
    },
    more: () => {
      state.windowStart = addDays(state.windowStart, -7);
      renderMain();
      refreshEntries();
    },
    'sum-days': (b) => {
      sum.preset = Number(b.dataset.days);
      sum.to = dayKey(Date.now());
      sum.from = dayKey(addDays(Date.now(), -(sum.preset - 1)));
      renderSummary();
      loadSummary();
    },
    'sum-toggle': (b) => {
      const k = b.dataset.cat;
      sum.hidden.has(k) ? sum.hidden.delete(k) : sum.hidden.add(k);
      renderReport();
    },
    'sum-mode': (b) => {
      sum.mode = b.dataset.mode;
      renderReport();
    },
    print: () => window.print(),
    'sum-csv': () => {
      if (!sum.entries) return;
      const list = sum.entries.filter((e) => !sum.hidden.has(e.category));
      download(`daily-log_${sum.from}_${sum.to}.csv`, toCSV(list), 'text/csv;charset=utf-8');
    },
    'cat-add': () => {
      readEditor();
      edit.push({ key: 'c' + Date.now().toString(36), label: 'หมวดใหม่', emoji: '⭐', presets: [], scale: false, hidden: false });
      renderSettings();
      const rows = $$('.cat-edit');
      $('[data-f="label"]', rows[rows.length - 1])?.select();
    },
    'cat-up': (b) => {
      readEditor();
      const i = Number(b.dataset.i);
      if (i > 0) [edit[i - 1], edit[i]] = [edit[i], edit[i - 1]];
      renderSettings();
    },
    'cat-down': (b) => {
      readEditor();
      const i = Number(b.dataset.i);
      if (i < edit.length - 1) [edit[i + 1], edit[i]] = [edit[i], edit[i + 1]];
      renderSettings();
    },
    'cat-save': async (b) => {
      readEditor();
      if (edit.some((c) => !c.label)) return toast('กรุณาใส่ชื่อหมวดให้ครบ');
      b.disabled = true;
      try {
        const r = await api('/api/categories', { method: 'PUT', body: { categories: edit } });
        state.cats = r.categories;
        store.set('dl_cats', state.cats);
        edit = JSON.parse(JSON.stringify(state.cats));
        toast('บันทึกการตั้งค่าแล้ว');
        renderSettings();
      } catch (e) {
        if (!handleErr(e)) toast('บันทึกไม่สำเร็จ');
        b.disabled = false;
      }
    },
    'cat-reset': async () => {
      if (!confirm('คืนค่าหมวดเป็นค่าเริ่มต้น? (บันทึกเดิมไม่หาย)')) return;
      try {
        const r = await api('/api/categories/reset', { method: 'POST' });
        state.cats = r.categories;
        store.set('dl_cats', state.cats);
        edit = null;
        renderSettings();
        toast('คืนค่าเริ่มต้นแล้ว');
      } catch (e) {
        if (!handleErr(e)) toast('ไม่สำเร็จ');
      }
    },
    'export-json': async () => {
      try {
        const entries = await fetchAllEntries();
        const data = { app: 'daily-log', version: 1, exported_at: new Date().toISOString(), categories: state.cats, entries };
        download(`daily-log-backup_${dayKey(Date.now())}.json`, JSON.stringify(data, null, 1), 'application/json');
      } catch (e) {
        if (!handleErr(e)) toast('ส่งออกไม่สำเร็จ');
        else toast('ต้องต่ออินเทอร์เน็ตเพื่อส่งออก');
      }
    },
    'export-csv': async () => {
      try {
        download(`daily-log_all_${dayKey(Date.now())}.csv`, toCSV(await fetchAllEntries()), 'text/csv;charset=utf-8');
      } catch (e) {
        if (!handleErr(e)) toast('ส่งออกไม่สำเร็จ');
        else toast('ต้องต่ออินเทอร์เน็ตเพื่อส่งออก');
      }
    },
    logout: async () => {
      if (state.outbox.length && !confirm(`ยังมี ${state.outbox.length} รายการที่ยังไม่ได้ส่งขึ้นเซิร์ฟเวอร์ ออกจากระบบแล้วจะหายไป ยืนยัน?`)) return;
      try {
        await api('/api/logout', { method: 'POST' });
      } catch {}
      for (const k of ['dl_cache', 'dl_sugg', 'dl_outbox', 'dl_cats']) store.del(k);
      state.entries = new Map();
      state.outbox = [];
      state.sugg = {};
      location.hash = '#/';
      showLogin();
    },
  };

  app.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-action]');
    if (!b || b.disabled) return;
    const fn = actions[b.dataset.action];
    if (fn) {
      ev.preventDefault();
      fn(b, ev);
    }
  });

  app.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'sum-from' || t.id === 'sum-to') {
      if (!t.value) return;
      sum[t.id === 'sum-from' ? 'from' : 'to'] = t.value;
      if (sum.from > sum.to) [sum.from, sum.to] = [sum.to, sum.from];
      sum.preset = null;
      renderSummary();
      loadSummary();
    } else if (t.id === 'import-file' && t.files && t.files[0]) {
      importBackup(t.files[0]);
      t.value = '';
    } else if (t.dataset && t.dataset.f === 'hidden') {
      t.closest('.cat-edit').classList.toggle('is-hidden', t.checked);
    }
  });

  app.addEventListener('submit', (ev) => {
    if (ev.target.id === 'login-form') {
      ev.preventDefault();
      doLogin(ev.target);
    }
  });

  // ---------- router ----------
  function route() {
    if (state.authed === false) return renderLogin();
    const h = location.hash;
    const prev = state.view;
    state.view = h.startsWith('#/summary') ? 'summary' : h.startsWith('#/settings') ? 'settings' : 'main';
    if (sheetEl.open) closeSheet();
    if (state.view === 'summary') {
      renderSummary();
      loadSummary();
    } else if (state.view === 'settings') {
      if (prev !== 'settings') edit = null;
      renderSettings();
    } else {
      renderMain();
    }
    if (prev !== state.view) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  function openDeepLink() {
    // รองรับลิงก์ลัด /?add=med (ใช้กับ shortcut บนหน้าจอโฮม)
    const p = new URLSearchParams(location.search);
    const add = p.get('add');
    if (add) {
      history.replaceState(null, '', location.pathname + location.hash);
      const c = state.cats.find((x) => x.key === add || x.label === add);
      if (c && state.view === 'main') openSheet({ cat: c.key });
    }
  }

  // ---------- เริ่มต้น ----------
  async function boot() {
    try {
      await api('/api/me');
      state.authed = true;
    } catch (e) {
      if (e.status === 401) return showLogin();
      // ออฟไลน์: ใช้ข้อมูลที่เก็บในเครื่องไปก่อน
      state.authed = true;
      state.online = false;
    }
    route();
    openDeepLink();
    if (state.online) {
      await refreshAll();
      flush();
    }
  }

  window.addEventListener('online', () => {
    state.online = true;
    updateSync();
    flush();
    refreshAll();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    updateSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || state.authed !== true) return;
    flush();
    if (Date.now() - state.lastRefresh > 60000) refreshAll();
    else if (state.view === 'main' && !sheetEl.open) renderMain(); // อัปเดตคำว่า "วันนี้" หลังข้ามเที่ยงคืน
  });
  setInterval(() => {
    if (state.outbox.length && state.authed === true) flush();
  }, 20000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  boot();
})();
