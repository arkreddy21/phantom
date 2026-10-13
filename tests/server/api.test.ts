import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase } from '../../server/database.js';

describe('server API', () => {
  let db: ReturnType<typeof createDatabase>;
  let server: Server;
  let baseUrl: string;
  let sessionCookie: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    server = createServer(createApp({ database: db, auth: { username: 'owner', password: 'correct-horse' } }).app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
    sessionCookie = login.headers.get('set-cookie')!.split(';')[0];
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  async function request(path: string, method = 'GET', body?: unknown, origin?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(origin === undefined ? {} : { origin }),
        cookie: sessionCookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: await response.json() as any };
  }

  const today = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };

  it('seeds configuration only, and serves health/state without powered-by header', async () => {
    const { response, body } = await request('/api/state');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(body.stats.map((item: any) => item.name)).toEqual(['Knowledge', 'Charm', 'Health', 'Kindness', 'Guts']);
    expect(body.habits.map((item: any) => item.name)).toEqual(['Read 20 minutes', 'Skin care', 'Move your body', 'Gratitude', 'Sleep check-in']);
    expect(body.entries).toEqual([]);
    expect((await request('/api/health')).body).toEqual({ status: 'ok' });
  });

  it('keeps all API data private and supports session inspection, login, and revocation', async () => {
    const privateRequests: Array<[string, string, unknown?]> = [
      ['/api/state', 'GET'], ['/api/backup', 'GET'], ['/api/backup', 'POST', {}],
      ['/api/stats', 'POST', { name: 'Private', color: '#123456' }], ['/api/stats/knowledge', 'PATCH', { name: 'Private' }],
      ['/api/habits', 'POST', { name: 'Private', kind: 'check', statId: 'knowledge', points: 1 }],
      ['/api/habits/read-20-minutes', 'PATCH', { archived: true }],
      [`/api/entries/read-20-minutes/${today()}`, 'PUT', { completed: true }], ['/api/no-such-endpoint', 'GET'],
    ];
    for (const [path, method, body] of privateRequests) {
      const response = await fetch(`${baseUrl}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    const session = await fetch(`${baseUrl}/api/auth/session`);
    expect(await session.json()).toEqual({ user: null });
    const wrong = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong' }) });
    expect(wrong.status).toBe(401);
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect(await login.json()).toEqual({ user: { id: 'owner', username: 'owner' } });
    expect((await fetch(`${baseUrl}/api/state`, { headers: { cookie } })).status).toBe(200);
    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
    expect(logout.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/state`, { headers: { cookie } })).status).toBe(401);
  });

  it('fails closed when owner credentials are absent', () => {
    expect(() => createApp({ database: db } as any)).toThrow(/Authentication is required/);
  });

  it('uses configured HTTPS origin for Secure cookies and rejects cross-site or non-JSON unsafe calls', async () => {
    const configuredServer = createServer(createApp({ database: db, publicOrigin: 'https://phantom.example.com', auth: { username: 'owner', password: 'correct-horse' } }).app);
    await new Promise<void>((resolve) => configuredServer.listen(0, '127.0.0.1', resolve));
    const address = configuredServer.address() as { port: number };
    try {
      const base = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://phantom.example.com' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
      expect(login.headers.get('set-cookie')).toContain('; Secure');
      expect((await fetch(`${base}/api/auth/session`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
      expect((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] }, body: 'logout' })).status).toBe(403);
      const spoof = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'phantom.example.com' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
      expect(spoof.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => configuredServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('persists sessions across app restart, invalidates them on credential change, and expires old sessions', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = mkdtempSync(join(tmpdir(), 'persona-auth-test-'));
    const filename = join(directory, 'data.sqlite');
    let persistentDb = createDatabase(filename);
    let persistentServer = createServer(createApp({ database: persistentDb, auth: { username: 'owner', password: 'correct-horse' } }).app);
    const listen = async (target: Server) => {
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    };
    try {
      const firstUrl = await listen(persistentServer);
      const login = await fetch(`${firstUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      await new Promise<void>((resolve) => persistentServer.close(() => resolve()));
      persistentDb.close();
      persistentDb = createDatabase(filename);
      persistentServer = createServer(createApp({ database: persistentDb, auth: { username: 'owner', password: 'correct-horse' } }).app);
      const secondUrl = await listen(persistentServer);
      expect((await fetch(`${secondUrl}/api/state`, { headers: { cookie } })).status).toBe(200);
      await new Promise<void>((resolve) => persistentServer.close(() => resolve()));
      persistentDb.close();

      persistentDb = createDatabase(filename);
      persistentServer = createServer(createApp({ database: persistentDb, auth: { username: 'owner', password: 'new-password' } }).app);
      const thirdUrl = await listen(persistentServer);
      expect((await fetch(`${thirdUrl}/api/state`, { headers: { cookie } })).status).toBe(401);
      persistentDb.prepare('UPDATE auth_sessions SET expires_at = 0').run();
      const fresh = await fetch(`${thirdUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'new-password' }) });
      expect((await fetch(`${thirdUrl}/api/state`, { headers: { cookie: fresh.headers.get('set-cookie')!.split(';')[0] } })).status).toBe(200);
      expect((persistentDb.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE expires_at <= ?').get(Date.now()) as { count: number }).count).toBe(0);
    } finally {
      await new Promise<void>((resolve) => persistentServer.close(() => resolve()));
      persistentDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('throttles repeated login failures with a generic response', async () => {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 9; attempt++) {
      last = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong' }) });
    }
    expect(last?.status).toBe(429);
    expect(await last?.json()).toEqual({ error: 'Invalid username or password' });
    const throttled = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not trust forwarded client addresses for throttling by default', async () => {
    const login = (password: string, xff: string) => fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ username: 'owner', password }),
    });
    for (let attempt = 0; attempt < 8; attempt++) await login('wrong', `198.51.100.${attempt + 1}`);
    const denied = await login('correct-horse', '203.0.113.77');
    expect(denied.status).toBe(429);
  });

  it('uses only the appended rightmost forwarded address when explicitly configured', async () => {
    const proxyServer = createServer(createApp({ database: db, auth: { username: 'owner', password: 'correct-horse' }, authTrustProxy: true }).app);
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyBase = `http://127.0.0.1:${(proxyServer.address() as { port: number }).port}`;
    const login = (password: string, xff: string) => fetch(`${proxyBase}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ username: 'owner', password }),
    });
    try {
      for (let attempt = 0; attempt < 8; attempt++) await login('wrong', `203.0.113.100, 198.51.100.10`);
      expect((await login('correct-horse', '1.2.3.4, 198.51.100.10')).status).toBe(429);
      expect((await login('correct-horse', '1.2.3.4, 198.51.100.11')).status).toBe(200);
    } finally { await new Promise<void>((resolve, reject) => proxyServer.close((error) => error ? reject(error) : resolve())); }
  });

  it('rejects owner usernames with surrounding whitespace', () => {
    expect(() => createApp({ database: db, auth: { username: ' owner ', password: 'correct-horse' } })).toThrow(/AUTH_USERNAME/);
  });

  it('exposes readiness for health checks and awaits auth initialization before app readiness', async () => {
    const delayed = createApp({ database: db, auth: { username: 'owner', password: 'correct-horse' } });
    const readinessServer = createServer(delayed.app);
    await new Promise<void>((resolve) => readinessServer.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(readinessServer.address() as { port: number }).port}`;
      await delayed.ready;
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
    } finally { await new Promise<void>((resolve, reject) => readinessServer.close((error) => error ? reject(error) : resolve())); }
  });

  it('clears the failed-login counter on a successful login', async () => {
    for (let attempt = 0; attempt < 7; attempt++) {
      await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong' }) });
    }
    const valid = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
    expect(valid.status).toBe(200);
    for (let attempt = 0; attempt < 8; attempt++) {
      expect((await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong' }) })).status).toBe(401);
    }
    expect((await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong' }) })).status).toBe(429);
  });

  it('keeps username/password failures indistinguishable and bounds oversized credentials', async () => {
    const attempt = async (username: string, password: string) => fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    const wrongName = await attempt('not-owner', 'correct-horse');
    const wrongPassword = await attempt('owner', 'incorrect');
    expect(wrongName.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(await wrongName.json()).toEqual(await wrongPassword.json());
    const tooLong = await attempt('x'.repeat(129), 'correct-horse');
    expect(tooLong.status).toBe(401);
    expect(await tooLong.json()).toEqual({ error: 'Invalid username or password' });
  });

  it('does not alter existing application data when auth tables are initialized or backups restored', async () => {
    await request(`/api/entries/read-20-minutes/${today()}`, 'PUT', { completed: true });
    const original = (await request('/api/backup')).body;
    expect(original).not.toHaveProperty('auth_sessions');
    expect(original).not.toHaveProperty('auth_metadata');
    const restored = await request('/api/backup', 'POST', { ...original, credentials: { username: 'attacker', password: 'changed' }, sessions: [] });
    expect(restored.response.status).toBe(400);
    expect((await request('/api/state')).body.entries).toHaveLength(1);
  });

  it('preserves pre-auth schema version 1 application data when adding auth tables', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = mkdtempSync(join(tmpdir(), 'persona-v1-auth-test-'));
    const filename = join(directory, 'legacy.sqlite');
    const legacyDb = createDatabase(filename);
    legacyDb.prepare(`INSERT INTO entries (id, habit_id, date, completed, content, good, bad, improve, sleep_hours,
      health_notes, awarded_points, stat_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-entry', 'read-20-minutes', '2025-01-01', 1, '', '', '', '', null, '', 10, 'knowledge', new Date().toISOString());
    legacyDb.close();
    try {
      const upgraded = createDatabase(filename);
      const upgradedServer = createServer(createApp({ database: upgraded, auth: { username: 'owner', password: 'correct-horse' } }).app);
      expect((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
      expect((upgraded.prepare("SELECT id FROM entries WHERE id = 'legacy-entry'").get() as { id: string }).id).toBe('legacy-entry');
      expect((upgraded.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count).toBe(0);
      await new Promise<void>((resolve) => upgradedServer.close(() => resolve()));
      upgraded.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('validates payloads and limits dates and points', async () => {
    expect((await request('/api/habits', 'POST', { name: 'Bad', kind: 'check', statId: 'knowledge', points: 0 })).response.status).toBe(400);
    expect((await request('/api/habits', 'POST', { name: 'Bad', kind: 'check', statId: 'knowledge', points: 1, alien: true })).response.status).toBe(400);
    expect((await request(`/api/entries/read-20-minutes/${today()}`, 'PUT', { completed: true, sleepHours: 25 })).response.status).toBe(400);
    expect((await request('/api/entries/read-20-minutes/2024-02-30', 'PUT', { completed: true })).response.status).toBe(400);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const future = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
    expect((await request(`/api/entries/read-20-minutes/${future}`, 'PUT', { completed: true })).response.status).toBe(400);
  });

  it('awards once, retains the initial reward snapshot, and reverses/re-awards on undo', async () => {
    const path = `/api/entries/read-20-minutes/${today()}`;
    const first = await request(path, 'PUT', { completed: true });
    expect(first.response.status).toBe(200);
    expect(first.body.reward).toEqual({ statId: 'knowledge', statName: 'Knowledge', points: 10 });
    const changedHabit = await request('/api/habits/read-20-minutes', 'PATCH', { points: 30, statId: 'guts' });
    expect(changedHabit.body.points).toBe(30);
    expect((await request(path, 'PUT', { completed: true })).body.reward).toBeNull();
    let state = (await request('/api/state')).body;
    expect(state.stats.find((item: any) => item.id === 'knowledge').points).toBe(10);
    expect(state.stats.find((item: any) => item.id === 'guts').points).toBe(0);
    expect((await request(path, 'PUT', { completed: false })).body.entry.awardedPoints).toBe(0);
    state = (await request('/api/state')).body;
    expect(state.stats.find((item: any) => item.id === 'knowledge').points).toBe(0);
    const reearned = await request(path, 'PUT', { completed: true });
    expect(reearned.body.reward).toEqual({ statId: 'guts', statName: 'Guts', points: 30 });
    state = (await request('/api/state')).body;
    expect(state.stats.find((item: any) => item.id === 'guts').points).toBe(30);
  });

  it('requires journal text to complete but saves draft text uncompleted', async () => {
    const path = `/api/entries/gratitude/${today()}`;
    expect((await request(path, 'PUT', { completed: true, content: '  ' })).response.status).toBe(400);
    const draft = await request(path, 'PUT', { completed: false, content: ' A small win ' });
    expect(draft.body.entry.content).toBe('A small win');
    expect(draft.body.entry.awardedPoints).toBe(0);
    expect((await request(path, 'PUT', { completed: true, content: 'Grateful for tea' })).body.reward.points).toBe(10);
    const repeated = await request(path, 'PUT', { completed: true });
    expect(repeated.response.status).toBe(200);
    expect(repeated.body.entry.content).toBe('Grateful for tea');
    expect(repeated.body.reward).toBeNull();
    const reopenedDraft = await request(path, 'PUT', { completed: false });
    expect(reopenedDraft.body.entry.content).toBe('Grateful for tea');
  });

  it('creates and edits stats/habits; archived habits remain and are editable', async () => {
    expect((await request('/api/stats', 'POST', { name: 'Focus', color: 'purple' })).response.status).toBe(400);
    const stat = (await request('/api/stats', 'POST', { name: 'Focus', color: '#123456' })).body;
    expect(stat.points).toBe(0);
    expect(stat.icon).toBe('Sparkles');
    expect((await request(`/api/stats/${stat.id}`, 'PATCH', { name: 'Deep focus' })).body.name).toBe('Deep focus');
    const habit = (await request('/api/habits', 'POST', { name: 'Stretch', kind: 'check', statId: stat.id, points: 5 })).body;
    expect(habit.description).toBe('');
    const archived = await request(`/api/habits/${habit.id}`, 'PATCH', { archived: true });
    expect(archived.body.archived).toBe(true);
    expect((await request('/api/state')).body.habits.some((item: any) => item.id === habit.id)).toBe(true);
  });

  it('rejects kind conversion when historical completed entries cannot satisfy the new kind', async () => {
    await request(`/api/entries/read-20-minutes/${today()}`, 'PUT', { completed: true });
    const response = await request('/api/habits/read-20-minutes', 'PATCH', { kind: 'journal' });
    expect(response.response.status).toBe(400);
    expect(response.body.error).toMatch(/completed entries have no journal text/);
    const backup = (await request('/api/backup')).body;
    expect((await request('/api/backup', 'POST', backup)).response.status).toBe(200);
  });

  it('blocks cross-origin requests but allows origin-less CLI and same-host writes', async () => {
    expect((await request('/api/state', 'GET', undefined, 'https://attacker.invalid')).response.status).toBe(403);
    expect((await request('/api/state', 'GET', undefined, baseUrl)).response.status).toBe(200);
    expect((await request('/api/state', 'GET', undefined, 'http://localhost:5173')).response.status).toBe(200);
    expect((await request('/api/state')).response.status).toBe(200);
    const denied = await request('/api/stats', 'POST', { name: 'bad', color: 'red' }, 'https://attacker.invalid');
    expect(denied.response.status).toBe(403);
    expect(denied.body).toEqual({ error: 'Cross-origin requests are not allowed' });
  });

  it('uses the configured public origin behind an HTTP reverse proxy without trusting forwarded headers', async () => {
    const configuredServer = createServer(createApp({ database: db, publicOrigin: 'https://phantom.example.com', auth: { username: 'owner', password: 'correct-horse' } }).app);
    await new Promise<void>((resolve) => configuredServer.listen(0, '127.0.0.1', resolve));
    const address = configuredServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const url = `http://127.0.0.1:${address.port}`;
    const write = (origin: string, extraHeaders: Record<string, string> = {}) => fetch(`${url}/api/stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: sessionCookie, ...extraHeaders },
      body: JSON.stringify({ name: 'Proxy stat', color: '#123456' }),
    });

    try {
      expect((await write('https://phantom.example.com')).status).toBe(201);
      expect((await write('https://wrong.example')).status).toBe(403);
      expect((await write('null')).status).toBe(403);
      expect((await write('https://wrong.example', {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'phantom.example.com',
      })).status).toBe(403);
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => configuredServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects invalid configured public origins when creating the app', () => {
    for (const publicOrigin of [
      'ftp://phantom.example.com',
      'https://user:pass@phantom.example.com',
      'https://phantom.example.com/path',
      'https://phantom.example.com?query=1',
      'https://phantom.example.com#fragment',
    ]) {
      expect(() => createApp({ database: db, publicOrigin, auth: { username: 'owner', password: 'correct-horse' } })).toThrow(/PUBLIC_ORIGIN/);
    }
  });

  it('returns a JSON API 404 for unknown endpoints', async () => {
    const { response, body } = await request('/api/no-such-endpoint');
    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'API route not found' });
  });

  it('backs up and transactionally restores records while ignoring forged totals', async () => {
    await request(`/api/entries/read-20-minutes/${today()}`, 'PUT', { completed: true });
    const backup = (await request('/api/backup')).body;
    expect(backup.version).toBe(1);
    backup.stats.find((item: any) => item.id === 'knowledge').points = 999999;
    await request('/api/habits/read-20-minutes', 'PATCH', { archived: true });
    const restored = await request('/api/backup', 'POST', backup);
    expect(restored.response.status).toBe(200);
    expect(restored.body.stats.find((item: any) => item.id === 'knowledge').points).toBe(10);
    expect(restored.body.habits.find((item: any) => item.id === 'read-20-minutes').archived).toBe(false);
    const invalid = structuredClone(backup);
    invalid.habits[0].statId = 'missing-stat';
    expect((await request('/api/backup', 'POST', invalid)).response.status).toBe(400);
    expect((await request('/api/state')).body.stats.find((item: any) => item.id === 'knowledge').points).toBe(10);

    const changedConfig = structuredClone(backup);
    changedConfig.habits[0].statId = 'guts';
    changedConfig.habits[0].points = 1;
    const restoredHistorical = await request('/api/backup', 'POST', changedConfig);
    expect(restoredHistorical.body.stats.find((item: any) => item.id === 'knowledge').points).toBe(10);
    expect(restoredHistorical.body.stats.find((item: any) => item.id === 'guts').points).toBe(0);
    const undo = await request(`/api/entries/read-20-minutes/${today()}`, 'PUT', { completed: false });
    expect(undo.body.entry.statId).toBe('knowledge');
    expect((await request('/api/state')).body.stats.find((item: any) => item.id === 'knowledge').points).toBe(0);
  });

  it('allows larger validated backup bodies but retains API JSON size limits', async () => {
    const backup = (await request('/api/backup')).body;
    backup.stats.push({ id: 'long-stat', name: 'Long stat', color: '#222222', icon: 'Sparkles', points: 0 });
    const oversizedField = 'x'.repeat(110_000);
    backup.habits[0].description = oversizedField;
    const response = await fetch(`${baseUrl}/api/backup`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie }, body: JSON.stringify(backup),
    });
    expect(response.status).toBe(400); // larger body limit does not bypass field bounds
    const tooLarge = await fetch(`${baseUrl}/api/backup`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie }, body: JSON.stringify({ version: 1, payload: 'x'.repeat(10_500_000) }),
    });
    expect(tooLarge.status).toBe(413);
    const ordinaryTooLarge = await fetch(`${baseUrl}/api/stats`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie }, body: JSON.stringify({ name: 'x'.repeat(110_000), color: '#000' }),
    });
    expect(ordinaryTooLarge.status).toBe(413);
  });

  it('persists data across database reopen and seeds only an empty store', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = mkdtempSync(join(tmpdir(), 'persona-test-'));
    const filename = join(directory, 'data.sqlite');
    try {
      const firstDb = createDatabase(filename);
      const firstServer = createServer(createApp({ database: firstDb, auth: { username: 'owner', password: 'correct-horse' } }).app);
      await new Promise<void>((resolve) => firstServer.listen(0, '127.0.0.1', resolve));
      const address = firstServer.address() as { port: number };
      const login = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct-horse' }) });
      const response = await fetch(`http://127.0.0.1:${address.port}/api/entries/read-20-minutes/${today()}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: login.headers.get('set-cookie')!.split(';')[0] }, body: JSON.stringify({ completed: true }),
      });
      expect(response.status).toBe(200);
      await new Promise<void>((resolve) => firstServer.close(() => resolve()));
      firstDb.close();
      const reopened = createDatabase(filename);
      expect((reopened.prepare('SELECT COUNT(*) AS count FROM entries').get() as { count: number }).count).toBe(1);
      expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
