import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase } from '../../server/database.js';

describe('server API', () => {
  let db: ReturnType<typeof createDatabase>;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    server = createServer(createApp({ database: db }).app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
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
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup),
    });
    expect(response.status).toBe(400); // larger body limit does not bypass field bounds
    const tooLarge = await fetch(`${baseUrl}/api/backup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, payload: 'x'.repeat(10_500_000) }),
    });
    expect(tooLarge.status).toBe(413);
    const ordinaryTooLarge = await fetch(`${baseUrl}/api/stats`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(110_000), color: '#000' }),
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
      const firstServer = createServer(createApp({ database: firstDb }).app);
      await new Promise<void>((resolve) => firstServer.listen(0, '127.0.0.1', resolve));
      const address = firstServer.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/entries/read-20-minutes/${today()}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: true }),
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
