import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, Archive, ArrowDown, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, Edit3, FileText, LoaderCircle, LockKeyhole, Menu, Moon, MoreHorizontal, Plus, Settings2, ShieldCheck, Sparkles, Volume2, VolumeX, X } from 'lucide-react';
import type { AppState, DailyEntry, Habit, Reward, Stat } from '../shared/types';
import { api } from './api';
import { localDate, monthDays, monthKey, monthTitle, prettyDate, shiftDate } from './dates';

type View = 'today' | 'archive' | 'stats';
const blankState: AppState = { stats: [], habits: [], entries: [] };
const statGlyphs: Record<string, string> = { knowledge: '✦', charm: '♡', health: '✚', kindness: '✿', guts: '✹' };
const defaultColor = '#ff3048';

function iconFor(stat: Stat) { return statGlyphs[stat.name.toLowerCase()] || stat.icon || '✦'; }

function useSound(enabled: boolean) {
  return useCallback(() => {
    if (!enabled) return;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      void context.resume();
      [659.25, 783.99, 987.77].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = index === 2 ? 'triangle' : 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, context.currentTime + index * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.11, context.currentTime + index * 0.09 + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + index * 0.09 + 0.22);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(context.currentTime + index * 0.09);
        oscillator.stop(context.currentTime + index * 0.09 + 0.24);
      });
      window.setTimeout(() => void context.close(), 650);
    } catch { /* audio is a small enhancement, never a blocker */ }
  }, [enabled]);
}

function Dialog({ title, eyebrow, children, onClose, className = '' }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; className?: string }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary') || [])
        .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) { event.preventDefault(); closeRef.current?.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!panelRef.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); before?.focus(); };
  }, []);
  return <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="dialog-title" className={`dialog ${className}`}>
      <button ref={closeRef} className="dialog-close icon-button" onClick={onClose} aria-label="Close dialog"><X size={19}/></button>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h2 id="dialog-title">{title}</h2>
      {children}
    </section>
  </div>;
}

function StatMark({ stat, size = 'normal' }: { stat: Stat; size?: 'normal' | 'large' }) {
  return <span className={`stat-mark ${size}`} style={{ '--stat': stat.color } as React.CSSProperties} aria-hidden="true"><svg viewBox="0 0 100 100"><path d="M50 3 61 36 96 28 72 51 94 77 61 67 50 98 39 67 6 77 28 51 4 28 39 36Z"/><circle cx="50" cy="51" r="12"/></svg><i>{iconFor(stat)}</i></span>;
}

function App() {
  const [data, setData] = useState<AppState>(blankState);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('today');
  const [selectedDate, setSelectedDate] = useState(localDate());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [entryError, setEntryError] = useState('');
  const [reward, setReward] = useState<Reward | null>(null);
  const [sound, setSound] = useState(() => localStorage.getItem('phantom-sound') !== 'off');
  const [reducedMotion, setReducedMotion] = useState(() => {
    const saved = localStorage.getItem('phantom-motion');
    return saved === null ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : saved === 'reduce';
  });
  const [dialog, setDialog] = useState<'habit' | 'stat' | 'settings' | null>(null);
  const [editingHabit, setEditingHabit] = useState<Habit | null>(null);
  const [editingStat, setEditingStat] = useState<Stat | null>(null);
  const [activeEntry, setActiveEntry] = useState<{ habit: Habit; date: string } | null>(null);
  const [archiveMonth, setArchiveMonth] = useState(() => monthKey(localDate()));
  const [archiveHabit, setArchiveHabit] = useState<string>('all');
  const [mobileNav, setMobileNav] = useState(false);
  const playReward = useSound(sound);
  const today = localDate();

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setLoadError('');
    try { setData(await api.state()); }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not connect to your day.'); }
    finally { if (initial) setLoading(false); }
  }, []);
  useEffect(() => { void load(true); }, [load]);

  const entriesByKey = useMemo(() => new Map(data.entries.map(entry => [`${entry.habitId}:${entry.date}`, entry])), [data.entries]);
  const visibleHabits = useMemo(() => data.habits.filter(h => !h.archived), [data.habits]);
  const activeDateEntries = visibleHabits.map(h => entriesByKey.get(`${h.id}:${selectedDate}`)).filter(Boolean) as DailyEntry[];
  const completeCount = activeDateEntries.filter(e => e.completed).length;
  const doneHabits = visibleHabits.filter(h => entriesByKey.get(`${h.id}:${selectedDate}`)?.completed);
  const progress = visibleHabits.length ? Math.round(doneHabits.length / visibleHabits.length * 100) : 0;
  const statPoints = useMemo(() => data.stats.map(stat => ({ ...stat, total: data.entries.filter(entry => entry.statId === stat.id).reduce((sum, entry) => sum + (entry.awardedPoints || 0), 0) })), [data]);
  const sortedHabits = useMemo(() => [...visibleHabits].sort((a, b) => Number(b.kind === 'journal') - Number(a.kind === 'journal')), [visibleHabits]);

  const setSoundPref = (value: boolean) => { setSound(value); localStorage.setItem('phantom-sound', value ? 'on' : 'off'); };
  const setMotionPref = (value: boolean) => { setReducedMotion(value); localStorage.setItem('phantom-motion', value ? 'reduce' : 'full'); };
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('user-reduced-motion', reducedMotion);
    root.classList.toggle('user-motion-override', localStorage.getItem('phantom-motion') !== null);
  }, [reducedMotion]);
  const navigateDate = (value: string) => { if (value <= today) setSelectedDate(value); };

  async function submitEntry(habit: Habit, date: string, body: Partial<DailyEntry> & { completed: boolean }) {
    const key = `entry:${habit.id}`;
    if (busy) return;
    setBusy(key); setError(''); setEntryError('');
    try {
      const result = await api.saveEntry(habit.id, date, body);
      await load();
      if (result.reward) {
        if (habit.kind === 'journal') setActiveEntry(null);
        setReward(result.reward); playReward();
      }
      if (activeEntry && activeEntry.habit.id === habit.id && !result.reward) setActiveEntry({ habit, date });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save this entry.';
      if (activeEntry?.habit.id === habit.id) setEntryError(message); else setError(message);
    }
    finally { setBusy(null); }
  }

  function openEntry(habit: Habit, date = selectedDate) { setActiveEntry({ habit, date }); }

  const headerDate = prettyDate(selectedDate, { weekday: 'long', month: 'long', day: 'numeric' });

  return <div className="app-shell">
    <div className="grain" aria-hidden="true" />
    <header className="topbar">
      <a className="brand" href="#today" onClick={e => { e.preventDefault(); setView('today'); }} aria-label="Phantom home"><span className="brand-mark">P</span><span>PHANTOM<span className="brand-period">.</span></span><small>DAILY PRACTICE</small></a>
      <button className="mobile-menu icon-button" onClick={() => setMobileNav(!mobileNav)} aria-label={mobileNav ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileNav}><Menu/></button>
      <nav className={`main-nav ${mobileNav ? 'open' : ''}`} aria-label="Main navigation">
        <NavItem active={view === 'today'} icon={<Activity size={16}/>} onClick={() => { setView('today'); setMobileNav(false); }}>Today</NavItem>
        <NavItem active={view === 'archive'} icon={<Archive size={16}/>} onClick={() => { setView('archive'); setMobileNav(false); }}>Archive</NavItem>
        <NavItem active={view === 'stats'} icon={<Sparkles size={16}/>} onClick={() => { setView('stats'); setMobileNav(false); }}>Stats</NavItem>
      </nav>
      <div className="top-actions"><button className="sound-toggle" onClick={() => setSoundPref(!sound)} aria-label={sound ? 'Mute reward sound' : 'Enable reward sound'} aria-pressed={sound} title={sound ? 'Sound on' : 'Sound off'}>{sound ? <Volume2 size={16}/> : <VolumeX size={16}/>}<span>{sound ? 'SOUND ON' : 'SOUND OFF'}</span></button><button className="settings-button" onClick={() => setDialog('settings')} aria-label="Settings"><Settings2 size={16}/><span>Settings</span></button></div>
    </header>

    <main className="main-content">
      {loading ? <div className="loading-state"><span className="loading-spinner"><LoaderCircle/></span><p>Getting your day in order…</p></div> : loadError ? <div className="connection-panel"><div className="connection-mark"><Activity/></div><p className="eyebrow">CONNECTION INTERRUPTED</p><h1>Your day is still here.</h1><p>{loadError}</p><button className="button button-red" onClick={() => void load(true)}>Try again <ArrowRight size={16}/></button></div> : <>
        {error && <div className="inline-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}
        {view === 'today' && <>
          <section className="day-intro">
            <div className="day-copy"><div className="eyebrow"><span className="red-slash">///</span> YOUR EVERYDAY, RECLAIMED</div><h1>Make today<br/><em>count.</em></h1><p>Small acts. Your own terms. One day at a time.</p></div>
            <div className="day-nav"><button className="icon-button date-arrow" aria-label="Previous day" onClick={() => navigateDate(shiftDate(selectedDate, -1))}><ChevronLeft/></button><div className="date-readout"><span>{selectedDate === today ? 'TODAY' : selectedDate > today ? '' : 'LOOKING BACK'}</span><strong>{headerDate}</strong></div><button className="icon-button date-arrow" aria-label="Next day" disabled={selectedDate >= today} onClick={() => navigateDate(shiftDate(selectedDate, 1))}><ChevronRight/></button>{selectedDate !== today && <button className="today-link" onClick={() => setSelectedDate(today)}>Back to today</button>}</div>
            <div className="hero-stamp" aria-label={`${progress}% of today's practices complete`}><div className="stamp-sunburst"><span>{String(progress).padStart(2, '0')}<small>%</small></span></div><span className="stamp-caption">THE DAY IS<br/>YOURS TO SHAPE</span></div>
          </section>

          <section className="agenda-section">
            <div className="section-heading"><div><span className="eyebrow">THE LINEUP <b>{String(visibleHabits.length).padStart(2, '0')}</b></span><h2>Your practices<span className="heading-dot">.</span></h2></div><button className="button button-outline add-habit" onClick={() => { setEditingHabit(null); setDialog('habit'); }}><Plus size={16}/> Add a practice</button></div>
            {visibleHabits.length === 0 ? <div className="empty-state"><div className="empty-symbol">✳</div><h3>Make the first move.</h3><p>Add one small practice you’d like to make room for.</p><button className="button button-red" onClick={() => setDialog('habit')}><Plus size={16}/> Add a practice</button></div> : <div className="habit-list">{sortedHabits.map((habit, index) => {
              const stat = data.stats.find(s => s.id === habit.statId);
              const entry = entriesByKey.get(`${habit.id}:${selectedDate}`);
              const done = !!entry?.completed;
              return <article key={habit.id} className={`habit-card ${done ? 'is-done' : ''} ${habit.kind === 'journal' ? 'journal-card' : ''}`} style={{ '--delay': `${index * 70}ms`, '--stat': stat?.color || defaultColor } as React.CSSProperties}>
                <button data-stat-id={stat?.id} className={`complete-control ${done ? 'checked' : ''}`} disabled={!!busy} onClick={() => habit.kind === 'journal' ? openEntry(habit) : void submitEntry(habit, selectedDate, { completed: !done })} aria-label={`${done ? 'Undo' : 'Complete'} ${habit.name}`} title={done ? 'Mark incomplete' : 'Mark complete'}>{busy === `entry:${habit.id}` ? <LoaderCircle className="spin" size={19}/> : done ? <Check size={18}/> : <span className="check-inner"/>}</button>
                <div className="habit-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="habit-main"><div className="habit-title-row"><h3 className={done ? 'strike' : ''}>{habit.name}</h3>{habit.kind === 'journal' && <span className="journal-label"><BookOpen size={12}/> REFLECTION</span>}</div><p>{habit.description || (habit.kind === 'journal' ? habit.prompt : 'A little effort goes a long way.')}</p>{habit.kind === 'check' && <button className="reflection-link" disabled={!!busy} onClick={() => openEntry(habit)}>{entry?.content || entry?.good || entry?.bad || entry?.improve ? <><FileText size={12}/> Read or edit your reflection</> : <><Edit3 size={12}/> Add a reflection <span>OPTIONAL</span></>}</button>}{entry?.content && habit.kind === 'journal' && <button className="entry-peek" disabled={!!busy} onClick={() => openEntry(habit)}><FileText size={13}/>{entry.content.slice(0, 85)}{entry.content.length > 85 ? '…' : ''}<span>READ</span></button>}
                  {done && <div className="habit-earned"><CheckCircle2 size={14}/><span>Done for this day</span>{entry?.awardedPoints ? <b>+{entry.awardedPoints} {data.stats.find(s => s.id === entry.statId)?.name || stat?.name}</b> : null}</div>}
                </div>
                <div className="habit-side">{stat && <div className="stat-chip"><StatMark stat={stat}/><span>{stat.name}</span><b>+{habit.points}</b></div>}<button className="edit-practice" disabled={!!busy} onClick={() => { setEditingHabit(habit); setDialog('habit'); }} aria-label={`Edit ${habit.name}`} title="Edit practice"><MoreHorizontal size={19}/></button></div>
              </article>;
            })}</div>}
          </section>
          <section className="bottom-note"><div className="note-star">✳</div><p><strong>No streaks. No score to beat.</strong> Just a place to notice the things you do for yourself.</p><div className="note-right">{completeCount} OF {visibleHabits.length} DONE</div></section>
        </>}
        {view === 'archive' && <ArchiveView data={data} month={archiveMonth} onMonth={setArchiveMonth} habitId={archiveHabit} onHabit={setArchiveHabit} onEntry={openEntry} onEdit={habit => { setEditingHabit(habit); setDialog('habit'); }} busy={!!busy} today={today} />}
        {view === 'stats' && <StatsView data={data} totals={statPoints} onAdd={() => setDialog('stat')} onEdit={stat => { setEditingStat(stat); setDialog('stat'); }} />}
      </>}
    </main>
    <footer className="site-footer"><span>PHANTOM<span className="brand-period">.</span> <i>Make your own way.</i></span><span>YOUR LIFE, YOUR PACE.</span></footer>

    {dialog === 'habit' && <HabitDialog habit={editingHabit} stats={data.stats} onClose={() => { setDialog(null); setEditingHabit(null); }} onSaved={async () => { setDialog(null); setEditingHabit(null); await load(); }} />}
    {dialog === 'stat' && <StatDialog stat={editingStat} onClose={() => { setDialog(null); setEditingStat(null); }} onSaved={async () => { setDialog(null); setEditingStat(null); await load(); }} />}
    {dialog === 'settings' && <SettingsDialog sound={sound} onSound={setSoundPref} reducedMotion={reducedMotion} onMotion={setMotionPref} onClose={() => setDialog(null)} />}
    {activeEntry && !reward && <EntryDialog habit={activeEntry.habit} date={activeEntry.date} entry={entriesByKey.get(`${activeEntry.habit.id}:${activeEntry.date}`)} busy={!!busy} error={entryError} onClearError={() => setEntryError('')} onClose={() => { setActiveEntry(null); setEntryError(''); }} onSave={(body) => submitEntry(activeEntry.habit, activeEntry.date, body)} />}
    {reward && <RewardOverlay reward={reward} onClose={() => { const statId = reward.statId; setReward(null); window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.complete-control[data-stat-id="${CSS.escape(statId)}"]`)?.focus()); }} />}
  </div>;
}

function NavItem({ active, icon, children, onClick }: { active: boolean; icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}{children}{active && <i/>}</button>;
}

function ArchiveView({ data, month, onMonth, habitId, onHabit, onEntry, onEdit, busy, today }: { data: AppState; month: string; onMonth: (month: string) => void; habitId: string; onHabit: (id: string) => void; onEntry: (habit: Habit, date: string) => void; onEdit: (habit: Habit) => void; busy: boolean; today: string }) {
  const [year, monthNum] = month.split('-').map(Number); const monthIndex = monthNum - 1;
  const { count, offset } = monthDays(year, monthIndex);
  const selectedHabit = data.habits.find(h => h.id === habitId);
  const habits = selectedHabit ? [selectedHabit] : data.habits;
  const entryMap = new Map(data.entries.map(entry => [`${entry.habitId}:${entry.date}`, entry]));
  const completed = data.entries.filter(entry => entry.completed && entry.date.startsWith(month)).length;
  const moveMonth = (amount: number) => { const d = new Date(year, monthIndex + amount, 1); onMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); };
  return <section className="archive-view view-enter">
    <div className="view-hero"><div><div className="eyebrow"><span className="red-slash">///</span> THE DAYS YOU SHOWED UP</div><h1>Looking <em>back.</em></h1><p>A record of effort, not a report card.</p></div><div className="archive-total"><span>{completed}</span><small>COMPLETIONS<br/>THIS MONTH</small></div></div>
    <div className="archive-toolbar"><div className="month-control"><button className="icon-button" onClick={() => moveMonth(-1)} aria-label="Previous month"><ChevronLeft/></button><h2>{monthTitle(year, monthIndex)}</h2><button className="icon-button" disabled={month >= monthKey(today)} onClick={() => moveMonth(1)} aria-label="Next month"><ChevronRight/></button></div><label className="select-wrap"><span className="sr-only">Filter by practice</span><select value={habitId} onChange={e => onHabit(e.target.value)}><option value="all">All practices</option>{data.habits.map(h => <option key={h.id} value={h.id}>{h.name}{h.archived ? ' · archived' : ''}</option>)}</select><ChevronDown size={15}/></label></div>
    {habits.length === 0 ? <div className="empty-state"><div className="empty-symbol">✳</div><h3>No practices yet.</h3><p>Your history will appear here as you make your own.</p></div> : <div className="calendar-list">{habits.map(habit => {
      const stat = data.stats.find(s => s.id === habit.statId);
      return <article className="calendar-card" key={habit.id} style={{ '--stat': stat?.color || defaultColor } as React.CSSProperties}><div className="calendar-card-head"><div className="calendar-label"><span className="color-dot"/><div><h3>{habit.name}</h3><p>{stat?.name || 'Practice'}{habit.archived ? ' · archived' : ''}</p></div></div><div className="archive-head-actions"><div className="calendar-count">{Array.from({ length: count }, (_, i) => entryMap.get(`${habit.id}:${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`)).filter(e => e?.completed).length}<small>DONE</small></div><button className="archive-edit" disabled={busy} onClick={() => onEdit(habit)} aria-label={`${habit.archived ? 'Edit or restore' : 'Edit or archive'} ${habit.name}`}><Edit3 size={14}/><span>{habit.archived ? 'Manage' : 'Edit'}</span></button></div></div>
        <div className="calendar-grid" role="grid" aria-label={`${habit.name} in ${monthTitle(year, monthIndex)}`}><div className="weekday-row">{['S','M','T','W','T','F','S'].map((day, i) => <span key={i} aria-label={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][i]}>{day}</span>)}</div><div className="days-grid">{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} className="day-blank"/>)}{Array.from({ length: count }, (_, i) => { const day = i + 1; const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; const entry = entryMap.get(`${habit.id}:${date}`); const future = date > today; return <button key={date} className={`calendar-day ${entry?.completed ? 'marked' : ''} ${entry?.content ? 'has-writing' : ''} ${date === today ? 'is-today' : ''}`} disabled={future || !entry} onClick={() => entry && onEntry(habit, date)} aria-label={`${prettyDate(date, { month: 'long', day: 'numeric', year: 'numeric' })}${entry ? entry.completed ? ', completed' : ', entry saved' : ''}${future ? ', future date' : ''}`} title={entry ? `${prettyDate(date, { month: 'short', day: 'numeric' })}${entry.content ? ': ' + entry.content.slice(0, 55) : ''}` : undefined}>{entry?.completed && <span className="day-tick">✓</span>}<span>{day}</span>{entry?.content && <i/>}</button>; })}</div></div>
        <div className="calendar-legend"><span><i className="legend-complete"/>Completed</span><span><i className="legend-writing"/>Writing saved</span><span>Choose a marked day to revisit it</span></div>
      </article>;
    })}</div>}
  </section>;
}

function StatsView({ data, totals, onAdd, onEdit }: { data: AppState; totals: (Stat & { total: number })[]; onAdd: () => void; onEdit: (stat: Stat) => void }) {
  const totalPoints = totals.reduce((s, stat) => s + stat.total, 0);
  return <section className="stats-view view-enter"><div className="view-hero"><div><div className="eyebrow"><span className="red-slash">///</span> A LITTLE PROOF OF YOU</div><h1>What you’re <em>growing.</em></h1><p>Points mark the effort you’ve put in. No levels, no finish line.</p></div><button className="button button-outline" onClick={onAdd}><Plus size={16}/> Add a stat</button></div>
    <div className="stats-overview"><div className="overview-copy"><span className="eyebrow">ALL-TIME EFFORT</span><strong>{totalPoints.toLocaleString()}</strong><span>points earned through your practices</span></div><div className="overview-spark">✷</div><div className="overview-foot">{data.entries.filter(e => e.completed).length} completed moments <span>·</span> {data.habits.length} practices in your story</div></div>
    {data.stats.length ? <div className="stat-grid">{totals.map((stat, i) => <article className="stat-card" key={stat.id} style={{ '--stat': stat.color, '--delay': `${i * 90}ms` } as React.CSSProperties}><div className="stat-card-top"><StatMark stat={stat} size="large"/><button className="edit-stat" onClick={() => onEdit(stat)} aria-label={`Edit ${stat.name}`}><Edit3 size={15}/></button></div><div className="stat-card-name">{stat.name}</div><div className="stat-card-total">{stat.total.toLocaleString()}<small> PTS</small></div><div className="stat-card-foot"><span className="stat-line"/><span>KEPT BY YOU</span></div></article>)}</div> : <div className="empty-state"><div className="empty-symbol">✳</div><h3>Give your effort a name.</h3><p>Make a stat that reflects what matters to you.</p><button className="button button-red" onClick={onAdd}><Plus size={16}/> Add a stat</button></div>}
    <div className="stats-footnote"><ShieldCheck size={17}/><p>Your points are yours. Phantom doesn’t rank you against anyone—not even a past version of you.</p></div>
  </section>;
}

function EntryDialog({ habit, date, entry, busy, error, onClearError, onClose, onSave }: { habit: Habit; date: string; entry?: DailyEntry; busy: boolean; error: string; onClearError: () => void; onClose: () => void; onSave: (body: Partial<DailyEntry> & { completed: boolean }) => void }) {
  const [content, setContent] = useState(entry?.content || '');
  const [good, setGood] = useState(entry?.good || '');
  const [bad, setBad] = useState(entry?.bad || '');
  const [improve, setImprove] = useState(entry?.improve || '');
  const [sleep, setSleep] = useState(entry?.sleepHours == null ? '' : String(entry.sleepHours));
  const [health, setHealth] = useState(entry?.healthNotes || '');
  const [validation, setValidation] = useState('');
  const isJournal = habit.kind === 'journal';
  function save(e: FormEvent) {
    e.preventDefault();
    if (isJournal && !content.trim()) { setValidation('Write a few words before checking this one off.'); return; }
    const sleepValue = sleep === '' ? null : Number(sleep);
    if (sleepValue !== null && (Number.isNaN(sleepValue) || sleepValue < 0 || sleepValue > 24)) { setValidation('Enter a number of hours from 0 to 24.'); return; }
    onSave({ completed: isJournal ? true : !!entry?.completed, content: content.trim(), good: good.trim(), bad: bad.trim(), improve: improve.trim(), sleepHours: sleepValue, healthNotes: health.trim() });
  }
  return <Dialog title={isJournal ? 'A moment to reflect.' : 'A note for this day.'} eyebrow={`${habit.name.toUpperCase()}  /  ${prettyDate(date, { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase()}`} onClose={onClose} className="entry-dialog">
    <form onSubmit={save}>
      {isJournal && <div className="prompt-card"><span className="prompt-mark">✳</span><div><small>YOUR PROMPT</small><p>{habit.prompt || 'What would you like to remember about today?'}</p></div></div>}
      <label className="field-label">{isJournal ? 'Your reflection' : 'Anything you want to remember?'}<textarea autoFocus={!isJournal} rows={isJournal ? 5 : 3} value={content} onChange={e => { setContent(e.target.value); setValidation(''); onClearError(); }} placeholder={isJournal ? 'Start wherever you are…' : 'A thought, a detail, a small win…'} /></label>
      <div className="reflection-grid"><label className="field-label">Something good<textarea rows={2} value={good} onChange={e => { setGood(e.target.value); onClearError(); }} placeholder="A small bright spot…"/></label><label className="field-label">Something hard<textarea rows={2} value={bad} onChange={e => { setBad(e.target.value); onClearError(); }} placeholder="No judgment, just notice…"/></label><label className="field-label wide-field">Something to try tomorrow<textarea rows={2} value={improve} onChange={e => { setImprove(e.target.value); onClearError(); }} placeholder="One gentle adjustment…"/></label></div>
      <details className="optional-notes"><summary><span><Moon size={14}/> Sleep &amp; health notes</span><ChevronDown size={15}/></summary><div className="health-fields"><label className="field-label">Hours of sleep<input type="number" min="0" max="24" step="0.25" value={sleep} onChange={e => { setSleep(e.target.value); onClearError(); }} placeholder="e.g. 7.5" /></label><label className="field-label">Health note<input value={health} onChange={e => { setHealth(e.target.value); onClearError(); }} placeholder="Optional note" /></label></div></details>
      {validation && <p className="form-error" role="alert">{validation}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">{isJournal && entry?.completed && <button type="button" className="button button-quiet" disabled={busy} onClick={() => onSave({ completed: false, content: content.trim(), good: good.trim(), bad: bad.trim(), improve: improve.trim(), sleepHours: sleep === '' ? null : Number(sleep), healthNotes: health.trim() })}>Mark incomplete</button>}<button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-red" disabled={busy || (isJournal && !content.trim())}>{busy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} {entry?.completed ? 'Save reflection' : isJournal ? 'Save & complete' : 'Save note'}</button></div>
    </form>
  </Dialog>;
}

function HabitDialog({ habit, stats, onClose, onSaved }: { habit: Habit | null; stats: Stat[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(habit?.name || '');
  const [description, setDescription] = useState(habit?.description || '');
  const [kind, setKind] = useState<'check' | 'journal'>(habit?.kind || 'check');
  const [statId, setStatId] = useState(habit?.statId || stats[0]?.id || '');
  const [points, setPoints] = useState(String(habit?.points ?? 10));
  const [prompt, setPrompt] = useState(habit?.prompt || '');
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);
  const [archiving, setArchiving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setFormError('');
    if (!name.trim()) { setFormError('Give your practice a name first.'); return; }
    if (!statId) { setFormError('Add a stat before creating a practice.'); return; }
    const value = Number(points);
    if (!Number.isInteger(value) || value < 1 || value > 100) { setFormError('Points must be a whole number from 1 to 100.'); return; }
    if (kind === 'journal' && !prompt.trim()) { setFormError('Give your reflection a prompt.'); return; }
    setPending(true);
    try {
      const body = { name: name.trim(), description: description.trim(), kind, statId, points: value, prompt: kind === 'journal' ? prompt.trim() : prompt.trim() };
      if (habit) await api.editHabit(habit.id, body); else await api.addHabit(body);
      onSaved();
    } catch (e) { setFormError(e instanceof Error ? e.message : 'Could not save this practice.'); }
    finally { setPending(false); }
  }
  async function archive() {
    if (!habit) return;
    if (!archiving) { setArchiving(true); return; }
    setPending(true); setFormError('');
    try { await api.editHabit(habit.id, { archived: !habit.archived }); onSaved(); }
    catch (e) { setFormError(e instanceof Error ? e.message : 'Could not update this practice.'); }
    finally { setPending(false); }
  }
  return <Dialog title={habit ? 'Shape this practice.' : 'Make room for something.'} eyebrow={habit ? 'EDIT PRACTICE' : 'A NEW PRACTICE'} onClose={onClose} className="form-dialog">
    <form onSubmit={submit}>
      <label className="field-label">Practice name<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Read a few pages" maxLength={80}/></label>
      <label className="field-label">A little context <span className="optional">OPTIONAL</span><input value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this look like for you?" maxLength={180}/></label>
      <fieldset className="kind-choice"><legend>How does it work?</legend><label className={kind === 'check' ? 'selected' : ''}><input type="radio" name="kind" checked={kind === 'check'} onChange={() => setKind('check')}/><span className="choice-icon"><CheckCircle2 size={17}/></span><span><b>Quick check-off</b><small>A simple done-for-today moment.</small></span></label><label className={kind === 'journal' ? 'selected' : ''}><input type="radio" name="kind" checked={kind === 'journal'} onChange={() => setKind('journal')}/><span className="choice-icon"><BookOpen size={17}/></span><span><b>Guided reflection</b><small>Pause to write before it counts.</small></span></label></fieldset>
      {kind === 'journal' && <label className="field-label">Reflection prompt<textarea rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="What would you like to ask yourself?" maxLength={240}/></label>}
      <div className="form-row"><label className="field-label">Build which stat?<select value={statId} onChange={e => setStatId(e.target.value)}>{stats.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field-label points-field">Points<input type="number" min="1" max="100" value={points} onChange={e => setPoints(e.target.value)}/></label></div>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      {stats.length === 0 && <p className="form-hint">Add a stat first to connect it to your practice.</p>}
      {archiving && <div className="archive-confirm"><span>{habit?.archived ? 'Bring this practice back to your daily lineup?' : 'This leaves the daily lineup, but its history stays in your archive.'}</span><button type="button" className="text-button" onClick={() => setArchiving(false)}>Keep it here</button></div>}
      <div className="dialog-actions dialog-actions-split">{habit ? <button type="button" className={`button ${archiving ? 'button-red' : 'button-quiet'}`} disabled={pending} onClick={archive}>{pending ? <LoaderCircle className="spin" size={16}/> : <Archive size={15}/>} {archiving ? (habit.archived ? 'Restore practice' : 'Confirm archive') : (habit.archived ? 'Restore' : 'Archive')}</button> : <span/>}<div><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-red" disabled={pending || stats.length === 0}>{pending ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} {habit ? 'Save changes' : 'Add practice'}</button></div></div>
    </form>
  </Dialog>;
}

function StatDialog({ stat, onClose, onSaved }: { stat: Stat | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(stat?.name || '');
  const [color, setColor] = useState(stat?.color || defaultColor);
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); if (!name.trim()) { setError('Give this stat a name.'); return; }
    setPending(true);
    try { if (stat) await api.editStat(stat.id, { name: name.trim(), color, icon: stat.icon }); else await api.addStat({ name: name.trim(), color }); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save this stat.'); }
    finally { setPending(false); }
  }
  return <Dialog title={stat ? 'Name what matters.' : 'What are you growing?'} eyebrow={stat ? 'EDIT STAT' : 'YOUR OWN MEASURE'} onClose={onClose} className="form-dialog"><form onSubmit={submit}><label className="field-label">Stat name<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Creativity" maxLength={40}/></label><label className="field-label">A color of its own<div className="color-picker-row"><input type="color" value={color} onChange={e => setColor(e.target.value)} aria-label="Choose stat color"/><span className="color-preview" style={{ backgroundColor: color }}/><code>{color.toUpperCase()}</code><span className="color-note">For this stat’s star and points.</span></div></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-red" disabled={pending}>{pending ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} {stat ? 'Save stat' : 'Add stat'}</button></div></form></Dialog>;
}

function SettingsDialog({ sound, onSound, reducedMotion, onMotion, onClose }: { sound: boolean; onSound: (value: boolean) => void; reducedMotion: boolean; onMotion: (value: boolean) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [restoreFile, setRestoreFile] = useState<File | null>(null); const [confirmRestore, setConfirmRestore] = useState(false); const fileRef = useRef<HTMLInputElement>(null);
  async function exportData() {
    setBusy(true); setMessage('');
    try { const response = await fetch('/api/backup'); if (!response.ok) { let m = 'Could not download your backup.'; try { m = (await response.json()).error || m; } catch {} throw new Error(m); } const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `phantom-backup-${localDate()}.json`; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1500); setMessage('Your backup is ready.'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Could not download your backup.'); }
    finally { setBusy(false); }
  }
  async function importData() {
    if (!restoreFile) return;
    setBusy(true); setMessage('');
    try { const parsed = JSON.parse(await restoreFile.text()); const response = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }); if (!response.ok) { let m = 'Could not restore this backup.'; try { m = (await response.json()).error || m; } catch {} throw new Error(m); } setMessage('Backup restored. Reloading…'); window.location.reload(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'That file could not be read as a backup.'); }
    finally { setBusy(false); }
  }
  return <Dialog title="Your data, your call." eyebrow="SETTINGS" onClose={onClose} className="settings-dialog"><div className="setting-row"><div className="setting-icon"><Volume2 size={18}/></div><div className="setting-copy"><b>Reward sound</b><span>A few original notes when you complete a practice.</span></div><button className={`toggle ${sound ? 'on' : ''}`} role="switch" aria-checked={sound} aria-label="Reward sound" onClick={() => onSound(!sound)}><i/></button></div><div className="setting-divider"/><div className="setting-row"><div className="setting-icon"><Activity size={18}/></div><div className="setting-copy"><b>Reduce motion</b><span>{reducedMotion ? 'Gentler movement is on.' : 'Use the full celebratory movement.'}</span></div><button className={`toggle ${reducedMotion ? 'on' : ''}`} role="switch" aria-checked={reducedMotion} aria-label="Reduce motion" onClick={() => onMotion(!reducedMotion)}><i/></button></div><div className="setting-divider"/><div className="setting-row backup-row"><div className="setting-icon"><Download size={18}/></div><div className="setting-copy"><b>Keep a copy</b><span>Export your practices, entries, and stats as a JSON file.</span></div><button className="button button-outline compact" disabled={busy} onClick={() => void exportData()}>{busy ? <LoaderCircle className="spin" size={14}/> : <Download size={14}/>} Export</button></div><div className="restore-block"><div className="restore-copy"><b>Restore from backup</b><span>This replaces the data currently in Phantom.</span></div><input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={e => { setRestoreFile(e.target.files?.[0] || null); setConfirmRestore(false); setMessage(''); }}/><button className="button button-quiet compact" disabled={busy} onClick={() => fileRef.current?.click()}><ArrowDown size={14}/> Choose file</button>{restoreFile && <div className="restore-file"><FileText size={14}/><span>{restoreFile.name}</span>{!confirmRestore ? <button className="text-button" onClick={() => setConfirmRestore(true)}>Continue</button> : <button className="text-button danger-text" disabled={busy} onClick={() => void importData()}>{busy ? 'Restoring…' : 'Replace my data'}</button>}</div>}</div>{message && <p className={`setting-message ${message.toLowerCase().includes('could not') ? 'form-error' : ''}`} role="status">{message}</p>}<div className="privacy-note"><LockKeyhole size={15}/><span>Your entries stay on this device. Backup files are yours to keep.</span></div><div className="dialog-actions"><button className="button button-quiet" onClick={onClose}>Done</button></div></Dialog>;
}

function RewardOverlay({ reward, onClose }: { reward: Reward; onClose: () => void }) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dismissRef.current?.focus();
    const timer = window.setTimeout(() => onCloseRef.current(), 4400);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        const focusable = Array.from(panel?.querySelectorAll<HTMLElement>('button:not([disabled])') || []).filter(element => element.getClientRects().length > 0);
        if (focusable.length < 1 || !panel?.contains(document.activeElement) || (e.shiftKey ? document.activeElement === focusable[0] : document.activeElement === focusable[focusable.length - 1])) {
          e.preventDefault(); (e.shiftKey && focusable.length ? focusable[focusable.length - 1] : focusable[0] || dismissRef.current)?.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', key, true); before?.focus(); };
  }, []);
  return <div className="reward-scrim" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={panelRef} className="reward-overlay" role="dialog" aria-modal="true" aria-label={`${reward.points} ${reward.statName} points earned`}><div className="reward-burst"><div className="burst-ring ring-one"/><div className="burst-ring ring-two"/><div className="reward-star">★</div><span className="reward-note note-one">♪</span><span className="reward-note note-two">♫</span><span className="reward-note note-three">♪</span><span className="reward-spark spark-one">✦</span><span className="reward-spark spark-two">✧</span><span className="reward-spark spark-three">✦</span></div><div className="reward-eyebrow">A LITTLE MORE <b>{reward.statName.toUpperCase()}</b></div><h2>THAT’S<br/><em>THE STUFF!</em></h2><div className="reward-points"><span>+</span>{reward.points}<small> {reward.statName.toUpperCase()}</small></div><p>You showed up for yourself.<br/>That counts.</p><button ref={dismissRef} className="reward-dismiss" onClick={onClose}>BACK TO MY DAY <ArrowRight size={15}/></button><span className="reward-corner">✦ &nbsp; ✦ &nbsp; ✦</span></section></div>;
}

export default App;
