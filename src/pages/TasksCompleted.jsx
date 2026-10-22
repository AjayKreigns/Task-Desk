import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { CheckCircle2, Clock, X, Filter, Search, ArrowUpRight, Download, Eye, Trash2, Plus, Timer, ArrowRightCircle, AlertTriangle } from 'lucide-react';
import * as XLSX from 'xlsx';
import TaskDetailModal from '../components/TaskDetailModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { calcModalPosition } from '../lib/modalPosition';
import { getTaskPercent, getTaskPendingPercent, isTaskExceeded, getEffectiveStatus } from '../lib/taskProgress';
import { sanitizeExcelRow } from '../lib/excelSafety';
import { isPastPeriod } from '../lib/periodLock';
import ModalPortal from '../components/ModalPortal';
import PeriodToggle from '../components/PeriodToggle';
import CarryForwardWarningBanner from '../components/CarryForwardWarningBanner';

import confetti from 'canvas-confetti';

export default function TasksCompleted({ selectedMonth, selectedYear, selectedWebsite, selectedProject, intent, onIntentConsumed, filterEmployee, setFilterEmployee, filterStatus, setFilterStatus, filterCategory, setFilterCategory }) {
  const { tasks, tasksById, employees, websites, categories, projects, addTask, completeTask, deleteTask, updateTask, getEmployeeName, getWebsiteName, getProjectName, unitLabel, currentTeam } = useApp();
  // Digital Marketing never has Projects — see supabase_projects_table.sql.
  const showProjects = !currentTeam?.is_lead_source_team;
  const { canManageTeam, isViewer, canViewAll, myEmployeeId, isMe, isSuperAdmin } = useAuth();
  // Only a super admin may still add/complete/log-hours/delete once a
  // period has ended — a team's own admin (canManageTeam is true for both)
  // is locked out too, same rule as Schedule.jsx.
  const periodLocked = isPastPeriod(selectedMonth, selectedYear) && !isSuperAdmin;
  const periodLockedTitle = periodLocked
    ? `Can't add tasks to ${new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' })} — it has ended`
    : undefined;
  const { notify } = useNotification();
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [showAddAdditionalModal, setShowAddAdditionalModal] = useState(false);
  const [taskToComplete, setTaskToComplete] = useState(null);
  const [completionUrl, setCompletionUrl] = useState('');
  // filterEmployee/filterStatus/filterCategory are lifted to App.jsx (passed
  // down as props) rather than local state, so they survive this component
  // unmounting on every tab switch instead of resetting back to default.
  const [period, setPeriod] = useState('month');
  const [appliedIntent, setAppliedIntent] = useState(null);
  const isYearView = period === 'year';

  // Apply a drill-down handed over from a Dashboard KPI card — same pattern
  // as Schedule's own intent handling (adjusting state during render, React's
  // recommended way to react to a changed prop, rather than an effect: it
  // re-renders before painting, so the filter is already correct on the
  // first frame the user sees).
  if (intent && intent.nonce !== appliedIntent) {
    setAppliedIntent(intent.nonce);
    setPeriod(intent.period === 'year' ? 'year' : 'month');
    setFilterStatus(intent.status || 'all');
  }

  // Tells App.jsx the intent has now been applied, so it goes back to null
  // there — see the matching comment in Schedule.jsx for why this is needed:
  // without it, revisiting this tab later would find the same stale intent
  // still sitting in App's state (this component unmounts on every tab
  // switch, so appliedIntent above resets too) and silently reapply it,
  // overwriting any filters set manually in between.
  useEffect(() => {
    if (appliedIntent !== null) onIntentConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedIntent]);

  const [searchQuery, setSearchQuery] = useState('');
  const [detailTask, setDetailTask] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [modalPos, setModalPos] = useState(null);
  const [taskToLogTime, setTaskToLogTime] = useState(null);

  const hasActiveFilters = filterStatus !== 'all'
    || filterCategory !== 'all'
    || filterEmployee !== (canViewAll ? 'all' : (myEmployeeId || 'all'))
    || searchQuery !== '';

  const clearFilters = () => {
    setFilterStatus('all');
    setFilterCategory('all');
    setFilterEmployee(canViewAll ? 'all' : (myEmployeeId || 'all'));
    setSearchQuery('');
  };

  const handleAddAdditional = async (taskData) => {
    const result = await addTask({
      ...taskData,
      isAdditional: true,
      month: selectedMonth,
      year: selectedYear,
    });
    if (result) {
      notify('success', 'Additional Task Added', `"${result.title}" has been added`);
      if (taskData.status === 'completed') {
        confetti({
          particleCount: 150,
          spread: 80,
          origin: { y: 0.6 }
        });
      }
    }
  };

  const handleOpenModal = (e, setter, value) => {
    if (e && e.clientX) {
      setModalPos({ x: e.clientX, y: e.clientY });
    } else {
      setModalPos(null);
    }
    setter(value);
  };

  // Tasks in the selected period + website — the scope the category dropdown is
  // built from, so it only offers categories present in what you're viewing.
  const periodTasks = useMemo(() => {
    return tasks.filter(t =>
      (isYearView || t.month === selectedMonth) &&
      t.year === selectedYear &&
      (selectedWebsite === 'all' || t.websiteId === selectedWebsite) &&
      (selectedProject === 'all' || t.projectId === selectedProject)
    );
  }, [tasks, isYearView, selectedMonth, selectedYear, selectedWebsite, selectedProject]);

  const availableCategories = useMemo(() => {
    const inPeriod = new Set(periodTasks.map(t => t.category || 'General'));
    // Keep the active selection listed even if the period has none of it, so
    // switching month never silently drops the filter.
    if (filterCategory !== 'all') inPeriod.add(filterCategory);
    return [...inPeriod].sort((a, b) => a.localeCompare(b));
  }, [periodTasks, filterCategory]);

  const filteredTasks = useMemo(() => {
    return periodTasks.filter(t =>
      (filterEmployee === 'all' || t.assignedTo === filterEmployee) &&
      // getEffectiveStatus, not raw t.status — lets filterStatus be 'pending',
      // 'completed', or 'carried_forward' and have each one actually mean
      // what it says: 'carried_forward' only matches a task whose chain
      // genuinely hasn't resolved yet, and one whose successor IS now done
      // correctly matches 'completed' here instead, following the same chain
      // the badge below shows.
      (filterStatus === 'all' || getEffectiveStatus(t, tasksById) === filterStatus) &&
      (filterCategory === 'all' || (t.category || 'General') === filterCategory) &&
      (searchQuery === '' || t.title.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  }, [periodTasks, filterEmployee, filterStatus, filterCategory, searchQuery, tasksById]);

  // These header counts describe exactly the rows filtered above, so they use
  // the same chain-following getEffectiveStatus — otherwise "16 Carried
  // Forward" could sit above a table where several of those rows visibly say
  // "Completed", which is the exact inconsistency this whole change fixes.
  const completedCount = filteredTasks.filter(t => getEffectiveStatus(t, tasksById) === 'completed').length;
  const carriedForwardCount = filteredTasks.filter(t => getEffectiveStatus(t, tasksById) === 'carried_forward').length;
  const pendingCount = filteredTasks.filter(t => getEffectiveStatus(t, tasksById) === 'pending').length;

  const [timeTaken, setTimeTaken] = useState('');
  const openCompleteModal = (task) => { setTaskToComplete(task); setCompletionUrl(''); setTimeTaken(task.timeTaken || ''); setShowCompleteModal(true); };

  const handleComplete = async (e) => {
    e.preventDefault();
    if (!timeTaken || Number(timeTaken) <= 0) return;
    const ok = await completeTask(taskToComplete.id, completionUrl, Number(timeTaken));
    if (!ok) return; // leave the modal open — completeTask already reported why
    notify('task_completed', 'Task Completed', `"${taskToComplete.title}" marked as done`);
    setShowCompleteModal(false);
    setTaskToComplete(null);
    confetti({
      particleCount: 150,
      spread: 80,
      origin: { y: 0.6 }
    });
  };

  const [logTimeValue, setLogTimeValue] = useState('');
  const openLogTimeModal = (task) => { setTaskToLogTime(task); setLogTimeValue(task.timeTaken || ''); };

  const handleLogTime = async (e) => {
    e.preventDefault();
    const ok = await updateTask(taskToLogTime.id, { timeTaken: logTimeValue ? Number(logTimeValue) : 0 });
    if (!ok) return;
    notify('success', 'Hours Logged', `"${taskToLogTime.title}" updated`);
    setTaskToLogTime(null);
  };

  const handleDelete = (task) => {
    setConfirmDelete(task);
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    const ok = await deleteTask(confirmDelete.id);
    if (ok) notify('task_deleted', 'Task Deleted', `"${confirmDelete.title}" removed`);
    setConfirmDelete(null);
  };

  const exportExcel = () => {
    const rows = filteredTasks.map(t => sanitizeExcelRow({
      ...(isYearView ? { 'Month': new Date(t.year, t.month - 1).toLocaleString('default', { month: 'short' }) } : {}),
      'Task': t.title, 'Category': t.category || 'General',
      'Assigned To': getEmployeeName(t.assignedTo), [unitLabel]: getWebsiteName(t.websiteId),
      ...(showProjects ? { 'Project': t.projectId ? getProjectName(t.projectId) : '' } : {}),
      'Status': t.status, 'Targeted Hrs': t.targetedTime || 0, 'Booked Hrs': t.timeTaken || 0,
      'Completed Date': t.completedDate ? new Date(t.completedDate).toLocaleDateString('en-IN') : '',
      'Proof URL': t.completionUrl || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tasks');
    const periodLabel = isYearView
      ? `FullYear-${selectedYear}`
      : `${new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long' })}-${selectedYear}`;
    XLSX.writeFile(wb, `Tasks-${periodLabel}.xlsx`);
  };

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h3>Task Status</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
            {isYearView ? `All of ${selectedYear}` : new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' })}
            {filterCategory !== 'all' && ` • ${filterCategory}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <PeriodToggle period={period} onChange={setPeriod} year={selectedYear} />
          <span className="badge badge-completed" style={{ padding: '6px 14px', fontSize: '0.82rem' }}><CheckCircle2 size={14} /> {completedCount} Done</span>
          <span className="badge badge-pending" style={{ padding: '6px 14px', fontSize: '0.82rem' }}><Clock size={14} /> {pendingCount} Pending</span>
          <span className="badge badge-info" style={{ padding: '6px 14px', fontSize: '0.82rem' }}><ArrowRightCircle size={14} /> {carriedForwardCount} Carried Forward</span>
          {filteredTasks.length > 0 && <button className="btn btn-secondary btn-sm" onClick={exportExcel}><Download size={14} /> Excel</button>}
          {!isViewer && <button className="btn btn-primary btn-sm" disabled={periodLocked} title={periodLockedTitle} onClick={(e) => handleOpenModal(e, setShowAddAdditionalModal, true)}><Plus size={14} /> Add Additional Task</button>}
        </div>
      </div>

      <CarryForwardWarningBanner />

      {/* Filters */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div className="card-body" style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <Filter size={16} style={{ color: 'var(--text-muted)' }} />
          <div className="filter-group">
            <Search size={14} style={{ color: 'var(--text-light)' }} />
            <input className="form-input" style={{ border: 'none', background: 'transparent', padding: '4px 8px', fontSize: '0.85rem' }} placeholder="Search tasks..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          {/* Same reasoning as Schedule.jsx: once a member can only ever see
              their own tasks, letting them pick another employee here would
              just produce an unexplained empty list. */}
          {canViewAll ? (
            <div className="filter-group">
              <select value={filterEmployee} onChange={e => setFilterEmployee(e.target.value)}>
                <option value="all">All Employees</option>
                {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="filter-group" style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Your tasks
            </div>
          )}
          <div className="filter-group">
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">All Status</option>
              <option value="completed">Completed</option>
              <option value="pending">Pending</option>
              <option value="carried_forward">Carried Forward</option>
            </select>
          </div>
          <div className="filter-group">
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
              <option value="all">All Categories</option>
              {availableCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {hasActiveFilters && (
            <button className="btn btn-secondary btn-sm" onClick={clearFilters}>
              <X size={13} /> Clear Filters
            </button>
          )}
        </div>
      </div>

      {filteredTasks.length === 0 ? (
        <div className="empty-state"><CheckCircle2 size={48} /><h4>No tasks found</h4><p>No tasks match your current filters</p></div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Task</th>{isYearView && <th>Month</th>}<th>Category</th><th>Assigned To</th><th>{unitLabel}</th>{showProjects && <th>Project</th>}<th>Status</th><th>Completed Date</th><th>Proof URL</th><th>Action</th></tr></thead>
            <tbody>
              {filteredTasks.map(task => {
                const rowLocked = isPastPeriod(task.month, task.year) && !isSuperAdmin;
                return (
                <tr key={task.id} style={task.status === 'completed' ? { background: 'var(--success-bg)' } : {}}>
                  <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      {task.title}
                      {task.isAdditional && (
                        <span className="badge badge-info" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>Additional</span>
                      )}
                      {task.carryForwardFrom && (
                        <span className="badge" style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'var(--info-bg)', color: 'var(--info)' }} title="Carried forward from previous month">CF</span>
                      )}
                      {task.carryForwardTo && (
                        <span className="badge" style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'var(--warning-bg)', color: 'var(--warning)' }} title="Carried forward to next month">CF</span>
                      )}
                    </div>
                  </td>
                  {isYearView && (
                    <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(task.year, task.month - 1).toLocaleString('default', { month: 'short' })}
                    </td>
                  )}
                  <td><span style={{ background: 'var(--primary-bg)', color: 'var(--primary)', padding: '2px 10px', borderRadius: 'var(--radius-full)', fontSize: '0.75rem', fontWeight: 600 }}>{task.category || 'General'}</span></td>
                  <td><div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: task.status === 'completed' ? 'var(--success-bg)' : 'var(--primary-bg)', color: task.status === 'completed' ? 'var(--success)' : 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>{getEmployeeName(task.assignedTo).charAt(0)}</span>
                    <span>{getEmployeeName(task.assignedTo)}</span>
                  </div></td>
                  <td style={{ fontSize: '0.85rem' }}>{getWebsiteName(task.websiteId)}</td>
                  {showProjects && (
                    <td style={{ fontSize: '0.85rem' }}>{task.projectId ? getProjectName(task.projectId) : <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                  )}
                  <td style={{ minWidth: '150px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {(() => {
                        // Follows carryForwardTo to wherever the work actually ended up
                        // — an original whose successor is now done reads "Completed"
                        // here too, instead of "Carried Forward" forever.
                        const effStatus = getEffectiveStatus(task, tasksById);
                        const pendingPct = getTaskPendingPercent(task);
                        const exceeded = isTaskExceeded(task);
                        // Own hours (0% if none were logged before this was forwarded)
                        // would look broken under a "Completed" badge, so the bar
                        // matches the resolved status too, not just this row's own record.
                        const pct = effStatus === 'completed' ? 100 : getTaskPercent(task);
                        return (
                          <>
                            <span className={`badge badge-${effStatus === 'completed' ? 'success' : effStatus === 'carried_forward' ? 'info' : 'pending'}`} style={{ alignSelf: 'flex-start' }}>
                              {effStatus === 'completed' ? <><CheckCircle2 size={12} /> Completed</>
                                : effStatus === 'carried_forward' ? <><ArrowRightCircle size={12} /> Carried Forward</>
                                : <><Clock size={12} /> {pendingPct}% Pending</>}
                            </span>
                            <div style={{ width: '100%', background: 'var(--border)', borderRadius: '4px', height: '6px', overflow: 'hidden', marginTop: '4px' }}>
                              <div style={{
                                width: `${pct}%`,
                                background: effStatus === 'completed' ? 'var(--success)' : exceeded ? 'var(--danger)' : 'var(--primary)',
                                height: '100%',
                                transition: 'width 0.3s ease'
                              }}></div>
                            </div>
                            {task.targetedTime > 0 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: exceeded ? 'var(--danger)' : 'var(--text-muted)' }}>
                                <span>{task.timeTaken || 0}h / {task.targetedTime}h</span>
                                {exceeded && <span style={{ fontWeight: 600 }}>Exceeded</span>}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{task.completedDate ? new Date(task.completedDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
                  <td>{task.completionUrl ? <a href={task.completionUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>View <ArrowUpRight size={12} /></a> : <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                  <td><div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <button className="btn-icon" onClick={(e) => handleOpenModal(e, setDetailTask, task)} title="Details"><Eye size={15} /></button>
                    {/* Log Hours/Mark Completed/Update Time all write — hidden
                        for a viewer (read-only admin), same as every other
                        write control in this app. */}
                    {!isViewer && (task.status !== 'completed' ? (
                      <>
                        <button className="btn-icon" disabled={rowLocked} style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => openLogTimeModal(task)} title={rowLocked ? "This task's month has ended — only a super admin can log hours now" : "Log Hours"}><Timer size={14} /> Log Hours</button>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.78rem', cursor: rowLocked ? 'not-allowed' : 'pointer', color: 'var(--text-muted)', opacity: rowLocked ? 0.4 : 1, userSelect: 'none' }} title={rowLocked ? "This task's month has ended — only a super admin can complete it now" : "Mark Completed"}>
                          <input type="checkbox" checked={false} disabled={rowLocked} onChange={() => openCompleteModal(task)} style={{ width: 15, height: 15, cursor: rowLocked ? 'not-allowed' : 'pointer' }} />
                          Mark Completed
                        </label>
                      </>
                    ) : (
                      <button className="btn-icon text-primary" disabled={rowLocked} style={{ padding: '4px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => openCompleteModal(task)} title={rowLocked ? "This task's month has ended — only a super admin can update it now" : "Update Time"}><Clock size={14} /> Update Time</button>
                    ))}
                    {/* Matches the tasks DELETE policy exactly: admin, or the
                        task's own assignee (and never a viewer). */}
                    {(canManageTeam || (!isViewer && isMe(task.assignedTo))) && (
                      <button className="btn-icon text-danger" disabled={rowLocked} title={rowLocked ? "This task's month has ended — only a super admin can delete it now" : "Delete"} onClick={() => handleDelete(task)}><Trash2 size={15} /></button>
                    )}
                  </div></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Complete Task Modal */}
      {showCompleteModal && taskToComplete && (
        <ModalPortal>
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowCompleteModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>Mark Task as Completed</h3><button className="btn-icon" onClick={() => setShowCompleteModal(false)}><X size={20} /></button></div>
            <form onSubmit={handleComplete}>
              <div className="modal-body">
                <div style={{ padding: '14px 18px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', marginBottom: '18px', borderLeft: '4px solid var(--primary)' }}>
                  <p style={{ fontWeight: 700, marginBottom: '4px' }}>{taskToComplete.title}</p>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Assigned to: {getEmployeeName(taskToComplete.assignedTo)} • {getWebsiteName(taskToComplete.websiteId)}</p>
                </div>
                <div className="form-group">
                  <label className="form-label">Completion URL / Proof of Work (Optional)</label>
                  <input className="form-input" type="url" value={completionUrl} onChange={e => setCompletionUrl(e.target.value)} placeholder="https://published-article-url.com" />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '4px' }}>Link to the published article, social post, or deliverable</span>
                </div>
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Time Taken (hours) *</label>
                  <input className="form-input" type="number" min="0.5" step="0.5" required value={timeTaken} onChange={e => setTimeTaken(e.target.value)} placeholder="e.g., 4" />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '4px' }}>Time booked must be logged before a task can be marked completed</span>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCompleteModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-success" disabled={!timeTaken || Number(timeTaken) <= 0}><CheckCircle2 size={16} /> Confirm Completion</button>
              </div>
            </form>
          </div>
        </div>
        </ModalPortal>
      )}

      {taskToLogTime && (
        <ModalPortal>
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setTaskToLogTime(null)}>
          <div className="modal">
            <div className="modal-header"><h3>Log Hours</h3><button className="btn-icon" onClick={() => setTaskToLogTime(null)}><X size={20} /></button></div>
            <form onSubmit={handleLogTime}>
              <div className="modal-body">
                <div style={{ padding: '14px 18px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', marginBottom: '18px', borderLeft: '4px solid var(--primary)' }}>
                  <p style={{ fontWeight: 700, marginBottom: '4px' }}>{taskToLogTime.title}</p>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Targeted: {taskToLogTime.targetedTime || 0}h</p>
                </div>
                <div className="form-group">
                  <label className="form-label">Time Taken So Far (hours)</label>
                  <input className="form-input" type="number" min="0" step="0.5" value={logTimeValue} onChange={e => setLogTimeValue(e.target.value)} placeholder="e.g., 1" autoFocus />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '4px' }}>Updates the pending completion % - task stays pending until marked completed</span>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setTaskToLogTime(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary"><Timer size={16} /> Save Hours</button>
              </div>
            </form>
          </div>
        </div>
        </ModalPortal>
      )}

      {showAddAdditionalModal && (
        <AddAdditionalTaskModal
          employees={employees}
          websites={websites}
          categories={categories}
          projects={projects}
          showProjects={showProjects}
          unitLabel={unitLabel}
          onAdd={handleAddAdditional}
          onClose={() => setShowAddAdditionalModal(false)}
          position={modalPos}
        />
      )}
      {detailTask && <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} position={modalPos} />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete Task"
          message={`Are you sure you want to permanently delete "${confirmDelete.title}"? This cannot be undone.`}
          onConfirm={executeDelete}
          onCancel={() => setConfirmDelete(null)}
          position={modalPos}
        />
      )}
    </div>
  );
}

function AddAdditionalTaskModal({ employees, websites, categories, projects, showProjects, unitLabel, onAdd, onClose, position }) {
  const { canManageTeam, myEmployeeId } = useAuth();
  // Additional tasks are inherently a member logging their own extra work, so
  // this pre-fills to the signed-in person rather than starting blank — a
  // team admin or super admin can still pick anyone.
  const [form, setForm] = useState({
    title: '',
    category: '',
    assignedTo: canManageTeam ? '' : (myEmployeeId || ''),
    websiteId: '',
    projectId: '',
    status: 'completed',
    completionUrl: '',
    referenceUrl: '',
    targetedTime: '',
    timeTaken: '',
  });

  const { originStyle } = calcModalPosition(position);
  const siteProjects = showProjects ? projects.filter(p => p.websiteId === form.websiteId) : [];
  const handleWebsiteChange = (websiteId) => {
    const stillValid = projects.some(p => p.id === form.projectId && p.websiteId === websiteId);
    setForm({ ...form, websiteId, projectId: stillValid ? form.projectId : '' });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title.trim() || !form.category || !form.assignedTo || !form.websiteId) return;

    onAdd({
      title: form.title.trim(),
      category: form.category,
      assignedTo: form.assignedTo,
      websiteId: form.websiteId,
      projectId: form.projectId,
      status: form.status,
      referenceUrl: form.referenceUrl,
      completionUrl: form.status === 'completed' ? form.completionUrl : '',
      completedDate: form.status === 'completed' ? new Date().toISOString() : null,
      priority: 'medium',
      targetedTime: form.targetedTime ? Number(form.targetedTime) : 0,
      timeTaken: form.timeTaken ? Number(form.timeTaken) : 0,
    });
    onClose();
  };

  const modal = (
    <div className="modal" style={originStyle || {}}>
      <div className="modal-header">
        <h3>Add Additional Task</h3>
        <button className="btn-icon" onClick={onClose}><X size={20} /></button>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px 14px', background: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: 'var(--radius-md)', fontSize: '0.82rem', lineHeight: 1.5 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>Tasks added here are logged as <strong>additional tasks</strong> — extra work completed outside the regular schedule. They're tracked separately from this employee's originally scheduled tasks.</span>
          </div>
          <div className="form-group">
            <label className="form-label">Task Title *</label>
            <input 
              className="form-input" 
              required 
              value={form.title} 
              onChange={e => setForm({ ...form, title: e.target.value })} 
              placeholder="e.g., Guest Post on High DA blog" 
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group">
              <label className="form-label">Category *</label>
              <select className="form-select" required value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                <option value="" disabled>Select Category</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Status *</label>
              <select className="form-select" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                <option value="completed">Completed</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group">
              <label className="form-label">Assigned To *</label>
              {canManageTeam ? (
                <select className="form-select" required value={form.assignedTo} onChange={e => setForm({ ...form, assignedTo: e.target.value })}>
                  <option value="" disabled>Select Employee</option>
                  {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                </select>
              ) : (
                <input className="form-input" value={employees.find(e => e.id === form.assignedTo)?.name || ''} disabled />
              )}
            </div>
            <div className="form-group">
              <label className="form-label">{unitLabel} *</label>
              <select className="form-select" required value={form.websiteId} onChange={e => handleWebsiteChange(e.target.value)}>
                <option value="" disabled>Select {unitLabel}</option>
                {websites.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>

          {showProjects && (
            <div className="form-group">
              <label className="form-label">Project (Optional)</label>
              <select className="form-select" value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })} disabled={!form.websiteId}>
                <option value="">{form.websiteId ? 'None' : `Select a ${unitLabel} first`}</option>
                {siteProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          {form.status === 'completed' && (
            <div className="form-group animate-in">
              <label className="form-label">Completion URL / Proof of Work (Optional)</label>
              <input 
                className="form-input" 
                type="url" 
                value={form.completionUrl} 
                onChange={e => setForm({ ...form, completionUrl: e.target.value })} 
                placeholder="https://published-article-url.com" 
              />
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group">
              <label className="form-label">Targeted Time (hrs)</label>
              <input className="form-input" type="number" min="0" step="0.5" value={form.targetedTime} onChange={e => setForm({ ...form, targetedTime: e.target.value })} placeholder="e.g., 5" />
            </div>
            <div className="form-group">
              <label className="form-label">Time Taken (hrs)</label>
              <input className="form-input" type="number" min="0" step="0.5" value={form.timeTaken} onChange={e => setForm({ ...form, timeTaken: e.target.value })} placeholder="e.g., 4" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Reference URL (Optional)</label>
            <input 
              className="form-input" 
              type="url" 
              value={form.referenceUrl} 
              onChange={e => setForm({ ...form, referenceUrl: e.target.value })} 
              placeholder="https://..." 
            />
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save Additional Task</button>
        </div>
      </form>
    </div>
  );

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
        {modal}
      </div>
    </ModalPortal>
  );
}
