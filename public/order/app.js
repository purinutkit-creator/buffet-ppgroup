// Customer QR ordering web app (mobile first). All data comes from /api/c/:token — the server validates every action.
(function () {
  'use strict';
  const { h, mount, $, api, tr, money, hhmm, dur, ikey, store } = { ...BF, api: BF.api, store: BF.store };
  const token = location.pathname.split('/').filter(Boolean)[1];
  const base = `/api/c/${encodeURIComponent(token)}`;
  const app = $('#app');
  $('#theme-css').href = `/theme.css?scope=customer&t=${encodeURIComponent(token)}`;

  const S = { info: null, menu: null, orders: [], calls: [], cart: [], guest: null, lang: 'th', cat: null, search: '', unseen: false, memberToken: null, timer: null, alerted: new Set() };
  const L = () => window.I18N[S.lang] || window.I18N.th;
  const t = (k, vars = {}) => (L()[k] || window.I18N.th[k] || k).replace(/\{(\w+)\}/g, (_, x) => vars[x] ?? '');
  const T = (v) => tr(v, S.lang);
  const skey = (k) => `bf_${k}_${S.info ? S.info.session.public_code : token.slice(0, 8)}`;

  // ---------- boot ----------
  async function boot() {
    mount(app, h('div.hero.skeleton', { style: { height: '300px', borderRadius: 0 } }), BF.states.loading(6));
    try {
      S.info = await api.get(base, { token: null });
      BF.syncClock(S.info.server_time);
    } catch (e) { return ended(e); }
    S.lang = store.get('bf_lang') || S.info.default_language || 'th';
    if (!S.info.languages.includes(S.lang)) S.lang = S.info.languages[0] || 'th';
    document.documentElement.lang = S.lang; BF.lang = S.lang;
    S.guest = store.get(skey('guest'));
    if (S.guest && !S.info.session.guests.some((g) => g.label === S.guest)) S.guest = null;
    if (!S.guest && S.info.session.guests.length === 1) S.guest = S.info.session.guests[0].label;
    S.memberToken = store.get(skey('mt'));
    try { S.cart = JSON.parse(store.get(skey('cart')) || '[]'); } catch { S.cart = []; }
    document.title = `${T(S.info.restaurant.name)} • ${t('table')} ${S.info.session.table_code}`;
    render();
    await loadMenu();
    loadOrders();
    connect();
    S.timer = setInterval(tick, 1000);
    if (needsGuest() && !S.guest) pickGuest(true);
    else if (!store.get(skey('seen_info'))) { store.set(skey('seen_info'), '1'); openInfo(); }
    if (new URLSearchParams(location.search).get('join') === '1') openMember();
  }

  function ended(e) {
    clearInterval(S.timer);
    const gone = e && (e.status === 410 || e.code === 'session_ended');
    mount(app, h('div.ended', null,
      h('div.ended-icon', null, gone ? '🍽️' : '⚠️'),
      h('h2', null, gone ? t('ended_title') : e && e.status === 404 ? t('invalid_title') : (e && e.message) || 'Error'),
      h('p.muted', null, gone ? t('ended_body') : e && e.status === 404 ? t('invalid_body') : ''),
      !gone && e && e.status !== 404 ? h('button.btn.primary', { onclick: () => location.reload() }, t('retry')) : null));
  }

  const needsGuest = () => new Set(S.info.session.guests.map((g) => g.package_id)).size > 1;
  const guestObj = () => S.info.session.guests.find((g) => g.label === S.guest);
  const guestName = (g) => (g ? g.display_name || `${t('you')} ${g.label}`.trim() : '');

  async function loadMenu() {
    try {
      S.menu = await api.get(`${base}/menu${S.guest && needsGuest() ? `?guest=${encodeURIComponent(S.guest)}` : ''}`, { token: null });
      // drop cart items no longer available for this guest
      S.cart = S.cart.filter((c) => S.menu.items.some((i) => i.id === c.menu_item_id));
      renderMenu();
    } catch (e) { if (e.status === 410 || e.status === 404) return ended(e); mount($('#menu'), BF.states.error(e, loadMenu)); }
  }
  async function loadOrders() {
    try { S.orders = (await api.get(`${base}/orders`, { token: null })).orders; } catch (e) { if (e.status === 410) return ended(e); }
    try { S.calls = (await api.get(`${base}/calls`, { token: null })).calls; } catch { /* ignore */ }
  }

  function connect() {
    const s = BF.socket({ sessionToken: token });
    s.on('order:updated', ({ order }) => {
      const i = S.orders.findIndex((o) => o.id === order.id);
      if (i >= 0) S.orders[i] = order; else S.orders.unshift(order);
      S.orders.sort((a, b) => b.id - a.id);
      S.unseen = true; updateBadges();
      if (openSheet === 'history') renderHistory();
    });
    s.on('call:updated', ({ call }) => {
      const i = S.calls.findIndex((c) => c.id === call.id);
      if (i >= 0) S.calls[i] = call; else S.calls.unshift(call);
      if (openSheet === 'call') renderCallList();
      if (call.status === 'accepted') BF.toast(`${T(call.label)} • ${t('call_accepted')}`, 'success');
    });
    s.on('session:updated', async () => { try { const fresh = await api.get(base, { token: null }); S.info = fresh; BF.syncClock(fresh.server_time); renderHeader(); } catch (e) { if (e.status === 410) ended(e); } });
    s.on('session:alert', (a) => {
      if (a.kind === 'time_left') { BF.toast(t('time_alert', { n: a.minutes }), 'warn', 6000); BF.beep(660, 160, 2); }
      if (a.kind === 'time_up') { BF.toast(t('time_up'), 'error', 8000); BF.beep(440, 300, 3); renderHeader(); }
      if (a.kind === 'ordering_closed') { BF.toast(t('ordering_closed'), 'warn', 6000); renderCartBar(); }
    });
    s.on('session:closed', () => ended({ status: 410 }));
    s.on('session:revoked', () => ended({ status: 404 }));
    s.on('session:merged', () => location.reload());
    s.on('connect_error', (e) => { if (e.message === 'session_ended') ended({ status: 410 }); if (e.message === 'invalid_token') ended({ status: 404 }); });
  }

  // ---------- render ----------
  function render() {
    mount(app,
      h('header#hero'), h('nav#catnav.catnav'), h('main#menu'), h('div#cartbar'));
    renderHeader();
  }

  function renderHeader() {
    const i = S.info, r = i.restaurant, s = i.session;
    const banner = (window.innerWidth <= 700 && r.banner_mobile) || r.banner || r.banner_mobile;
    const g = guestObj();
    mount($('#hero'),
      h('div.hero', { style: banner ? { backgroundImage: `url("${banner}")` } : null },
        h('div.hero-top', null,
          h('button.table-chip', { onclick: () => pickGuest(false) }, `${t('table')}: ${s.table_code}`, g ? h('span.sep', null, '|') : null, g ? guestName(g) : null, h('span.chev', null, '⌄')),
          h('div.hero-actions', null,
            h('button.round', { 'aria-label': t('language'), onclick: pickLang }, h('span.flag', null, { th: '🇹🇭', en: '🇬🇧', zh: '🇨🇳' }[S.lang])),
            h('button.round', { 'aria-label': t('call_staff'), onclick: openCall }, bellIcon()),
            h('button.round#histbtn', { 'aria-label': t('history'), onclick: openHistory }, receiptIcon(), h('span.blue-dot.hidden#histdot'))))),
      h('div.brand', null,
        h('div.logo', { onclick: openInfo }, r.logo ? h('img', { src: r.logo, alt: '' }) : h('span', null, (T(r.name) || '?').slice(0, 1))),
        h('h1.store-name', null, T(r.name)),
        r.branch_name && T(r.branch_name) !== T(r.name) ? h('div.branch-name.muted', null, T(r.branch_name)) : null,
        h('button.timer-pill#timer', { onclick: openInfo }, '…')));
    updateBadges(); tick();
  }

  function bellIcon() { return svg('<path d="M4 18h16M6 18a6 6 0 0 1 12 0M12 9V7.5M9.5 7.5h5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>'); }
  function receiptIcon() { return svg('<path d="M7 3h10v18l-2-1.4L13 21l-2-1.4L9 21l-2-1.4V3z M9.5 8h5M9.5 11.5h5M9.5 15h3" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round" stroke-linecap="round"/>'); }
  function svg(inner) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '24'); s.setAttribute('height', '24'); s.innerHTML = inner; return s; }

  function updateBadges() { const d = $('#histdot'); if (d) d.classList.toggle('hidden', !S.unseen); }

  function tick() {
    const el = $('#timer'); if (!el || !S.info) return;
    const s = S.info.session; const now = BF.now();
    const left = s.end_at - now;
    el.classList.toggle('warn', left > 0 && left < 15 * 60000);
    el.classList.toggle('over', left <= 0);
    mount(el, h('span', null, s.status === 'billing' ? t('billing') : left > 0 ? `${t('time_left')} ${dur(left)}` : t('time_up')));
    // local fallback alerts (server also pushes)
    for (const m of S.info.alerts_min || []) if (left <= m * 60000 && left > (m - 1) * 60000 && !S.alerted.has(m)) { S.alerted.add(m); }
    if (openSheet === 'info') { const c = $('#info-left'); if (c) c.textContent = left > 0 ? dur(left) : t('time_up'); }
  }

  const orderingOpen = () => { const s = S.info.session; return s.status === 'active' && (!S.info.lock_after_time_up || BF.now() < s.order_end_at); };

  function renderMenu() {
    const m = S.menu;
    if (!m) return;
    const q = S.search.trim().toLowerCase();
    const items = m.items.filter((i) => !q || [i.name.th, i.name.en, i.name.zh, T(i.description)].some((x) => (x || '').toLowerCase().includes(q)));
    // category nav
    const cats = m.categories.filter((c) => items.some((i) => i.category_id === c.id));
    mount($('#catnav'),
      h('button.nav-icon', { 'aria-label': t('search'), onclick: toggleSearch }, svg('<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>')),
      h('button.nav-icon', { 'aria-label': 'categories', onclick: openCategories }, svg('<path d="M4 6h1M8 6h12M4 12h1M8 12h12M4 18h1M8 18h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>')),
      h('div.cat-scroll', null, cats.map((c) => h('button.cat', { class: S.cat === c.id ? 'active' : '', dataset: { cat: c.id }, onclick: () => scrollToCat(c.id) }, T(c.name)))));
    if (S.searchOpen) $('#catnav').after(searchBar());
    const main = $('#menu');
    if (!items.length) return mount(main, BF.states.empty(q ? `"${S.search}"` : t('no_orders')));
    mount(main, cats.map((c) => h('section.cat-section', { id: `cat-${c.id}`, dataset: { cat: c.id } },
      h('h2.cat-title', null, T(c.name)),
      h('div.grid', null, items.filter((i) => i.category_id === c.id).map(card)))),
      h('div.bottom-space'));
    observeCats();
    renderCartBar();
  }

  function img(src, alt) {
    const wrap = h('div.img-wrap.skeleton');
    if (!src) { wrap.classList.remove('skeleton'); wrap.classList.add('noimg'); wrap.appendChild(h('span', null, '🍽️')); return wrap; }
    const im = h('img', { src, alt: alt || '', loading: 'lazy', decoding: 'async', onload: () => wrap.classList.remove('skeleton'), onerror: () => { wrap.classList.remove('skeleton'); wrap.classList.add('noimg'); } });
    wrap.appendChild(im);
    return wrap;
  }

  function card(i) {
    const inCart = S.cart.filter((c) => c.menu_item_id === i.id).reduce((a, c) => a + c.qty, 0);
    const disabled = i.status !== 'available';
    return h('button.food', { class: disabled ? 'disabled' : '', onclick: () => openItem(i) },
      h('div.food-img', null, img(i.image, T(i.name)),
        disabled ? h('div.sold', null, i.status === 'out' ? t('out_of_stock') : t('not_now')) : null,
        inCart ? h('div.in-cart', null, `×${inCart}`) : null),
      h('div.food-name', null, T(i.name)),
      T(i.description) ? h('div.food-desc', null, T(i.description)) : null,
      i.extra_price ? h('div.food-price', null, `+฿${money(i.extra_price, i.extra_price % 100 ? 2 : 0)}`) : null);
  }

  function toggleSearch() {
    S.searchOpen = !S.searchOpen;
    const ex = $('.searchbar'); if (ex) ex.remove();
    if (S.searchOpen) { $('#catnav').after(searchBar()); $('.searchbar input').focus(); } else { S.search = ''; renderMenu(); }
  }
  function searchBar() {
    const input = h('input', { type: 'search', placeholder: t('search'), value: S.search, oninput: BF.debounce((e) => { S.search = e.target.value; const pos = e.target.selectionStart; renderMenu(); const ni = $('.searchbar input'); if (ni) { ni.focus(); ni.setSelectionRange(pos, pos); } }, 200) });
    return h('div.searchbar', null, input, h('button.btn.ghost.sm', { onclick: toggleSearch }, '✕'));
  }

  function scrollToCat(id) {
    const el = document.getElementById(`cat-${id}`);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - $('#catnav').offsetHeight - 8;
    window.scrollTo({ top: y, behavior: 'smooth' });
    setActiveCat(id);
  }
  function setActiveCat(id) {
    S.cat = id;
    document.querySelectorAll('.cat').forEach((b) => b.classList.toggle('active', Number(b.dataset.cat) === id));
    const act = document.querySelector('.cat.active'); if (act) act.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  let observer;
  function observeCats() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setActiveCat(Number(vis.target.dataset.cat));
    }, { rootMargin: '-120px 0px -60% 0px' });
    document.querySelectorAll('.cat-section').forEach((s) => observer.observe(s));
  }
  function openCategories() {
    const m = BF.modal(t('menu'), h('div.cat-list', null, S.menu.categories.map((c) => h('button.cat-row', { onclick: () => { m.close(); scrollToCat(c.id); } }, T(c.name), h('span.muted', null, S.menu.items.filter((i) => i.category_id === c.id).length)))), { sheet: true });
  }

  // ---------- item detail ----------
  function openItem(i) {
    const st = { qty: 1, note: '', choices: {} };
    for (const o of i.options) st.choices[o.id] = [];
    const unitExtra = () => i.extra_price + i.options.reduce((a, o) => a + st.choices[o.id].reduce((x, cid) => x + Number((o.choices.find((c) => String(c.id) === cid) || {}).price || 0), 0), 0);
    const qtyEl = h('span', null, '1');
    const addBtn = h('button.btn.primary.block.add-btn');
    const refresh = () => {
      qtyEl.textContent = st.qty;
      const ue = unitExtra();
      mount(addBtn, t('add_to_cart'), ue ? h('span.add-price', null, `+฿${money(ue * st.qty)}`) : null);
      const missing = i.options.some((o) => o.required && !st.choices[o.id].length);
      addBtn.disabled = i.status !== 'available' || missing || !orderingOpen();
    };
    const optionsEl = i.options.map((o) => h('div.opt', null,
      h('div.opt-head', null, h('b', null, T(o.name)), h('span.badge', null, o.required ? t('required') : t('optional')), o.type === 'multi' && o.max_select ? h('span.muted.small', null, t('choose_up_to', { n: o.max_select })) : null),
      o.choices.map((c) => {
        const input = h('input', { type: o.type === 'multi' ? 'checkbox' : 'radio', name: `o${o.id}`, value: c.id, onchange: (e) => {
          const arr = st.choices[o.id];
          if (o.type === 'multi') {
            if (e.target.checked) { if (o.max_select && arr.length >= o.max_select) { e.target.checked = false; return; } arr.push(String(c.id)); } else arr.splice(arr.indexOf(String(c.id)), 1);
          } else st.choices[o.id] = [String(c.id)];
          refresh();
        } });
        return h('label.opt-choice', null, input, h('span.grow', null, T(c.name)), c.price ? h('span.muted', null, `+฿${money(c.price, 0)}`) : null);
      })));
    const content = h('div.item-detail', null,
      h('div.item-hero', null, img(i.image, T(i.name))),
      h('div.item-body', null,
        h('h2.item-name', null, T(i.name)),
        T(i.description) ? h('p.item-desc', null, T(i.description)) : null,
        i.extra_price ? h('div.extra', null, `${t('extra_charge')} +฿${money(i.extra_price)}`) : null,
        T(i.ingredients) ? h('div.info-block', null, h('b', null, t('ingredients')), h('div', null, T(i.ingredients))) : null,
        i.allergens.length ? h('div.info-block', null, h('b', null, t('allergens')), h('div.allergens', null, i.allergens.map((a) => h('span.badge.allergen', null, a)))) : null,
        i.status !== 'available' ? h('div.warnbox', null, i.status === 'out' ? t('out_of_stock') : `${t('not_now')} (${i.available_from || ''}-${i.available_to || ''})`) : null,
        optionsEl,
        h('label.note', null, t('note'), h('textarea', { rows: 2, maxlength: 200, placeholder: t('note_ph'), oninput: (e) => { st.note = e.target.value; } })),
        h('div.qty-row', null, h('b', null, t('qty')), h('div.stepper', null,
          h('button', { onclick: () => { if (st.qty > 1) { st.qty--; refresh(); } } }, '−'), qtyEl,
          h('button', { onclick: () => { const max = i.max_per_order || 20; if (st.qty < max) { st.qty++; refresh(); } } }, '+')))));
    const m = BF.modal(null, content, { sheet: true, actions: [addBtn] });
    m.el.classList.add('item-sheet');
    m.el.prepend(h('button.sheet-close', { onclick: () => m.close(), 'aria-label': t('close') }, '✕'));
    addBtn.onclick = () => {
      const options = i.options.filter((o) => st.choices[o.id].length).map((o) => ({ option_id: o.id, choice_ids: st.choices[o.id] }));
      const labels = i.options.flatMap((o) => st.choices[o.id].map((cid) => T((o.choices.find((c) => String(c.id) === cid) || {}).name)));
      const keyStr = JSON.stringify([i.id, options, st.note.trim()]);
      const ex = S.cart.find((c) => c.key === keyStr);
      if (ex) ex.qty += st.qty; else S.cart.push({ key: keyStr, menu_item_id: i.id, qty: st.qty, options, labels, note: st.note.trim(), unit_extra: unitExtra() });
      saveCart(); m.close(); renderMenu();
      BF.toast(`${T(i.name)} ×${st.qty}`, 'success', 1500);
    };
    refresh();
  }

  function saveCart() { store.set(skey('cart'), JSON.stringify(S.cart)); }
  const cartCount = () => S.cart.reduce((a, c) => a + c.qty, 0);
  const cartExtra = () => S.cart.reduce((a, c) => a + c.qty * c.unit_extra, 0);

  function renderCartBar() {
    const bar = $('#cartbar'); if (!bar) return;
    const n = cartCount();
    if (!n) return mount(bar);
    mount(bar, h('button.cartbar', { onclick: openCart, disabled: !orderingOpen() },
      h('span.cart-count', null, n), h('span.grow', null, orderingOpen() ? `${t('cart')} • ${t('order_now')}` : (S.info.session.status === 'billing' ? t('billing') : t('ordering_closed'))),
      cartExtra() ? h('span', null, `+฿${money(cartExtra())}`) : h('span', null, '›')));
  }

  function itemById(id) { return S.menu.items.find((i) => i.id === id); }

  function openCart() {
    let submitting = false;
    const body = h('div');
    const submit = h('button.btn.primary.block', { onclick: send }, t('confirm_order'));
    const m = BF.modal(t('cart'), body, { sheet: true, actions: [submit] });
    const draw = () => {
      if (!S.cart.length) { mount(body, BF.states.empty(t('empty_cart'), '🛒')); submit.disabled = true; return; }
      const pkgs = S.info.packages;
      const rule = pkgs[0];
      const maxRound = rule && rule.max_per_round ? rule.max_per_round * (rule.round_per_guest ? (needsGuest() ? 1 : S.info.session.guests_count) : 1) : 0;
      mount(body,
        maxRound ? h('div.muted.small', null, t('round_limit', { n: maxRound })) : null,
        S.cart.map((c, idx) => {
          const it = itemById(c.menu_item_id);
          return h('div.cart-line', null,
            h('div.cart-thumb', null, img(it && it.image, '')),
            h('div.grow', null, h('div.cart-name', null, it ? T(it.name) : '?'),
              c.labels.length ? h('div.muted.small', null, c.labels.join(', ')) : null,
              c.note ? h('div.muted.small', null, `“${c.note}”`) : null,
              c.unit_extra ? h('div.small', null, `+฿${money(c.unit_extra * c.qty)}`) : null),
            h('div.stepper', null,
              h('button', { onclick: () => { c.qty--; if (c.qty <= 0) S.cart.splice(idx, 1); saveCart(); draw(); renderMenu(); } }, c.qty === 1 ? '🗑' : '−'),
              h('span', null, c.qty),
              h('button', { onclick: () => { const mx = it && it.max_per_order ? it.max_per_order : 20; if (c.qty < mx) { c.qty++; saveCart(); draw(); renderMenu(); } } }, '+')));
        }),
        cartExtra() ? h('div.sum-row', null, h('b', null, t('extra_charge')), h('b', null, `฿${money(cartExtra())}`)) : null);
      submit.disabled = submitting || !orderingOpen();
      submit.textContent = submitting ? t('sending') : `${t('confirm_order')} (${cartCount()})`;
    };
    async function send() {
      if (submitting || !S.cart.length) return;
      submitting = true; draw();
      // Same idempotency key until this cart is accepted — safe to retry after a network error
      let k = store.get(skey('ikey'));
      if (!k) { k = ikey(); store.set(skey('ikey'), k); }
      try {
        const r = await api.post(`${base}/orders`, { idempotency_key: k, guest_label: S.guest || undefined, device_id: deviceId(), items: S.cart.map((c) => ({ menu_item_id: c.menu_item_id, qty: c.qty, options: c.options, note: c.note || undefined })) }, { token: null });
        store.del(skey('ikey'));
        S.cart = []; saveCart();
        const i = S.orders.findIndex((o) => o.id === r.order.id); if (i < 0) S.orders.unshift(r.order);
        m.close(); renderMenu();
        BF.toast(`${t('order_success')} • ${r.order.order_no}`, 'success');
        openHistory();
      } catch (e) {
        if (e.status !== 0) store.del(skey('ikey')); // definitive server answer → new key next time
        if (e.status === 410) { m.close(); return ended(e); }
        if (e.code === 'guest_required') { m.close(); return pickGuest(true); }
        BF.error(e);
        submitting = false; draw();
      }
    }
    draw();
  }
  function deviceId() { let d = store.get('bf_device'); if (!d) { d = ikey().slice(0, 20); store.set('bf_device', d); } return d; }

  // ---------- history ----------
  let openSheet = null; let histBody;
  function openHistory() {
    S.unseen = false; updateBadges();
    histBody = h('div.history');
    openSheet = 'history';
    BF.modal(t('history'), histBody, { sheet: true, onClose: () => { openSheet = null; } });
    renderHistory();
    loadOrders().then(renderHistory);
  }
  function renderHistory() {
    if (!histBody) return;
    const s = S.info.session;
    if (!S.orders.length) return mount(histBody, h('div.muted', null, `${t('table')} ${s.table_code}`), BF.states.empty(t('no_orders'), '🧾'));
    mount(histBody, h('div.muted.small', null, `${t('table')} ${s.table_code} • #${s.public_code}`),
      S.orders.map((o) => h('div.order-card', null,
        h('div.row.between', null, h('div', null, h('b', null, `${t('order')} #${o.order_no}`), o.guest_label ? h('span.muted', null, ` • ${guestName(S.info.session.guests.find((g) => g.label === o.guest_label)) || o.guest_label}`) : null), status(o.status)),
        h('div.muted.small', null, t('ordered_at', { t: hhmm(o.created_at) })),
        o.items.map((i) => h('div.order-item', null,
          h('div.grow', null, h('div', null, `${T(i.name)} × ${i.qty}`), i.options.length ? h('div.muted.small', null, i.options.map((x) => T(x.choice)).join(', ')) : null, i.note ? h('div.muted.small', null, `“${i.note}”`) : null),
          status(i.status))))),
      h('button.btn.block.view-bill', { onclick: openBill }, t('view_bill')));
  }
  const status = (st) => h(`span.badge.st.st-${st}`, null, t(`st_${st}`));

  async function openBill() {
    const body = h('div', null, BF.states.loading(1, 'sk-line'));
    BF.modal(t('bill'), body, { sheet: true });
    try {
      const { bill } = await api.get(`${base}/bill?lang=${S.lang}`, { token: null });
      mount(body, bill.lines.map((l) => h('div.sum-row', null, h('span', null, `${l.qty}× ${l.name}`), h('span', null, money(l.amount)))),
        bill.discounts.map((d) => h('div.sum-row', null, h('span', null, d.name), h('span', null, `-${money(d.amount)}`))),
        h('div.sum-row', null, h('span', null, 'Service Charge'), h('span', null, money(bill.service_charge))),
        h('div.sum-row', null, h('span', null, `VAT ${bill.vat_rate}%`), h('span', null, money(bill.vat))),
        h('div.sum-row.total', null, h('span', null, 'Total'), h('span', null, `฿${money(bill.total)}`)));
    } catch (e) { mount(body, BF.states.error(e)); }
  }

  // ---------- staff call ----------
  let callBody;
  function openCall() {
    openSheet = 'call';
    callBody = h('div');
    const grid = h('div.call-grid', null, S.info.call_types.map((c) => h('button.call-btn', { style: { '--c': c.color }, onclick: (e) => sendCall(c, e.currentTarget) },
      c.image ? h('img', { src: c.image, alt: '' }) : h('span.call-icon', null, c.icon || '🔔'), h('span', null, T(c.name)))));
    BF.modal(t('call_staff'), h('div', null, grid, h('h4.mt', null, t('recent_requests')), callBody), { sheet: true, onClose: () => { openSheet = null; } });
    renderCallList();
  }
  async function sendCall(c, btn) {
    btn.disabled = true;
    try {
      const r = await api.post(`${base}/calls`, { type_id: c.id, guest_label: S.guest || undefined }, { token: null });
      S.calls.unshift(r.call); renderCallList();
      BF.toast(`${T(c.name)} • ${t('call_sent')}`, 'success');
    } catch (e) { if (e.status === 410) return ended(e); BF.error(e); }
    setTimeout(() => { btn.disabled = false; }, 1500);
  }
  function renderCallList() {
    if (!callBody) return;
    if (!S.calls.length) return mount(callBody, h('div.muted.small', null, '—'));
    mount(callBody, S.calls.slice(0, 8).map((c) => h('div.call-row', null, h('span.grow', null, T(c.label)), h('span.muted.small', null, hhmm(c.created_at)), h(`span.badge.st.st-${c.status}`, null, t(`call_${c.status}`)))));
  }

  // ---------- info / terms / share (reference screenshot 1) ----------
  function openInfo() {
    openSheet = 'info';
    const s = S.info.session, r = S.info.restaurant;
    const pk = S.info.packages;
    const content = h('div.info-sheet', null,
      h('div.info-head', null, h('div.logo.sm', null, r.logo ? h('img', { src: r.logo, alt: '' }) : h('span', null, (T(r.name) || '?')[0])), h('div.info-title', null, T(r.branch_name) || T(r.name))),
      h('div.course-card', null,
        h('div.course-left', null, h('div.course-name', null, pk.map((p) => (p.name.en || T(p.name)).toUpperCase()).join(' + ')), h('div.course-persons', null, '👤 ', t('persons', { n: s.guests_count }))),
        h('div.course-right', null, h('div.course-time', null, `${hhmm(s.start_at)} - ${hhmm(s.end_at)}`), h('div.muted', null, t('eat_time', { n: s.duration_min })), h('div.course-left-time', null, h('span.muted', null, `${t('time_left')} `), h('b#info-left', null, '')),
          s.order_end_at < s.end_at ? h('div.muted.small', null, t('ordering_closes', { t: hhmm(s.order_end_at) })) : null)),
      T(S.info.terms) ? h('div.terms', null, h('h3', null, t('terms')), h('div.terms-body', { html: T(S.info.terms) })) : null,
      pk.some((p) => p.leftover && T(p.leftover.text)) ? h('div.terms-body.muted', null, pk.map((p) => T(p.leftover.text)).filter(Boolean).join(' ')) : null,
      h('button.list-row', { onclick: openShare }, h('b', null, t('share_qr')), h('span', null, '›')),
      h('button.list-row', { onclick: openMember }, h('b', null, S.info.member ? `${t('member')}: ${S.info.member.first_name || ''} • ${S.info.member.points} ${t('points')}` : t('join_member')), h('span', null, '›')),
      s.guests_count > 1 ? h('button.list-row', { onclick: () => pickGuest(false) }, h('b', null, t('guests')), h('span', null, '›')) : null);
    BF.modal(null, content, { sheet: true, onClose: () => { openSheet = null; } });
    tick();
  }

  function openShare() {
    const url = location.origin + location.pathname;
    BF.modal(t('share_qr'), h('div.share', null,
      h('img.share-qr', { src: `${base}/qr.png`, alt: 'QR' }),
      h('p.muted.center', null, t('share_hint')),
      h('div.row', null,
        navigator.share ? h('button.btn.primary.grow', { onclick: () => navigator.share({ title: T(S.info.restaurant.name), url }).catch(() => {}) }, t('share')) : null,
        h('button.btn.grow', { onclick: async () => { try { await navigator.clipboard.writeText(url); BF.toast(t('copied'), 'success'); } catch { prompt('', url); } } }, t('copy')))), { sheet: true });
  }

  function pickLang() {
    const names = { th: 'ภาษาไทย', en: 'English', zh: '中文' }, flags = { th: '🇹🇭', en: '🇬🇧', zh: '🇨🇳' };
    const m = BF.modal(t('language'), h('div.lang-list', null, S.info.languages.map((l) => h('button.list-row', { class: l === S.lang ? 'active' : '', onclick: () => { S.lang = l; BF.lang = l; store.set('bf_lang', l); document.documentElement.lang = l; m.close(); renderHeader(); renderMenu(); } }, h('span', null, `${flags[l]}  ${names[l]}`), l === S.lang ? h('span', null, '✓') : null))), { sheet: true });
  }

  function pickGuest(force) {
    const guests = S.info.session.guests;
    const pk = (id) => S.info.packages.find((p) => p.id === id);
    const m = BF.modal(t('who_are_you'), h('div', null,
      h('p.muted', null, t('who_hint')),
      h('div.guest-list', null, guests.map((g) => h('div.guest-row', { class: g.label === S.guest ? 'active' : '' },
        h('button.grow.guest-pick', { onclick: async () => { S.guest = g.label; store.set(skey('guest'), g.label); m.close(); renderHeader(); await loadMenu(); } },
          h('span.guest-avatar', null, g.label), h('span.grow', null, h('b', null, guestName(g)), needsGuest() && pk(g.package_id) ? h('div.muted.small', null, T(pk(g.package_id).name)) : null)),
        h('button.btn.sm', { onclick: async () => { const n = prompt(t('rename'), g.display_name || ''); if (n == null) return; try { await api.post(`${base}/guest-name`, { label: g.label, name: n.trim() }, { token: null }); g.display_name = n.trim() || null; m.close(); renderHeader(); pickGuest(force); } catch (e) { BF.error(e); } } }, '✎'))))), { sheet: true });
  }

  // ---------- membership ----------
  function openMember() {
    if (S.info.member && S.memberToken) return memberHome();
    const body = h('div.form');
    const m = BF.modal(t('join_member'), body, { sheet: true });
    const phone = h('input', { type: 'tel', inputmode: 'tel', placeholder: '08x-xxx-xxxx', autocomplete: 'tel' });
    const sendBtn = h('button.btn.primary.block', { onclick: async () => {
      sendBtn.disabled = true;
      try {
        const r = await api.post(`${base}/member/otp`, { phone: phone.value }, { token: null });
        stepOtp(r.dev_code, r.notice);
      } catch (e) { BF.error(e); sendBtn.disabled = false; }
    } }, t('send_otp'));
    mount(body, h('label', null, t('phone'), phone), sendBtn);
    function stepOtp(devCode, notice) {
      const otp = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '••••••' });
      const btn = h('button.btn.primary.block', { onclick: async () => {
        btn.disabled = true;
        try {
          const r = await api.post(`${base}/member/verify`, { phone: phone.value, code: otp.value }, { token: null });
          if (r.needs_profile) return stepProfile(r);
          done(r);
        } catch (e) { BF.error(e); btn.disabled = false; }
      } }, t('verify'));
      mount(body, h('label', null, t('otp'), otp), devCode ? h('div.warnbox', null, `${notice} — ${devCode}`) : null, btn);
      otp.focus();
    }
    function stepProfile(v) {
      const f = { first_name: h('input', { autocomplete: 'given-name' }), last_name: h('input', { autocomplete: 'family-name' }), birthday: h('input', { type: 'date' }), email: h('input', { type: 'email', autocomplete: 'email' }) };
      const consent = h('input', { type: 'checkbox' });
      const btn = h('button.btn.primary.block', { onclick: async () => {
        btn.disabled = true;
        try {
          const r = await api.post(`${base}/member/register`, { phone: v.phone, signup_token: v.signup_token, first_name: f.first_name.value, last_name: f.last_name.value, birthday: f.birthday.value || undefined, email: f.email.value || undefined, consent: consent.checked }, { token: null });
          done(r);
        } catch (e) { BF.error(e); btn.disabled = false; }
      } }, t('save'));
      mount(body, h('label', null, t('first_name'), f.first_name), h('label', null, t('last_name'), f.last_name), h('label', null, t('birthday'), f.birthday), h('label', null, t('email'), f.email), h('label.check', null, consent, t('consent')), btn);
    }
    function done(r) {
      S.memberToken = r.member_token; store.set(skey('mt'), r.member_token);
      S.info.member = r.member;
      m.close(); BF.toast(t('member_linked'), 'success'); memberHome();
    }
  }
  async function memberHome() {
    const body = h('div', null, BF.states.loading(2, 'sk-line'));
    const m = BF.modal(t('member'), body, { sheet: true });
    try {
      const r = await api.get(`${base}/member`, { token: null, headers: { 'x-member-token': S.memberToken } });
      const mem = r.member;
      mount(body,
        h('div.member-card', { style: { background: mem.tier ? mem.tier.color : 'var(--primary)' } }, h('div', null, h('div.small', null, mem.tier ? T(mem.tier.name) : ''), h('b', null, `${mem.first_name || ''} ${mem.last_name || ''}`), h('div.small', null, mem.code)), h('div.member-points', null, h('b', null, mem.points), h('div.small', null, t('points')))),
        r.redemptions.length ? h('div', null, h('h4', null, t('my_codes')), r.redemptions.map((x) => h('div.call-row', null, h('span.grow', null, T(x.name)), h('code', null, x.code), h('span.badge', null, x.status)))) : null,
        h('h4', null, t('promotions')),
        r.promotions.length ? r.promotions.map((p) => h('div.promo', null,
          p.image ? h('img', { src: p.image, alt: '' }) : null,
          h('div.grow', null, h('b', null, T(p.name)), h('div.muted.small', null, T(p.description)), h('div.small', null, `${p.points_cost} ${t('points')}`), p.ineligible ? h('div.small.warn-text', null, p.ineligible) : null),
          h('button.btn.sm.primary', { disabled: !!p.ineligible, onclick: async (e) => { e.target.disabled = true; try { await api.post(`${base}/member/redeem`, { promotion_id: p.id }, { token: null, headers: { 'x-member-token': S.memberToken } }); BF.toast(t('redeemed'), 'success'); m.close(); memberHome(); } catch (err) { BF.error(err); e.target.disabled = false; } } }, t('redeem')))) : BF.states.empty('—', '🎁'),
        h('h4', null, t('points')), r.history.map((x) => h('div.call-row', null, h('span.grow.small', null, x.reason || x.type), h('span.small.muted', null, BF.dt(x.created_at)), h('b', { style: { color: x.points >= 0 ? 'var(--success)' : 'var(--danger)' } }, x.points > 0 ? `+${x.points}` : x.points))));
    } catch (e) {
      if (e.status === 403) { S.memberToken = null; store.del(skey('mt')); m.close(); return openMember(); }
      mount(body, BF.states.error(e));
    }
  }

  window.addEventListener('resize', BF.debounce(() => { if (S.info) renderHeader(); }, 300));
  boot();
})();
