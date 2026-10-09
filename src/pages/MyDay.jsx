import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Plus, Trash2, ListChecks, CheckCircle2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { scoped } from '../lib/localCache';
import Stopwatch from '../components/Stopwatch';
import { DEFAULT_STOPWATCH } from '../lib/stopwatch';
import { isCarriedForward } from '../lib/taskProgress';

const MYDAY_STORAGE_KEY = 'td_myday_todos'; // td_ prefix matches project convention

function loadTodos(key) {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch (e) { console.error('Error loading My Day todos:', e); }
  return [];
}

function saveTodos(key, todos) {
  try { localStorage.setItem(key, JSON.stringify(todos)); }
  catch (e) { console.error('Error saving My Day todos:', e); }
}

export default function MyDay() {
  const { tasks, employees, getEmployeeName, getWebsiteName } = useApp();
  const { user, myEmployeeId, canViewAll } = useAuth();
  // scoped() returns the plain key when there is no signed-in user (local-only
  // mode), so this falls back to the single shared list exactly as before in
  // that mode. Elsewhere it must match the key localCache.js's one-time
  // migration writes to, or that migrated data would sit under a key nothing
  // ever reads.
  const storageKey = scoped(MYDAY_STORAGE_KEY, user?.id);
  const [todos, setTodos] = useState(() => loadTodos(storageKey));
  const [newText, setNewText] = useState('');
  // Members always see their own tasks — the free choice of any employee here
  // was the clearest sign the app had no notion of who was using it. Admins
  // keep the full picker, defaulted to themselves rather than blank.
  const [filterEmployee, setFilterEmployee] = useState(myEmployeeId || '');

  useEffect(() => { saveTodos(storageKey, todos); }, [storageKey, todos]);

  // Belt-and-braces: AuthGate normally guarantees myEmployeeId is already known
  // by the time this component mounts, but this covers a late-resolving link
  // without ever overwriting a value the person already chose.
  useEffect(() => {
    if (myEmployeeId && !filterEmployee) setFilterEmployee(myEmployeeId);
  }, [myEmployeeId, filterEmployee]);

  // Real calendar "now" — deliberately independent of any other tab's selected
  // period, since My Day has no month/year selector of its own.
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const employeeTasks = useMemo(() => {
    if (!filterEmployee) return [];
    return tasks.filter(t =>
      t.assignedTo === filterEmployee &&
      t.status !== 'completed' &&
      // A task carried forward mid-month (before month-end) is superseded by
      // its own clone in the next month — importing the old, forwarded copy
      // into a personal to-do list would mean tracking work that's already
      // moved on. The active clone shows up here normally once its own month
      // arrives.
      !isCarriedForward(t) &&
      t.month === currentMonth &&
      t.year === currentYear
    );
  }, [tasks, filterEmployee, currentMonth, currentYear]);

  // Tracks which source tasks are already in My Day, so the picker can show
  // "Added" instead of letting the same task be imported twice.
  const importedTaskIds = useMemo(
    () => new Set(todos.filter(t => t.sourceTaskId).map(t => t.sourceTaskId)),
    [todos]
  );

  const handleAdd = (e) => {
    e.preventDefault();
    const text = newText.trim();
    if (!text) return;
    setTodos(t => [...t, { id: uuidv4(), text, done: false, createdAt: new Date().toISOString(), stopwatch: { ...DEFAULT_STOPWATCH } }]);
    setNewText('');
  };

  const importTask = (task) => {
    setTodos(t => [...t, {
      id: uuidv4(), text: task.title, done: false,
      createdAt: new Date().toISOString(), sourceTaskId: task.id,
      stopwatch: { ...DEFAULT_STOPWATCH },
    }]);
  };

  const toggleTodo = (id) => setTodos(t => t.map(x => x.id === id ? { ...x, done: !x.done } : x));
  const deleteTodo = (id) => setTodos(t => t.filter(x => x.id !== id));
  const clearCompleted = () => setTodos(t => t.filter(x => !x.done));
  // Todos created before this feature shipped have no `stopwatch` field —
  // DEFAULT_STOPWATCH fills in for those rather than crashing Stopwatch on a
  // missing prop.
  const updateStopwatch = (id, next) => setTodos(t => t.map(x => x.id === id ? { ...x, stopwatch: next } : x));

  const remaining = todos.filter(t => !t.done).length;
  const completedCount = todos.length - remaining;

  return (
    <div className="animate-in">
      <div className="page-header">
        <h3>My Day</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Private to this browser - not synced or shared with your team.
        </p>
      </div>

      <div className="card" style={{ marginBottom: '16px' }}>
        <div className="card-body">
          <div className="form-group" style={{ marginBottom: filterEmployee ? '14px' : 0 }}>
            <label className="form-label">Add from a scheduled task</label>
            {canViewAll ? (
              <select className="form-select" value={filterEmployee} onChange={e => setFilterEmployee(e.target.value)}>
                <option value="">Select employee...</option>
                {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
              </select>
            ) : (
              // A member browsing a colleague's pending workload from their own
              // to-do list made no sense — the picker is now implicit.
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>
                Your pending tasks this month
              </p>
            )}
          </div>

          {filterEmployee && (
            employeeTasks.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-light)' }}>
                No pending tasks this month for {getEmployeeName(filterEmployee)}.
              </p>
            ) : (
              <div className="myday-import-list">
                {employeeTasks.map(task => {
                  const added = importedTaskIds.has(task.id);
                  return (
                    <div key={task.id} className="myday-import-row">
                      <div className="myday-import-info">
                        <span className="myday-import-title">{task.title}</span>
                        <span className="myday-import-meta">{task.category || 'General'} • {getWebsiteName(task.websiteId)}</span>
                      </div>
                      {added ? (
                        <span className="myday-import-added"><CheckCircle2 size={14} /> Added</span>
                      ) : (
                        <button className="btn btn-secondary btn-sm" onClick={() => importTask(task)}>
                          <Plus size={14} /> Add
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '16px' }}>
        <div className="card-body">
          <form onSubmit={handleAdd} style={{ display: 'flex', gap: '10px' }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              value={newText}
              onChange={e => setNewText(e.target.value)}
              placeholder="Add a task for today..."
            />
            <button type="submit" className="btn btn-primary" disabled={!newText.trim()}>
              <Plus size={16} /> Add
            </button>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          {todos.length === 0 ? (
            <div className="empty-state">
              <ListChecks size={40} />
              <h4>Nothing on your list yet</h4>
              <p>Add your first task above to get started.</p>
            </div>
          ) : (
            <>
              <div className="myday-list">
                {todos.map(todo => (
                  <div key={todo.id} className={`myday-item ${todo.done ? 'done' : ''}`}>
                    <div className="myday-item-main">
                      <input
                        type="checkbox"
                        className="myday-checkbox"
                        checked={todo.done}
                        onChange={() => toggleTodo(todo.id)}
                      />
                      <span className="myday-text">
                        {todo.text}
                        {todo.sourceTaskId && <span className="badge badge-info myday-source-badge">Schedule</span>}
                      </span>
                      <button className="btn-icon" style={{ color: 'var(--danger)' }} onClick={() => deleteTodo(todo.id)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <Stopwatch
                      value={todo.stopwatch || DEFAULT_STOPWATCH}
                      onChange={(next) => updateStopwatch(todo.id, next)}
                    />
                  </div>
                ))}
              </div>

              <div className="myday-footer">
                <span>{remaining} remaining • {completedCount} done</span>
                {completedCount > 0 && (
                  <button className="btn btn-secondary btn-sm" onClick={clearCompleted}>
                    Clear completed
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
