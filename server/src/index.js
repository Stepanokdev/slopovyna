'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl,
  origin: new URL(baseUrl).origin,
  dbFile: process.env.DB_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'slop.db'),
  github: { clientId: process.env.GITHUB_CLIENT_ID || '', clientSecret: process.env.GITHUB_CLIENT_SECRET || '' },
  devLogin: process.env.SLOP_DEV_LOGIN === '1',
};
if (config.devLogin && process.env.NODE_ENV === 'production') { console.error('SLOP_DEV_LOGIN is for local development only'); process.exit(1); }
if (!config.devLogin && (!config.github.clientId || !config.github.clientSecret)) console.warn('GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set: nobody can sign in');

const app = createApp(config);
app.server.listen(config.port, () => console.log(`slopovyna on :${config.port} (${config.baseUrl})${config.devLogin ? ' DEV LOGIN' : ''}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.close(); process.exit(0); });
