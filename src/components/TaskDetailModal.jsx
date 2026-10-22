import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { useNotification } from '../context/NotificationContext';
import { X, MessageSquare, Activity, Send, Clock, Link as LinkIcon, ArrowRightCircle } from 'lucide-react';
import { calcModalPosition } from '../lib/modalPosition';
import { getTaskPendingPercent, getEffectiveStatus } from '../lib/taskProgress';
import ModalPortal from './ModalPortal';

function timeAgo(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function TaskDetailModal({ task, onClose, position }) {
  const { tasks, tasksById, getEmployeeName, getWebsiteName, getProjectName, addComment, getTaskComments, activityLog, updateTask, unitLabel, currentTeam } = useApp();
  const { notify } = useNotification();
  const [activeTab, setActiveTab] = useState('comments');
  const [newComment, setNewComment] = useState('');
  const [completionUrl, setCompletionUrl] = useState(task.completionUrl || '');
  const [isSavingUrl, setIsSavingUrl] = useState(false);

  const comments = getTaskComments(task.id);
  const taskActivities = useMemo(() =>
    activityLog.filter(a => a.taskId === task.id).slice(0, 30),
    [activityLog, task.id]
  );

  const { originStyle } = calcModalPosition(position, 750, 580);

  const handleAddComment = (e) => {
    e.preventDefault();
    if (!newComment.trim()) return;
    addComment(task.id, newComment.trim());
    notify('info', 'Comment Added', `New comment on "${task.title}"`);
    setNewComment('');
  };

  const handleUpdateUrl = async () => {
    setIsSavingUrl(true);
    const ok = await updateTask(task.id, { completionUrl });
    if (ok) notify('success', 'URL Updated', 'Task proof URL updated.');
    setIsSavingUrl(false);
  };

  const modal = (
    <div className="modal modal-lg" style={originStyle || {}}>
      <div className="modal-header">
        <h3>Task Details</h3>
        <button className="btn-icon" onClick={onClose}><X size={20} /></button>
      </div>

      <div className="modal-body" style={{ padding: 0 }}>
        {/* Task Info Card */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg-input)' }}>
          <h4 style={{ fontSize: '1.1rem', marginBottom: '10px' }}>{task.title}</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '0.85rem' }}>
            <span><strong>Category:</strong> {task.category || 'General'}</span>
            <span><strong>Assigned:</strong> {getEmployeeName(task.assignedTo)}</span>
            <span><strong>{unitLabel}:</strong> {getWebsiteName(task.websiteId)}</span>
            {!currentTeam?.is_lead_source_team && task.projectId && (
              <span><strong>Project:</strong> {getProjectName(task.projectId)}</span>
            )}
            <span><strong>Priority:</strong> <span className={`badge badge-${task.priority || 'medium'}`}>{task.priority || 'Medium'}</span></span>
            {(() => {
              // Follows carryForwardTo to wherever the work actually ended up —
              // an original whose successor is now done reads "Completed" here
              // too, instead of "Carried Forward" forever.
              const effStatus = getEffectiveStatus(task, tasksById);
              return (
                <span><strong>Status:</strong> <span className={`badge badge-${effStatus === 'completed' ? 'success' : effStatus === 'carried_forward' ? 'info' : 'pending'}`}>
                  {effStatus === 'completed' ? 'Completed' : effStatus === 'carried_forward' ? 'Carried Forward' : `${getTaskPendingPercent(task)}% Pending`}
                </span></span>
              );
            })()}
            {task.targetedTime > 0 && <span><strong>Hours:</strong> {task.timeTaken || 0}h / {task.targetedTime}h</span>}
          </div>
          {/* Carry-forward lineage — this modal previously showed none at
              all, despite having the most room for it. Both directions:
              where this task came from, and (for an original that's since
              moved on) where it went. Just the linked title, not a jump link
              — that would need cross-month navigation state this modal
              doesn't have; the title alone is enough to find it. */}
          {(task.carryForwardFrom || task.carryForwardTo) && (
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.82rem', color: 'var(--info)' }}>
              {task.carryForwardFrom && (() => {
                const prior = tasks.find(t => t.id === task.carryForwardFrom);
                return (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ArrowRightCircle size={14} /> Carried forward from: <strong>{prior ? prior.title : 'a previous task'}</strong>
                  </span>
                );
              })()}
              {task.carryForwardTo && (() => {
                const next = tasks.find(t => t.id === task.carryForwardTo);
                return (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ArrowRightCircle size={14} /> Carried forward to: <strong>{next ? next.title : 'next month'}</strong>
                  </span>
                );
              })()}
            </div>
          )}
        </div>

        {/* Completion URL Input */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
          <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
            <LinkIcon size={14} /> Completion URL / Proof of Work
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              type="url"
              value={completionUrl}
              onChange={e => setCompletionUrl(e.target.value)}
              placeholder="https://..."
            />
            <button
              className="btn btn-primary"
              onClick={handleUpdateUrl}
              disabled={isSavingUrl}
            >
              {isSavingUrl ? 'Saving...' : 'Save URL'}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="tab-bar" style={{ padding: '0 24px', marginBottom: 0 }}>
          <div className={`tab-item ${activeTab === 'comments' ? 'active' : ''}`} onClick={() => setActiveTab('comments')}>
            <MessageSquare size={15} /> Comments ({comments.length})
          </div>
          <div className={`tab-item ${activeTab === 'activity' ? 'active' : ''}`} onClick={() => setActiveTab('activity')}>
            <Activity size={15} /> Activity ({taskActivities.length})
          </div>
        </div>

        {/* Tab Content */}
        <div style={{ padding: '16px 24px', maxHeight: '350px', overflowY: 'auto' }}>
          {activeTab === 'comments' && (
            <div>
              <form onSubmit={handleAddComment} style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <input
                  className="form-input"
                  value={newComment}
                  onChange={e => setNewComment(e.target.value)}
                  placeholder="Add a comment..."
                  style={{ flex: 1 }}
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={!newComment.trim()}>
                  <Send size={14} />
                </button>
              </form>
              {comments.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                  <MessageSquare size={28} style={{ opacity: 0.3, marginBottom: '8px' }} />
                  <p>No comments yet</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {comments.map(c => (
                    <div key={c.id} className="comment-item">
                      {/* author is now the real signed-in name/email rather than a
                          hardcoded string, so it is data rather than a guaranteed
                          constant — guard against a blank value. */}
                      <div className="comment-avatar">{(c.author || '?').charAt(0)}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{c.author}</span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>{timeAgo(c.createdAt)}</span>
                        </div>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{c.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'activity' && (
            <div>
              {taskActivities.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                  <Activity size={28} style={{ opacity: 0.3, marginBottom: '8px' }} />
                  <p>No activity recorded</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {taskActivities.map(a => (
                    <div key={a.id} className="activity-item">
                      <Clock size={14} style={{ color: 'var(--text-light)', flexShrink: 0, marginTop: '2px' }} />
                      <div>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{a.action}</span>
                        {a.details && <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}> - {a.details}</span>}
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '2px' }}>{timeAgo(a.timestamp)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
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
