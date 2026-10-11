export const localDate = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const parseDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};

export const shiftDate = (value: string, amount: number) => {
  const date = parseDate(value);
  date.setDate(date.getDate() + amount);
  return localDate(date);
};

export const prettyDate = (value: string, options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }) =>
  parseDate(value).toLocaleDateString(undefined, options);

export const monthKey = (value: string) => value.slice(0, 7);
export const monthTitle = (year: number, month: number) => new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export function monthDays(year: number, month: number) {
  const count = new Date(year, month + 1, 0).getDate();
  const offset = new Date(year, month, 1).getDay();
  return { count, offset };
}
