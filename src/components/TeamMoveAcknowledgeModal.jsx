import { Building2, CheckCircle2 } from 'lucide-react';
import ModalPortal from './ModalPortal';

// Deliberately NOT dismissible via backdrop click, an X button, or Escape —
// same reasoning as CarryForwardAcknowledgeModal: "Acknowledge" is the only
// way out, so clicking it is a real, deliberate action, matching
// team_move_notifications.acknowledged_at being the one thing that ever
// clears this notice from the moved employee's next session.
export default function TeamMoveAcknowledgeModal({ notification, onAcknowledge }) {
  return (
    <ModalPortal>
      <div className="modal-overlay" style={{ zIndex: 9999 }}>
        <div className="modal" style={{ maxWidth: '460px' }}>
          <div className="modal-header">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Building2 size={20} style={{ color: 'var(--info)' }} />
              You've been moved to a different team
            </h3>
          </div>
          <div className="modal-body" style={{ padding: '20px 24px' }}>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              You were moved from <strong>{notification.from_team_name}</strong> to{' '}
              <strong>{notification.to_team_name}</strong>
              {notification.task_count > 0
                ? ` — your ${notification.task_count} task${notification.task_count !== 1 ? 's' : ''} (scheduled, completed, and pending alike) moved with you.`
                : '.'}
            </p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-light)', marginTop: '14px', lineHeight: 1.5 }}>
              Everything you see from now on — colleagues, categories, and {notification.to_team_name}'s own work list — reflects your new team.
            </p>
          </div>
          <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 24px', borderTop: '1px solid var(--border)' }}>
            <button className="btn btn-primary" onClick={onAcknowledge}>
              <CheckCircle2 size={16} /> OK
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
