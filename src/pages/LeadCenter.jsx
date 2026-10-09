import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import {
  Plus, Upload, Trash2, Inbox, Mail, Phone, ExternalLink, X,
  AlertCircle, CheckCircle2, XCircle, FileSpreadsheet, Calendar, Download, ChevronDown,
} from 'lucide-react';
import ModalPortal from '../components/ModalPortal';
import ConfirmDialog from '../components/ConfirmDialog';
import AnimatedCounter from '../components/AnimatedCounter';
import WorldMap from '../components/WorldMap';
import { isDuplicateLead } from '../lib/leadDedup';
import { sanitizeExcelRow } from '../lib/excelSafety';
import { getCountryFromPhone } from '../lib/phoneCountry';
import { STATUS_LABEL, leadStatusKey, parseDate, formatDate } from '../lib/leadFields';

const CONFIRM_YES = 'Yes, this is a project enquiry';

// Module-level (not a component-body closure) so it's a stable reference —
// each of the three filter dropdowns' options + counts need to be scoped by
// the OTHER two filters (not itself), so e.g. "GAIL (3)" always means
// "picking GAIL right now shows 3 rows", regardless of what's currently
// selected in the other two. Takes the current filter values as an explicit
// argument rather than closing over component state, so callers' own
// useMemo dependency arrays stay exhaustive-deps clean.
function scopeByOtherFilters(list, filters, skip = {}) {
  let result = list;
  if (!skip.company && filters.company !== 'all') result = result.filter(l => l.company === filters.company);
  if (!skip.country && filters.country !== 'all') result = result.filter(l => getCountryFromPhone(l.phone) === filters.country);
  if (!skip.status && filters.status !== 'all') result = result.filter(l => leadStatusKey(l) === filters.status);
  return result;
}

// Inverse of the Status/Reason columns written by toExportRows, so an exported
// file re-imports with its conversion decisions intact. Anything unrecognised
// (including a raw website export with no such columns) falls back to
// "pending", never to a wrong Converted/Not Converted call.
function readStatusColumns(row) {
  const raw = (row['Status'] || row['status'] || '').toString().trim().toLowerCase();
  const converted = raw === 'converted' || raw === 'yes' ? 'yes'
    : raw === 'not converted' || raw === 'no' ? 'no'
    : '';
  return {
    converted,
    convertedReason: converted === 'no'
      ? (row['Reason'] || row['reason'] || '').toString().trim()
      : '',
  };
}

// Headers deliberately match what ImportLeadsModal reads, so an export can be
// re-imported as a working backup rather than being a dead-end report. Status
// and Reason are extra columns the importer also understands (see
// readStatusColumns), so a restore keeps the conversion decisions too.
function toExportRows(rows) {
  return rows.map(l => sanitizeExcelRow({
    'Name': l.name || '',
    'Company': l.company || '',
    'Email': l.email || '',
    'Phone/Mobile': l.phone || '',
    'Message': l.message || '',
    'Confirm': l.confirm || '',
    'Source URL': l.sourceUrl || '',
    // A real Date, written with cellDates so Excel shows a date rather than a
    // serial number — and so re-importing reads back the same instant.
    // sanitizeExcelRow leaves it untouched (it only ever touches strings).
    'created_at': parseDate(l.createdAt) || '',
    'Status': STATUS_LABEL[l.converted] ?? STATUS_LABEL[''],
    'Reason': l.convertedReason || '',
  }));
}

export default function LeadCenter() {
  const { leads, addLead, addLeadsBulk, updateLead, deleteLead, deleteLeadsBulk } = useApp();
  // Members get read-only access: they see every enquiry but cannot import,
  // export, add, delete or change a conversion status. Hiding the controls is
  // presentation only — the real enforcement is the admin-only RLS policies
  // in supabase_leads_admin_only_writes.sql, since the anon key is public and
  // a member could otherwise call the REST API directly.
  const { canManageTeam } = useAuth();
  const { notify } = useNotification();
  // 'month' = the picked month+year, 'year' = every month of the picked year,
  // 'all' = every enquiry ever recorded.
  //
  // This replaces an earlier two-state toggle whose second option was
  // LABELLED "Full Year <year>" but applied no date filter at all — so it
  // actually showed all-time data under a year heading, and filtering by year
  // was impossible. Defaults to 'all', preserving what that option really did.
  const [periodScope, setPeriodScope] = useState('all'); // month | year | all
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [filterCompany, setFilterCompany] = useState('all');
  const [filterCountry, setFilterCountry] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [detailLead, setDetailLead] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);
  // Lazy initialiser so the clock is read outside render — same reason as the
  // WelcomeBanner clock. "This month" is fixed at mount, which is correct: the
  // month cannot change while someone has the menu open.
  const [today] = useState(() => new Date());

  // Click-outside to close, matching NotificationPanel's dropdown.
  useEffect(() => {
    const handler = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Any filter change drops the selection. Otherwise rows could stay selected
  // while scrolled out of view behind a filter, and "Delete 12 selected" would
  // remove records the person could not see at the moment they confirmed —
  // the kind of surprise that is unrecoverable for a destructive action.
  const clearSelection = () => setSelectedIds(new Set());

  // Leads scoped to the current period only, before the company/country
  // filters — the base both dropdowns (and their occurrence counts) are
  // built from, and what filteredLeads below layers its own two filters on
  // top of. getUTC*, matching how the date is displayed and how duplicates
  // are grouped — with local getters, a late-in-the-day enquiry could show
  // one date in the table but be filtered into a different month.
  const periodLeads = useMemo(() => {
    let result = leads;
    if (periodScope === 'month') {
      result = result.filter(l => {
        const d = parseDate(l.createdAt);
        return d && d.getUTCMonth() + 1 === filterMonth && d.getUTCFullYear() === filterYear;
      });
    } else if (periodScope === 'year') {
      result = result.filter(l => {
        const d = parseDate(l.createdAt);
        return d && d.getUTCFullYear() === filterYear;
      });
    }
    return result;
  }, [leads, periodScope, filterMonth, filterYear]);

  const activeFilters = { company: filterCompany, country: filterCountry, status: filterStatus };

  const companies = useMemo(() => {
    const scoped = scopeByOtherFilters(periodLeads, activeFilters, { company: true });
    const counts = new Map();
    for (const l of scoped) {
      if (!l.company) continue;
      counts.set(l.company, (counts.get(l.company) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [periodLeads, filterCountry, filterStatus]); // eslint-disable-line react-hooks/exhaustive-deps -- scopeByOtherFilters/activeFilters are derived fresh each render from these same primitives; filterCompany deliberately excluded (this list is scoped by the OTHER two filters, not itself)

  const countries = useMemo(() => {
    const scoped = scopeByOtherFilters(periodLeads, activeFilters, { country: true });
    const counts = new Map();
    for (const l of scoped) {
      const c = getCountryFromPhone(l.phone);
      if (!c) continue;
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [periodLeads, filterCompany, filterStatus]); // eslint-disable-line react-hooks/exhaustive-deps -- see companies above; filterCountry deliberately excluded

  // Fixed order (not alphabetical, unlike companies/countries) — this is a
  // closed three-value field, so every option always shows even at (0),
  // rather than only ever listing whichever statuses happen to be present.
  const statuses = useMemo(() => {
    const scoped = scopeByOtherFilters(periodLeads, activeFilters, { status: true });
    const counts = { '': 0, yes: 0, no: 0 };
    for (const l of scoped) counts[leadStatusKey(l)]++;
    return ['', 'yes', 'no'].map(key => [key, counts[key]]);
  }, [periodLeads, filterCompany, filterCountry]); // eslint-disable-line react-hooks/exhaustive-deps -- see companies above; filterStatus deliberately excluded

  const filteredLeads = useMemo(() => {
    let result = periodLeads;
    if (filterCompany !== 'all') {
      result = result.filter(l => l.company === filterCompany);
    }
    if (filterCountry !== 'all') {
      result = result.filter(l => getCountryFromPhone(l.phone) === filterCountry);
    }
    if (filterStatus !== 'all') {
      result = result.filter(l => leadStatusKey(l) === filterStatus);
    }
    return result;
  }, [periodLeads, filterCompany, filterCountry, filterStatus]);

  // Conversion breakdown for the KPI row, scoped to whatever is on screen so
  // the three cards always agree with the table beneath them.
  const stats = useMemo(() => ({
    total: filteredLeads.length,
    converted: filteredLeads.filter(l => l.converted === 'yes').length,
    notConverted: filteredLeads.filter(l => l.converted === 'no').length,
  }), [filteredLeads]);

  // The four export scopes, each carrying its own live count so the menu says
  // exactly how many rows a choice will produce — no guessing which filters
  // are or aren't being honoured.
  const exportScopes = useMemo(() => {
    const curMonth = today.getUTCMonth() + 1;
    const curYear = today.getUTCFullYear();
    const monthName = new Date(Date.UTC(curYear, curMonth - 1, 1))
      .toLocaleString('default', { month: 'long', timeZone: 'UTC' });
    const utc = (l) => parseDate(l.createdAt);
    return [
      {
        key: 'view',
        label: 'Current view',
        hint: 'exactly what the table shows now, filters included',
        rows: filteredLeads,
        file: 'Current-View',
      },
      {
        key: 'month',
        label: `This month - ${monthName} ${curYear}`,
        hint: 'the real calendar month, whatever the filters say',
        rows: leads.filter(l => { const d = utc(l); return d && d.getUTCMonth() + 1 === curMonth && d.getUTCFullYear() === curYear; }),
        file: `${monthName}-${curYear}`,
      },
      {
        key: 'year',
        label: `Full year - ${filterYear}`,
        hint: 'every month of the year selected above',
        rows: leads.filter(l => { const d = utc(l); return d && d.getUTCFullYear() === filterYear; }),
        file: `Year-${filterYear}`,
      },
      {
        key: 'all',
        label: 'Everything',
        hint: 'the complete table - usable as a backup',
        rows: leads,
        file: 'All',
      },
    ];
  }, [leads, filteredLeads, filterYear, today]);

  const handleExport = (scope) => {
    setExportOpen(false);
    if (scope.rows.length === 0) {
      notify('warning', 'Nothing to export', `There are no enquiries in "${scope.label}".`);
      return;
    }
    const ws = XLSX.utils.json_to_sheet(toExportRows(scope.rows), { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    XLSX.writeFile(wb, `Leads-${scope.file}.xlsx`);
    notify('success', 'Export ready',
      `${scope.rows.length} enquir${scope.rows.length !== 1 ? 'ies' : 'y'} exported as Leads-${scope.file}.xlsx`);
  };

  const handleAdd = async (data) => {
    const result = await addLead(data);
    if (!result.ok) {
      notify(result.duplicate ? 'warning' : 'error', result.duplicate ? 'Duplicate lead' : 'Could not add lead',
        result.duplicate ? 'An identical enquiry has already been added.' : 'Please try again.');
      return;
    }
    notify('success', 'Lead added', `"${result.lead.name || 'Unnamed'}" was added to Lead Center.`);
    setShowAddModal(false);
  };

  const handleImport = async (rows) => {
    const result = await addLeadsBulk(rows);
    if (result.failed) return;
    setShowImportModal(false);
    const parts = [`${result.inserted} new lead${result.inserted !== 1 ? 's' : ''} added`];
    if (result.skipped > 0) parts.push(`${result.skipped} duplicate${result.skipped !== 1 ? 's' : ''} skipped`);
    notify(result.inserted > 0 ? 'success' : 'warning', 'Import complete', parts.join(' • '));
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const ok = await deleteLead(confirmDelete.id);
    if (ok) {
      notify('success', 'Lead deleted', `"${confirmDelete.name || 'Unnamed'}" was removed.`);
      setSelectedIds(prev => {
        if (!prev.has(confirmDelete.id)) return prev;
        const next = new Set(prev);
        next.delete(confirmDelete.id);
        return next;
      });
    }
    setConfirmDelete(null);
  };

  // Selection only ever spans the rows currently on screen (see
  // clearSelection's note), so "all selected" means all *filtered* rows.
  const allVisibleSelected = filteredLeads.length > 0 && filteredLeads.every(l => selectedIds.has(l.id));
  const someVisibleSelected = filteredLeads.some(l => selectedIds.has(l.id));

  const toggleOne = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAllVisible = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(filteredLeads.map(l => l.id)));
  };

  const handleBulkDelete = async () => {
    const ids = filteredLeads.filter(l => selectedIds.has(l.id)).map(l => l.id);
    setBulkDeleting(true);
    const result = await deleteLeadsBulk(ids);
    setBulkDeleting(false);
    setConfirmBulkDelete(false);
    clearSelection();
    if (result.deleted > 0) {
      notify(
        result.failed ? 'warning' : 'success',
        result.failed ? 'Partially deleted' : 'Enquiries deleted',
        result.failed
          ? `${result.deleted} of ${ids.length} removed before the request failed - the rest are still listed.`
          : `${result.deleted} enquir${result.deleted !== 1 ? 'ies' : 'y'} removed.`,
      );
    }
  };

  const handleUpdateStatus = async (id, patch) => {
    const ok = await updateLead(id, patch);
    if (ok) {
      notify('success', 'Status updated', patch.converted === 'yes' ? 'Marked as converted.' : patch.converted === 'no' ? 'Marked as not converted.' : 'Status cleared.');
      setDetailLead(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
    }
    return ok;
  };

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h3>Lead Center</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '2px' }}>
            Enquiries received from the website - visible to the whole team.
            {!canManageTeam && ' You can record whether an enquiry converted; an administrator manages the list itself.'}
          </p>
        </div>
        {/* Import / Export / Add are admin-only. Members keep the filters and
            the detail view, so they can still find and read anything. */}
        {canManageTeam && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <div className="lead-export-wrapper" ref={exportRef}>
              <button className="btn btn-secondary" onClick={() => setExportOpen(o => !o)} aria-expanded={exportOpen}>
                <Download size={16} /> Export <ChevronDown size={14} />
              </button>
              {exportOpen && (
                <div className="lead-export-menu" role="menu">
                  {exportScopes.map(scope => (
                    <button
                      key={scope.key}
                      type="button"
                      role="menuitem"
                      className="lead-export-item"
                      onClick={() => handleExport(scope)}
                      disabled={scope.rows.length === 0}
                    >
                      <span className="lead-export-item-main">
                        <span className="lead-export-item-label">{scope.label}</span>
                        <span className="lead-export-item-count">
                          {scope.rows.length} {scope.rows.length === 1 ? 'row' : 'rows'}
                        </span>
                      </span>
                      <span className="lead-export-item-hint">{scope.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="btn btn-secondary" onClick={() => setShowImportModal(true)}><Upload size={16} /> Import</button>
            <button className="btn btn-primary" onClick={() => setShowAddModal(true)}><Plus size={16} /> Add Lead</button>
          </div>
        )}
      </div>

      <div className="kpi-grid" style={{ marginBottom: '20px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div className="kpi-card blue">
          <div className="kpi-icon blue"><Inbox size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Total Enquiries</div>
            <div className="kpi-value"><AnimatedCounter to={stats.total} /></div>
          </div>
        </div>
        {/* Green/red match the Converted / Not Converted badges in the table,
            so the same outcome is the same colour wherever it appears. */}
        <div className="kpi-card green">
          <div className="kpi-icon green"><CheckCircle2 size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Converted</div>
            <div className="kpi-value"><AnimatedCounter to={stats.converted} /></div>
          </div>
        </div>
        <div className="kpi-card red">
          <div className="kpi-icon red"><XCircle size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Not Converted</div>
            <div className="kpi-value"><AnimatedCounter to={stats.notConverted} /></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '16px' }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {/* Three states, so PeriodToggle (a two-state Monthly/Full-Year
              control shared with Schedule, Tasks Completed and Monthly
              Report) is not reused here — widening it would change those
              pages too. Built from the same .seg/.seg-btn classes Dashboard
              uses for its own segmented control, so it looks native. */}
          <div className="seg" role="group" aria-label="Reporting period">
            <button
              type="button"
              className={`seg-btn ${periodScope === 'month' ? 'is-active' : ''}`}
              aria-pressed={periodScope === 'month'}
              onClick={() => { setPeriodScope('month'); clearSelection(); }}
            >Monthly</button>
            <button
              type="button"
              className={`seg-btn ${periodScope === 'year' ? 'is-active' : ''}`}
              aria-pressed={periodScope === 'year'}
              onClick={() => { setPeriodScope('year'); clearSelection(); }}
            >Year {filterYear}</button>
            <button
              type="button"
              className={`seg-btn ${periodScope === 'all' ? 'is-active' : ''}`}
              aria-pressed={periodScope === 'all'}
              onClick={() => { setPeriodScope('all'); clearSelection(); }}
            >All Time</button>
          </div>
          {periodScope !== 'all' && (
            <div style={{ display: 'flex', gap: '8px' }}>
              {/* Month picker only matters when scoping to a single month;
                  the year picker drives both 'month' and 'year'. */}
              {periodScope === 'month' && (
                <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterMonth} onChange={e => { setFilterMonth(parseInt(e.target.value)); clearSelection(); }}>
                  {Array.from({ length: 12 }, (_, i) => (<option key={i + 1} value={i + 1}>{new Date(2000, i).toLocaleString('default', { month: 'long' })}</option>))}
                </select>
              )}
              <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterYear} onChange={e => { setFilterYear(parseInt(e.target.value)); clearSelection(); }}>
                {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          )}
          <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterCompany} onChange={e => { setFilterCompany(e.target.value); clearSelection(); }}>
            <option value="all">All Companies</option>
            {companies.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
          </select>
          <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterCountry} onChange={e => { setFilterCountry(e.target.value); clearSelection(); }}>
            <option value="all">All Countries</option>
            {countries.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
          </select>
          <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterStatus} onChange={e => { setFilterStatus(e.target.value); clearSelection(); }}>
            <option value="all">All Statuses</option>
            {statuses.map(([key, count]) => <option key={key || 'pending'} value={key}>{STATUS_LABEL[key]} ({count})</option>)}
          </select>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '16px' }}>
        <div className="card-body">
          <WorldMap leads={filteredLeads} />
        </div>
      </div>

      {canManageTeam && selectedIds.size > 0 && (
        <div className="lead-bulk-bar">
          <span className="lead-bulk-count">
            {selectedIds.size} selected
          </span>
          <button className="btn btn-secondary btn-sm" onClick={clearSelection}>Clear selection</button>
          <button
            className="btn btn-sm btn-danger-solid lead-bulk-delete"
            onClick={() => setConfirmBulkDelete(true)}
            disabled={bulkDeleting}
          >
            <Trash2 size={14} /> {bulkDeleting ? 'Deleting…' : `Delete ${selectedIds.size}`}
          </button>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        {filteredLeads.length === 0 ? (
          <div className="empty-state">
            <Inbox size={40} />
            <h4>No enquiries yet</h4>
            <p>
              {canManageTeam
                ? 'Import a spreadsheet or add one manually to get started.'
                : 'Nothing matches the current filters.'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                {/* Selection and the delete column exist only for admins —
                    for a member there is nothing they could do with them. */}
                {canManageTeam && (
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      className="lead-checkbox"
                      checked={allVisibleSelected}
                      // Shows the dash state when only some rows are ticked, so
                      // the header never implies "all" when it isn't.
                      ref={el => { if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                      onChange={toggleAllVisible}
                      title={allVisibleSelected ? 'Clear selection' : 'Select all shown'}
                      aria-label="Select all shown enquiries"
                    />
                  </th>
                )}
                <th>Name</th><th>Company</th><th>Contact</th><th>Country</th><th>Message</th>
                <th>Status</th><th>Source</th><th>Date</th>
                {canManageTeam && <th style={{ width: 50 }}></th>}
              </tr>
            </thead>
            <tbody>
              {filteredLeads.map(lead => (
                <tr
                  key={lead.id}
                  onClick={() => setDetailLead(lead)}
                  style={{ cursor: 'pointer' }}
                  className={selectedIds.has(lead.id) ? 'is-selected' : undefined}
                >
                  {canManageTeam && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="lead-checkbox"
                        checked={selectedIds.has(lead.id)}
                        onChange={() => toggleOne(lead.id)}
                        aria-label={`Select enquiry from ${lead.name || 'unnamed contact'}`}
                      />
                    </td>
                  )}
                  <td style={{ fontWeight: 600 }}>{lead.name || '—'}</td>
                  <td>{lead.company || '—'}</td>
                  <td>
                    {lead.email && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem' }}><Mail size={12} /> {lead.email}</div>}
                    {lead.phone && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem', color: 'var(--text-muted)' }}><Phone size={12} /> {lead.phone}</div>}
                  </td>
                  <td style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}>{getCountryFromPhone(lead.phone) || '—'}</td>
                  <td style={{ maxWidth: '260px' }}>
                    <span title={lead.message} style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: '0.82rem' }}>
                      {lead.message || '—'}
                    </span>
                  </td>
                  <td>
                    {lead.converted === 'yes' ? <span className="badge badge-success">Converted</span>
                      : lead.converted === 'no' ? <span className="badge badge-danger" title={lead.convertedReason || undefined}>Not Converted</span>
                      : <span className="badge badge-pending">Pending Review</span>}
                  </td>
                  <td>
                    {lead.sourceUrl ? (
                      <a href={lead.sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        View <ExternalLink size={12} />
                      </a>
                    ) : <span style={{ color: 'var(--text-light)' }}>—</span>}
                  </td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDate(lead.createdAt)}</td>
                  {canManageTeam && (
                    <td>
                      <button className="btn-icon" style={{ color: 'var(--danger)' }} onClick={(e) => { e.stopPropagation(); setConfirmDelete(lead); }}>
                        <Trash2 size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {canManageTeam && showAddModal && <AddLeadModal onSave={handleAdd} onClose={() => setShowAddModal(false)} />}
      {canManageTeam && showImportModal && <ImportLeadsModal existingLeads={leads} onImport={handleImport} onClose={() => setShowImportModal(false)} />}
      {detailLead && (
        <LeadDetailModal
          lead={detailLead}
          onUpdateStatus={handleUpdateStatus}
          onClose={() => setDetailLead(null)}
        />
      )}

      {canManageTeam && confirmDelete && (
        <ConfirmDialog
          title="Delete Enquiry"
          message={`Are you sure you want to delete the enquiry from "${confirmDelete.name || 'this contact'}"? This cannot be undone, and the data will be permanently removed for everyone.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {canManageTeam && confirmBulkDelete && (
        <ConfirmDialog
          title={`Delete ${selectedIds.size} Enquir${selectedIds.size !== 1 ? 'ies' : 'y'}`}
          message={
            `This permanently deletes ${selectedIds.size} enquir${selectedIds.size !== 1 ? 'ies' : 'y'} for everyone on the team. ` +
            `It cannot be undone${selectedIds.size === filteredLeads.length && filteredLeads.length > 1 ? ' - that is every enquiry currently shown' : ''}. ` +
            `Please make sure you have a copy of anything you still need.`
          }
          confirmLabel={`Delete ${selectedIds.size}`}
          onConfirm={handleBulkDelete}
          onCancel={() => setConfirmBulkDelete(false)}
        />
      )}
    </div>
  );
}

function AddLeadModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    name: '', company: '', email: '', phone: '', message: '',
    confirmed: false, sourceUrl: '', createdAt: new Date().toISOString().slice(0, 10),
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSave({
      name: form.name.trim(), company: form.company.trim(), email: form.email.trim(),
      phone: form.phone.trim(), message: form.message.trim(),
      confirm: form.confirmed ? CONFIRM_YES : '',
      sourceUrl: form.sourceUrl.trim(),
      createdAt: new Date(form.createdAt).toISOString(),
    });
    setSaving(false);
  };

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="modal-header">
            <h3>Add Lead</h3>
            <button className="btn-icon" onClick={onClose}><X size={20} /></button>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="form-group">
                <label className="form-label">Name *</label>
                <input className="form-input" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g., Mark Ampong" />
              </div>
              <div className="form-group">
                <label className="form-label">Company</label>
                <input className="form-input" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} placeholder="e.g., Saltegra Consulting LLC" />
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Phone/Mobile</label>
                  <input className="form-input" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Message</label>
                <textarea className="form-input" rows={4} value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Source URL</label>
                <input className="form-input" value={form.sourceUrl} onChange={e => setForm({ ...form, sourceUrl: e.target.value })} placeholder="https://ifluids.com/contact-us/" />
              </div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Date</label>
                  <input className="form-input" type="date" value={form.createdAt} onChange={e => setForm({ ...form, createdAt: e.target.value })} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', paddingBottom: '10px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.confirmed} onChange={e => setForm({ ...form, confirmed: e.target.checked })} />
                  This is a project enquiry
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim()}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
}

function ImportLeadsModal({ existingLeads, onImport, onClose }) {
  const [previewData, setPreviewData] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = React.useRef(null);

  const processFile = (file) => {
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // cellDates:true converts genuinely date-typed cells straight into JS
        // Date objects instead of leaving them as raw Excel serial numbers —
        // see parseDate's own fallback for the rest of the story.
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws);
        if (json.length === 0) { setError('No data found in the file.'); return; }
        const seen = [...existingLeads];
        const mapped = json.map(row => {
          const rawDate = row['created_at'] || row['Created At'] || row['createdAt'] || '';
          const parsed = parseDate(rawDate);
          const lead = {
            name: (row['Name'] || row['name'] || '').toString().trim(),
            company: (row['Company'] || row['company'] || '').toString().trim(),
            email: (row['Email'] || row['email'] || '').toString().trim(),
            phone: (row['Phone/Mobile'] || row['Phone'] || row['phone'] || row['Mobile'] || '').toString().trim(),
            message: (row['Message'] || row['message'] || '').toString().trim(),
            confirm: (row['Confirm'] || row['confirm'] || '').toString().trim(),
            sourceUrl: (row['Source URL'] || row['source_url'] || row['SourceURL'] || '').toString().trim(),
            createdAt: (parsed || new Date()).toISOString(),
            dateInvalid: !!rawDate && !parsed,
            // Read back from an exported file, so a restore keeps the
            // conversion decisions instead of resetting everything to
            // Pending Review. Absent in a raw website export, which
            // correctly leaves these blank.
            ...readStatusColumns(row),
          };
          const duplicate = isDuplicateLead(lead, seen);
          if (!duplicate) seen.push(lead);
          return { ...lead, duplicate };
        }).filter(r => r.name);
        setPreviewData(mapped);
      } catch { setError('Failed to parse file. Please use .xlsx or .csv format.'); }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); };

  const handleConfirmImport = async () => {
    if (!previewData) return;
    setImporting(true);
    // Explicit pick rather than passing the preview rows straight through —
    // they also carry UI-only flags (duplicate, dateInvalid) that must not
    // reach the database.
    await onImport(previewData.map(({ name, company, email, phone, message, confirm, sourceUrl, createdAt, converted, convertedReason }) =>
      ({ name, company, email, phone, message, confirm, sourceUrl, createdAt, converted, convertedReason })));
    setImporting(false);
  };

  const downloadTemplate = () => {
    const t = [{
      Name: 'Mark Ampong', Company: 'Saltegra Consulting LLC', Email: 'mampong@saltegra.com',
      'Phone/Mobile': '+639069621940', Message: 'Looking for a DHA and QRA for a plant.',
      Confirm: CONFIRM_YES, 'Source URL': 'https://ifluids.com/contact-us/', created_at: '2026-08-13 08:20:23',
    }];
    const ws = XLSX.utils.json_to_sheet(t);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    XLSX.writeFile(wb, 'leads_template.xlsx');
  };

  const duplicateCount = previewData ? previewData.filter(r => r.duplicate).length : 0;
  const invalidDateCount = previewData ? previewData.filter(r => r.dateInvalid).length : 0;

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-lg">
          <div className="modal-header"><h3>Import Leads</h3><button className="btn-icon" onClick={onClose}><X size={20} /></button></div>
          <div className="modal-body">
            {!previewData ? (
              <>
                <div className={`upload-zone ${dragOver ? 'dragover' : ''}`} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop} onClick={() => fileRef.current?.click()}>
                  <Upload size={36} style={{ color: 'var(--primary)', marginBottom: '12px' }} />
                  <h4 style={{ marginBottom: '6px' }}>Drag & Drop your file here</h4>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>or click to browse • Supports .xlsx and .csv</p>
                  <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); }} />
                </div>
                {error && <div style={{ marginTop: '12px', padding: '10px 14px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}><AlertCircle size={16} /> {error}</div>}
                <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Columns: Name, Company, Email, Phone/Mobile, Message, Confirm, Source URL, created_at</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={downloadTemplate}><FileSpreadsheet size={14} /> Download Template</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ fontWeight: 600 }}>
                    {previewData.length} rows found
                    {duplicateCount > 0 && <span style={{ color: 'var(--warning)', fontWeight: 500 }}> • {duplicateCount} look like duplicates, will be skipped</span>}
                    {invalidDateCount > 0 && <span style={{ color: 'var(--danger)', fontWeight: 500 }}> • {invalidDateCount} have an unreadable date, defaulted to today</span>}
                  </span>
                  <button className="btn btn-secondary btn-sm" onClick={() => setPreviewData(null)}>← Back</button>
                </div>
                <div style={{ maxHeight: '350px', overflow: 'auto', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                  <table className="data-table">
                    <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Date</th><th>Status</th></tr></thead>
                    <tbody>{previewData.map((row, idx) => (
                      <tr key={idx} style={row.duplicate ? { opacity: 0.55 } : undefined}>
                        <td style={{ fontWeight: 500 }}>{row.name}</td>
                        <td>{row.company || '—'}</td>
                        <td>{row.email || '—'}</td>
                        <td>{formatDate(row.createdAt)}</td>
                        <td>
                          {row.duplicate
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--warning)', fontSize: '0.8rem' }}><AlertCircle size={14} /> Duplicate</span>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--success)', fontSize: '0.8rem' }}><CheckCircle2 size={14} /> New</span>}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            {previewData && (
              <button type="button" className="btn btn-primary" onClick={handleConfirmImport} disabled={importing}>
                {importing ? 'Importing…' : `Import ${previewData.length - duplicateCount} New Lead${previewData.length - duplicateCount !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function DetailRow({ icon: Icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: '10px', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ width: '20px', flexShrink: 0, color: 'var(--text-light)', paddingTop: '2px' }}><Icon size={16} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>{label}</div>
        <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', wordBreak: 'break-word' }}>{children}</div>
      </div>
    </div>
  );
}

// Open to every role. Setting the conversion outcome is the work of whoever
// handled the enquiry, so members edit it here too — the database backs that
// up with a column-level grant covering only converted/converted_reason (see
// supabase_leads_admin_only_writes.sql), so this form cannot be used to alter
// a contact's details even via the API.
function LeadDetailModal({ lead, onUpdateStatus, onClose }) {
  const [converted, setConverted] = useState(lead.converted || '');
  const [reason, setReason] = useState(lead.convertedReason || '');
  const [saving, setSaving] = useState(false);

  const dirty = converted !== (lead.converted || '') || reason !== (lead.convertedReason || '');
  const needsReason = converted === 'no';
  const canSave = dirty && (!needsReason || reason.trim());

  const handleSave = async () => {
    setSaving(true);
    const ok = await onUpdateStatus(lead.id, { converted, convertedReason: needsReason ? reason.trim() : '' });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="modal-header">
            <h3>{lead.name || 'Enquiry'}</h3>
            <button className="btn-icon" onClick={onClose}><X size={20} /></button>
          </div>
          <div className="modal-body">
            <DetailRow icon={Inbox} label="Company">{lead.company || '—'}</DetailRow>
            <DetailRow icon={Mail} label="Email">{lead.email || '—'}</DetailRow>
            <DetailRow icon={Phone} label="Phone / Mobile">{lead.phone || '—'}</DetailRow>
            <DetailRow icon={FileSpreadsheet} label="Message">
              <span style={{ whiteSpace: 'pre-wrap' }}>{lead.message || '—'}</span>
            </DetailRow>
            <DetailRow icon={CheckCircle2} label="Website form confirmation">{lead.confirm || '—'}</DetailRow>
            <DetailRow icon={ExternalLink} label="Source">
              {lead.sourceUrl
                ? <a href={lead.sourceUrl} target="_blank" rel="noreferrer">{lead.sourceUrl}</a>
                : '—'}
            </DetailRow>
            <DetailRow icon={Calendar} label="Date">{formatDate(lead.createdAt)}</DetailRow>

            <div style={{ marginTop: '18px', paddingTop: '16px', borderTop: '2px solid var(--border)' }}>
              <label className="form-label">Conversion status</label>
              <select className="form-select" value={converted} onChange={e => setConverted(e.target.value)}>
                <option value="">Pending Review</option>
                <option value="yes">Yes - Converted</option>
                <option value="no">No - Not Converted</option>
              </select>
              {needsReason && (
                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">Why wasn't this converted? *</label>
                  <textarea className="form-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g., Budget too low, went with another vendor, out of scope…" />
                </div>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!canSave || saving}>
              {saving ? 'Saving…' : 'Save Status'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
