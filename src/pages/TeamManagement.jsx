import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { supabase } from '../lib/supabase';
import { classifyDbError } from '../lib/dbErrors';
import { Plus, X, Save, Building2, Users, AlertCircle, Trash2 } from 'lucide-react';
import ModalPortal from '../components/ModalPortal';
import AccessDenied from '../components/AccessDenied';
import ConfirmDialog from '../components/ConfirmDialog';
import { SETTINGS_DRILLED_IN_KEY } from '../lib/settingsDrill';

// Super-admin-only: where a brand-new team comes into existence. This is
// deliberately separate from Settings.jsx's Employees-tab drill-down, which
// is how anyone browses and manages a team's people AFTER it exists — there
// is no admin to add through Settings yet for a team that hasn't been
// created, so bootstrapping its first admin has to happen in this same
// action as creating the team itself (create_team_with_admin does both,
// atomically — see supabase_teams_admin_rpc.sql).
//
// onOpenTeam: switches to the Settings tab (App.jsx passes setActiveTab),
// used when a card here is clicked — a team card is otherwise just a
// read-only summary with nowhere for a click to go.
export default function TeamManagement({ onOpenTeam }) {
  const { teams, isCloud, refresh } = useApp();
  const { isSuperAdmin, selectedTeamId, setSelectedTeamId } = useAuth();
  const { notify } = useNotification();
  const [showAddModal, setShowAddModal] = useState(false);
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState(null);
  const [roster, setRoster] = useState([]);

  // Same lightweight cross-team query Settings.jsx's Employees-tab cards use,
  // for the same reason: this page's own data (via useApp()) is scoped to
  // whichever one team is currently selected, so a count/lead-name per OTHER
  // team needs its own direct query. RLS already limits this to every team
  // for a super admin, which is the only role that can ever reach this page.
  useEffect(() => {
    if (!isCloud) { return undefined; }
    let cancelled = false;
    supabase.from('employees').select('id, name, role, team_id').then(({ data, error }) => {
      if (cancelled || error || !data) return;
      setRoster(data);
    });
    return () => { cancelled = true; };
  }, [isCloud, teams.length]);

  if (!isSuperAdmin) return <AccessDenied />;

  const handleConfirmDeleteTeam = async () => {
    const team = confirmDeleteTeam;
    if (!team) return;
    const { error } = await supabase.rpc('delete_team', { p_team_id: team.id });
    if (error) {
      // delete_team's own RAISE EXCEPTION text is already written for a
      // person to read (which exact rule rejected it: not a super admin,
      // the Digital Marketing team, or real tasks still attached) —
      // classifyDbError's generic per-error-code wording would collapse all
      // three into the same unhelpful message here, so this surfaces the
      // raw text instead.
      notify('error', 'Could not delete team', error.message || 'Something went wrong.');
      setConfirmDeleteTeam(null);
      return;
    }
    notify('success', 'Team deleted', `"${team.name}" has been removed.`);
    setConfirmDeleteTeam(null);
    if (team.id === selectedTeamId) {
      // Switching selectedTeamId itself fully remounts AppProvider for a
      // super admin (App.jsx's appKey), which already re-fetches everything
      // fresh — no separate refresh() call needed on this branch, and
      // calling it anyway would just be chasing a provider that's about to
      // be torn down.
      const fallback = teams.find(t => t.id !== team.id && t.is_lead_source_team)
        || teams.find(t => t.id !== team.id);
      if (fallback) setSelectedTeamId(fallback.id);
    } else {
      refresh();
    }
  };

  return (
    <div className="animate-in">
      <div className="page-header">
        <h3>Teams</h3>
        <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
          <Plus size={16} /> Add Team
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
        {teams.map(team => {
          const members = roster.filter(e => e.team_id === team.id);
          const lead = members.find(e => e.role === 'admin');
          return (
            <div
              key={team.id}
              className="card"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setSelectedTeamId(team.id);
                // Jump straight to that team's drilled-in view in Settings,
                // not its own team-picker grid — same reasoning as clicking
                // a card there: this click already said which team.
                try { sessionStorage.setItem(SETTINGS_DRILLED_IN_KEY, '1'); } catch { /* storage unavailable */ }
                onOpenTeam?.();
              }}
            >
              <div className="card-body" style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 'var(--radius-md)',
                  background: 'var(--info-bg)', color: 'var(--info)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}><Building2 size={22} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h4 style={{ fontSize: '1rem', marginBottom: '2px' }}>{team.name}</h4>
                  <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    Tracks {team.is_lead_source_team ? 'Websites' : 'Companies'}
                  </p>
                  <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                    <Users size={13} /> {members.length} member{members.length !== 1 ? 's' : ''}
                  </p>
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>Lead: {lead?.name || 'Unassigned'}</p>
                </div>
                {/* Digital Marketing can never be deleted (delete_team
                    rejects it server-side regardless) — hidden here rather
                    than shown-then-rejected, same "don't offer a control
                    that's guaranteed to fail" approach used elsewhere. */}
                {!team.is_lead_source_team && (
                  <button
                    className="btn-icon"
                    style={{ color: 'var(--danger)', flexShrink: 0 }}
                    title="Delete team"
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteTeam(team); }}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {confirmDeleteTeam && (
        <ConfirmDialog
          title="Delete Team"
          message={
            `Permanently delete "${confirmDeleteTeam.name}"? This removes its ${roster.filter(e => e.team_id === confirmDeleteTeam.id).length} employee(s) and all of its categories and ${confirmDeleteTeam.is_lead_source_team ? 'websites' : 'companies'}. ` +
            `A team with any real tasks can't be deleted this way — you'll see an error naming the reason if this one still has some. This cannot be undone.`
          }
          onConfirm={handleConfirmDeleteTeam}
          onCancel={() => setConfirmDeleteTeam(null)}
        />
      )}

      {showAddModal && (
        <AddTeamModal
          onCreated={() => { setShowAddModal(false); refresh(); }}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}

function AddTeamModal({ onCreated, onClose }) {
  const [form, setForm] = useState({
    name: '', adminName: '', adminDesignation: '', adminEmail: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('create_team_with_admin', {
      p_name: form.name.trim(),
      // Fixed, not user-entered — every team but Digital Marketing sees
      // "Company"/"Companies" (AppContext.jsx's unitLabel/unitLabelPlural),
      // so these two columns are no longer customizable per team. The RPC
      // itself is left unchanged (still takes these two params) to avoid
      // another schema migration over a value nothing reads any more.
      p_entity_label_singular: 'Company',
      p_entity_label_plural: 'Companies',
      p_admin_name: form.adminName.trim(),
      p_admin_designation: form.adminDesignation.trim(),
      p_admin_email: form.adminEmail.trim().toLowerCase(),
    });
    setBusy(false);
    if (rpcError) {
      const { message } = classifyDbError(rpcError);
      setError(message);
      return;
    }
    onCreated();
  };

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="modal-header">
            <h3>Add Team</h3>
            <button type="button" className="btn-icon" onClick={onClose}><X size={20} /></button>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="form-group">
                <label className="form-label">Team Name *</label>
                <input className="form-input" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g., Client Services" />
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-light)', marginTop: '-6px' }}>
                This team tracks "Companies" (Digital Marketing is the only team that tracks "Websites") and starts with no categories — its lead adds whichever ones fit this team's own work from the Settings page afterward.
              </p>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '2px 0' }} />
              <h4 style={{ fontSize: '0.9rem' }}>First Admin (team lead)</h4>

              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input className="form-input" required value={form.adminName}
                  onChange={e => setForm({ ...form, adminName: e.target.value })}
                  placeholder="e.g., Priya Sharma" />
              </div>
              <div className="form-group">
                <label className="form-label">Designation *</label>
                <input className="form-input" required value={form.adminDesignation}
                  onChange={e => setForm({ ...form, adminDesignation: e.target.value })}
                  placeholder="e.g., Team Lead" />
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input className="form-input" type="email" required value={form.adminEmail}
                  onChange={e => setForm({ ...form, adminEmail: e.target.value })}
                  placeholder="e.g., priya@company.com" />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '6px', display: 'block' }}>
                  This exact email must be used when this person signs up — sign-up is gated to pre-approved emails already in the system.
                </span>
              </div>

              {error && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--danger)' }}>
                  <AlertCircle size={14} /> {error}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <Save size={16} /> {busy ? 'Creating…' : 'Create Team'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
}
