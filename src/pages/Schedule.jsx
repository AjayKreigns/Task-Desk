import React, { useState, useMemo, useEffect } from 'react';
import { calcModalPosition } from '../lib/modalPosition';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { Plus, Upload, X, FileSpreadsheet, Trash2, Edit3, CheckCircle2, AlertCircle, Download, Eye, Clock, Search, Filter } from 'lucide-react';
import * as XLSX from 'xlsx';
import TaskDetailModal from '../components/TaskDetailModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { ArrowRightCircle } from 'lucide-react';
import { getTaskPercent, getTaskPendingPercent, isTaskExceeded, getEffectiveStatus } from '../lib/taskProgress';
import { sanitizeExcelRow } from '../lib/excelSafety';
import { isPastPeriod } from '../lib/periodLock';
import ModalPortal from '../components/ModalPortal';
import PeriodToggle from '../components/PeriodToggle';

// Shared by the carry-forward confirm dialog's message and the actual action
// so the destination month is never computed two different ways.
function getCarryForwardTarget(task, fallbackMonth, fallbackYear) {
  let nextMonth = (task.month || fallbackMonth) + 1;
  let nextYear = task.year || fallbackYear;
  if (nextMonth > 12) { nextMonth = 1; nextYear++; }
  return { nextMonth, nextYear };
}

export default function Schedule({ selectedMonth, selectedYear, selectedWebsite, selectedProject, intent, onIntentConsumed, filterEmployee, setFilterEmployee, filterCategory, setFilterCategory }) {
  const { tasks, tasksById, employees, websites, categories, projects, addTask, addBulkTasks, updateTask, deleteTask, getEmployeeName, getWebsiteName, getProjectName, unitLabel, currentTeam } = useApp();
  // Digital Marketing never has Projects — see supabase_projects_table.sql.
  const showProjects = !currentTeam?.is_lead_source_team;
  const { canManageTeam, isViewer, canViewAll, myEmployeeId, isMe, isSuperAdmin } = useAuth();
  // Only a super admin may still add/edit/delete once a period has ended —
  // a team's own admin (canManageTeam is true for both) is locked out too.
  // Carry Forward is deliberately exempt (see executeCarryForward/its button
  // below) — it's the normal way a stale past-month task gets resolved.
  const periodLocked = isPastPeriod(selectedMonth, selectedYear) && !isSuperAdmin;
  const periodLockedTitle = periodLocked
    ? `Can't add tasks to ${new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' })} — it has ended`
    : undefined;
  const { notify } = useNotification();
  const [showSingleModal, setShowSingleModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [detailTask, setDetailTask] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmCarryForward, setConfirmCarryForward] = useState(null);
  const [modalPos, setModalPos] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  // filterEmployee/filterCategory are lifted to App.jsx (passed down as
  // props) rather than local state, so they survive this component
  // unmounting on every tab switch instead of resetting back to default.
  const [period, setPeriod] = useState('month');
  const [appliedIntent, setAppliedIntent] = useState(null);
  const isYearView = period === 'year';

  // Apply a drill-down handed over from Dashboard (the category donut,
  // website bars, trend points, or employee bars — all four now funnel
  // through the same intent shape). Adjusting state during render (rather
  // than in an effect) is React's recommended way to react to a changed
  // prop — it re-renders before painting, so the filters are already correct
  // on the first frame the user sees.
  //
  // Both fields default to 'all' if the intent didn't specify them — a click
  // from Dashboard means "show me exactly this slice", so a dimension the
  // click wasn't about resets rather than leaving a stale filter from
  // whatever was picked on a previous visit to this page.
  if (intent && intent.nonce !== appliedIntent) {
    setAppliedIntent(intent.nonce);
    setPeriod(intent.period === 'year' ? 'year' : 'month');
    setFilterCategory(intent.category ?? 'all');
    setFilterEmployee(intent.employee ?? 'all');
  }

  // Tells App.jsx the intent it handed over has now been applied, so it goes
  // back to null there. Otherwise leaving this tab and coming back would find
  // the same (now stale) intent object still sitting in App's state — and
  // since this whole component unmounts on every tab switch, appliedIntent
  // above would be back to its initial null too, so the guard above would
  // treat it as new again and silently reapply it, overwriting any filters
  // set manually since. Runs after commit (not during render, unlike the
  // block above) since clearing the PARENT's state has no bearing on what
  // this render needs to show.
  useEffect(() => {
    if (appliedIntent !== null) onIntentConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedIntent]);

  const hasActiveFilters = filterCategory !== 'all'
    || filterEmployee !== (canViewAll ? 'all' : (myEmployeeId || 'all'))
    || searchQuery !== '';

  const clearFilters = () => {
    setFilterCategory('all');
    setFilterEmployee(canViewAll ? 'all' : (myEmployeeId || 'all'));
    setSearchQuery('');
  };

  const handleOpenModal = (e, setter, value) => {
    if (e && e.clientX) {
      setModalPos({ x: e.clientX, y: e.clientY });
    } else {
      setModalPos(null);
    }
    setter(value);
  };

  // Tasks in the selected period + website — the scope the category dropdown
  // is built from, so it only offers categories that exist in what you're viewing.
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
      (filterCategory === 'all' || (t.category || 'General') === filterCategory) &&
      (searchQuery === '' || t.title.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  }, [periodTasks, filterEmployee, filterCategory, searchQuery]);

  const groupedTasks = useMemo(() => {
    const grouped = {};
    filteredTasks.forEach(t => {
      const cat = t.category || 'General';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(t);
    });
    return grouped;
  }, [filteredTasks]);

  const handleAddTask = async (task) => {
    const result = await addTask(task);
    if (result) notify('task_created', 'Task Scheduled', `"${result.title}" has been added`);
  };

  const handleBulkAdd = async (taskList) => {
    const results = await addBulkTasks(taskList);
    if (results?.length) notify('task_created', 'Bulk Tasks Added', `${results.length} tasks scheduled`);
  };

  const handleDelete = (task) => {
    setConfirmDelete(task);
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    // updateTask/deleteTask/completeTask report their own error toast on failure
    // (permission denied, expired session, etc). This success toast and the modal
    // close must only follow a confirmed write — otherwise a rejected delete would
    // show "Task Deleted" right next to the error that says it wasn't.
    const ok = await deleteTask(confirmDelete.id);
    if (ok) notify('task_deleted', 'Task Deleted', `"${confirmDelete.title}" removed`);
    setConfirmDelete(null);
  };

  const handleEditSave = async (id, data) => {
    const ok = await updateTask(id, data);
    if (!ok) return; // leave the modal open so the edit isn't lost
    notify('task_edited', 'Task Updated', `"${data.title}" has been updated`);
    setEditingTask(null);
    setModalPos(null);
  };

  const executeCarryForward = async (task) => {
    // Advance from the task's own month — in the full-year view the rows span
    // several months, so selectedMonth is not the right base.
    const { nextMonth, nextYear } = getCarryForwardTarget(task, selectedMonth, selectedYear);

    const newTask = {
      ...task,
      id: undefined, // Let context generate new ID
      title: task.title.includes('(Carry Forwarded)') ? task.title : `${task.title} (Carry Forwarded)`,
      month: nextMonth,
      year: nextYear,
      status: 'pending', // Reset status for new month
      completionUrl: '',
      completedDate: null,
      carryForwardFrom: task.id,
      carryForwardTo: null,
    };

    const insertedTask = await addTask(newTask);
    if (insertedTask) {
      // The new task already exists even if this link-back update fails, so a
      // failure here doesn't need to undo the carry-forward — it only means the
      // new task won't record which task it came from. Still worth its own
      // wording rather than a blanket success message.
      const linked = await updateTask(task.id, { carryForwardTo: insertedTask.id });
      notify('success', 'Task Carried Forward', `"${task.title}" moved to ${new Date(nextYear, nextMonth - 1).toLocaleString('default', { month: 'long' })}`);
      if (!linked) {
        notify('warning', 'Link not saved', 'The new task was created, but linking it back to the original was not saved.');
      }
    }
  };

  const exportExcel = () => {
    const rows = filteredTasks.map(t => sanitizeExcelRow({
      ...(isYearView ? { 'Month': new Date(t.year, t.month - 1).toLocaleString('default', { month: 'short' }) } : {}),
      'Task': t.title, 'Category': t.category || 'General',
      'Assigned To': getEmployeeName(t.assignedTo), [unitLabel]: getWebsiteName(t.websiteId),
      ...(showProjects ? { 'Project': t.projectId ? getProjectName(t.projectId) : '' } : {}),
      'Priority': t.priority || 'medium', 'Status': t.status,
      'Targeted Time (hrs)': t.targetedTime || '',
      'Reference URL': t.referenceUrl || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
    const periodLabel = isYearView
      ? `FullYear-${selectedYear}`
      : `${new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long' })}-${selectedYear}`;
    XLSX.writeFile(wb, `Schedule-${periodLabel}.xlsx`);
  };

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h3>Schedule Management</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
            {isYearView ? `All of ${selectedYear}` : new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' })}
            {' • '}{filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <PeriodToggle period={period} onChange={setPeriod} year={selectedYear} />
          {filteredTasks.length > 0 && (
            <button className="btn btn-secondary" onClick={exportExcel}><Download size={16} /> Export Excel</button>
          )}
          {/* Both of these create tasks for MULTIPLE people at once — inherently a
              team-scheduling operation, not something that fits "each employee
              manages their own tasks". The single Add Task flow below covers a
              member's need; it's just locked to assigning themselves. */}
          {canManageTeam && (
            <>
              <button className="btn btn-secondary" disabled={periodLocked} title={periodLockedTitle} onClick={(e) => handleOpenModal(e, setShowUploadModal, true)}><Upload size={16} /> Upload Excel</button>
              <button className="btn btn-secondary" disabled={periodLocked} title={periodLockedTitle} onClick={(e) => handleOpenModal(e, setShowBulkModal, true)}><FileSpreadsheet size={16} /> Bulk Entry</button>
            </>
          )}
          {!isViewer && <button className="btn btn-primary" disabled={periodLocked} title={periodLockedTitle} onClick={(e) => handleOpenModal(e, setShowSingleModal, true)}><Plus size={16} /> Add Task</button>}
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div className="card-body" style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <Filter size={16} style={{ color: 'var(--text-muted)' }} />
          <div className="filter-group">
            <Search size={14} style={{ color: 'var(--text-light)' }} />
            <input className="form-input" style={{ border: 'none', background: 'transparent', padding: '4px 8px', fontSize: '0.85rem' }} placeholder="Search tasks..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          {/* A member can now only ever see their own tasks (enforced by the
              database, not just this default) — a dropdown listing everyone
              else would just show empty results with no explanation for any
              other choice, so it's replaced with a plain label instead. */}
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

      {Object.keys(groupedTasks).length === 0 ? (
        <div className="empty-state">
          <CalendarIcon />
          <h4>No tasks scheduled</h4>
          <p>{filterCategory !== 'all'
            ? `No "${filterCategory}" tasks in ${isYearView ? selectedYear : new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' })}`
            : `Add tasks for ${isYearView ? selectedYear : new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' })}`}</p>
        </div>
      ) : (
        Object.entries(groupedTasks).map(([category, catTasks]) => (
          <div key={category} style={{ marginBottom: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', paddingBottom: '8px', borderBottom: '2px solid var(--primary)' }}>
              <span style={{ background: 'var(--primary-bg)', color: 'var(--primary)', padding: '4px 12px', borderRadius: 'var(--radius-full)', fontSize: '0.78rem', fontWeight: 700 }}>{category}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{catTasks.length} task{catTasks.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Task</th>{isYearView && <th>Month</th>}<th>Assigned To</th><th>{unitLabel}</th>{showProjects && <th>Project</th>}<th>Priority</th><th>Target Hrs</th><th>Status</th><th>URL</th><th style={{ width: 100 }}></th></tr></thead>
                <tbody>
                  {catTasks.map(task => {
                    const rowLocked = isPastPeriod(task.month, task.year) && !isSuperAdmin;
                    return (
                    <tr key={task.id}>
                      <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {task.title}
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
                      <td><span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--primary-bg)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>{getEmployeeName(task.assignedTo).charAt(0)}</span>
                        {getEmployeeName(task.assignedTo)}
                      </span></td>
                      <td><span style={{ fontSize: '0.825rem' }}>{getWebsiteName(task.websiteId)}</span></td>
                      {showProjects && (
                        <td><span style={{ fontSize: '0.825rem' }}>{task.projectId ? getProjectName(task.projectId) : <span style={{ color: 'var(--text-light)' }}>—</span>}</span></td>
                      )}
                      <td><span className={`badge badge-${task.priority || 'medium'}`}>{task.priority || 'Medium'}</span></td>
                      <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {task.targetedTime ? `${task.targetedTime} hrs` : <span style={{ color: 'var(--text-light)' }}>—</span>}
                      </td>
                      <td style={{ minWidth: '130px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {(() => {
                            const pct = getTaskPercent(task);
                            const pendingPct = getTaskPendingPercent(task);
                            const exceeded = isTaskExceeded(task);
                            // Follows carryForwardTo to wherever the work actually ended
                            // up, so an original whose successor is now done reads
                            // "Completed" here too, instead of "Carried Forward" forever.
                            const effStatus = getEffectiveStatus(task, tasksById);
                            return (
                              <>
                                <span className={`badge badge-${effStatus === 'completed' ? 'success' : effStatus === 'carried_forward' ? 'info' : 'pending'}`} style={{ alignSelf: 'flex-start' }}>
                                  {effStatus === 'completed' ? <><CheckCircle2 size={12} /> Completed</>
                                    : effStatus === 'carried_forward' ? <><ArrowRightCircle size={12} /> Carried Forward</>
                                    : <><Clock size={12} /> {pendingPct}% Pending</>}
                                </span>
                                <div style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                                  <div style={{
                                    width: `${pct}%`,
                                    background: task.status === 'completed' ? 'var(--success)' : exceeded ? 'var(--danger)' : 'var(--primary)',
                                    height: '100%',
                                    transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
                                  }} />
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      </td>
                      <td>{task.referenceUrl ? <a href={task.referenceUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem' }}>View ↗</a> : <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                      <td><div style={{ display: 'flex', gap: '2px' }}>
                        <button className="btn-icon" onClick={(e) => handleOpenModal(e, setDetailTask, task)} title="Details"><Eye size={15} /></button>
                        {/* Edit/Carry-Forward/Delete all write — a viewer (read-
                            only admin) gets none of them, matching RLS giving
                            them zero write access regardless of assigned_to. */}
                        {!isViewer && (
                          <>
                            <button className="btn-icon" disabled={rowLocked} title={rowLocked ? "This task's month has ended — only a super admin can edit it now" : "Edit"} onClick={(e) => handleOpenModal(e, setEditingTask, task)}><Edit3 size={15} /></button>
                            {/* Carry Forward is deliberately NOT gated by rowLocked —
                                it's the normal way a stale past-month task gets
                                resolved, not an edit to the task in place. */}
                            <button className="btn-icon" onClick={(e) => handleOpenModal(e, setConfirmCarryForward, task)} title="Carry Forward to Next Month"><ArrowRightCircle size={15} style={{ color: 'var(--secondary)' }} /></button>
                          </>
                        )}
                        {/* Matches the tasks DELETE policy exactly: admin, or the
                            task's own assignee (and never a viewer). Hidden
                            rather than disabled, so nobody sees a control that
                            would just be rejected by the database anyway. */}
                        {(canManageTeam || (!isViewer && isMe(task.assignedTo))) && (
                          <button className="btn-icon" disabled={rowLocked} title={rowLocked ? "This task's month has ended — only a super admin can delete it now" : "Delete"} onClick={() => handleDelete(task)}><Trash2 size={15} /></button>
                        )}
                      </div></td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {showSingleModal && <SingleTaskModal employees={employees} websites={websites} categories={categories} projects={projects} showProjects={showProjects} unitLabel={unitLabel} selectedMonth={selectedMonth} selectedYear={selectedYear} selectedWebsite={selectedWebsite} onAdd={handleAddTask} onClose={() => setShowSingleModal(false)} position={modalPos} />}
      {showBulkModal && <BulkTaskModal employees={employees} websites={websites} categories={categories} projects={projects} showProjects={showProjects} unitLabel={unitLabel} selectedMonth={selectedMonth} selectedYear={selectedYear} onAdd={handleBulkAdd} onClose={() => setShowBulkModal(false)} position={modalPos} />}
      {showUploadModal && <ExcelUploadModal employees={employees} websites={websites} categories={categories} projects={projects} showProjects={showProjects} unitLabel={unitLabel} selectedMonth={selectedMonth} selectedYear={selectedYear} onAdd={handleBulkAdd} onClose={() => setShowUploadModal(false)} position={modalPos} />}
      {editingTask && <EditTaskModal task={editingTask} employees={employees} websites={websites} categories={categories} projects={projects} showProjects={showProjects} unitLabel={unitLabel} onSave={handleEditSave} onClose={() => setEditingTask(null)} position={modalPos} />}
      {detailTask && <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} position={modalPos} />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete Task"
          message={`Are you sure you want to delete "${confirmDelete.title}"? This action cannot be undone.`}
          onConfirm={executeDelete}
          onCancel={() => setConfirmDelete(null)}
          position={modalPos}
        />
      )}
      {confirmCarryForward && (() => {
        const { nextMonth, nextYear } = getCarryForwardTarget(confirmCarryForward, selectedMonth, selectedYear);
        const monthLabel = new Date(nextYear, nextMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
        return (
          <ConfirmDialog
            title="Carry Forward Task?"
            message={`Move "${confirmCarryForward.title}" to ${monthLabel}? A new pending task is created there, linked back to this one.`}
            confirmLabel="Carry Forward"
            tone="neutral"
            onConfirm={async () => { await executeCarryForward(confirmCarryForward); setConfirmCarryForward(null); }}
            onCancel={() => setConfirmCarryForward(null)}
            position={modalPos}
          />
        );
      })()}
    </div>
  );
}

function CalendarIcon() {
  return <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>;
}

// === EDIT TASK MODAL ===
function EditTaskModal({ task, employees, websites, categories, projects, showProjects, unitLabel, onSave, onClose, position }) {
  const { canManageTeam } = useAuth();
  const [form, setForm] = useState({
    title: task.title, category: task.category || 'SEO', assignedTo: task.assignedTo,
    websiteId: task.websiteId, projectId: task.projectId || '', priority: task.priority || 'medium', referenceUrl: task.referenceUrl || '',
    targetedTime: task.targetedTime || '',
    month: task.month, year: task.year,
  });
  const { originStyle } = calcModalPosition(position);
  const siteProjects = showProjects ? projects.filter(p => p.websiteId === form.websiteId) : [];
  // Switching the company can orphan a project that belonged to the OLD one.
  const handleWebsiteChange = (websiteId) => {
    const stillValid = projects.some(p => p.id === form.projectId && p.websiteId === websiteId);
    setForm({ ...form, websiteId, projectId: stillValid ? form.projectId : '' });
  };
  const handleSubmit = (e) => { e.preventDefault(); onSave(task.id, form); };
  const modal = (
    <div className="modal" style={originStyle || {}}>
      <div className="modal-header"><h3>Edit Task</h3><button className="btn-icon" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={handleSubmit}>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="form-group"><label className="form-label">Task Title *</label><input className="form-input" required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group"><label className="form-label">Category</label><select className="form-select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="form-group"><label className="form-label">Priority</label><select className="form-select" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group">
              <label className="form-label">Assigned To</label>
              {canManageTeam ? (
                <select className="form-select" value={form.assignedTo} onChange={e => setForm({ ...form, assignedTo: e.target.value })}>{employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}</select>
              ) : (
                // Reassigning a task away from yourself would be rejected by the
                // database anyway (the update policy checks assigned_to stays
                // yours unless you're a team admin or super admin) — shown as
                // fixed text instead of a control that would just fail on save.
                <input className="form-input" value={employees.find(e => e.id === form.assignedTo)?.name || ''} disabled />
              )}
            </div>
            <div className="form-group"><label className="form-label">{unitLabel}</label><select className="form-select" value={form.websiteId} onChange={e => handleWebsiteChange(e.target.value)}>{websites.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
          </div>
          {showProjects && (
            <div className="form-group">
              <label className="form-label">Project</label>
              <select className="form-select" value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })}>
                <option value="">None</option>
                {siteProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group"><label className="form-label">Reference URL</label><input className="form-input" type="url" value={form.referenceUrl} onChange={e => setForm({ ...form, referenceUrl: e.target.value })} placeholder="https://..." /></div>
            <div className="form-group"><label className="form-label">Targeted Time (hours)</label><input className="form-input" type="number" min="0" step="0.5" value={form.targetedTime} onChange={e => setForm({ ...form, targetedTime: e.target.value ? Number(e.target.value) : '' })} placeholder="e.g., 5" /></div>
          </div>
        </div>
        <div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary">Save Changes</button></div>
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

// === SINGLE TASK MODAL ===
function SingleTaskModal({ employees, websites, categories, projects, showProjects, unitLabel, selectedMonth, selectedYear, selectedWebsite, onAdd, onClose, position }) {
  const { canManageTeam, myEmployeeId } = useAuth();
  // Members can only ever create a task assigned to themselves (the insert
  // policy checks this), so the field starts pre-filled with their own id
  // rather than empty.
  const [form, setForm] = useState({ title: '', category: '', assignedTo: canManageTeam ? '' : (myEmployeeId || ''), websiteId: '', projectId: '', priority: 'medium', referenceUrl: '', targetedTime: '', month: selectedMonth, year: selectedYear });
  const { originStyle } = calcModalPosition(position);
  const siteProjects = showProjects ? projects.filter(p => p.websiteId === form.websiteId) : [];
  const handleWebsiteChange = (websiteId) => {
    const stillValid = projects.some(p => p.id === form.projectId && p.websiteId === websiteId);
    setForm({ ...form, websiteId, projectId: stillValid ? form.projectId : '' });
  };
  const handleSubmit = (e) => { e.preventDefault(); onAdd(form); onClose(); };
  const modal = (
    <div className="modal" style={originStyle || {}}>
      <div className="modal-header"><h3>Add Scheduled Task</h3><button className="btn-icon" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={handleSubmit}>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="form-group"><label className="form-label">Task Title *</label><input className="form-input" required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g., Write 5 blog posts for SEO" /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group"><label className="form-label">Category *</label><select className="form-select" required value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}><option value="" disabled>Select Category</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="form-group"><label className="form-label">Priority</label><select className="form-select" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group">
              <label className="form-label">Assigned To *</label>
              {canManageTeam ? (
                <select className="form-select" required value={form.assignedTo} onChange={e => setForm({ ...form, assignedTo: e.target.value })}><option value="" disabled>Select Employee</option>{employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}</select>
              ) : (
                <input className="form-input" value={employees.find(e => e.id === form.assignedTo)?.name || ''} disabled />
              )}
            </div>
            <div className="form-group"><label className="form-label">{unitLabel} *</label><select className="form-select" required value={form.websiteId} onChange={e => handleWebsiteChange(e.target.value)}><option value="" disabled>Select {unitLabel}</option>{websites.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div className="form-group"><label className="form-label">Reference URL (Optional)</label><input className="form-input" type="url" value={form.referenceUrl} onChange={e => setForm({ ...form, referenceUrl: e.target.value })} placeholder="https://..." /></div>
            <div className="form-group"><label className="form-label">Targeted Time (hrs)</label><input className="form-input" type="number" min="0" step="0.5" value={form.targetedTime} onChange={e => setForm({ ...form, targetedTime: e.target.value ? Number(e.target.value) : '' })} placeholder="e.g., 5" /></div>
          </div>
        </div>
        <div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary">Save Task</button></div>
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

// === BULK TASK MODAL ===
function BulkTaskModal({ employees, websites, categories, projects, showProjects, unitLabel, selectedMonth, selectedYear, onAdd, onClose, position }) {
  const emptyRow = { title: '', category: categories[0] || 'Other', assignedTo: employees[0]?.id || '', websiteId: websites[0]?.id || '', projectId: '', priority: 'medium', referenceUrl: '', targetedTime: '' };
  const [rows, setRows] = useState([{ ...emptyRow }, { ...emptyRow }, { ...emptyRow }, { ...emptyRow }, { ...emptyRow }]);
  const { originStyle } = calcModalPosition(position);
  const updateRow = (idx, field, value) => {
    const u = [...rows];
    u[idx] = { ...u[idx], [field]: value };
    // Switching a row's company can orphan a project that belonged to the OLD one.
    if (field === 'websiteId') {
      const stillValid = projects.some(p => p.id === u[idx].projectId && p.websiteId === value);
      if (!stillValid) u[idx].projectId = '';
    }
    setRows(u);
  };
  const addRow = () => setRows([...rows, { ...emptyRow }]);
  const removeRow = (idx) => setRows(rows.filter((_, i) => i !== idx));
  const handleSubmit = (e) => { e.preventDefault(); const valid = rows.filter(r => r.title.trim()); if (!valid.length) return; onAdd(valid.map(r => ({ ...r, month: selectedMonth, year: selectedYear }))); onClose(); };
  const bulkModal = (
    <div className="modal modal-lg" style={originStyle || {}}>
        <div className="modal-header"><h3>Bulk Entry - Add Multiple Tasks</h3><button className="btn-icon" onClick={onClose}><X size={20} /></button></div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: '0.82rem' }}>
              <thead><tr><th>Task Title *</th><th>Category</th><th>Assigned To</th><th>{unitLabel}</th>{showProjects && <th>Project</th>}<th>Priority</th><th>Target Hrs</th><th style={{ width: 40 }}></th></tr></thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={idx}>
                    <td><input className="form-input" style={{ padding: '6px 10px', fontSize: '0.82rem' }} value={row.title} onChange={e => updateRow(idx, 'title', e.target.value)} placeholder="Task title" /></td>
                    <td><select className="form-select" style={{ padding: '6px 8px', fontSize: '0.82rem' }} value={row.category} onChange={e => updateRow(idx, 'category', e.target.value)}>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></td>
                    <td><select className="form-select" style={{ padding: '6px 8px', fontSize: '0.82rem' }} value={row.assignedTo} onChange={e => updateRow(idx, 'assignedTo', e.target.value)}>{employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}</select></td>
                    <td><select className="form-select" style={{ padding: '6px 8px', fontSize: '0.82rem' }} value={row.websiteId} onChange={e => updateRow(idx, 'websiteId', e.target.value)}>{websites.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></td>
                    {showProjects && (
                      <td><select className="form-select" style={{ padding: '6px 8px', fontSize: '0.82rem' }} value={row.projectId} onChange={e => updateRow(idx, 'projectId', e.target.value)}>
                        <option value="">None</option>
                        {projects.filter(p => p.websiteId === row.websiteId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select></td>
                    )}
                    <td><select className="form-select" style={{ padding: '6px 8px', fontSize: '0.82rem' }} value={row.priority} onChange={e => updateRow(idx, 'priority', e.target.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></td>
                    <td><input className="form-input" type="number" min="0" step="0.5" style={{ padding: '6px 10px', fontSize: '0.82rem', width: '70px' }} value={row.targetedTime} onChange={e => updateRow(idx, 'targetedTime', e.target.value ? Number(e.target.value) : '')} placeholder="Hrs" /></td>
                    <td><button type="button" className="btn-icon" onClick={() => removeRow(idx)}><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="btn btn-secondary btn-sm" onClick={addRow} style={{ marginTop: '12px' }}><Plus size={14} /> Add Row</button>
          </div>
          <div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary">Save All Tasks</button></div>
        </form>
      </div>
  );
  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
        {bulkModal}
      </div>
    </ModalPortal>
  );
}

// === EXCEL UPLOAD MODAL ===
function ExcelUploadModal({ employees, websites, categories, projects, showProjects, unitLabel, selectedMonth, selectedYear, onAdd, onClose, position }) {
  const [previewData, setPreviewData] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = React.useRef(null);
  const { originStyle } = calcModalPosition(position);

  const processFile = (file) => {
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws);
        if (json.length === 0) { setError('No data found in the file.'); return; }
        const mapped = json.map(row => {
          const empName = (row['Assigned To'] || row['assigned_to'] || row['Employee'] || '').toString().trim();
          // A previously-downloaded template may use this team's own label
          // (e.g. "Company") instead of the literal "Website"/"Site" — both
          // still have to work so an old export keeps importing correctly.
          const siteName = (row[unitLabel] || row['Website'] || row['website'] || row['Site'] || '').toString().trim();
          const emp = employees.find(e => e.name.toLowerCase() === empName.toLowerCase());
          const site = websites.find(w => w.name.toLowerCase() === siteName.toLowerCase());
          // Optional — unlike the company column, an unmatched project name
          // is left blank rather than falling back to some other project,
          // since "no project" is itself a perfectly valid, common case.
          const projectName = showProjects ? (row['Project'] || row['project'] || '').toString().trim() : '';
          const project = projectName
            ? projects.find(p => p.websiteId === (site?.id || '') && p.name.toLowerCase() === projectName.toLowerCase())
            : null;
          return {
            title: row['Task'] || row['task'] || row['Title'] || row['title'] || '',
            category: row['Category'] || row['category'] || 'Other',
            assignedTo: emp?.id || employees[0]?.id || '', assignedToName: emp?.name || empName || 'Unmatched',
            websiteId: site?.id || websites[0]?.id || '', websiteName: site?.name || siteName || 'Unmatched',
            projectId: project?.id || '', projectName: project?.name || (projectName ? `${projectName} (not found)` : ''),
            priority: (row['Priority'] || row['priority'] || 'medium').toString().toLowerCase(),
            referenceUrl: row['URL'] || row['url'] || row['Reference URL'] || '',
            targetedTime: Number(row['Targeted Time'] || row['targetedTime'] || row['Time'] || 0) || '',
            matched: !!emp && !!site,
          };
        }).filter(r => r.title);
        setPreviewData(mapped);
      } catch { setError('Failed to parse file. Please use .xlsx or .csv format.'); }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); };
  const handleImport = () => { if (!previewData) return; onAdd(previewData.map(({ title, category, assignedTo, websiteId, projectId, priority, referenceUrl, targetedTime }) => ({ title, category, assignedTo, websiteId, projectId, priority, referenceUrl, targetedTime, month: selectedMonth, year: selectedYear }))); onClose(); };
  const downloadTemplate = () => {
    const t = [{ 'Task': 'Write SEO Blog Post', 'Category': categories[0] || 'Other', 'Assigned To': employees[0]?.name || 'Employee', [unitLabel]: websites[0]?.name || 'example.com', ...(showProjects ? { 'Project': '' } : {}), 'Priority': 'high', 'URL': '', 'Targeted Time': 5 }];
    const ws = XLSX.utils.json_to_sheet(t); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Schedule'); XLSX.writeFile(wb, 'schedule_template.xlsx');
  };

  const uploadModal = (
    <div className="modal modal-lg" style={originStyle || {}}>
        <div className="modal-header"><h3>Upload Excel Schedule</h3><button className="btn-icon" onClick={onClose}><X size={20} /></button></div>
        <div className="modal-body">
          {!previewData ? (
            <>
              <div className={`upload-zone ${dragOver ? 'dragover' : ''}`} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop} onClick={() => fileRef.current?.click()}>
                <Upload size={36} style={{ color: 'var(--primary)', marginBottom: '12px' }} />
                <h4 style={{ marginBottom: '6px' }}>Drag & Drop your Excel file here</h4>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>or click to browse • Supports .xlsx and .csv</p>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); }} />
              </div>
              {error && <div style={{ marginTop: '12px', padding: '10px 14px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}><AlertCircle size={16} /> {error}</div>}
              <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Columns: Task, Category, Assigned To, {unitLabel}{showProjects ? ', Project (optional)' : ''}, Priority, URL, Targeted Time</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={downloadTemplate}><FileSpreadsheet size={14} /> Download Template</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>Preview: {previewData.length} tasks found</span>
                <button className="btn btn-secondary btn-sm" onClick={() => setPreviewData(null)}>← Back</button>
              </div>
              <div style={{ maxHeight: '350px', overflow: 'auto', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                <table className="data-table">
                  <thead><tr><th>Task</th><th>Category</th><th>Assigned To</th><th>{unitLabel}</th>{showProjects && <th>Project</th>}<th>Priority</th><th>Match</th></tr></thead>
                  <tbody>{previewData.map((row, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 500 }}>{row.title}</td><td>{row.category}</td>
                      <td style={{ color: row.matched ? 'inherit' : 'var(--warning)' }}>{row.assignedToName}</td>
                      <td style={{ color: row.matched ? 'inherit' : 'var(--warning)' }}>{row.websiteName}</td>
                      {showProjects && (
                        <td style={{ color: row.projectName && !row.projectId ? 'var(--warning)' : 'inherit' }}>{row.projectName || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                      )}
                      <td><span className={`badge badge-${row.priority}`}>{row.priority}</span></td>
                      <td>{row.matched ? <CheckCircle2 size={16} style={{ color: 'var(--success)' }} /> : <AlertCircle size={16} style={{ color: 'var(--warning)' }} />}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {previewData && <button type="button" className="btn btn-primary" onClick={handleImport}>Import {previewData.length} Tasks</button>}
        </div>
      </div>
  );
  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
        {uploadModal}
      </div>
    </ModalPortal>
  );
}
