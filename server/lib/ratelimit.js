'use strict';
// Minimal in-memory sliding-window rate limiter (per process).
const { err } = require('./util');
const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 60, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    const k = `${req.baseUrl}${req.route ? req.route.path : ''}|${key(req)}`;
    const t = Date.now();
    const arr = (buckets.get(k) || []).filter((x) => x > t - windowMs);
    if (arr.length >= max) return next(err(429, 'rate_limited', 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่'));
    arr.push(t); buckets.set(k, arr);
    next();
  };
}
setInterval(() => { const t = Date.now(); for (const [k, v] of buckets) if (!v.length || v[v.length - 1] < t - 3600e3) buckets.delete(k); }, 600000).unref();
module.exports = { rateLimit };
