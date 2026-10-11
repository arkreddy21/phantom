import { createServer } from 'node:http';
import { createApp } from './app.js';
import { databasePathFromEnvironment } from './database.js';

if (process.env.NODE_ENV === 'production' && !process.env.HOST) {
  console.warn('No HOST configured; binding to loopback. Put production deployment behind authentication and network protections.');
}

const { app, db } = createApp({
  databasePath: databasePathFromEnvironment(),
  production: process.env.NODE_ENV === 'production',
});
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const server = createServer(app);
server.listen(port, host, () => console.info(`Persona server listening on http://${host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
