// Print Station: keeps this device's USB / Bluetooth / Serial printers connected and prints their queued jobs.
(function () {
  'use strict';
  const { h, mount, $, api } = { ...BF, api: BF.api };
  const app = $('#app');
  const P = BF.printing;
  const TICON = { usb: '🔌 USB', ble: '📶 Bluetooth', serial: '🔗 Serial / Bluetooth SPP' };

  async function start() {
    await BF.requireLogin('Print Station', { permission: ['settings.manage', 'table.close', 'table.open', 'kitchen.update'] });
    await P.start(BF.socket({ staffToken: BF.auth.token() }));
    P.onChange(render);
    render();
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  }
  function render() {
    const s = P.support;
    const mine = P.mine();
    const others = P.printers.filter((p) => p.config && p.config.device_id && p.config.host_device_id !== BF.deviceId());
    mount(app,
      h('header.topbar', null, h('div.brand', null, '🖨 Print Station'), h('span.grow'), h('button.btn.sm', { onclick: BF.auth.logout }, 'ออก')),
      h('main.wrap', null,
        h('div.card.support', null, h('b', null, 'เบราว์เซอร์นี้: '),
          h('span', { class: s.usb ? 'ok' : 'bad' }, `USB ${s.usb ? '✔' : '✘'}`), h('span', { class: s.ble ? 'ok' : 'bad' }, `Bluetooth ${s.ble ? '✔' : '✘'}`), h('span', { class: s.serial ? 'ok' : 'bad' }, `Serial ${s.serial ? '✔' : '✘'}`),
          !s.secure ? h('div.bad', null, 'ต้องเปิดผ่าน HTTPS') : null,
          h('p.muted.small', null, 'เปิดหน้านี้ค้างไว้บนอุปกรณ์ที่ต่อเครื่องพิมพ์ ระบบจะพิมพ์งานให้อัตโนมัติ • เพิ่มเครื่องพิมพ์ใหม่ได้ที่ Admin › เครื่องพิมพ์ › 🔍 ค้นหาเครื่องพิมพ์ (หรือปุ่มด้านล่างสำหรับผู้ดูแล)'),
          BF.auth.can('settings.manage') ? h('a.btn.primary.sm', { href: '/admin/#printers' }, '🔍 ค้นหาเครื่องพิมพ์ (Admin)') : null),
        h('h3', null, 'เครื่องพิมพ์ของอุปกรณ์นี้'),
        mine.length ? mine.map((p) => {
          const st = P.state[p.id];
          return h('div.card.pcard', null, h('div.row.between', null,
            h('div', null, h('b', null, p.name), h('div.muted.small', null, `${TICON[p.config.transport]} • ${p.config.device_name || ''} • ${p.paper_width} มม.`)),
            h('span', { class: st && st.status === 'online' ? 'ok' : 'bad' }, st ? (st.status === 'online' ? 'เชื่อมต่อแล้ว' : st.error) : 'กำลังเชื่อมต่อ…')),
            h('div.row', null, h('button.btn', { onclick: async () => { try { await P.connect(p, { prompt: true }); } catch (e) { BF.error(e); } } }, 'เชื่อมต่อ'), h('button.btn', { onclick: () => P.drain() }, 'พิมพ์งานที่ค้าง'),
              h('button.btn.ghost', { onclick: async () => { try { await api.post(`/api/admin/printers/${p.id}/test`); BF.toast('ส่งงานทดสอบแล้ว', 'success'); } catch (e) { BF.error(e); } } }, 'พิมพ์ทดสอบ')));
        }) : BF.states.empty('ยังไม่มีเครื่องพิมพ์ที่ผูกกับอุปกรณ์นี้', '🖨'),
        others.length ? h('div', null, h('h3', null, 'เครื่องพิมพ์ที่ต่อกับอุปกรณ์อื่น'), others.map((p) => h('div.card', null, h('b', null, p.name), h('span.muted.small', null, ` ${TICON[p.config.transport]} • ${p.config.host_label || ''}`)))) : null));
  }
  start();
})();
