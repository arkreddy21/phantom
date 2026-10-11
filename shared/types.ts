export type Stat = {
  id: string;
  name: string;
  color: string;
  icon: string;
  points: number;
};

export type Habit = {
  id: string;
  name: string;
  description: string;
  kind: 'check' | 'journal';
  statId: string;
  points: number;
  prompt: string;
  archived: boolean;
  createdAt: string;
};

export type DailyEntry = {
  id: string;
  habitId: string;
  date: string;
  completed: boolean;
  content: string;
  good: string;
  bad: string;
  improve: string;
  sleepHours: number | null;
  healthNotes: string;
  awardedPoints: number;
  statId: string;
  updatedAt: string;
};

export type AppState = {
  stats: Stat[];
  habits: Habit[];
  entries: DailyEntry[];
};

export type Reward = {
  statId: string;
  statName: string;
  points: number;
};
