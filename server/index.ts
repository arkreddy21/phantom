import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createApp } from './app.js';
import { databasePathFromEnvironment } from './database.js';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) loadEnvFile(envFile);

const authUsername = process.env.AUTH_USERNAME;
const authPassword = process.env.AUTH_PASSWORD;
if (!authUsername || !authPassword) {
  throw new Error('AUTH_USERNAME and AUTH_PASSWORD must both be configured before starting the server');
}
const host = process.env.HOST || '127.0.0.1';
const trustProxySetting = process.env.AUTH_TRUST_PROXY;
if (trustProxySetting !== undefined && trustProxySetting !== '0' && trustProxySetting !== '1') {
  throw new Error('AUTH_TRUST_PROXY must be exactly 1 or 0 when set');
}
const trustProxy = trustProxySetting === '1';
if (trustProxy) console.warn('AUTH_TRUST_PROXY=1: forwarded client IPs are trusted; expose this service only through a trusted single-hop proxy.');

if (process.env.NODE_ENV === 'production' && !process.env.HOST) {
  console.warn('No HOST configured; binding to loopback. Put production deployment behind authentication and network protections.');
}

let app: ReturnType<typeof createApp>['app'];
let db: ReturnType<typeof createApp>['db'];
let ready: ReturnType<typeof createApp>['ready'];
try {
  ({ app, db, ready } = createApp({
    databasePath: databasePathFromEnvironment(),
    production: process.argv.includes('--production') || process.env.NODE_ENV === 'production',
    publicOrigin: process.env.PUBLIC_ORIGIN,
    authTrustProxy: trustProxy,
    auth: { username: authUsername, password: authPassword },
  }));
} catch {
  console.error('Authentication initialization failed; server startup aborted');
  process.exit(1);
}
const port = Number(process.env.PORT || 3001);
const server = createServer(app);
void ready.then(() => {
  server.listen(port, host, () => console.info(`Persona server listening on http://${host}:${port}`));
}).catch(() => {
  db.close();
  console.error('Authentication initialization failed; server startup aborted');
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
