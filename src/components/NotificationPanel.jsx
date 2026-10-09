import React, { useState, useRef, useEffect } from 'react';
import { useNotification } from '../context/NotificationContext';
import { Bell, CheckCircle2, AlertCircle, Info, Edit3, Trash2, Check } from 'lucide-react';

function timeAgo(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const typeIcon = {
  task_created: <CheckCircle2 size={16} style={{ color: 'var(--primary)' }} />,
  task_completed: <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />,
  task_edited: <Edit3 size={16} style={{ color: 'var(--warning)' }} />,
  task_deleted: <Trash2 size={16} style={{ color: 'var(--danger)' }} />,
  info: <Info size={16} style={{ color: 'var(--info)' }} />,
};

export default function NotificationPanel() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } = useNotification();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="notification-wrapper" ref={ref}>
      <button className="notification-bell" onClick={() => setOpen(!open)} title="Notifications">
        <Bell size={20} />
        {unreadCount > 0 && <span className="notification-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="notification-panel">
          <div className="notification-panel-header">
            <h4>Notifications</h4>
            <div style={{ display: 'flex', gap: '8px' }}>
              {unreadCount > 0 && (
                <button onClick={markAllAsRead} className="notif-action-btn">
                  <Check size={13} /> Read all
                </button>
              )}
              {notifications.length > 0 && (
                <button onClick={() => { clearAll(); setOpen(false); }} className="notif-action-btn">Clear</button>
              )}
            </div>
          </div>
          <div className="notification-list">
            {notifications.length === 0 ? (
              <div className="notification-empty">
                <Bell size={32} style={{ opacity: 0.2, marginBottom: '8px' }} />
                <p>No notifications yet</p>
              </div>
            ) : (
              notifications.slice(0, 20).map(n => (
                <div
                  key={n.id}
                  className={`notification-item ${n.read ? '' : 'unread'}`}
                  onClick={() => markAsRead(n.id)}
                >
                  <div className="notif-icon">{typeIcon[n.type] || <Info size={16} />}</div>
                  <div className="notif-body">
                    <div className="notif-title">{n.title}</div>
                    <div className="notif-message">{n.message}</div>
                    <div className="notif-time">{timeAgo(n.timestamp)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
