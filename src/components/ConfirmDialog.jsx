import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { calcModalPosition } from '../lib/modalPosition';
import ModalPortal from './ModalPortal';

// `confirmLabel`/`tone` are optional so all existing call sites (delete actions)
// keep their exact current look with no changes; they exist so this same dialog
// can confirm a non-destructive action (signing out) without a red Delete
// button and a warning-triangle icon that don't fit what's being confirmed.
export default function ConfirmDialog({ title, message, onConfirm, onCancel, position, confirmLabel = 'Delete', tone = 'danger' }) {
  const { originStyle } = calcModalPosition(position, 420, 220);
  const iconColor = tone === 'danger' ? 'var(--danger)' : 'var(--primary)';
  // .btn-danger-solid rather than inline `background: var(--danger)`: the
  // inline version left .btn's near-white ::after hover sheen painting over
  // the red fill, which made the button look like it faded out when hovered.
  // See the .btn-danger-solid comment in index.css.
  const confirmClass = tone === 'danger' ? 'btn btn-danger-solid' : 'btn btn-primary';

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel()} style={{ zIndex: 9999 }}>
        <div className="modal" style={{ maxWidth: '420px', ...(originStyle || {}) }}>
          <div className="modal-header">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={20} style={{ color: iconColor }} />
              {title || 'Confirm Delete'}
            </h3>
            <button className="btn-icon" onClick={onCancel}><X size={20} /></button>
          </div>
          <div className="modal-body" style={{ padding: '20px 24px' }}>
            <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {message || 'Are you sure? This action cannot be undone.'}
            </p>
          </div>
          <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '14px 24px', borderTop: '1px solid var(--border)' }}>
            <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button className={confirmClass} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
