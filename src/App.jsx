import React, { useState, useEffect } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { NotificationProvider } from './context/NotificationContext';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import { isTabAccessible } from './lib/tabAccess';
import { isLeadCenterVisible } from './lib/leadCenterAccess';
import Toast from './components/Toast';
import FullScreenLoader from './components/FullScreenLoader';
import AccessDenied from './components/AccessDenied';
import Dashboard from './pages/Dashboard';
import Schedule from './pages/Schedule';
import TasksCompleted from './pages/TasksCompleted';
import MonthlyReport from './pages/MonthlyReport';
import Settings from './pages/Settings';
import MyDay from './pages/MyDay';
import LeadCenter from './pages/LeadCenter';
import TeamManagement from './pages/TeamManagement';
import { CalendarDays } from 'lucide-react';

const NAV_KEYS = ['dashboard', 'schedule', 'completed', 'report', 'myday', 'leads', 'settings', 'teams'];

// Chrome (and other browsers) will silently discard a backgrounded tab under
// memory pressure — switching away and back then loads the page fresh rather
// than resuming it, same as a manual refresh. Nothing in this app can prevent
// that discard, but sessionStorage survives it (it only clears when the tab
// is actually closed), so restoring activeTab from there means a discard just
// looks like nothing happened, instead of dumping the user back on Dashboard.
function readStoredTab() {
  try {
    const stored = sessionStorage.getItem('td_active_tab');
    return NAV_KEYS.includes(stored) ? stored : 'dashboard';
  } catch {
    return 'dashboard';
  }
}

function AppContent() {
  const [activeTab, setActiveTab] = useState(readStoredTab);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedWebsite, setSelectedWebsite] = useState('all');
  // Only meaningful for teams other than Digital Marketing (see
  // supabase_projects_table.sql) — a project always belongs to one company,
  // so picking a company narrows which projects this offers (handled below).
  const [selectedProject, setSelectedProject] = useState('all');
  // Set when a Dashboard donut slice is clicked, so Schedule opens pre-filtered
  // to that category over the same period. The nonce lets the same category be
  // clicked twice in a row and still re-apply.
  const [scheduleIntent, setScheduleIntent] = useState(null);
  // Same idea, for Dashboard's KPI cards (Total/Completed/Pending/Carried
  // Forward) opening Tasks Completed pre-filtered to that status.
  const [completedIntent, setCompletedIntent] = useState(null);
  const { websites, projects, loading, unitLabelPlural, teams, currentTeam } = useApp();
  const { canViewAll, myEmployeeId, isSuperAdmin, canManageTeam, selectedTeamId, setSelectedTeamId } = useAuth();
  // One shared context object for every isTabAccessible() call below, so the
  // redirect effect, the renderPage() switch, and Layout.jsx's nav filter can
  // never drift onto checking slightly different things.
  const tabAccessCtx = { canViewAll, isSuperAdmin, isLeadSourceTeam: isLeadCenterVisible(currentTeam, canManageTeam) };

  // Schedule's and Tasks Completed's own employee/category/status filter
  // selections, lifted up here rather than kept as local state in each page.
  // renderPage() below fully unmounts a page on every tab switch, which would
  // otherwise silently reset whatever filter someone picked the moment they
  // looked at another tab and came back — this is what keeps it sticky until
  // manually cleared.
  const [scheduleFilterEmployee, setScheduleFilterEmployee] = useState(canViewAll ? 'all' : (myEmployeeId || 'all'));
  const [scheduleFilterCategory, setScheduleFilterCategory] = useState('all');
  const [completedFilterEmployee, setCompletedFilterEmployee] = useState(canViewAll ? 'all' : (myEmployeeId || 'all'));
  const [completedFilterStatus, setCompletedFilterStatus] = useState('all');
  const [completedFilterCategory, setCompletedFilterCategory] = useState('all');

  // The nav item is already hidden for non-admins (Layout.jsx), so the only way
  // to land here is a role change on an already-open tab — an admin demoting
  // their own account, or a stale tab from before a re-link. Bounce back to the
  // dashboard rather than leaving them stuck on a page every action in it would
  // reject anyway.
  useEffect(() => {
    if (!isTabAccessible(activeTab, { canViewAll, isSuperAdmin, isLeadSourceTeam: isLeadCenterVisible(currentTeam, canManageTeam) })) {
      setActiveTab('dashboard');
    }
  }, [canViewAll, isSuperAdmin, canManageTeam, currentTeam, activeTab]);

  useEffect(() => {
    try { sessionStorage.setItem('td_active_tab', activeTab); } catch { /* storage unavailable */ }
  }, [activeTab]);

  // A project belongs to exactly one company — narrowing the company filter
  // to one that doesn't contain the currently-selected project would
  // otherwise leave an impossible combination selected (a project filter
  // that can never match anything in the filtered company). Adjusted during
  // render rather than in an effect, same reasoning as Schedule.jsx's own
  // intent-handling below: it re-renders before painting, so the dropdown is
  // already correct on the first frame rather than flashing the stale value.
  if (selectedProject !== 'all' && selectedWebsite !== 'all') {
    const project = projects.find(p => p.id === selectedProject);
    if (!project || project.websiteId !== selectedWebsite) setSelectedProject('all');
  }

  const handleCategoryDrill = ({ category, employee, period, month, year, website }) => {
    if (website !== undefined) setSelectedWebsite(website);
    if (month) setSelectedMonth(month);
    if (year) setSelectedYear(year);
    setScheduleIntent({ category, employee, period, nonce: Date.now() });
    setActiveTab('schedule');
  };

  const handleStatusDrill = ({ status, period, month, year, website }) => {
    if (website !== undefined) setSelectedWebsite(website);
    if (month) setSelectedMonth(month);
    if (year) setSelectedYear(year);
    setCompletedIntent({ status, period, nonce: Date.now() });
    setActiveTab('completed');
  };

  // Schedule/TasksCompleted call these the moment they've applied an intent,
  // so it goes back to null here. Without this, the intent object would still
  // be sitting in this state the NEXT time the tab is visited — and since
  // Schedule/TasksCompleted unmount on every tab switch (see renderPage's
  // switch below), their own "already applied this nonce" tracking resets
  // too, so a stale intent would silently reapply and stomp over whatever
  // filters the user had manually set in between.
  const clearScheduleIntent = () => setScheduleIntent(null);
  const clearCompletedIntent = () => setCompletedIntent(null);

  const showTopbarFilters = ['schedule', 'completed', 'report'].includes(activeTab);

  const TopbarControls = (
    <div className="topbar-right">
      {isSuperAdmin && (
        // A session-identity selector, not a page filter — shown on every
        // tab (unlike selectedWebsite/selectedMonth below, which only matter
        // on the three data-table tabs), since switching teams changes whose
        // data the WHOLE dashboard is scoped to, not just one page's view.
        <div className="filter-group">
          <select value={selectedTeamId || ''} onChange={e => setSelectedTeamId(e.target.value)}>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      {showTopbarFilters && (
        <>
          <div className="filter-group">
            <select value={selectedWebsite} onChange={e => setSelectedWebsite(e.target.value)}>
              <option value="all">{`All ${unitLabelPlural}`}</option>
              {websites.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          {/* Digital Marketing never has Projects at all (see
              supabase_projects_table.sql) — this filter only exists for
              every other team. */}
          {!currentTeam?.is_lead_source_team && (
            <div className="filter-group">
              <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)}>
                <option value="all">All Projects</option>
                {projects
                  .filter(p => selectedWebsite === 'all' || p.websiteId === selectedWebsite)
                  .map(p => {
                    const siteName = websites.find(w => w.id === p.websiteId)?.name;
                    return (
                      <option key={p.id} value={p.id}>
                        {selectedWebsite === 'all' && siteName ? `${siteName} — ${p.name}` : p.name}
                      </option>
                    );
                  })}
              </select>
            </div>
          )}
          <div className="filter-group">
            <CalendarDays size={15} style={{ color: 'var(--text-light)' }} />
            <select value={selectedMonth} onChange={e => setSelectedMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(0, i).toLocaleString('default', { month: 'long' })}
                </option>
              ))}
            </select>
            <select value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))}>
              {[2024, 2025, 2026, 2027, 2028].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );

  if (loading) {
    return <FullScreenLoader />;
  }

  const renderPage = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard onCategoryDrill={handleCategoryDrill} onStatusDrill={handleStatusDrill} onNavigateToLeads={() => setActiveTab('leads')} />;
      case 'schedule':
        return <Schedule selectedMonth={selectedMonth} selectedYear={selectedYear} selectedWebsite={selectedWebsite} selectedProject={selectedProject} intent={scheduleIntent} onIntentConsumed={clearScheduleIntent}
          filterEmployee={scheduleFilterEmployee} setFilterEmployee={setScheduleFilterEmployee}
          filterCategory={scheduleFilterCategory} setFilterCategory={setScheduleFilterCategory}
        />;
      case 'completed':
        return <TasksCompleted selectedMonth={selectedMonth} selectedYear={selectedYear} selectedWebsite={selectedWebsite} selectedProject={selectedProject} intent={completedIntent} onIntentConsumed={clearCompletedIntent}
          filterEmployee={completedFilterEmployee} setFilterEmployee={setCompletedFilterEmployee}
          filterStatus={completedFilterStatus} setFilterStatus={setCompletedFilterStatus}
          filterCategory={completedFilterCategory} setFilterCategory={setCompletedFilterCategory}
        />;
      case 'report':
        return <MonthlyReport selectedMonth={selectedMonth} selectedYear={selectedYear} selectedWebsite={selectedWebsite} />;
      case 'myday':
        return <MyDay />;
      case 'leads':
        return isTabAccessible('leads', tabAccessCtx) ? <LeadCenter /> : <AccessDenied />;
      case 'settings':
        return isTabAccessible('settings', tabAccessCtx) ? <Settings /> : <AccessDenied />;
      case 'teams':
        return isTabAccessible('teams', tabAccessCtx) ? <TeamManagement onOpenTeam={() => setActiveTab('settings')} /> : <AccessDenied />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <Layout activeTab={activeTab} setActiveTab={setActiveTab}>
      {TopbarControls}
      {renderPage()}
    </Layout>
  );
}

// Reads the signed-in user's id (or 'local' with no backend configured) and uses
// it as AppProvider's key. Changing the key unmounts and remounts AppProvider
// entirely — fresh useState initializers, a fresh fetch, a fresh realtime
// channel — which is what makes a different user signing in on the same browser
// get their own data rather than inheriting whatever the previous session
// loaded. Ordinary token refreshes don't change user.id, so they don't trigger
// this; only an actual account change does.
//
// A super admin switching teams gets the exact same treatment, deliberately:
// appending selectedTeamId to the key means picking a different team from the
// switcher is just as much a full remount as signing in as someone else is —
// fresh fetch scoped to the new team, fresh realtime channel, activeTab reset
// — rather than trying to patch a live AppContext over to a different team's
// data in place.
function AuthedApp() {
  const { authKey, isSuperAdmin, selectedTeamId } = useAuth();
  const appKey = isSuperAdmin ? `${authKey}:${selectedTeamId || 'none'}` : authKey;
  return (
    <AuthGate>
      <AppProvider key={appKey}>
        <AppContent />
      </AppProvider>
    </AuthGate>
  );
}

export default function App() {
  return (
    // ThemeProvider is outermost so that every screen is themed, including ones
    // that render outside Layout (the loading spinner, the login screen).
    // AuthProvider sits above AppProvider because AppContext reads session/user
    // state from it; context only flows one direction, so auth cannot live below
    // or beside the data layer it gates.
    // Toast is a sibling of AuthGate, not a child of AppProvider, because it only
    // needs NotificationContext — that keeps toasts working on the login screen
    // and during the restore spinner, before the data layer ever mounts.
    <ThemeProvider>
      <NotificationProvider>
        <AuthProvider>
          <AuthedApp />
          <Toast />
        </AuthProvider>
      </NotificationProvider>
    </ThemeProvider>
  );
}
