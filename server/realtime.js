'use strict';
// Socket.IO real-time hub.
// Rooms:  staff:<branch>   — POS / admin / staff call center
//         kds:<branch>     — kitchen displays
//         session:<id>     — customer devices of one table session
//         printers:<branch>— browser print stations
const { Server } = require('socket.io');
const auth = require('./auth');

let io = null;

function init(httpServer) {
  io = new Server(httpServer, { cors: { origin: false }, pingInterval: 20000 });
  io.use((socket, next) => {
    const a = socket.handshake.auth || {};
    if (a.staffToken) {
      const r = auth.resolveToken(a.staffToken);
      if (!r) return next(new Error('unauthenticated'));
      socket.data.staff = r.staff; socket.data.branchId = r.branch_id;
      return next();
    }
    if (a.sessionToken) {
      const sessions = require('./services/sessions');
      try {
        const s = sessions.resolveCustomerToken(a.sessionToken, { allowClosed: true });
        socket.data.sessionId = s.id; socket.data.branchId = s.branch_id;
        return next();
      } catch (e) { return next(new Error(e.code || 'invalid_session')); }
    }
    next(new Error('unauthenticated'));
  });
  io.on('connection', (socket) => {
    const { staff, branchId, sessionId } = socket.data;
    if (staff) {
      socket.join(`staff:${branchId}`);
      if (staff.permissions.includes('kitchen.update')) socket.join(`kds:${branchId}`);
      socket.on('join', (room) => {
        if (room === 'kds') socket.join(`kds:${branchId}`);
        if (room === 'printers' && staff.permissions.includes('settings.manage')) socket.join(`printers:${branchId}`);
      });
    } else if (sessionId) {
      socket.join(`session:${sessionId}`);
    }
    socket.emit('hello', { serverTime: Date.now() });
  });
  return io;
}

function emit(room, event, payload) { if (io) io.to(room).emit(event, { ...payload, serverTime: Date.now() }); }
const toStaff = (branchId, ev, p) => emit(`staff:${branchId}`, ev, p);
const toKds = (branchId, ev, p) => emit(`kds:${branchId}`, ev, p);
const toSession = (sessionId, ev, p) => emit(`session:${sessionId}`, ev, p);
const toPrinters = (branchId, ev, p) => emit(`printers:${branchId}`, ev, p);
// Force-disconnect all customer sockets of a session (after closing the table)
function kickSession(sessionId) {
  if (!io) return;
  io.in(`session:${sessionId}`).fetchSockets().then((socks) => socks.forEach((s) => setTimeout(() => s.disconnect(true), 500))).catch(() => {});
}

module.exports = { init, emit, toStaff, toKds, toSession, toPrinters, kickSession, get io() { return io; } };
