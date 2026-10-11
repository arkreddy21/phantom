import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppState, DailyEntry, Habit, Stat } from '../shared/types.js';
import { backupSchema } from './validation.js';

type SqliteDatabase = DatabaseSync;
const { DatabaseSync: SqliteConstructor } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const seedStats = [
  { id: 'knowledge', name: 'Knowledge', color: '#7c6cf2', icon: 'BookOpen' },
  { id: 'charm', name: 'Charm', color: '#ec6e9b', icon: 'Heart' },
  { id: 'health', name: 'Health', color: '#4caf8b', icon: 'Activity' },
  { id: 'kindness', name: 'Kindness', color: '#e9a844', icon: 'Sun' },
  { id: 'guts', name: 'Guts', color: '#e66c5c', icon: 'Flame' },
];

const seedHabits = [
  { id: 'read-20-minutes', name: 'Read 20 minutes', description: '', kind: 'check', statId: 'knowledge', points: 10, prompt: '' },
  { id: 'skin-care', name: 'Skin care', description: '', kind: 'check', statId: 'charm', points: 10, prompt: '' },
  { id: 'move-your-body', name: 'Move your body', description: '', kind: 'check', statId: 'health', points: 10, prompt: '' },
  { id: 'gratitude', name: 'Gratitude', description: '', kind: 'journal', statId: 'kindness', points: 10, prompt: 'What are you grateful for today?' },
  { id: 'sleep-check-in', name: 'Sleep check-in', description: '', kind: 'journal', statId: 'health', points: 10, prompt: 'How did you sleep?' },
];

export function createDatabase(filename: string): SqliteDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new SqliteConstructor(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    migrate(db);
    seedIfEmpty(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: SqliteDatabase): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > 1) throw new Error('Database schema is newer than this application supports');
  if (version === 1) return;
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE stats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      icon TEXT NOT NULL
    );
    CREATE TABLE habits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('check', 'journal')),
      stat_id TEXT NOT NULL REFERENCES stats(id),
      points INTEGER NOT NULL CHECK (points BETWEEN 1 AND 100),
      prompt TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL REFERENCES habits(id),
      date TEXT NOT NULL,
      completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
      content TEXT NOT NULL DEFAULT '',
      good TEXT NOT NULL DEFAULT '',
      bad TEXT NOT NULL DEFAULT '',
      improve TEXT NOT NULL DEFAULT '',
      sleep_hours REAL,
      health_notes TEXT NOT NULL DEFAULT '',
      awarded_points INTEGER NOT NULL DEFAULT 0 CHECK (awarded_points BETWEEN 0 AND 100),
      stat_id TEXT NOT NULL REFERENCES stats(id),
      updated_at TEXT NOT NULL,
      UNIQUE(habit_id, date),
      CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 0 AND 24),
      CHECK ((completed = 1 AND awarded_points > 0) OR (completed = 0 AND awarded_points = 0))
    );
    CREATE INDEX entries_by_date ON entries(date);
    PRAGMA user_version = 1;
    COMMIT;
  `);
}

function seedIfEmpty(db: SqliteDatabase): void {
  const statsCount = Number((db.prepare('SELECT COUNT(*) AS count FROM stats').get() as { count: number }).count);
  const habitsCount = Number((db.prepare('SELECT COUNT(*) AS count FROM habits').get() as { count: number }).count);
  if (statsCount !== 0 || habitsCount !== 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertStat = db.prepare('INSERT INTO stats (id, name, color, icon) VALUES (?, ?, ?, ?)');
    for (const stat of seedStats) insertStat.run(stat.id, stat.name, stat.color, stat.icon);
    const insertHabit = db.prepare(`INSERT INTO habits
      (id, name, description, kind, stat_id, points, prompt, archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`);
    const createdAt = new Date().toISOString();
    for (const habit of seedHabits) {
      insertHabit.run(habit.id, habit.name, habit.description, habit.kind, habit.statId, habit.points, habit.prompt, createdAt);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readState(db: SqliteDatabase): AppState {
  const statsRows = db.prepare(`SELECT s.id, s.name, s.color, s.icon,
    COALESCE(SUM(e.awarded_points), 0) AS points
    FROM stats s LEFT JOIN entries e ON e.stat_id = s.id
    GROUP BY s.id ORDER BY s.rowid`).all() as Array<Stat>;
  const habits = db.prepare(`SELECT id, name, description, kind, stat_id AS statId, points, prompt,
    archived, created_at AS createdAt FROM habits ORDER BY rowid`).all() as Array<Record<string, unknown>>;
  const entries = db.prepare(`SELECT id, habit_id AS habitId, date, completed, content, good, bad, improve,
    sleep_hours AS sleepHours, health_notes AS healthNotes, awarded_points AS awardedPoints,
    stat_id AS statId, updated_at AS updatedAt FROM entries ORDER BY date DESC, rowid`).all() as Array<Record<string, unknown>>;
  return {
    stats: statsRows.map((row) => ({ ...row, points: Number(row.points) })),
    habits: habits.map((row) => ({ ...row, archived: Boolean(row.archived) })) as unknown as Habit[],
    entries: entries.map((row) => ({ ...row, completed: Boolean(row.completed), sleepHours: row.sleepHours === null ? null : Number(row.sleepHours), awardedPoints: Number(row.awardedPoints) })) as unknown as DailyEntry[],
  };
}

export function readBackup(db: SqliteDatabase): { version: 1 } & AppState {
  return { version: 1, ...readState(db) };
}

export function restoreBackup(db: SqliteDatabase, input: unknown): void {
  const backup = backupSchema.parse(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM entries; DELETE FROM habits; DELETE FROM stats;');
    const insertStat = db.prepare('INSERT INTO stats (id, name, color, icon) VALUES (?, ?, ?, ?)');
    for (const stat of backup.stats) insertStat.run(stat.id, stat.name, stat.color, stat.icon);
    const insertHabit = db.prepare(`INSERT INTO habits
      (id, name, description, kind, stat_id, points, prompt, archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const habit of backup.habits) insertHabit.run(habit.id, habit.name, habit.description, habit.kind, habit.statId,
      habit.points, habit.prompt, Number(habit.archived), habit.createdAt);
    const insertEntry = db.prepare(`INSERT INTO entries
      (id, habit_id, date, completed, content, good, bad, improve, sleep_hours, health_notes, awarded_points, stat_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const entry of backup.entries) insertEntry.run(entry.id, entry.habitId, entry.date, Number(entry.completed),
      entry.content, entry.good, entry.bad, entry.improve, entry.sleepHours, entry.healthNotes, entry.awardedPoints,
      entry.statId, entry.updatedAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function databasePathFromEnvironment(): string {
  const dataDir = process.env.DATA_DIR || './data';
  return resolve(dataDir, 'persona.sqlite');
}
