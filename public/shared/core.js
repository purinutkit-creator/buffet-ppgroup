// Shared front-end helpers (no build step). Exposes window.BF.
(function () {
  'use strict';
  const BF = {};

  // ---------- DOM ----------
  function h(tag, props, ...children) {
    // allow h('div', 'text') / h('div', node) / h('div', [..]) — props omitted
    if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
    const name = /^[a-z0-9-]*/i.exec(tag)[0];
    const el = document.createElement(name || 'div');
    const cls = [];
    for (const [, kind, val] of tag.slice(name.length).matchAll(/([#.])([\w-]+)/g)) { if (kind === '#') el.id = val; else cls.push(val); }
    if (cls.length) el.className = cls.join(' ');
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // only used with sanitized server HTML
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const mount = (el, ...children) => append(clear(el), children);

  // ---------- formatting ----------
  const money = (satang, dec = 2) => (Number(satang || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const baht = (satang) => `฿${money(satang, Number(satang) % 100 ? 2 : 0)}`;
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dt = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hhmm(ts)}`; };
  const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`; };
  const toSatang = (v) => Math.round(Number(String(v).replace(/,/g, '')) * 100);
  const tr = (v, lang = BF.lang || 'th') => { if (v == null) return ''; if (typeof v === 'string') return v; return v[lang] || v.th || v.en || v.zh || ''; };
  const ikey = () => 'k' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));

  // ---------- server clock ----------
  let offset = 0;
  BF.syncClock = (serverTime) => { if (serverTime) offset = serverTime - Date.now(); };
  BF.now = () => Date.now() + offset;

  // ---------- API ----------
  class ApiError extends Error { constructor(status, body) { super((body && body.error && body.error.message) || `HTTP ${status}`); this.status = status; this.code = body && body.error && body.error.code; this.details = body && body.error && body.error.details; } }
  async function api(method, url, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = opts.token !== undefined ? opts.token : BF.auth.token();
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, { method, headers, body: payload }); } catch (e) { throw new ApiError(0, { error: { code: 'network', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต' } }); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : opts.raw ? await res.blob() : await res.text();
    if (!res.ok) {
      if (res.status === 401 && opts.token === undefined && BF.auth.token() && !opts.noLogout) { BF.auth.clear(); location.reload(); }
      throw new ApiError(res.status, data);
    }
    return data;
  }
  BF.api = { get: (u, o) => api('GET', u, undefined, o), post: (u, b, o) => api('POST', u, b ?? {}, o), put: (u, b, o) => api('PUT', u, b ?? {}, o), patch: (u, b, o) => api('PATCH', u, b ?? {}, o), del: (u, o) => api('DELETE', u, undefined, o), raw: api };
  BF.ApiError = ApiError;

  // ---------- staff auth ----------
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } } };
  BF.store = store;
  BF.auth = {
    token: () => store.get('bf_staff_token'),
    set: (t, staff, branchId) => { store.set('bf_staff_token', t); store.set('bf_staff', JSON.stringify(staff)); store.set('bf_branch', String(branchId)); },
    staff: () => { try { return JSON.parse(store.get('bf_staff')); } catch { return null; } },
    branch: () => Number(store.get('bf_branch')) || null,
    clear: () => { store.del('bf_staff_token'); store.del('bf_staff'); },
    can: (p) => { const s = BF.auth.staff(); return !!(s && s.permissions.includes(p)); },
    logout: async () => { try { await BF.api.post('/api/auth/logout', {}, { noLogout: true }); } catch { /* ignore */ } BF.auth.clear(); location.reload(); },
  };

  // Login screen for staff apps. Resolves when logged in.
  BF.requireLogin = (appTitle, opts = {}) => new Promise(async (resolve) => {
    if (BF.auth.token()) {
      try { const me = await BF.api.get('/api/auth/me', { noLogout: true }); BF.auth.set(BF.auth.token(), me.staff, me.branch_id); return resolve(me); } catch { BF.auth.clear(); }
    }
    let branches = [];
    let setupRequired = false;
    try { const b = await BF.api.get('/api/auth/branches', { token: null }); branches = b.branches; setupRequired = b.setup_required; } catch (e) { /* shown below */ }
    const code = h('input', { placeholder: 'รหัสพนักงาน', autocomplete: 'username', autocapitalize: 'characters', value: store.get('bf_last_code') || '' });
    const pin = h('input', { placeholder: 'PIN', type: 'password', inputmode: 'numeric', autocomplete: 'current-password' });
    const branch = h('select', null, branches.map((b) => h('option', { value: b.id, selected: Number(store.get('bf_branch')) === b.id }, `${b.code} — ${tr(b.name)}`)));
    const msg = h('div.login-msg');
    const btn = h('button.btn.primary.block', { type: 'submit' }, 'เข้าสู่ระบบ');
    const form = h('form.login-card', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; msg.textContent = '';
      try {
        const r = await BF.api.post('/api/auth/login', { code: code.value.trim(), pin: pin.value, branch_id: Number(branch.value) || null }, { token: null });
        if (opts.permission && !r.staff.permissions.some((p) => [].concat(opts.permission).includes(p))) throw new Error('บัญชีนี้ไม่มีสิทธิ์ใช้งานหน้านี้');
        store.set('bf_last_code', code.value.trim());
        BF.auth.set(r.token, r.staff, r.branch_id); overlay.remove(); resolve({ staff: r.staff, branch_id: r.branch_id });
      } catch (err) { msg.textContent = err.message; btn.disabled = false; pin.value = ''; pin.focus(); }
    } },
    h('div.login-title', appTitle), h('div.login-sub', 'Buffet Management System'),
    setupRequired ? h('div.login-msg', 'ยังไม่ได้ตั้งค่าระบบ — รันคำสั่ง npm run setup บนเซิร์ฟเวอร์ก่อน') : null,
    branches.length > 1 ? h('label', null, 'สาขา', branch) : null,
    h('label', null, 'รหัสพนักงาน', code), h('label', null, 'PIN', pin), msg, btn);
    const overlay = h('div.login-overlay', null, form);
    document.body.appendChild(overlay);
    (code.value ? pin : code).focus();
  });

  // ---------- UI feedback ----------
  let toastBox;
  BF.toast = (text, type = 'info', ms = 3000) => {
    if (!toastBox) { toastBox = h('div.toasts'); document.body.appendChild(toastBox); }
    const t = h(`div.toast.${type}`, null, text);
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  };
  BF.error = (e) => BF.toast(e && e.message ? e.message : String(e), 'error', 4500);

  // Modal / bottom sheet. Returns {el, close, body}
  BF.modal = (title, content, { sheet = false, wide = false, onClose, actions } = {}) => {
    const body = h('div.modal-body', null, content);
    const close = () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 180); document.removeEventListener('keydown', esc); onClose && onClose(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    const box = h(`div.modal${sheet ? '.sheet' : ''}${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', onclick: (e) => e.stopPropagation() },
      title != null ? h('div.modal-head', null, h('div.modal-title', null, title), h('button.icon-btn.modal-x', { 'aria-label': 'ปิด', onclick: close }, '✕')) : null,
      body, actions ? h('div.modal-actions', null, actions) : null);
    const wrap = h('div.modal-wrap', { onclick: close }, box);
    document.body.appendChild(wrap);
    document.addEventListener('keydown', esc);
    return { el: box, body, close };
  };
  BF.confirm = (text, { ok = 'ยืนยัน', danger = false } = {}) => new Promise((resolve) => {
    let done = false;
    const m = BF.modal('ยืนยัน', h('p', null, text), { onClose: () => { if (!done) resolve(false); },
      actions: [h('button.btn', { onclick: () => { m.close(); } }, 'ยกเลิก'), h(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => { done = true; m.close(); resolve(true); } }, ok)] });
  });
  // Ask for manager approval (code + PIN)
  BF.approval = (reason) => new Promise((resolve) => {
    const code = h('input', { placeholder: 'รหัสผู้อนุมัติ' }); const pin = h('input', { type: 'password', placeholder: 'PIN', inputmode: 'numeric' });
    let done = false;
    const m = BF.modal('ต้องได้รับการอนุมัติจากผู้จัดการ', h('div.form', null, h('p.muted', null, reason || ''), h('label', null, 'รหัสผู้อนุมัติ', code), h('label', null, 'PIN', pin)), {
      onClose: () => { if (!done) resolve(null); },
      actions: [h('button.btn', { onclick: () => m.close() }, 'ยกเลิก'), h('button.btn.primary', { onclick: () => { done = true; m.close(); resolve({ code: code.value.trim(), pin: pin.value }); } }, 'อนุมัติ')] });
    setTimeout(() => code.focus(), 50);
  });
  // Run an API call; if the server answers 428 approval_required, ask and retry with approval
  BF.withApproval = async (fn, reason) => {
    try { return await fn(undefined); } catch (e) {
      if (e.code !== 'approval_required') throw e;
      const a = await BF.approval(reason); if (!a) throw new Error('ยกเลิกการอนุมัติ');
      return fn(a);
    }
  };

  BF.states = {
    loading: (n = 6, cls = 'sk-card') => h('div.sk-grid', null, Array.from({ length: n }, () => h(`div.${cls}.skeleton`))),
    empty: (text, icon = '🍽️') => h('div.empty', null, h('div.empty-icon', null, icon), h('div', null, text)),
    error: (e, retry) => h('div.error-state', null, h('div.empty-icon', null, '⚠️'), h('div', null, e.message || String(e)), retry ? h('button.btn', { onclick: retry }, 'ลองใหม่') : null),
  };

  // Socket.IO (served by the server at /socket.io/socket.io.js)
  BF.socket = (auth) => {
    // eslint-disable-next-line no-undef
    const s = io({ auth, transports: ['websocket', 'polling'] });
    s.on('hello', (p) => BF.syncClock(p.serverTime));
    s.on('connect', () => document.body.classList.remove('offline'));
    s.on('disconnect', () => document.body.classList.add('offline'));
    return s;
  };

  // Simple beep for alerts (WebAudio; requires a prior user gesture)
  let actx;
  BF.beep = (freq = 880, ms = 180, times = 2) => {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = actx.createOscillator(); const g = actx.createGain();
        o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
        const t = actx.currentTime + i * (ms / 1000 + 0.08);
        g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
        o.start(t); o.stop(t + ms / 1000);
      }
    } catch { /* audio unavailable */ }
  };

  BF.download = async (url, filename) => {
    const blob = await BF.api.raw('GET', url, undefined, { raw: true });
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  BF.debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  Object.assign(BF, { h, append, $, $$, clear, mount, money, baht, hhmm, dt, dur, pad, toSatang, tr, ikey, lang: 'th' });
  window.BF = BF;
})();
