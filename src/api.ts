import type { AppState, DailyEntry, Habit, Reward, Stat } from '../shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let message = `Something went wrong (${response.status}).`;
    try { message = (await response.json()).error || message; } catch { /* use fallback */ }
    throw new Error(message);
  }
  return response.json();
}

export const api = {
  state: () => request<AppState>('/api/state'),
  saveEntry: (habitId: string, date: string, body: Partial<DailyEntry> & { completed: boolean }) =>
    request<{ entry: DailyEntry; reward: Reward | null }>(`/api/entries/${encodeURIComponent(habitId)}/${date}`, { method: 'PUT', body: JSON.stringify(body) }),
  addHabit: (body: Pick<Habit, 'name' | 'kind' | 'statId' | 'points'> & Partial<Pick<Habit, 'description' | 'prompt'>>) =>
    request<Habit>('/api/habits', { method: 'POST', body: JSON.stringify(body) }),
  editHabit: (id: string, body: Partial<Pick<Habit, 'name' | 'description' | 'kind' | 'statId' | 'points' | 'prompt' | 'archived'>>) =>
    request<Habit>(`/api/habits/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  addStat: (body: Pick<Stat, 'name' | 'color'> & Partial<Pick<Stat, 'icon'>>) =>
    request<Stat>('/api/stats', { method: 'POST', body: JSON.stringify(body) }),
  editStat: (id: string, body: Partial<Pick<Stat, 'name' | 'color' | 'icon'>>) =>
    request<Stat>(`/api/stats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
};
