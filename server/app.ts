import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { DailyEntry, Habit, Reward, Stat } from '../shared/types.js';
import { createDatabase, readBackup, readState, restoreBackup } from './database.js';
import { entryUpdateSchema, habitCreateSchema, habitPatchSchema, isoDate, localDateString, statCreateSchema, statPatchSchema } from './validation.js';

type AppOptions = { database?: DatabaseSync; databasePath?: string; production?: boolean; clientDirectory?: string; publicOrigin?: string };

export function createApp(options: AppOptions = {}) {
  const publicOrigin = options.publicOrigin === undefined ? undefined : normalizePublicOrigin(options.publicOrigin);
  const db = options.database ?? createDatabase(options.databasePath ?? './data/persona.sqlite');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (publicOrigin !== undefined) {
          if (normalizePublicOrigin(origin) !== publicOrigin) {
            return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
          }
          return next();
        }
        const requestUrl = new URL(`${req.protocol}://${req.get('host')}`);
        const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
        const developmentProxy = !options.production &&
          localHosts.has(originUrl.hostname.toLowerCase()) && localHosts.has(requestUrl.hostname.toLowerCase()) &&
          originUrl.port === '5173';
        if ((!developmentProxy && originUrl.host.toLowerCase() !== requestUrl.host.toLowerCase()) ||
            originUrl.protocol !== requestUrl.protocol) {
          return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
        }
      } catch {
        return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      }
    }
    next();
  });
  app.use((req, res, next) => {
    const limit = req.path === '/api/backup' && req.method === 'POST' ? '10mb' : '100kb';
    express.json({ limit, strict: true })(req, res, next);
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/state', (_req, res) => res.json(readState(db)));
  app.get('/api/backup', (_req, res) => res.json(readBackup(db)));
  app.post('/api/backup', (req, res, next) => {
    try {
      restoreBackup(db, req.body);
      res.json(readBackup(db));
    } catch (error) { next(error); }
  });

  app.post('/api/habits', (req, res, next) => {
    try {
      const input = habitCreateSchema.parse(req.body);
      if (!exists(db, 'stats', input.statId)) return res.status(400).json({ error: 'Unknown statId' });
      const habit: Habit = {
        id: randomUUID(), ...input, archived: false, createdAt: new Date().toISOString(),
      };
      db.prepare(`INSERT INTO habits (id, name, description, kind, stat_id, points, prompt, archived, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(habit.id, habit.name, habit.description, habit.kind,
        habit.statId, habit.points, habit.prompt, habit.createdAt);
      res.status(201).json(habit);
    } catch (error) { next(error); }
  });
  app.patch('/api/habits/:id', (req, res, next) => {
    try {
      const input = habitPatchSchema.parse(req.body);
      const current = db.prepare(`SELECT id, name, description, kind, stat_id AS statId, points, prompt,
        archived, created_at AS createdAt FROM habits WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
      if (!current) return res.status(404).json({ error: 'Habit not found' });
      if (input.kind === 'journal' && current.kind !== 'journal') {
        const incompatible = db.prepare(`SELECT 1 FROM entries
          WHERE habit_id = ? AND completed = 1 AND TRIM(content) = '' LIMIT 1`).get(req.params.id);
        if (incompatible) return res.status(400).json({ error: 'Cannot convert to a journal while completed entries have no journal text' });
      }
      const updated = { ...current, ...input, archived: input.archived ?? Boolean(current.archived), statId: input.statId ?? current.statId } as Record<string, unknown>;
      if (!exists(db, 'stats', String(updated.statId))) return res.status(400).json({ error: 'Unknown statId' });
      db.prepare(`UPDATE habits SET name = ?, description = ?, kind = ?, stat_id = ?, points = ?, prompt = ?, archived = ? WHERE id = ?`)
        .run(updated.name as string, updated.description as string, updated.kind as string, updated.statId as string,
          updated.points as number, updated.prompt as string, Number(updated.archived), updated.id as string);
      res.json({ ...updated, archived: Boolean(updated.archived) });
    } catch (error) { next(error); }
  });

  app.post('/api/stats', (req, res, next) => {
    try {
      const input = statCreateSchema.parse(req.body);
      const stat: Stat = { id: randomUUID(), ...input, points: 0 };
      db.prepare('INSERT INTO stats (id, name, color, icon) VALUES (?, ?, ?, ?)').run(stat.id, stat.name, stat.color, stat.icon);
      res.status(201).json(stat);
    } catch (error) { next(error); }
  });
  app.patch('/api/stats/:id', (req, res, next) => {
    try {
      const input = statPatchSchema.parse(req.body);
      const current = db.prepare(`SELECT s.id, s.name, s.color, s.icon, COALESCE(SUM(e.awarded_points), 0) AS points
        FROM stats s LEFT JOIN entries e ON e.stat_id = s.id WHERE s.id = ? GROUP BY s.id`).get(req.params.id) as Stat | undefined;
      if (!current) return res.status(404).json({ error: 'Stat not found' });
      const updated = { ...current, ...input };
      db.prepare('UPDATE stats SET name = ?, color = ?, icon = ? WHERE id = ?').run(updated.name, updated.color, updated.icon, updated.id);
      res.json({ ...updated, points: Number(updated.points) });
    } catch (error) { next(error); }
  });

  app.put('/api/entries/:habitId/:date', (req, res, next) => {
    try {
      const { habitId, date } = req.params;
      if (!isoDate.safeParse(date).success) return res.status(400).json({ error: 'Invalid date; expected YYYY-MM-DD' });
      if (date > localDateString()) return res.status(400).json({ error: 'Future dates are not allowed' });
      const input = entryUpdateSchema.parse(req.body);
      const habit = db.prepare('SELECT id, kind, stat_id AS statId, points FROM habits WHERE id = ?').get(habitId) as { id: string; kind: 'check' | 'journal'; statId: string; points: number } | undefined;
      if (!habit) return res.status(404).json({ error: 'Habit not found' });
      const existing = db.prepare(`SELECT id, completed, awarded_points AS awardedPoints, stat_id AS statId,
        content, good, bad, improve, sleep_hours AS sleepHours, health_notes AS healthNotes
        FROM entries WHERE habit_id = ? AND date = ?`).get(habitId, date) as {
          id: string; completed: number; awardedPoints: number; statId: string; content: string; good: string;
          bad: string; improve: string; sleepHours: number | null; healthNotes: string;
        } | undefined;
      const content = req.body.content === undefined ? String(existing?.content ?? '') : input.content;
      if (input.completed && habit.kind === 'journal' && content.trim().length === 0) {
        return res.status(400).json({ error: 'Journal entries require nonempty content before completion' });
      }
      const wasCompleted = Boolean(existing?.completed);
      const awarding = input.completed && !wasCompleted;
      const awardedPoints = input.completed ? (wasCompleted ? Number(existing!.awardedPoints) : Number(habit.points)) : 0;
      const statId = awarding ? habit.statId : (existing?.statId ?? habit.statId);
      const now = new Date().toISOString();
      const entry: DailyEntry = {
        id: existing?.id ?? randomUUID(), habitId, date, completed: input.completed,
        content,
        good: req.body.good === undefined ? String(existing?.good ?? '') : input.good,
        bad: req.body.bad === undefined ? String(existing?.bad ?? '') : input.bad,
        improve: req.body.improve === undefined ? String(existing?.improve ?? '') : input.improve,
        sleepHours: req.body.sleepHours === undefined ? (existing?.sleepHours === null || existing?.sleepHours === undefined ? null : Number(existing.sleepHours)) : input.sleepHours,
        healthNotes: req.body.healthNotes === undefined ? String(existing?.healthNotes ?? '') : input.healthNotes,
        awardedPoints, statId, updatedAt: now,
      };
      db.prepare(`INSERT INTO entries (id, habit_id, date, completed, content, good, bad, improve, sleep_hours,
        health_notes, awarded_points, stat_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(habit_id, date) DO UPDATE SET completed = excluded.completed, content = excluded.content,
        good = excluded.good, bad = excluded.bad, improve = excluded.improve, sleep_hours = excluded.sleep_hours,
        health_notes = excluded.health_notes, awarded_points = excluded.awarded_points, stat_id = excluded.stat_id,
        updated_at = excluded.updated_at`).run(entry.id, entry.habitId, entry.date, Number(entry.completed), entry.content,
        entry.good, entry.bad, entry.improve, entry.sleepHours, entry.healthNotes, entry.awardedPoints, entry.statId, entry.updatedAt);
      const stat = db.prepare('SELECT name FROM stats WHERE id = ?').get(entry.statId) as { name: string };
      const reward: Reward | null = awarding ? { statId, statName: stat.name, points: awardedPoints } : null;
      res.json({ entry, reward });
    } catch (error) { next(error); }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));

  if (options.production) {
    const clientDirectory = options.clientDirectory ?? fileURLToPath(new URL('../../client/', import.meta.url));
    app.use(express.static(clientDirectory));
    app.get('*path', (_req, res) => res.sendFile('index.html', { root: clientDirectory }));
  }

  const errorHandler: ErrorRequestHandler = (error: unknown, _req: Request, res: Response, _next) => {
    if (res.headersSent) return;
    const candidate = error as { status?: number; statusCode?: number; type?: string; issues?: unknown; message?: string; name?: string };
    if (candidate?.issues) return res.status(400).json({ error: 'Invalid request data' });
    if (candidate?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body exceeds configured limit' });
    if (candidate?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (candidate?.status === 400 || candidate?.statusCode === 400) return res.status(400).json({ error: 'Invalid request' });
    const databaseError = error instanceof Error && error.message.includes('FOREIGN KEY constraint failed');
    if (databaseError) return res.status(400).json({ error: 'Referenced record does not exist' });
    console.error('Request failed:', candidate?.message ?? 'unknown error');
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);
  return { app, db };
}

function normalizePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an http or https origin');
  }
  if (value !== value.trim() || !/^https?:\/\/[^/?#]+\/?$/i.test(value) ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password ||
      (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('PUBLIC_ORIGIN must be an http or https origin with no credentials, path, query, or fragment');
  }
  return url.origin;
}

function exists(db: DatabaseSync, table: 'stats' | 'habits', id: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
}
