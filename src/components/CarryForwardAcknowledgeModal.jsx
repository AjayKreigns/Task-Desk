import { ArrowRightCircle, CheckCircle2 } from 'lucide-react';
import ModalPortal from './ModalPortal';

// Deliberately NOT dismissible via backdrop click, an X button, or Escape —
// unlike every other modal in this app (ConfirmDialog, TaskDetailModal),
// which all let you back out. The whole point here is that "Acknowledge" is
// the only way out, so clicking it is a real, deliberate action — that's
// what makes the activity-log entry it creates (see
// TaskCarryForwardNotifier's handleAcknowledge) meaningful as a record of
// when the person actually saw this, not just that a toast was fired.
export default function CarryForwardAcknowledgeModal({ tasks, onAcknowledge }) {
  return (
    <ModalPortal>
      <div className="modal-overlay" style={{ zIndex: 9999 }}>
        <div className="modal" style={{ maxWidth: '460px' }}>
          <div className="modal-header">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ArrowRightCircle size={20} style={{ color: 'var(--info)' }} />
              Tasks Carried Forward
            </h3>
          </div>
          <div className="modal-body" style={{ padding: '20px 24px' }}>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '14px' }}>
              {tasks.length === 1
                ? 'The following task was still incomplete and has been automatically moved to this month:'
                : `The following ${tasks.length} tasks were still incomplete and have been automatically moved to this month:`}
            </p>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {tasks.map((t) => (
                <li key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                  background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', fontSize: '0.88rem', fontWeight: 600,
                }}>
                  <ArrowRightCircle size={14} style={{ color: 'var(--info)', flexShrink: 0 }} />
                  {t.title}
                </li>
              ))}
            </ul>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '14px', lineHeight: 1.5 }}>
              Acknowledging this records that you were notified, with a timestamp, on each task's own activity log.
            </p>
          </div>
          <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 24px', borderTop: '1px solid var(--border)' }}>
            <button className="btn btn-primary" onClick={onAcknowledge}>
              <CheckCircle2 size={16} /> Acknowledge
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
