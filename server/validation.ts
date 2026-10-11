import { z } from 'zod';

const shortText = (max: number) => z.string().trim().max(max);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const colorSchema = z.string().regex(/^#[\da-fA-F]{6}$/, 'Color must be a 6-digit hex value');

export const habitCreateSchema = z.object({
  name: requiredText(100),
  description: shortText(500).optional().default(''),
  kind: z.enum(['check', 'journal']),
  statId: requiredText(100),
  points: z.number().int().min(1).max(100),
  prompt: shortText(500).optional().default(''),
}).strict();

export const habitPatchSchema = z.object({
  name: requiredText(100).optional(),
  description: shortText(500).optional(),
  kind: z.enum(['check', 'journal']).optional(),
  statId: requiredText(100).optional(),
  points: z.number().int().min(1).max(100).optional(),
  prompt: shortText(500).optional(),
  archived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const statCreateSchema = z.object({
  name: requiredText(80),
  color: colorSchema,
  icon: requiredText(80).optional().default('Sparkles'),
}).strict();

export const statPatchSchema = z.object({
  name: requiredText(80).optional(),
  color: colorSchema.optional(),
  icon: requiredText(80).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const entryUpdateSchema = z.object({
  completed: z.boolean(),
  content: shortText(10_000).optional().default(''),
  good: shortText(2_000).optional().default(''),
  bad: shortText(2_000).optional().default(''),
  improve: shortText(2_000).optional().default(''),
  sleepHours: z.number().min(0).max(24).nullable().optional().default(null),
  healthNotes: shortText(2_000).optional().default(''),
}).strict();

const id = requiredText(100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}, 'Invalid calendar date');

export const backupSchema = z.object({
  version: z.literal(1),
  stats: z.array(z.object({
    id,
    name: requiredText(80),
    color: colorSchema,
    icon: requiredText(80),
    points: z.number().int().min(0),
  }).strict()),
  habits: z.array(z.object({
    id,
    name: requiredText(100),
    description: shortText(500),
    kind: z.enum(['check', 'journal']),
    statId: id,
    points: z.number().int().min(1).max(100),
    prompt: shortText(500),
    archived: z.boolean(),
    createdAt: z.string().datetime(),
  }).strict()),
  entries: z.array(z.object({
    id,
    habitId: id,
    date: isoDate,
    completed: z.boolean(),
    content: shortText(10_000),
    good: shortText(2_000),
    bad: shortText(2_000),
    improve: shortText(2_000),
    sleepHours: z.number().min(0).max(24).nullable(),
    healthNotes: shortText(2_000),
    awardedPoints: z.number().int().min(0).max(100),
    statId: id,
    updatedAt: z.string().datetime(),
  }).strict().refine((entry) => entry.completed ? entry.awardedPoints > 0 : entry.awardedPoints === 0,
    'Completed entries must have an award and incomplete entries must not')), 
}).strict().superRefine((backup, context) => {
  const unique = (values: string[], label: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) context.addIssue({ code: z.ZodIssueCode.custom, path: [label, index, 'id'], message: 'Duplicate id' });
      seen.add(value);
    });
  };
  unique(backup.stats.map((item) => item.id), 'stats');
  unique(backup.habits.map((item) => item.id), 'habits');
  unique(backup.entries.map((item) => item.id), 'entries');
  const statIds = new Set(backup.stats.map((item) => item.id));
  const habitsById = new Map(backup.habits.map((item) => [item.id, item]));
  const habitIds = new Set(habitsById.keys());
  backup.habits.forEach((habit, index) => {
    if (!statIds.has(habit.statId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['habits', index, 'statId'], message: 'Unknown stat' });
  });
  const entryKeys = new Set<string>();
  backup.entries.forEach((entry, index) => {
    if (!habitIds.has(entry.habitId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'habitId'], message: 'Unknown habit' });
    if (!statIds.has(entry.statId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'statId'], message: 'Unknown stat' });
    const habit = habitsById.get(entry.habitId);
    if (entry.completed && (!habit || entry.awardedPoints < 1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'awardedPoints'], message: 'Completed entries require an award snapshot' });
    }
    if (entry.completed && habit?.kind === 'journal' && entry.content.trim().length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'content'], message: 'Completed journals require nonempty content' });
    }
    const key = `${entry.habitId}\0${entry.date}`;
    if (entryKeys.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index], message: 'Duplicate habit/date entry' });
    entryKeys.add(key);
    if (entry.date > localDateString()) context.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'date'], message: 'Future dates are not allowed' });
  });
});

export function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export { isoDate };
