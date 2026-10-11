'use strict';
// Base URL used in printed QR codes when PUBLIC_URL is not configured: remembered from the latest staff request.
const config = require('../config');
let last = `http://localhost:${config.port}`;
module.exports = {
  remember(req) { if (!config.publicUrl && req && req.get('host')) last = `${req.protocol}://${req.get('host')}`; },
  get() { return config.publicUrl || last; },
};
