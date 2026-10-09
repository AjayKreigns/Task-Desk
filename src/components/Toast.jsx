import React from 'react';
import { useNotification } from '../context/NotificationContext';
import { X, CheckCircle2, AlertCircle, Info, Bell } from 'lucide-react';

const iconMap = {
  success: <CheckCircle2 size={18} />,
  error: <AlertCircle size={18} />,
  warning: <AlertCircle size={18} />,
  info: <Info size={18} />,
  task_created: <CheckCircle2 size={18} />,
  task_completed: <CheckCircle2 size={18} />,
  task_edited: <Info size={18} />,
  task_deleted: <AlertCircle size={18} />,
};

const colorMap = {
  success: 'var(--success)',
  error: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--primary)',
  task_created: 'var(--primary)',
  task_completed: 'var(--success)',
  task_edited: 'var(--warning)',
  task_deleted: 'var(--danger)',
};

export default function Toast() {
  const { toasts, removeToast } = useNotification();
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className="toast-item" style={{ borderLeftColor: colorMap[t.type] || 'var(--primary)' }}>
          <span className="toast-icon" style={{ color: colorMap[t.type] || 'var(--primary)' }}>
            {iconMap[t.type] || <Bell size={18} />}
          </span>
          <div className="toast-content">
            <div className="toast-title">{t.title}</div>
            <div className="toast-message">{t.message}</div>
          </div>
          <button className="toast-close" onClick={() => removeToast(t.id)}><X size={14} /></button>
          <div className="toast-progress" style={{ background: colorMap[t.type] || 'var(--primary)' }} />
        </div>
      ))}
    </div>
  );
}
