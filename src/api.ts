import type { AppState, DailyEntry, Habit, Reward, Stat } from '../shared/types';

export type AuthUser = { id: string; username: string };

let requestEpoch = 0;
export function authEpoch() { return requestEpoch; }
export function bumpAuthEpoch() { requestEpoch++; }

function reportUnauthorized(response: Response, epoch: number, notify = true) {
  if (response.status === 401 && notify) window.dispatchEvent(new CustomEvent('phantom:unauthorized', { detail: { epoch } }));
}

async function request<T>(url: string, init?: RequestInit, notifyUnauthorized = true): Promise<T> {
  const epoch = authEpoch();
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  reportUnauthorized(response, epoch, notifyUnauthorized);
  if (!response.ok) {
    let message = `Something went wrong (${response.status}).`;
    try { message = (await response.json()).error || message; } catch { /* use fallback */ }
    throw new Error(message);
  }
  return response.json();
}

export const api = {
  session: () => request<{ user: AuthUser | null }>('/api/auth/session', undefined, false),
  login: (username: string, password: string) => request<{ user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }, false),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }, false),
  backup: async (method: 'GET' | 'POST', body?: unknown) => {
    const epoch = authEpoch();
    const response = await fetch('/api/backup', { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    reportUnauthorized(response, epoch);
    return response;
  },
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
