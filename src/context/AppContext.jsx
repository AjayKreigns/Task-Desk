import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useNotification } from './NotificationContext';
import { useAuth } from './AuthContext';
import { taskWrite } from '../lib/schemaFallback';
import { classifyDbError } from '../lib/dbErrors';
import { isDuplicateLead } from '../lib/leadDedup';
import { getTaskPercent } from '../lib/taskProgress';
import {
  DEFAULT_CATEGORIES, CATEGORY_PALETTE, normalizeHex, defaultCategoryColor,
} from '../lib/categories';
import { normalizeRole } from '../lib/roles';

const AppContext = createContext();

// Shown when the database refuses a write. Worded for the person reading it rather
// than echoing Postgres — once roles exist, these are the actions only an admin has.
const TEAM_PERMISSION_MSG = 'Only an administrator can change the team list.';
const SITE_PERMISSION_MSG = 'Only an administrator can change the website list.';
const CATEGORY_PERMISSION_MSG = 'Only an administrator can change the category list.';

const STORAGE_KEYS = {
  employees: 'td_employees',
  websites: 'td_websites',
  tasks: 'td_tasks',
  comments: 'td_comments',
  activityLog: 'td_activity',
  categories: 'td_categories_v2',
  teams: 'td_teams',
  leads: 'td_leads',
};

const LEAD_PERMISSION_MSG = 'Could not save this - you may need to sign in again.';

// Helper: convert a Supabase leads row to app format
function mapLeadFromDB(row) {
  return {
    id: row.id,
    name: row.name || '',
    company: row.company || '',
    email: row.email || '',
    phone: row.phone || '',
    message: row.message || '',
    confirm: row.confirm || '',
    sourceUrl: row.source_url || '',
    createdAt: row.created_at,
    // '' = not yet reviewed, 'yes'/'no' = a conversion call has been made.
    // Independent of `confirm` above (that's the website form's own
    // submission-intent checkbox, not a conversion outcome) — see
    // supabase_leads_conversion_tracking.sql.
    converted: row.converted || '',
    convertedReason: row.converted_reason || '',
  };
}

// The duplicate rule lives in src/lib/leadDedup.js — see the long note there
// on why it deliberately ignores the exact timestamp. Used here for
// local-only mode (no database to enforce it) and imported by LeadCenter for
// the import preview.

// Helper: convert a Supabase categories row to app format
function mapCategoryFromDB(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    color: row.color,
    hidden: row.hidden || false,
  };
}

const defaultEmployees = [
  { id: uuidv4(), name: 'Priya Sharma', designation: 'SEO Specialist', email: 'priya@company.com' },
  { id: uuidv4(), name: 'Rahul Verma', designation: 'Content Writer', email: 'rahul@company.com' },
  { id: uuidv4(), name: 'Anita Desai', designation: 'Social Media Manager', email: 'anita@company.com' },
];

const defaultWebsites = [
  { id: uuidv4(), name: 'techsolutions.com', description: 'Main Business Website' },
  { id: uuidv4(), name: 'digitalhub.in', description: 'Digital Marketing Blog' },
];

// Local-only mode's starting category set — the same pairing the
// supabase_categories_table.sql migration seeds a brand-new team with, just
// built client-side here since there's no database to seed in this mode.
const defaultCategoryRows = DEFAULT_CATEGORIES.map((name, i) => ({
  id: uuidv4(), name, color: CATEGORY_PALETTE[i] || defaultCategoryColor(i), hidden: false,
}));

// Local-only mode has no database to fetch a `teams` row from, but Settings'
// Employees tab now needs at least one team card to drill into — without
// this, the whole roster (demo employees above included) would be
// permanently unreachable the moment this feature shipped, since
// `teamCards` is built from `teams`, not from `employees` directly.
const defaultTeams = [
  { id: uuidv4(), name: 'Digital Marketing', entity_label_singular: 'Website', entity_label_plural: 'Websites', is_lead_source_team: true },
];

function loadFromStorage(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored);
  } catch (e) { console.error(`Error loading ${key}:`, e); }
  return fallback;
}

function saveToStorage(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); }
  catch (e) { console.error(`Error saving ${key}:`, e); }
}

// Helper: convert Supabase row to app format
function mapTaskFromDB(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category || 'General',
    assignedTo: row.assigned_to || '',
    websiteId: row.website_id || '',
    priority: row.priority || 'medium',
    status: row.status === 'completed' ? 'completed' : 'pending',
    referenceUrl: row.reference_url || '',
    completionUrl: row.completion_url || '',
    completedDate: row.completed_date || null,
    month: row.month,
    year: row.year,
    createdAt: row.created_at,
    isAdditional: row.is_additional || false,
    carryForwardFrom: row.carry_forward_from || null,
    carryForwardTo: row.carry_forward_to || null,
    // Set only by the scheduled auto_carry_forward_tasks() Postgres function
    // (see supabase_task_auto_carryforward.sql), never by the app — this is
    // what lets the client tell "auto-carried on this date" apart from an
    // ordinary manual carry-forward, which has no batch and was already
    // announced client-side at click-time.
    carryForwardBatch: row.carry_forward_batch || null,
    targetedTime: row.targeted_time || 0,
    timeTaken: row.time_taken || 0,
  };
}

function mapTaskToDB(task) {
  const dbStatus = task.status === 'completed' ? 'completed' : 'pending';
  return {
    title: task.title,
    category: task.category || 'General',
    assigned_to: task.assignedTo || null,
    website_id: task.websiteId || null,
    priority: task.priority || 'medium',
    status: dbStatus,
    progress: getTaskPercent(task),
    reference_url: task.referenceUrl || '',
    completion_url: task.completionUrl || '',
    completed_date: task.completedDate || null,
    month: task.month,
    year: task.year,
    is_additional: task.isAdditional || false,
    carry_forward_from: task.carryForwardFrom || null,
    carry_forward_to: task.carryForwardTo || null,
    targeted_time: task.targetedTime || 0,
    time_taken: task.timeTaken || 0,
  };
}

export function AppProvider({ children }) {
  // "Does this build have credentials?" Derived once and never changed. Every write
  // path below branches on it, so flipping it to false on a failure would silently
  // redirect writes into local state that never reaches the server — the user would
  // keep working, believe everything saved, and lose it on refresh. Reachability and
  // authorisation are tracked separately in cloudStatus.
  const isCloud = isSupabaseConfigured();

  // Read early (AuthContext.jsx computes all of this independently of
  // AppContext) — isSuperAdmin decides the seed guards right below, well
  // before authKey/currentUserName/etc. further down ever needed authCtx.
  const authCtx = useAuth();
  const isSuperAdmin = authCtx?.isSuperAdmin ?? false;
  const selectedTeamId = authCtx?.selectedTeamId ?? null;
  const setSelectedTeamId = authCtx?.setSelectedTeamId;
  const myTeamId = authCtx?.myTeamId ?? null;

  // In cloud mode the server is the source of truth, so seed empty rather than with
  // demo people. Otherwise a cleared cache hydrates the three fake employees, they
  // flash on screen before the fetch lands, and — worse — if the fetch is denied
  // they persist and look real, so a task assigned to one would write an
  // assigned_to UUID that does not exist server-side.
  //
  // isCloud alone already covers the super-admin case (switching teams flashes
  // the OLD team's cached rows for an instant before the new fetch lands,
  // same reasoning as above) — isSuperAdmin adds nothing further here since
  // it only matters once isCloud is already true. It's called out in this
  // comment because local-only mode's AuthContext hard-codes isSuperAdmin to
  // true for every session, which would otherwise look like it should empty
  // the local demo-data fallback below — it must not.
  const seedEmployees = isCloud ? [] : defaultEmployees;
  const seedWebsites = isCloud ? [] : defaultWebsites;
  const seedCategories = isCloud ? [] : defaultCategoryRows;
  const seedTeams = isCloud ? [] : defaultTeams;

  const [employees, setEmployees] = useState(() => loadFromStorage(STORAGE_KEYS.employees, seedEmployees));
  const [websites, setWebsites] = useState(() => loadFromStorage(STORAGE_KEYS.websites, seedWebsites));
  const [tasks, setTasks] = useState(() => loadFromStorage(STORAGE_KEYS.tasks, []));
  const [comments, setComments] = useState(() => loadFromStorage(STORAGE_KEYS.comments, []));
  const [activityLog, setActivityLog] = useState(() => loadFromStorage(STORAGE_KEYS.activityLog, []));
  const [categoryRows, setCategoryRows] = useState(() => loadFromStorage(STORAGE_KEYS.categories, seedCategories));
  const [teams, setTeams] = useState(() => loadFromStorage(STORAGE_KEYS.teams, seedTeams));
  const [leads, setLeads] = useState(() => loadFromStorage(STORAGE_KEYS.leads, []));
  // Reachability + authorisation, as opposed to isCloud's "are we configured".
  //   'local'        no backend at all
  //   'connecting'   credentials exist, first fetch in flight
  //   'ready'        the database answered
  //   'unauthorized' the database refused us (RLS, expired session)
  //   'error'        unreachable or an unexpected failure
  const [cloudStatus, setCloudStatus] = useState(isCloud ? 'connecting' : 'local');
  const [cloudError, setCloudError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Bumping this re-runs the fetch effect below — the mechanism a future Retry
  // control needs. Also bumped once automatically if the realtime channel drops.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [channelEpoch, setChannelEpoch] = useState(0);
  const schemaWarned = useRef(false);

  // AppProvider renders inside AuthGate, which renders inside NotificationProvider;
  // the optional chaining below keeps this file usable even if either of those
  // ever stops being true.
  const notificationCtx = useNotification();
  const authKey = authCtx?.authKey ?? 'local';
  const reportSessionExpired = authCtx?.reportSessionExpired;
  // Falls back to the raw login email if this person has no linked employee
  // row yet (mid-setup), and to a generic label in local-only mode where
  // there is no signed-in identity at all.
  const currentUserName = authCtx?.employee?.name || authCtx?.user?.email || 'Unknown';

  // A PGRST301 (expired/invalid JWT) means more than "show an error" — it means
  // the client needs to re-authenticate. This both marks the connection
  // unauthorized AND asks AuthContext to sign the user out and show the login
  // screen again, so a stale session doesn't just spin forever with failed writes.
  const handleAuthError = useCallback(() => {
    setCloudStatus('unauthorized');
    reportSessionExpired?.();
  }, [reportSessionExpired]);
  const warnMissingColumn = useCallback((col) => {
    console.warn(`tasks.${col} is missing in the database — saving without it. Run supabase_migration.sql to enable it.`);
    if (schemaWarned.current) return;
    schemaWarned.current = true;
    notificationCtx?.notify?.(
      'warning',
      'Database update needed',
      `The "tasks" table is missing the ${col} column, so time tracking will not be saved. Run supabase_migration.sql in Supabase to enable it.`,
    );
  }, [notificationCtx]);

  // Runs one Supabase call and reports failures in human terms. Every database
  // call in this file goes through here, so there is a single place that knows how
  // to talk about permission denials, expired sessions and unreachable servers.
  //
  // `permissionMsg` lets a call site say something specific ("Only an
  // administrator can change the team list") instead of the generic wording.
  const dbRun = useCallback(async (label, run, permissionMsg) => {
    const result = await run();
    if (result?.error) {
      const { kind, message } = classifyDbError(result.error);
      console.error(`${label}:`, result.error);
      const text = kind === 'permission' && permissionMsg ? permissionMsg : message;
      notificationCtx?.notify?.('error', label, text);
      if (kind === 'auth') handleAuthError();
    }
    return result;
  }, [notificationCtx, handleAuthError]);

  // Reports a write that came back successful but changed nothing. Under RLS a
  // denied UPDATE or DELETE looks exactly like this — the row is invisible to the
  // policy, so nothing matches and PostgREST returns no error. Without this check
  // the UI would show a change the server rejected.
  const reportBlocked = useCallback((label, message) => {
    console.warn(`${label}: write affected 0 rows — blocked by a database policy.`);
    notificationCtx?.notify?.('error', label, message);
  }, [notificationCtx]);

  // A Retry control (or anything else) can force a re-fetch by calling this.
  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

  // === DATA FETCH ===
  // Split from realtime (below) so each can depend on what it actually needs —
  // this one on isCloud and refreshNonce, the channel on isCloud and the signed-in
  // user. Combined, they used to be one effect gated by an `initialized` ref,
  // which is also what made a Retry action impossible: the ref meant the effect
  // could only ever run once, ever, for the lifetime of the component.
  useEffect(() => {
    if (!isCloud) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function fetchAll() {
      setCloudStatus('connecting');
      try {
        // teams is fetched first, not folded into the Promise.all below,
        // because a super admin's very first session has no team selected
        // yet — that has to be resolved before employees/websites/tasks/
        // categories can be correctly scoped to one team.
        const teamsRes = await supabase.from('teams').select('*').order('created_at');
        if (cancelled) return;
        if (teamsRes.error) {
          // Pre-existing installs haven't run supabase_teams_foundation.sql
          // yet — degrade like the leads table below, not a hard failure.
          console.warn('Teams fetch failed (has supabase_teams_foundation.sql been run?):', teamsRes.error);
        } else if (teamsRes.data) {
          setTeams(teamsRes.data);
        }
        const teamRows = teamsRes.data || [];

        if (isSuperAdmin && !selectedTeamId && teamRows.length > 0) {
          // App.jsx keys <AppProvider> on selectedTeamId for a super admin, so
          // setting it here unmounts and remounts this whole provider with
          // the real scope — this same in-flight fetch must not continue.
          setSelectedTeamId?.(teamRows[0].id);
          setLoading(false);
          return;
        }

        // Only a super admin needs this — everyone else's RLS policies
        // already return just their own team's rows unfiltered.
        const scope = (query) => (isSuperAdmin && selectedTeamId ? query.eq('team_id', selectedTeamId) : query);

        const [empRes, siteRes, taskRes, catRes, leadRes] = await Promise.all([
          scope(supabase.from('employees').select('*')).order('created_at'),
          scope(supabase.from('websites').select('*')).order('created_at'),
          scope(supabase.from('tasks').select('*')).order('created_at'),
          scope(supabase.from('categories').select('*')).order('created_at'),
          supabase.from('leads').select('*').order('created_at', { ascending: false }),
        ]);
        if (cancelled) return;

        // Promise.all does not reject on a PostgREST error, so these have to be
        // inspected explicitly. Previously an RLS-denied read produced
        // { data: null, error } and fell through every `if (res.data)` guard with
        // no console output and no toast — the dashboard just looked empty.
        //
        // leadRes and catRes are deliberately NOT part of this — leads and
        // categories are both newer tables than employees/websites/tasks, so
        // an install that hasn't yet run their migrations would otherwise see
        // the ENTIRE dashboard fail to load over one missing table. A failed
        // fetch for either degrades only its own feature, handled separately
        // below.
        const firstError = empRes.error || siteRes.error || taskRes.error;
        if (firstError) {
          const { kind, message } = classifyDbError(firstError);
          console.error('Supabase fetch error:', firstError);
          if (kind === 'auth') handleAuthError();
          else setCloudStatus(kind === 'permission' ? 'unauthorized' : 'error');
          setCloudError(message);
          setLoading(false);
          // Deliberately return without touching state: the cached data already on
          // screen is more useful than blanking it, and blanking would also wipe
          // the localStorage mirror via the save effects below.
          return;
        }

        if (empRes.data) setEmployees(empRes.data.map(e => ({ id: e.id, name: e.name, designation: e.designation, email: e.email || '', role: normalizeRole(e.role) })));
        if (siteRes.data) setWebsites(siteRes.data.map(w => ({ id: w.id, name: w.name, description: w.description || '' })));
        if (taskRes.data) setTasks(taskRes.data.map(mapTaskFromDB));
        if (catRes.error) {
          console.warn('Categories fetch failed (has supabase_categories_table.sql been run?):', catRes.error);
        } else if (catRes.data) {
          setCategoryRows(catRes.data.map(mapCategoryFromDB));
        }
        if (leadRes.error) {
          console.warn('Leads fetch failed (has supabase_leads_table.sql been run?):', leadRes.error);
        } else if (leadRes.data) {
          setLeads(leadRes.data.map(mapLeadFromDB));
        }
        setCloudStatus('ready');
        setCloudError(null);
      } catch (err) {
        if (cancelled) return;
        // A thrown error here means the request never completed (offline, DNS, CORS).
        console.error('Supabase fetch error:', err);
        const { message } = classifyDbError(err);
        setCloudStatus('error');
        setCloudError(message);
      }
      if (!cancelled) setLoading(false);
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [isCloud, refreshNonce, handleAuthError, isSuperAdmin, selectedTeamId, setSelectedTeamId]);

  // === REALTIME ===
  // Keyed on authKey so a different user signing in gets a fresh channel under
  // their own name, and on channelEpoch so a dropped connection can rebuild
  // itself. `torndown` distinguishes a status callback that fires because the
  // effect is intentionally tearing down (unmount, or authKey/epoch changing)
  // from one reporting a real drop — without it, calling removeChannel in the
  // cleanup could itself trigger a CLOSED callback that bumps the epoch and
  // starts an unnecessary reconnect right as the component unmounts.
  useEffect(() => {
    if (!isCloud) return undefined;

    let torndown = false;
    // A super admin's own RLS legitimately allows reading every team, so
    // Realtime can hand them a live event for a team other than the one
    // currently selected — the initial fetch above filters by team, but
    // nothing stops a cross-team row sneaking into these handlers without
    // this check. Not needed for `leads` (never team-scoped) or for anyone
    // but a super admin (everyone else's own RLS already only ever admits
    // their one team's events in the first place).
    const crossTeamLeak = (row) => isSuperAdmin && row?.team_id != null && row.team_id !== selectedTeamId;
    const channel = supabase.channel(`db-changes-${authKey}-${channelEpoch}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employees' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const e = payload.new;
          if (crossTeamLeak(e)) return;
          setEmployees(prev => {
            if (prev.find(x => x.id === e.id)) return prev;
            return [...prev, { id: e.id, name: e.name, designation: e.designation, email: e.email || '', role: normalizeRole(e.role) }];
          });
        } else if (payload.eventType === 'UPDATE') {
          const e = payload.new;
          if (crossTeamLeak(e)) return;
          setEmployees(prev => prev.map(x => x.id === e.id ? { id: e.id, name: e.name, designation: e.designation, email: e.email || '', role: normalizeRole(e.role) } : x));
        } else if (payload.eventType === 'DELETE') {
          setEmployees(prev => prev.filter(x => x.id !== payload.old.id));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'websites' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const w = payload.new;
          if (crossTeamLeak(w)) return;
          setWebsites(prev => {
            if (prev.find(x => x.id === w.id)) return prev;
            return [...prev, { id: w.id, name: w.name, description: w.description || '' }];
          });
        } else if (payload.eventType === 'UPDATE') {
          const w = payload.new;
          if (crossTeamLeak(w)) return;
          setWebsites(prev => prev.map(x => x.id === w.id ? { id: w.id, name: w.name, description: w.description || '' } : x));
        } else if (payload.eventType === 'DELETE') {
          setWebsites(prev => prev.filter(x => x.id !== payload.old.id));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          if (crossTeamLeak(payload.new)) return;
          const t = mapTaskFromDB(payload.new);
          setTasks(prev => {
            if (prev.find(x => x.id === t.id)) return prev;
            return [...prev, t];
          });
        } else if (payload.eventType === 'UPDATE') {
          if (crossTeamLeak(payload.new)) return;
          const t = mapTaskFromDB(payload.new);
          setTasks(prev => prev.map(x => x.id === t.id ? t : x));
        } else if (payload.eventType === 'DELETE') {
          setTasks(prev => prev.filter(x => x.id !== payload.old.id));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const c = payload.new;
          if (crossTeamLeak(c)) return;
          setCategoryRows(prev => {
            if (prev.find(x => x.id === c.id)) return prev;
            return [...prev, mapCategoryFromDB(c)];
          });
        } else if (payload.eventType === 'UPDATE') {
          const c = payload.new;
          if (crossTeamLeak(c)) return;
          setCategoryRows(prev => prev.map(x => x.id === c.id ? mapCategoryFromDB(c) : x));
        } else if (payload.eventType === 'DELETE') {
          setCategoryRows(prev => prev.filter(x => x.id !== payload.old.id));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const l = mapLeadFromDB(payload.new);
          setLeads(prev => {
            if (prev.find(x => x.id === l.id)) return prev;
            return [l, ...prev];
          });
        } else if (payload.eventType === 'UPDATE') {
          const l = mapLeadFromDB(payload.new);
          setLeads(prev => prev.map(x => x.id === l.id ? l : x));
        } else if (payload.eventType === 'DELETE') {
          setLeads(prev => prev.filter(x => x.id !== payload.old.id));
        }
      })
      .subscribe((status) => {
        if (torndown) return;
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setChannelEpoch((e) => e + 1);
        }
      });

    return () => {
      torndown = true;
      supabase.removeChannel(channel);
    };
  }, [isCloud, authKey, channelEpoch, isSuperAdmin, selectedTeamId]);

  // Save to localStorage as fallback cache
  useEffect(() => { saveToStorage(STORAGE_KEYS.employees, employees); }, [employees]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.websites, websites); }, [websites]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.tasks, tasks); }, [tasks]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.comments, comments); }, [comments]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.activityLog, activityLog); }, [activityLog]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.categories, categoryRows); }, [categoryRows]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.teams, teams); }, [teams]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.leads, leads); }, [leads]);

  // === ACTIVITY LOG ===
  const logActivity = useCallback((action, taskTitle, details = '', taskId = '') => {
    const entry = { id: uuidv4(), action, taskTitle, details, taskId, timestamp: new Date().toISOString() };
    setActivityLog(prev => [entry, ...prev].slice(0, 200));
  }, []);

  const getRecentActivity = useCallback((limit = 20) => {
    return activityLog.slice(0, limit);
  }, [activityLog]);

  // === COMMENTS ===
  // `author` is a normal parameter, coalesced in the body rather than given a
  // default value — a caller that explicitly passes `undefined` (as opposed to
  // omitting the argument) still gets the real signed-in name this way, where a
  // default parameter would not have caught that case.
  const addComment = useCallback((taskId, text, author) => {
    const comment = { id: uuidv4(), taskId, author: author || currentUserName, text, createdAt: new Date().toISOString() };
    setComments(prev => [comment, ...prev]);
    return comment;
  }, [currentUserName]);

  const getTaskComments = useCallback((taskId) => {
    return comments.filter(c => c.taskId === taskId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [comments]);

  // === EMPLOYEE OPERATIONS ===
  // Every branch below follows the same three rules, which are what make these
  // safe once RLS is on: report failures to the user rather than only the console,
  // verify that a write actually touched a row, and never apply a change locally
  // that the server refused.
  const addEmployee = useCallback(async (emp) => {
    const role = normalizeRole(emp.role);
    if (isCloud) {
      // team_id: selectedTeamId — already resolves to the right value either
      // way (AuthContext.jsx pins it to the caller's own team for anyone but
      // a super admin, and to whichever team a super admin currently has
      // selected), and is_team_admin(team_id)'s WITH CHECK only passes a
      // super admin through for any value, so this is also what makes "which
      // team does a super admin's new hire land in" actually work.
      const { data, error } = await dbRun(
        'Could not add team member',
        () => supabase.from('employees').insert({ name: emp.name, designation: emp.designation, email: emp.email || '', role, team_id: selectedTeamId }).select().single(),
        TEAM_PERMISSION_MSG,
      );
      if (error || !data) return null;
      const newEmp = { id: data.id, name: data.name, designation: data.designation, email: data.email || '', role: normalizeRole(data.role) };
      setEmployees(prev => {
        if (prev.find(x => x.id === newEmp.id)) return prev;
        return [...prev, newEmp];
      });
      return newEmp;
    }
    const newEmp = { ...emp, role, id: uuidv4() };
    setEmployees(prev => [...prev, newEmp]);
    return newEmp;
  }, [isCloud, dbRun, selectedTeamId]);

  const updateEmployee = useCallback(async (id, data) => {
    if (isCloud) {
      // team_id is deliberately NOT part of this plain update — moving
      // someone to a different team also has to move every one of their
      // tasks (scheduled, completed, pending, all of it — confirmed with the
      // user), which a bare employees-table UPDATE can't do: tasks.team_id
      // is pinned by tasks_assign_team_id_trg on any update that doesn't
      // also change assigned_to. move_employee_to_team() (
      // supabase_teams_move_employee_rpc.sql) is the one place that does
      // both atomically, so a team move always goes through it below,
      // never through this payload.
      const payload = { name: data.name, designation: data.designation, email: data.email || '', role: normalizeRole(data.role) };
      const { data: rows, error } = await dbRun(
        'Could not save team member',
        () => supabase.from('employees').update(payload).eq('id', id).select('id'),
        TEAM_PERMISSION_MSG,
      );
      // Return before touching state on failure. The previous version logged the
      // error and then applied the edit regardless, so a rejected rename stayed on
      // screen until the next fetch quietly reverted it.
      if (error) return;
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not save team member', TEAM_PERMISSION_MSG);
        return;
      }
      setEmployees(prev => prev.map(e => e.id === id ? { ...e, ...data } : e));

      // teamId is only ever present when a super admin picked a different
      // destination team in the Employee modal (Settings.jsx) — omitted
      // entirely otherwise. Unchanged (picked the team they're already in)
      // is a no-op here, same as it always was.
      if (data.teamId && data.teamId !== selectedTeamId) {
        const { error: moveError } = await dbRun(
          'Could not move employee',
          () => supabase.rpc('move_employee_to_team', { p_employee_id: id, p_new_team_id: data.teamId }),
        );
        if (moveError) return; // name/role changes above already saved regardless
        // Counted before dropping them below — the confirmation step in
        // Settings.jsx's Employee modal already showed this same list before
        // the move was confirmed; this is the after-the-fact receipt.
        const movedCount = tasks.filter(t => t.assignedTo === id).length;
        const destinationName = teams.find(t => t.id === data.teamId)?.name || 'the new team';
        notificationCtx?.notify?.('success', 'Employee moved',
          movedCount > 0
            ? `${data.name} moved to ${destinationName} with ${movedCount} task${movedCount !== 1 ? 's' : ''}.`
            : `${data.name} moved to ${destinationName}.`);
        // Moved to a different team than the one currently in view: both the
        // employee and every one of their tasks no longer belong in this
        // scoped view at all, so they're dropped rather than merged —
        // merging the team change in would otherwise leave them visibly
        // stuck in the wrong team's lists until the next full refetch.
        setEmployees(prev => prev.filter(e => e.id !== id));
        setTasks(prev => prev.filter(t => t.assignedTo !== id));
      }
      return;
    }
    setEmployees(prev => prev.map(e => e.id === id ? { ...e, ...data } : e));
  }, [isCloud, dbRun, reportBlocked, selectedTeamId, tasks, teams, notificationCtx]);

  const deleteEmployee = useCallback(async (id) => {
    if (isCloud) {
      const { data: rows, error } = await dbRun(
        'Could not remove team member',
        () => supabase.from('employees').delete().eq('id', id).select('id'),
        TEAM_PERMISSION_MSG,
      );
      if (error) return;
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not remove team member', TEAM_PERMISSION_MSG);
        return;
      }
      setEmployees(prev => prev.filter(e => e.id !== id));
      return;
    }
    setEmployees(prev => prev.filter(e => e.id !== id));
  }, [isCloud, dbRun, reportBlocked]);

  // === WEBSITE OPERATIONS ===
  const addWebsite = useCallback(async (site) => {
    if (isCloud) {
      const { data, error } = await dbRun(
        'Could not add website',
        () => supabase.from('websites').insert({ name: site.name, description: site.description || '', team_id: selectedTeamId }).select().single(),
        SITE_PERMISSION_MSG,
      );
      if (error || !data) return null;
      const newSite = { id: data.id, name: data.name, description: data.description || '' };
      setWebsites(prev => {
        if (prev.find(x => x.id === newSite.id)) return prev;
        return [...prev, newSite];
      });
      return newSite;
    }
    const newSite = { ...site, id: uuidv4() };
    setWebsites(prev => [...prev, newSite]);
    return newSite;
  }, [isCloud, dbRun, selectedTeamId]);

  const updateWebsite = useCallback(async (id, data) => {
    if (isCloud) {
      const { data: rows, error } = await dbRun(
        'Could not save website',
        () => supabase.from('websites').update({ name: data.name, description: data.description || '' }).eq('id', id).select('id'),
        SITE_PERMISSION_MSG,
      );
      if (error) return;
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not save website', SITE_PERMISSION_MSG);
        return;
      }
      setWebsites(prev => prev.map(w => w.id === id ? { ...w, ...data } : w));
      return;
    }
    setWebsites(prev => prev.map(w => w.id === id ? { ...w, ...data } : w));
  }, [isCloud, dbRun, reportBlocked]);

  const deleteWebsite = useCallback(async (id) => {
    if (isCloud) {
      const { data: rows, error } = await dbRun(
        'Could not remove website',
        () => supabase.from('websites').delete().eq('id', id).select('id'),
        SITE_PERMISSION_MSG,
      );
      if (error) return;
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not remove website', SITE_PERMISSION_MSG);
        return;
      }
      setWebsites(prev => prev.filter(w => w.id !== id));
      return;
    }
    setWebsites(prev => prev.filter(w => w.id !== id));
  }, [isCloud, dbRun, reportBlocked]);

  // === TASK OPERATIONS ===
  const addTask = useCallback(async (task) => {
    if (isCloud) {
      const { data, error } = await taskWrite(
        (row) => supabase.from('tasks').insert(row).select().single(),
        mapTaskToDB(task),
        warnMissingColumn,
      );
      if (error) {
        // An insert blocked by a policy raises 42501, so unlike an update it is
        // visible here — it just needs translating out of Postgres-speak.
        const { kind, message } = classifyDbError(error);
        console.error('Add task error:', error);
        notificationCtx?.notify?.('error', 'Could not add task',
          kind === 'permission' ? 'You can only create tasks assigned to yourself.' : message);
        if (kind === 'auth') handleAuthError();
        return null;
      }
      const mapped = mapTaskFromDB(data);
      setTasks(prev => {
        if (prev.find(x => x.id === mapped.id)) return prev;
        return [...prev, mapped];
      });
      logActivity('Task Created', mapped.title, 'New task scheduled', mapped.id);
      return mapped;
    }
    const newTask = {
      ...task,
      id: uuidv4(),
      status: task.status || 'pending',
      completionUrl: task.completionUrl || '',
      completedDate: task.completedDate || (task.status === 'completed' ? new Date().toISOString() : null),
      createdAt: new Date().toISOString(),
      isAdditional: task.isAdditional || false,
      carryForwardFrom: task.carryForwardFrom || null,
      carryForwardTo: task.carryForwardTo || null,
    };
    setTasks(prev => [...prev, newTask]);
    logActivity('Task Created', newTask.title, 'New task scheduled', newTask.id);
    return newTask;
  }, [isCloud, logActivity, warnMissingColumn, notificationCtx, handleAuthError]);

  const addBulkTasks = useCallback(async (taskList) => {
    if (isCloud) {
      const { data, error } = await taskWrite(
        (rows) => supabase.from('tasks').insert(rows).select(),
        taskList.map(mapTaskToDB),
        warnMissingColumn,
      );
      if (error) {
        console.error('Bulk add error:', error);
        notificationCtx?.notify?.('error', 'Could not add tasks', error.message || 'The tasks were not saved.');
        return [];
      }
      const mapped = data.map(mapTaskFromDB);
      setTasks(prev => {
        const newItems = mapped.filter(m => !prev.find(p => p.id === m.id));
        return [...prev, ...newItems];
      });
      return mapped;
    }
    const newTasks = taskList.map(t => ({ ...t, id: uuidv4(), status: 'pending', completionUrl: '', completedDate: null, createdAt: new Date().toISOString() }));
    setTasks(prev => [...prev, ...newTasks]);
    return newTasks;
  }, [isCloud, warnMissingColumn, notificationCtx]);

  // Returns true only once the change is confirmed saved (or there is no server to
  // reject it). Callers use this to decide whether to show their own success
  // toast and close their modal — without it, a page-level handler would report
  // success and dismiss the form even when this function had just rolled the
  // edit back, which is exactly the "denied write looks like success" failure
  // mode this file exists to prevent.
  const updateTask = useCallback(async (id, data) => {
    const previous = tasks.find(t => t.id === id);
    if (!previous) return false;
    const updated = { ...previous, ...data };

    // Apply straight away so the UI stays responsive, then undo it if the server
    // refuses. The previous version fired the write from inside the setTasks
    // updater and never reconciled the result, so a rejected edit stayed on screen
    // *and* got mirrored into localStorage — surviving a refresh as phantom data.
    setTasks(prev => prev.map(t => (t.id === id ? updated : t)));
    logActivity('Task Edited', data.title || 'Task', 'Task details updated', id);

    if (!isCloud) return true;

    const rollback = () => setTasks(prev => prev.map(t => (t.id === id ? previous : t)));
    const { data: rows, error } = await taskWrite(
      (row) => supabase.from('tasks').update(row).eq('id', id).select('id'),
      mapTaskToDB(updated),
      warnMissingColumn,
    );

    if (error) {
      const { kind, message } = classifyDbError(error);
      console.error('Update error:', error);
      rollback();
      notificationCtx?.notify?.('error', 'Could not save changes',
        kind === 'permission' ? 'You can only edit tasks assigned to you.' : message);
      if (kind === 'auth') handleAuthError();
      return false;
    }

    // No error but no row returned: a policy filtered the update out silently.
    // This is what a denied UPDATE looks like — it must not be treated as success.
    if (Array.isArray(rows) && rows.length === 0) {
      rollback();
      reportBlocked('Could not save changes', 'You can only edit tasks assigned to you.');
      return false;
    }
    return true;
  }, [isCloud, tasks, logActivity, warnMissingColumn, notificationCtx, reportBlocked, handleAuthError]);

  const completeTask = useCallback(async (id, completionUrl = '', timeTaken = 0) => {
    const task = tasks.find(t => t.id === id);
    if (isCloud) {
      const { data: rows, error } = await taskWrite(
        (row) => supabase.from('tasks').update(row).eq('id', id).select('id'),
        {
          status: 'completed',
          progress: 100,
          completion_url: completionUrl,
          completed_date: new Date().toISOString(),
          time_taken: timeTaken,
        },
        warnMissingColumn,
      );

      // Only apply locally once the server has confirmed it. Previously the state
      // update ran even after an error was logged, so a rejected completion showed
      // as done.
      if (error) {
        const { kind, message } = classifyDbError(error);
        console.error('Complete task error:', error);
        notificationCtx?.notify?.('error', 'Could not mark completed',
          kind === 'permission' ? 'You can only complete tasks assigned to you.' : message);
        if (kind === 'auth') handleAuthError();
        return false;
      }
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not mark completed', 'You can only complete tasks assigned to you.');
        return false;
      }

      setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'completed', completionUrl, timeTaken, completedDate: new Date().toISOString() } : t));
      logActivity('Task Completed', task?.title || '', 'Marked as completed', id);
      return true;
    }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'completed', completionUrl, timeTaken, completedDate: new Date().toISOString() } : t));
    logActivity('Task Completed', task?.title || '', 'Marked as completed', id);
    return true;
  }, [isCloud, tasks, logActivity, warnMissingColumn, notificationCtx, reportBlocked, handleAuthError]);

  const deleteTask = useCallback(async (id) => {
    const task = tasks.find(t => t.id === id);
    if (isCloud) {
      // .select('id') is what makes a blocked delete detectable. Without it a row
      // the policy hides simply matches nothing, PostgREST reports success, and the
      // task disappears locally only to return on the next fetch.
      const { data: rows, error } = await dbRun(
        'Could not delete task',
        () => supabase.from('tasks').delete().eq('id', id).select('id'),
        "You don't have permission to delete this task.",
      );
      if (error) return false;
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not delete task', "You don't have permission to delete this task.");
        return false;
      }
      setTasks(prev => prev.filter(t => t.id !== id));
      logActivity('Task Deleted', task?.title || '', 'Task removed from schedule', id);
      return true;
    }
    setTasks(prev => prev.filter(t => t.id !== id));
    logActivity('Task Deleted', task?.title || '', 'Task removed from schedule', id);
    return true;
  }, [isCloud, tasks, logActivity, dbRun, reportBlocked]);

  // === LEAD OPERATIONS ===
  // Shared team resource — every linked employee can read, add and delete
  // (see supabase_leads_table.sql), so there is no ownership check here the
  // way task writes have. The one rule that does apply everywhere is
  // duplicate prevention: an exact match on every field is silently skipped
  // rather than inserted again, enforced for real by a UNIQUE index in the
  // database (leads_exact_duplicate_idx) and mirrored here for local-only
  // mode, which has no database to fall back on.
  // A single generated column rather than a list of real ones: `dedup_key` is
  // computed by the database from email + message + the UTC calendar day, so
  // the match survives timestamp drift between exports. See
  // supabase_leads_dedup.sql and src/lib/leadDedup.js.
  const LEAD_CONFLICT_COLUMNS = 'dedup_key';

  // Shared so addLead and addLeadsBulk cannot drift on which columns they
  // send — a mismatch there is how an imported field silently stops being
  // saved.
  const toLeadRow = (r) => ({
    name: r.name || '', company: r.company || '', email: r.email || '',
    phone: r.phone || '', message: r.message || '', confirm: r.confirm || '',
    sourceUrl: r.sourceUrl || '', createdAt: r.createdAt || new Date().toISOString(),
    converted: r.converted === 'yes' || r.converted === 'no' ? r.converted : '',
    convertedReason: r.converted === 'no' ? (r.convertedReason || '') : '',
  });
  const toLeadDbRow = (r) => ({
    name: r.name, company: r.company, email: r.email, phone: r.phone,
    message: r.message, confirm: r.confirm, source_url: r.sourceUrl,
    created_at: r.createdAt, converted: r.converted, converted_reason: r.convertedReason,
  });

  const addLead = useCallback(async (lead) => {
    const row = toLeadRow(lead);
    if (isCloud) {
      const { data, error } = await dbRun(
        'Could not add lead',
        () => supabase.from('leads')
          .upsert(
            [toLeadDbRow(row)],
            { onConflict: LEAD_CONFLICT_COLUMNS, ignoreDuplicates: true },
          )
          .select(),
        LEAD_PERMISSION_MSG,
      );
      if (error) return { ok: false, duplicate: false };
      // ON CONFLICT DO NOTHING never returns the skipped row, so an empty
      // result here — with no error — is exactly what a duplicate looks like.
      if (!data || data.length === 0) return { ok: false, duplicate: true };
      const newLead = mapLeadFromDB(data[0]);
      setLeads(prev => [newLead, ...prev]);
      return { ok: true, lead: newLead };
    }
    if (isDuplicateLead(row, leads)) return { ok: false, duplicate: true };
    const newLead = { ...row, id: uuidv4() };
    setLeads(prev => [newLead, ...prev]);
    return { ok: true, lead: newLead };
  }, [isCloud, dbRun, leads]);

  const addLeadsBulk = useCallback(async (rows) => {
    const payload = rows.map(toLeadRow);
    if (isCloud) {
      const { data, error } = await dbRun(
        'Could not import leads',
        () => supabase.from('leads')
          .upsert(
            payload.map(toLeadDbRow),
            { onConflict: LEAD_CONFLICT_COLUMNS, ignoreDuplicates: true },
          )
          .select(),
        LEAD_PERMISSION_MSG,
      );
      if (error) return { inserted: 0, skipped: 0, failed: true };
      const inserted = (data || []).map(mapLeadFromDB);
      setLeads(prev => [...inserted, ...prev]);
      return { inserted: inserted.length, skipped: payload.length - inserted.length, failed: false };
    }
    const toInsert = [];
    const seenSoFar = [...leads];
    for (const row of payload) {
      if (isDuplicateLead(row, seenSoFar)) continue;
      const newLead = { ...row, id: uuidv4() };
      toInsert.push(newLead);
      seenSoFar.push(newLead);
    }
    setLeads(prev => [...toInsert, ...prev]);
    return { inserted: toInsert.length, skipped: payload.length - toInsert.length, failed: false };
  }, [isCloud, dbRun, leads]);

  const deleteLead = useCallback(async (id) => {
    if (isCloud) {
      const { data: rows, error } = await dbRun(
        'Could not delete lead',
        () => supabase.from('leads').delete().eq('id', id).select('id'),
        LEAD_PERMISSION_MSG,
      );
      if (error) return false;
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not delete lead', LEAD_PERMISSION_MSG);
        return false;
      }
      setLeads(prev => prev.filter(l => l.id !== id));
      return true;
    }
    setLeads(prev => prev.filter(l => l.id !== id));
    return true;
  }, [isCloud, dbRun, reportBlocked]);

  // Bulk delete, sent in chunks rather than one big request. PostgREST puts
  // an .in() filter in the QUERY STRING, so a single call with every id is a
  // URL roughly 40 bytes per id long — fine for the ~135 rows here today, but
  // this table grows with every weekly import and would silently start
  // failing on oversized-URL errors somewhere past a few hundred selected
  // rows. Chunking keeps each request small no matter how large the table
  // gets.
  //
  // Local state is updated from the ids the server actually confirmed
  // deleting, not from the ids requested, so a chunk failing partway leaves
  // the table showing exactly what still exists rather than optimistically
  // hiding rows that survived.
  const deleteLeadsBulk = useCallback(async (ids) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { deleted: 0, failed: false };

    if (isCloud) {
      const CHUNK = 50;
      const deletedIds = [];
      let failed = false;
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        const { data: rows, error } = await dbRun(
          'Could not delete enquiries',
          () => supabase.from('leads').delete().in('id', chunk).select('id'),
          LEAD_PERMISSION_MSG,
        );
        if (error) { failed = true; break; }
        if (Array.isArray(rows)) deletedIds.push(...rows.map(r => r.id));
      }
      if (deletedIds.length > 0) {
        const gone = new Set(deletedIds);
        setLeads(prev => prev.filter(l => !gone.has(l.id)));
      }
      // Nothing deleted and no transport error means every row was invisible
      // to the delete policy — the silent-RLS-denial case.
      if (!failed && deletedIds.length === 0) {
        reportBlocked('Could not delete enquiries', LEAD_PERMISSION_MSG);
        return { deleted: 0, failed: true };
      }
      return { deleted: deletedIds.length, failed };
    }

    const gone = new Set(unique);
    setLeads(prev => prev.filter(l => !gone.has(l.id)));
    return { deleted: unique.length, failed: false };
  }, [isCloud, dbRun, reportBlocked]);

  // Only ever touches converted/convertedReason today — every other lead
  // field is set once at add/import time and never edited afterward.
  const updateLead = useCallback(async (id, data) => {
    const patch = { converted: data.converted ?? '', convertedReason: data.convertedReason ?? '' };
    if (isCloud) {
      const { data: rows, error } = await dbRun(
        'Could not update lead',
        () => supabase.from('leads').update({ converted: patch.converted, converted_reason: patch.convertedReason }).eq('id', id).select('id'),
        LEAD_PERMISSION_MSG,
      );
      if (error) return false;
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not update lead', LEAD_PERMISSION_MSG);
        return false;
      }
      setLeads(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
      return true;
    }
    setLeads(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
    return true;
  }, [isCloud, dbRun, reportBlocked]);

  const getEmployeeName = useCallback((id) => {
    const emp = employees.find(e => e.id === id);
    return emp ? emp.name : 'Unassigned';
  }, [employees]);

  const getWebsiteName = useCallback((id) => {
    const site = websites.find(w => w.id === id);
    return site ? site.name : 'Unknown';
  }, [websites]);

  // === CATEGORIES ===
  // Every category is a real row in the `categories` table now (per-team,
  // synced via Supabase) — categoryRows IS the source of truth, not a
  // DEFAULT_CATEGORIES merge; DEFAULT_CATEGORIES only still matters for
  // local-only mode's seed (defaultCategoryRows above) and isDefaultCategory
  // below. Any category already present on a task is still folded in too, so
  // one surviving from before this table existed (or arriving from another
  // device mid-sync) doesn't vanish from the list it's actually used in.
  // Hidden rows (soft-deleted) are filtered out of both.
  const categories = useMemo(() => {
    const hiddenNames = new Set(categoryRows.filter(r => r.hidden).map(r => r.name.toLowerCase()));
    const seen = new Set();
    const merged = [];
    const push = (c) => {
      const name = (c || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key) || hiddenNames.has(key)) return;
      seen.add(key);
      merged.push(name);
    };
    categoryRows.forEach(r => push(r.name));
    tasks.forEach(t => push(t.category));
    return merged;
  }, [categoryRows, tasks]);

  // name(lowercased) -> hex. Each row already carries its own colour; a task's
  // category with no matching row yet (pre-migration leftover, or the
  // categories table failing to load) falls back to the next free palette
  // slot by stable position, same as before this table existed.
  const categoryColorMap = useMemo(() => {
    const map = {};
    categoryRows.forEach(r => {
      const h = normalizeHex(r.color);
      if (h) map[r.name.toLowerCase()] = h;
    });
    let next = categoryRows.length;
    categories.forEach(c => {
      const key = c.toLowerCase();
      if (!map[key]) map[key] = defaultCategoryColor(next++);
    });
    return map;
  }, [categoryRows, categories]);

  const getCategoryColor = useCallback(
    (name) => categoryColorMap[(name || '').toLowerCase()] || CATEGORY_PALETTE[0],
    [categoryColorMap]
  );

  // A colour already used by another visible category can't be reused
  const findColorOwner = useCallback((hex, exceptCategory) => {
    const h = normalizeHex(hex);
    if (!h) return null;
    const except = (exceptCategory || '').toLowerCase();
    return categories.find(c => c.toLowerCase() !== except && categoryColorMap[c.toLowerCase()] === h) || null;
  }, [categories, categoryColorMap]);

  // First palette colour nobody is using — the default for a new category
  const suggestCategoryColor = useCallback(() => {
    const used = new Set(categories.map(c => categoryColorMap[c.toLowerCase()]));
    return CATEGORY_PALETTE.find(c => !used.has(c)) || '';
  }, [categories, categoryColorMap]);

  const addCategory = useCallback(async (name, color) => {
    const clean = (name || '').trim();
    if (!clean) return { ok: false, error: 'Category name cannot be empty.' };
    const exists = categories.some(c => c.toLowerCase() === clean.toLowerCase());
    if (exists) return { ok: false, error: `"${clean}" already exists.` };

    let hex = normalizeHex(color);
    if (color && !hex) return { ok: false, error: 'That colour is not a valid hex value.' };
    if (hex) {
      const owner = findColorOwner(hex, clean);
      if (owner) return { ok: false, error: `That colour is already used by "${owner}". Pick a different one.` };
    } else {
      // The table's color column is NOT NULL — unlike the old localStorage
      // shape, every row needs a real value, not an absent entry that
      // categoryColorMap used to backfill at render time.
      hex = suggestCategoryColor() || CATEGORY_PALETTE[0];
    }

    if (isCloud) {
      const { data, error } = await dbRun(
        'Could not add category',
        () => supabase.from('categories').insert({ team_id: selectedTeamId, name: clean, color: hex }).select().single(),
        CATEGORY_PERMISSION_MSG,
      );
      if (error || !data) return { ok: false, error: 'Could not save this category.' };
      const row = mapCategoryFromDB(data);
      setCategoryRows(prev => (prev.find(x => x.id === row.id) ? prev : [...prev, row]));
      return { ok: true, name: clean };
    }

    setCategoryRows(prev => [...prev, { id: uuidv4(), name: clean, color: hex, hidden: false }]);
    return { ok: true, name: clean };
  }, [categories, findColorOwner, suggestCategoryColor, isCloud, dbRun, selectedTeamId]);

  const setCategoryColor = useCallback(async (name, color) => {
    const hex = normalizeHex(color);
    if (!hex) return { ok: false, error: 'That colour is not a valid hex value.' };
    const owner = findColorOwner(hex, name);
    if (owner) return { ok: false, error: `That colour is already used by "${owner}". Pick a different one.` };

    const row = categoryRows.find(r => r.name.toLowerCase() === (name || '').toLowerCase());
    if (isCloud) {
      if (!row) return { ok: false, error: `"${name}" was not found.` };
      const { data: rows, error } = await dbRun(
        'Could not save category colour',
        () => supabase.from('categories').update({ color: hex }).eq('id', row.id).select('id'),
        CATEGORY_PERMISSION_MSG,
      );
      if (error) return { ok: false, error: 'Could not save this colour.' };
      if (Array.isArray(rows) && rows.length === 0) {
        reportBlocked('Could not save category colour', CATEGORY_PERMISSION_MSG);
        return { ok: false, error: CATEGORY_PERMISSION_MSG };
      }
      setCategoryRows(prev => prev.map(r => (r.id === row.id ? { ...r, color: hex } : r)));
      return { ok: true };
    }

    if (row) {
      setCategoryRows(prev => prev.map(r => (r.id === row.id ? { ...r, color: hex } : r)));
    } else {
      setCategoryRows(prev => [...prev, { id: uuidv4(), name, color: hex, hidden: false }]);
    }
    return { ok: true };
  }, [findColorOwner, categoryRows, isCloud, dbRun, reportBlocked]);

  // Moves every task off one category onto another, in the DB and in memory
  const reassignCategory = useCallback(async (fromCategory, toCategory) => {
    const affected = tasks.filter(t => (t.category || 'General') === fromCategory);
    if (!affected.length) return { ok: true, moved: 0 };

    if (isCloud) {
      // Update by id (not by category) so tasks with a null category are caught
      // too, and chunk to keep the request URL a sane length.
      const ids = affected.map(t => t.id);
      for (let i = 0; i < ids.length; i += 50) {
        const { error } = await supabase
          .from('tasks')
          .update({ category: toCategory })
          .in('id', ids.slice(i, i + 50));
        if (error) {
          console.error('Reassign category error:', error);
          return { ok: false, error: error.message };
        }
      }
    }

    const moving = new Set(affected.map(t => t.id));
    setTasks(prev => prev.map(t => (moving.has(t.id) ? { ...t, category: toCategory } : t)));
    return { ok: true, moved: affected.length };
  }, [isCloud, tasks]);

  const countTasksInCategory = useCallback(
    (name) => tasks.filter(t => (t.category || 'General') === name).length,
    [tasks]
  );

  // Deleting a category that still has tasks requires a replacement to move
  // them to, so no task is ever left pointing at a category that's gone.
  // Soft-deleted (hidden: true), not row-deleted — the `categories` useMemo
  // already filters hidden rows out of the visible list, and keeping the row
  // means its colour isn't lost if the same name gets re-added later.
  const deleteCategory = useCallback(async (name, replacement) => {
    const inUse = countTasksInCategory(name);
    if (inUse > 0) {
      if (!replacement || replacement === name) {
        return { ok: false, error: 'Choose a category to move these tasks to.' };
      }
      const result = await reassignCategory(name, replacement);
      if (!result.ok) return result;
    }

    const row = categoryRows.find(r => r.name.toLowerCase() === (name || '').toLowerCase());
    if (row) {
      if (isCloud) {
        const { data: rows, error } = await dbRun(
          'Could not delete category',
          () => supabase.from('categories').update({ hidden: true }).eq('id', row.id).select('id'),
          CATEGORY_PERMISSION_MSG,
        );
        if (error) return { ok: false, error: 'Could not delete this category.' };
        if (Array.isArray(rows) && rows.length === 0) {
          reportBlocked('Could not delete category', CATEGORY_PERMISSION_MSG);
          return { ok: false, error: CATEGORY_PERMISSION_MSG };
        }
      }
      setCategoryRows(prev => prev.map(r => (r.id === row.id ? { ...r, hidden: true } : r)));
    }
    logActivity('Category Deleted', name, inUse > 0 ? `${inUse} task(s) moved to "${replacement}"` : 'No tasks affected');
    return { ok: true, moved: inUse };
  }, [countTasksInCategory, reassignCategory, logActivity, categoryRows, isCloud, dbRun, reportBlocked]);

  const isDefaultCategory = useCallback(
    (name) => DEFAULT_CATEGORIES.some(c => c.toLowerCase() === (name || '').toLowerCase()),
    []
  );

  const exportData = useCallback(() => {
    const data = { employees, websites, tasks, categories: categoryRows, exportDate: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `team-dashboard-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [employees, websites, tasks, categoryRows]);

  const importData = useCallback((jsonData) => {
    try {
      const data = JSON.parse(jsonData);
      if (data.employees) setEmployees(data.employees);
      if (data.websites) setWebsites(data.websites);
      if (data.tasks) setTasks(data.tasks);
      if (data.categories) setCategoryRows(data.categories);
      return true;
    } catch (e) { console.error('Import failed:', e); return false; }
  }, []);

  // Read-only usage stats for the Settings page's storage meter. Not kept in
  // state — it doesn't need to be reactive, so the page fetches it on mount
  // and offers its own manual refresh, rather than every session paying for
  // it on load the way employees/tasks/leads are.
  const fetchStorageUsage = useCallback(async () => {
    if (!isCloud) return null;
    const { data, error } = await dbRun('Could not load storage usage', () => supabase.rpc('get_storage_usage'));
    if (error || !data) return null;
    return data; // { total_bytes, tables: [{ name, bytes }] }
  }, [isCloud, dbRun]);

  // O(1) task lookup by id, for following a carryForwardTo/carryForwardFrom
  // chain to see where the real current status of a carried-forward task
  // actually lives now — see getEffectiveStatus in lib/taskProgress.js.
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // The team currently in view — fixed to the signed-in person's own team for
  // everyone but a super admin, who can switch via selectedTeamId. Drives the
  // per-team "Website"/"Company"-style relabeling everywhere below, and
  // Layout.jsx's Lead Center visibility rule (currentTeam?.is_lead_source_team).
  const currentTeam = useMemo(
    () => teams.find(t => t.id === (isSuperAdmin ? selectedTeamId : myTeamId)) || null,
    [teams, isSuperAdmin, selectedTeamId, myTeamId]
  );
  // Fixed, not per-team customizable (confirmed with the user after testing
  // a real second team — a freely-typed label was confusing in practice, not
  // useful). Digital Marketing keeps "Website"/"Websites"; every other team
  // sees the identical feature as "Company"/"Companies", the same for all of
  // them. teams.entity_label_singular/plural still exist as columns but are
  // no longer read here or asked for when creating a team.
  const unitLabel = currentTeam?.is_lead_source_team ? 'Website' : 'Company';
  const unitLabelPlural = currentTeam?.is_lead_source_team ? 'Websites' : 'Companies';

  const value = {
    employees, websites, tasks, tasksById, isCloud, loading,
    fetchStorageUsage,
    // Connection health, separate from isCloud. Consumers should show a problem
    // banner on 'unauthorized'/'error' rather than an innocent empty state.
    cloudStatus, cloudError, refresh,
    comments, activityLog,
    teams, currentTeam, unitLabel, unitLabelPlural,
    categories, addCategory, deleteCategory, isDefaultCategory,
    getCategoryColor, setCategoryColor, findColorOwner, suggestCategoryColor,
    countTasksInCategory, reassignCategory,
    addEmployee, updateEmployee, deleteEmployee,
    addWebsite, updateWebsite, deleteWebsite,
    addTask, addBulkTasks, updateTask, completeTask, deleteTask,
    leads, addLead, addLeadsBulk, updateLead, deleteLead, deleteLeadsBulk,
    getEmployeeName, getWebsiteName,
    addComment, getTaskComments, logActivity, getRecentActivity,
    exportData, importData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export const useApp = () => useContext(AppContext);
