import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Edit3, X, Users, Globe, Save, Download, Upload, Mail, Briefcase, Tag, AlertCircle, AlertTriangle, Building2, ArrowLeft } from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import ModalPortal from '../components/ModalPortal';
import AccessDenied from '../components/AccessDenied';
import StorageUsageCard from '../components/StorageUsageCard';
import { CATEGORY_PALETTE } from '../lib/categories';
import { normalizeRole, ROLE_LABELS, ROLE_BADGE_CLASS } from '../lib/roles';
import { SETTINGS_DRILLED_IN_KEY } from '../lib/settingsDrill';

export default function Settings() {
  const {
    employees, websites, tasks, categories, addEmployee, updateEmployee, deleteEmployee,
    addWebsite, updateWebsite, deleteWebsite, addCategory, deleteCategory, isDefaultCategory,
    getCategoryColor, setCategoryColor, suggestCategoryColor,
    exportData, importData, isCloud, teams, unitLabel, unitLabelPlural,
  } = useApp();
  const { isSuperAdmin, canViewAll, canManageTeam, setSelectedTeamId, myTeamId } = useAuth();
  const [activeSection, setActiveSection] = useState('employees');
  const [showEmpModal, setShowEmpModal] = useState(false);
  const [showSiteModal, setShowSiteModal] = useState(false);
  const [editingEmp, setEditingEmp] = useState(null);
  const [editingSite, setEditingSite] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [newCategory, setNewCategory] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState('');
  const [categoryError, setCategoryError] = useState('');
  const [colorError, setColorError] = useState('');
  // Staged file contents + counts, shown in a confirm dialog before Import
  // actually replaces anything. Import used to run the instant a file was
  // picked, with no confirmation, no preview, and no undo — the single most
  // destructive control in the app, now the only mutation in this file that
  // needs a step in between "picked a file" and "applied it".
  const [pendingImport, setPendingImport] = useState(null);

  // Employees tab's own two-level drill-down: a card per team first, then
  // that team's roster. Starts un-drilled for everyone, including a team's
  // own admin/viewer/member who only ever has the one card — shown anyway,
  // for one consistent component instead of special-casing the single-team
  // case (confirmed with the user).
  //
  // Backed by sessionStorage, not a plain useState, because clicking a card
  // calls setSelectedTeamId — for a super admin that changes App.jsx's
  // appKey, which fully unmounts and remounts AppProvider (and everything
  // below it, including this component) to give the newly-selected team a
  // clean fetch. A plain useState here would reset to false on that very
  // remount, so the card would never look like it was clicked. sessionStorage
  // survives the remount the same way App.jsx's own readStoredTab does for
  // activeTab.
  const [drilledIn, setDrilledInState] = useState(() => {
    try { return sessionStorage.getItem(SETTINGS_DRILLED_IN_KEY) === '1'; } catch { return false; }
  });
  const setDrilledIn = (value) => {
    setDrilledInState(value);
    try { sessionStorage.setItem(SETTINGS_DRILLED_IN_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ }
  };

  // Powers the level-1 cards' member counts and each team's lead name. Needs
  // its own direct, cross-team query — the `employees` resource from
  // useApp() is already scoped to just the one currently-selected team (that
  // scoping is exactly what makes Settings itself safe for a team's own
  // admin), so it can't answer "how many people are on every OTHER team."
  // RLS naturally limits this to just the caller's own team for anyone but a
  // super admin, so this is harmless to run regardless of role.
  const [teamRoster, setTeamRoster] = useState([]);
  useEffect(() => {
    if (!isCloud) return undefined;
    let cancelled = false;
    supabase.from('employees').select('id, name, role, team_id').then(({ data, error }) => {
      if (cancelled || error || !data) return;
      setTeamRoster(data);
    });
    return () => { cancelled = true; };
  }, [isCloud, teams.length, employees.length]);

  const teamCards = useMemo(() => {
    const visibleTeams = isSuperAdmin ? teams : teams.filter(t => t.id === myTeamId);
    // Local-only mode has no cross-team query to run (teamRoster stays
    // empty, see the effect above) — there's exactly one team there anyway,
    // so its own already-fetched `employees` stands in for the roster.
    const roster = isCloud ? teamRoster : employees.map(e => ({ ...e, team_id: teams[0]?.id }));
    return visibleTeams.map(team => {
      const members = roster.filter(e => e.team_id === team.id);
      const lead = members.find(e => normalizeRole(e.role) === 'admin');
      return { team, memberCount: members.length, leadName: lead?.name || 'Unassigned' };
    });
  }, [teams, teamRoster, isSuperAdmin, myTeamId, isCloud, employees]);

  // How many tasks currently use each category
  const categoryUsage = useMemo(() => {
    const map = {};
    tasks.forEach(t => {
      const c = t.category || 'General';
      map[c] = (map[c] || 0) + 1;
    });
    return map;
  }, [tasks]);

  // Seed the picker with a colour nobody is using yet
  const pickerColor = newCategoryColor || suggestCategoryColor() || CATEGORY_PALETTE[0];

  const handleAddCategory = async (e) => {
    e.preventDefault();
    const result = await addCategory(newCategory, pickerColor);
    if (!result.ok) { setCategoryError(result.error); return; }
    setCategoryError('');
    setNewCategory('');
    setNewCategoryColor('');
  };

  const handleColorChange = async (categoryName, hex) => {
    const result = await setCategoryColor(categoryName, hex);
    setColorError(result.ok ? '' : `${categoryName}: ${result.error}`);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const raw = ev.target.result;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          alert('Import failed. That file is not valid JSON.');
          return;
        }
        // Stage it and let the confirm dialog show what's about to change,
        // rather than applying it immediately with no way to back out.
        setPendingImport({
          raw,
          employees: parsed.employees?.length ?? 0,
          websites: parsed.websites?.length ?? 0,
          tasks: parsed.tasks?.length ?? 0,
        });
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    const success = importData(pendingImport.raw);
    setPendingImport(null);
    if (success) alert('Data imported successfully!');
    else alert('Import failed. Please check the file format.');
  };

  // Defense in depth: App.jsx already keeps a signed-in-but-unlinked account
  // from ever navigating here, but this guard means the page still refuses to
  // render its content even if something renders <Settings /> directly in the
  // future. All the hooks above run unconditionally either way, satisfying
  // the rules of hooks. A viewer (read-only admin) passes this same gate —
  // canViewAll, not canManageTeam — and every write control below is
  // individually gated on the real canManageTeam instead.
  if (!canViewAll) return <AccessDenied />;

  return (
    <div className="animate-in">
      <div className="page-header">
        <h3>Settings</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          {/* Import REPLACES this browser's data outright — a write, unlike
              Export, which is read-only and safe for a viewer too. */}
          {canManageTeam && <button className="btn btn-secondary" onClick={handleImport}><Upload size={16} /> Import</button>}
          <button className="btn btn-secondary" onClick={exportData}><Download size={16} /> Export Backup</button>
        </div>
      </div>

      {isCloud && <StorageUsageCard />}

      {/* Level 1 — a card per team (every team for a super admin, just this
          one for anyone else). Gates the ENTIRE page below it — Employees,
          {unitLabelPlural}, and Categories are all scoped to whichever team
          is drilled into, so a super admin picks the team once here and
          every tab reflects it, rather than each tab needing its own
          separate "which team" picker. Clicking a card is simply a second
          way to change selectedTeamId, same as the topbar switcher. */}
      {!drilledIn ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px' }}>
          {teamCards.map(({ team, memberCount, leadName }) => (
            <div
              key={team.id}
              className="card"
              style={{ cursor: 'pointer' }}
              onClick={() => { setSelectedTeamId(team.id); setDrilledIn(true); }}
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
                    {memberCount} member{memberCount !== 1 ? 's' : ''}
                  </p>
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>Lead: {leadName}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* A team's own admin/viewer/member has only the one card, so
              there's nothing to go back to — this control is only
              meaningful (and only shown) for a super admin. */}
          {isSuperAdmin && (
            <div style={{ marginBottom: '16px' }}>
              <button className="btn btn-secondary" onClick={() => setDrilledIn(false)}>
                <ArrowLeft size={16} /> All Teams
              </button>
            </div>
          )}

          {/* Section Tabs */}
          <div className="tab-bar">
            <div className={`tab-item ${activeSection === 'employees' ? 'active' : ''}`}
              onClick={() => setActiveSection('employees')}>
              <Users size={16} /> Employees ({employees.length})
            </div>
            <div className={`tab-item ${activeSection === 'websites' ? 'active' : ''}`}
              onClick={() => setActiveSection('websites')}>
              <Globe size={16} /> {unitLabelPlural} ({websites.length})
            </div>
            <div className={`tab-item ${activeSection === 'categories' ? 'active' : ''}`}
              onClick={() => setActiveSection('categories')}>
              <Tag size={16} /> Categories ({categories.length})
            </div>
          </div>

      {/* EMPLOYEES SECTION — an org chart: lead(s) on top, a connector down
          to every team member below, same shape as a standard org tree. */}
      {activeSection === 'employees' && (() => {
        const leads = employees.filter(e => normalizeRole(e.role) === 'admin');
        const members = employees.filter(e => normalizeRole(e.role) !== 'admin');
        const renderEmpCard = (emp) => {
          const role = normalizeRole(emp.role);
          return (
            <div key={emp.id} className="card" style={{ overflow: 'hidden', width: '260px' }}>
              <div className="card-body" style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <div style={{
                  width: 42, height: 42, borderRadius: 'var(--radius-md)',
                  background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontWeight: 700, fontSize: '1rem', flexShrink: 0
                }}>{emp.name.charAt(0)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <h4 style={{ fontSize: '0.92rem', marginBottom: '2px' }}>{emp.name}</h4>
                    <span className={`badge ${ROLE_BADGE_CLASS[role]}`}>{ROLE_LABELS[role]}</span>
                  </div>
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Briefcase size={12} /> {emp.designation}
                  </p>
                  {emp.email && (
                    <p style={{ fontSize: '0.74rem', color: 'var(--text-light)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                      <Mail size={11} /> {emp.email}
                    </p>
                  )}
                </div>
                {canManageTeam && (
                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <button className="btn-icon" onClick={() => { setEditingEmp(emp); setShowEmpModal(true); }}><Edit3 size={14} /></button>
                    <button className="btn-icon" style={{ color: 'var(--danger)' }} onClick={() => {
                      setConfirmDelete({ type: 'employee', id: emp.id, name: emp.name });
                    }}><Trash2 size={14} /></button>
                  </div>
                )}
              </div>
            </div>
          );
        };

        return (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '16px', gap: '8px', flexWrap: 'wrap' }}>
              {canManageTeam && (
                <button className="btn btn-primary" onClick={() => { setEditingEmp(null); setShowEmpModal(true); }}>
                  <Plus size={16} /> Add Employee
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', overflowX: 'auto', paddingBottom: '8px' }}>
              {/* Top: the team's lead(s), side by side if there's more than one */}
              <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
                {leads.length > 0 ? leads.map(renderEmpCard) : (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-light)', padding: '12px 0' }}>No team lead assigned yet</div>
                )}
              </div>

              {/* Trunk + branches connecting the lead(s) down to every member */}
              {members.length > 0 && (
                <>
                  <div style={{ width: 2, height: 20, background: 'var(--border)' }} />
                  <div style={{ position: 'relative', width: '100%', maxWidth: 'fit-content' }}>
                    <div style={{ position: 'absolute', top: 0, left: 130, right: 130, height: 2, background: 'var(--border)' }} />
                    <div style={{ display: 'flex', gap: '16px', paddingTop: '20px' }}>
                      {members.map(emp => (
                        <div key={emp.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div style={{ width: 2, height: 20, background: 'var(--border)', marginTop: '-20px', marginBottom: '0' }} />
                          {renderEmpCard(emp)}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* WEBSITES SECTION */}
      {activeSection === 'websites' && (
        <div>
          {canManageTeam && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
              <button className="btn btn-primary" onClick={() => { setEditingSite(null); setShowSiteModal(true); }}>
                <Plus size={16} /> Add {unitLabel}
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
            {websites.map(site => (
              <div key={site.id} className="card" style={{ overflow: 'hidden' }}>
                <div className="card-body" style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: 'var(--radius-md)',
                    background: 'var(--info-bg)', color: 'var(--info)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0
                  }}><Globe size={22} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h4 style={{ fontSize: '1rem', marginBottom: '2px' }}>{site.name}</h4>
                    <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{site.description || 'No description'}</p>
                  </div>
                  {canManageTeam && (
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      <button className="btn-icon" onClick={() => { setEditingSite(site); setShowSiteModal(true); }}><Edit3 size={15} /></button>
                      <button className="btn-icon" style={{ color: 'var(--danger)' }} onClick={() => {
                        setConfirmDelete({ type: 'website', id: site.id, name: site.name });
                      }}><Trash2 size={15} /></button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* CATEGORIES SECTION */}
      {activeSection === 'categories' && (
        <div>
          {canManageTeam && (
          <div className="card" style={{ marginBottom: '16px' }}>
            <div className="card-body">
              <h4 style={{ fontSize: '0.95rem', marginBottom: '10px' }}>Add a Category</h4>
              <form onSubmit={handleAddCategory} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: '220px' }}>
                  <input
                    className="form-input"
                    value={newCategory}
                    onChange={e => { setNewCategory(e.target.value); setCategoryError(''); }}
                    placeholder="e.g., Video Marketing"
                  />
                  {categoryError && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.78rem', color: 'var(--danger)', marginTop: '6px' }}>
                      <AlertCircle size={13} /> {categoryError}
                    </span>
                  )}
                </div>

                <div>
                  <label className="form-label" style={{ fontSize: '0.75rem', marginBottom: '4px', display: 'block' }}>Colour</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="color"
                      className="color-swatch-input"
                      value={pickerColor}
                      onChange={e => { setNewCategoryColor(e.target.value); setCategoryError(''); }}
                      title="Pick a colour for this category"
                    />
                    <code style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{pickerColor}</code>
                  </div>
                </div>

                <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={!newCategory.trim()}>
                  <Plus size={16} /> Add Category
                </button>
              </form>

              {/* Quick picks — palette colours not yet taken */}
              {(() => {
                const used = new Set(categories.map(c => getCategoryColor(c)));
                const free = CATEGORY_PALETTE.filter(c => !used.has(c));
                if (!free.length) return null;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginRight: '2px' }}>Available:</span>
                    {free.slice(0, 12).map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => { setNewCategoryColor(c); setCategoryError(''); }}
                        title={c}
                        style={{
                          width: 20, height: 20, borderRadius: '5px', background: c, cursor: 'pointer',
                          border: pickerColor === c ? '2px solid var(--text-primary)' : '1px solid var(--border)',
                        }}
                      />
                    ))}
                  </div>
                );
              })()}

              <p style={{ fontSize: '0.78rem', color: 'var(--text-light)', marginTop: '12px', lineHeight: 1.5 }}>
                Each category needs its own colour - duplicates are rejected. New categories appear immediately in the
                Schedule and Tasks Completed dropdowns, and in the Dashboard donut and Monthly Report once a task uses them.
              </p>
            </div>
          </div>
          )}

          {colorError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '10px 14px', marginBottom: '14px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-md)', fontSize: '0.82rem' }}>
              <AlertCircle size={15} /> {colorError}
              <button className="btn-icon" style={{ marginLeft: 'auto', color: 'inherit' }} onClick={() => setColorError('')}><X size={15} /></button>
            </div>
          )}

          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th style={{ width: 90 }}>Colour</th><th>Category</th><th>Type</th><th>Tasks Using It</th><th style={{ width: 80 }}>Action</th></tr></thead>
              <tbody>
                {categories.map(cat => {
                  const isBuiltIn = isDefaultCategory(cat);
                  const usage = categoryUsage[cat] || 0;
                  const color = getCategoryColor(cat);
                  return (
                    <tr key={cat}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <input
                            type="color"
                            className="color-swatch-input"
                            value={color}
                            disabled={!canManageTeam}
                            onChange={e => handleColorChange(cat, e.target.value)}
                            title={`${cat} - click to change colour`}
                          />
                          <code style={{ fontSize: '0.7rem', color: 'var(--text-light)' }}>{color}</code>
                        </div>
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                          <Tag size={14} style={{ color, flexShrink: 0 }} /> {cat}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${isBuiltIn ? 'badge-info' : 'badge-success'}`}>
                          {isBuiltIn ? 'Built-in' : 'Custom'}
                        </span>
                      </td>
                      <td>{usage > 0 ? `${usage} task${usage !== 1 ? 's' : ''}` : <span style={{ color: 'var(--text-light)' }}>Not used yet</span>}</td>
                      <td>
                        {canManageTeam && (
                          <button
                            className="btn-icon"
                            style={{ color: 'var(--danger)' }}
                            title={usage > 0 ? `Delete - ${usage} task(s) will need moving` : 'Delete category'}
                            onClick={() => setCategoryToDelete(cat)}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
        </>
      )}

      {/* Employee Modal */}
      {showEmpModal && (
        <EmployeeModal
          employee={editingEmp}
          onSave={(data) => {
            if (editingEmp) updateEmployee(editingEmp.id, data);
            else addEmployee(data);
            setShowEmpModal(false);
          }}
          onClose={() => setShowEmpModal(false)}
        />
      )}

      {/* Website Modal */}
      {showSiteModal && (
        <WebsiteModal
          website={editingSite}
          unitLabel={unitLabel}
          onSave={(data) => {
            if (editingSite) updateWebsite(editingSite.id, data);
            else addWebsite(data);
            setShowSiteModal(false);
          }}
          onClose={() => setShowSiteModal(false)}
        />
      )}

      {categoryToDelete && (
        <DeleteCategoryModal
          category={categoryToDelete}
          taskCount={categoryUsage[categoryToDelete] || 0}
          options={categories.filter(c => c !== categoryToDelete)}
          getCategoryColor={getCategoryColor}
          onConfirm={(replacement) => deleteCategory(categoryToDelete, replacement)}
          onClose={() => setCategoryToDelete(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.type === 'employee' ? 'Employee' : confirmDelete.type === 'category' ? 'Category' : unitLabel}`}
          message={`Are you sure you want to delete "${confirmDelete.name}"? This action cannot be undone.`}
          onConfirm={async () => {
            if (confirmDelete.type === 'employee') {
              await deleteEmployee(confirmDelete.id);
            } else if (confirmDelete.type === 'category') {
              deleteCategory(confirmDelete.id);
            } else {
              await deleteWebsite(confirmDelete.id);
            }
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {pendingImport && (
        <ConfirmDialog
          title="Replace current data?"
          message={
            `This replaces ${pendingImport.employees} employee(s), ${pendingImport.websites} website(s) ` +
            `and ${pendingImport.tasks} task(s) in this browser.` +
            (isCloud
              ? ' Imported data is not written to the database - refreshing the page restores what the server has and discards this import.'
              : '')
          }
          confirmLabel="Replace data"
          onConfirm={confirmImport}
          onCancel={() => setPendingImport(null)}
        />
      )}
    </div>
  );
}

// Deleting a category that still holds tasks forces the user to say where those
// tasks should go, so nothing is left pointing at a category that no longer exists.
function DeleteCategoryModal({ category, taskCount, options, getCategoryColor, onConfirm, onClose }) {
  const [replacement, setReplacement] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const needsReplacement = taskCount > 0;

  const handleConfirm = async (e) => {
    e.preventDefault();
    if (needsReplacement && !replacement) {
      setError('Pick the category these tasks should move to.');
      return;
    }
    setBusy(true);
    const result = await onConfirm(replacement);
    setBusy(false);
    if (!result?.ok) { setError(result?.error || 'Could not delete this category.'); return; }
    onClose();
  };

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="modal" style={{ maxWidth: '480px' }}>
          <div className="modal-header">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={19} style={{ color: 'var(--danger)' }} /> Delete Category
            </h3>
            <button className="btn-icon" onClick={onClose}><X size={20} /></button>
          </div>
          <form onSubmit={handleConfirm}>
            <div className="modal-body">
              <div style={{ padding: '12px 16px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', marginBottom: '16px', borderLeft: `4px solid ${getCategoryColor(category)}` }}>
                <p style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <Tag size={15} style={{ color: getCategoryColor(category) }} /> {category}
                </p>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {needsReplacement
                    ? `${taskCount} task${taskCount !== 1 ? 's' : ''} currently use${taskCount === 1 ? 's' : ''} this category.`
                    : 'No tasks use this category.'}
                </p>
              </div>

              {needsReplacement ? (
                <div className="form-group">
                  <label className="form-label">Move these {taskCount} task{taskCount !== 1 ? 's' : ''} to *</label>
                  <select
                    className="form-select"
                    value={replacement}
                    onChange={e => { setReplacement(e.target.value); setError(''); }}
                    autoFocus
                  >
                    <option value="" disabled>Select a category</option>
                    {options.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '6px', display: 'block' }}>
                    Every task in "{category}" is reassigned to the category you choose, then "{category}" is removed.
                  </span>
                </div>
              ) : (
                <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                  "{category}" will be removed from all category dropdowns. This cannot be undone.
                </p>
              )}

              {error && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '14px', fontSize: '0.8rem', color: 'var(--danger)' }}>
                  <AlertCircle size={14} /> {error}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button
                type="submit"
                className="btn btn-danger-solid"
                disabled={busy || (needsReplacement && !replacement)}
              >
                <Trash2 size={15} /> {busy ? 'Deleting…' : needsReplacement ? `Move & Delete` : 'Delete'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
}

function EmployeeModal({ employee, onSave, onClose }) {
  const { employee: me, isSuperAdmin } = useAuth();
  const [form, setForm] = useState({
    name: employee?.name || '',
    designation: employee?.designation || '',
    email: employee?.email || '',
    role: normalizeRole(employee?.role),
  });
  // The database refuses to demote the very last admin (employees_last_admin_trg
  // in supabase_rls_policies.sql) — this just avoids offering a control that
  // would only come back as a rejected write for the one account it can't apply to.
  const isSelf = !!employee && !!me && employee.id === me.id;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
        <div className="modal-header">
          <h3>{employee ? 'Edit Employee' : 'Add Employee'}</h3>
          <button className="btn-icon" onClick={onClose}><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="form-group">
              <label className="form-label">Full Name *</label>
              <input className="form-input" required value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., Priya Sharma" />
            </div>
            <div className="form-group">
              <label className="form-label">Designation *</label>
              <input className="form-input" required value={form.designation}
                onChange={e => setForm({ ...form, designation: e.target.value })}
                placeholder="e.g., SEO Specialist" />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                placeholder="e.g., priya@company.com" />
            </div>
            <div className="form-group">
              <label className="form-label">Role</label>
              <select className="form-select" value={form.role} disabled={isSelf}
                onChange={e => setForm({ ...form, role: e.target.value })}>
                <option value="member">Member - sees only their own tasks</option>
                <option value="viewer">Viewer - sees everyone, read-only</option>
                <option value="admin">Admin - sees everyone, manages this team</option>
                {/* Only a super admin can even offer promoting someone to super
                    admin — the backend trigger (guard_employee_role_changes in
                    supabase_teams_rls.sql) is the real enforcement; hiding the
                    option from everyone else is the matching UI-level courtesy,
                    the same "don't show a control that's guaranteed to be
                    rejected" approach already used for Delete elsewhere here. */}
                {isSuperAdmin && <option value="super_admin">Super Admin - sees and manages every team</option>}
              </select>
              {isSelf && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-light)', marginTop: '6px', display: 'block' }}>
                  You can't change your own role here - have another admin do it.
                </span>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary"><Save size={16} /> Save</button>
          </div>
        </form>
        </div>
      </div>
    </ModalPortal>
  );
}

function WebsiteModal({ website, unitLabel, onSave, onClose }) {
  const [form, setForm] = useState({
    name: website?.name || '',
    description: website?.description || '',
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="modal-header">
            <h3>{website ? `Edit ${unitLabel}` : `Add ${unitLabel}`}</h3>
            <button className="btn-icon" onClick={onClose}><X size={20} /></button>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="form-group">
                <label className="form-label">{unitLabel} Name *</label>
                <input className="form-input" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g., example.com" />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <input className="form-input" value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  placeholder="e.g., Main company website" />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary"><Save size={16} /> Save</button>
            </div>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
}
