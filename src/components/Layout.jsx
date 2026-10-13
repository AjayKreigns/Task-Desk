import React, { useState, useEffect, useMemo } from 'react';
import { LayoutDashboard, CalendarDays, CheckCircle2, Settings, FileText, ListChecks, Menu, Sun, Moon, LogOut, Inbox, Building2 } from 'lucide-react';
import NotificationPanel from './NotificationPanel';
import BackgroundNetwork from './BackgroundNetwork';
import TaskCarryForwardNotifier from './TaskCarryForwardNotifier';
import TeamMoveNotifier from './TeamMoveNotifier';
import ConfirmDialog from './ConfirmDialog';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useApp } from '../context/AppContext';
import { isTabAccessible } from '../lib/tabAccess';
import { isLeadCenterVisible } from '../lib/leadCenterAccess';

const SIDEBAR_COLLAPSED_KEY = 'td_sidebar_collapsed';

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

export default function Layout({ activeTab, setActiveTab, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // A device/UI preference, not user data — kept unscoped like td_theme, so it
  // deliberately survives a sign-out and applies the same to whoever signs in
  // next on this browser.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  // Theme lives in ThemeContext, which sits above the auth gate so the login and
  // loading screens are themed too. The toggle button below is unchanged.
  const { theme, toggleTheme } = useTheme();
  const { displayName, role, canViewAll, isSuperAdmin, canManageTeam, localOnly, signOut, myEmployeeId } = useAuth();
  const { tasks, currentTeam } = useApp();

  // Always lists every tab unconditionally — isTabAccessible (shared with
  // App.jsx) is the one place that decides which of these actually show,
  // including Lead Center: it stays a single, shared, company-wide resource,
  // never duplicated per team, so it's only accessible while Digital
  // Marketing (is_lead_source_team, not its editable name) is the team in
  // view, whether that's this person's own fixed team or, for a super admin,
  // whichever team the switcher currently has selected.
  const navItems = [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, section: 'Main' },
    { key: 'schedule', label: 'Schedule', icon: CalendarDays, section: 'Main' },
    { key: 'completed', label: 'Tasks Completed', icon: CheckCircle2, section: 'Main' },
    { key: 'report', label: 'Monthly Report', icon: FileText, section: 'Main' },
    { key: 'myday', label: 'My Day', icon: ListChecks, section: 'Main' },
    { key: 'leads', label: 'Lead Center', icon: Inbox, section: 'Main' },
    { key: 'settings', label: 'Settings', icon: Settings, section: 'Manage' },
    { key: 'teams', label: 'Teams', icon: Building2, section: 'Manage' },
  ];

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [sidebarCollapsed]);

  // Same "own data only" rule as the sidebar stats below, scoped to the
  // current real-world month — same idea as My Day's own "today" scoping
  // (MyDay.jsx), not whatever month/year another tab's filter happens to be
  // showing, since the sidebar is visible regardless of which page is open.
  const { myScheduledCount, myCompletedCount } = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const mine = tasks.filter(t =>
      t.assignedTo === myEmployeeId && t.month === currentMonth && t.year === currentYear
    );
    return {
      myScheduledCount: mine.length,
      myCompletedCount: mine.filter(t => t.status === 'completed').length,
    };
  }, [tasks, myEmployeeId]);

  // Hiding this button is cosmetic, not security: the real enforcement is the
  // database's RLS policies. This exists so a member never sees a route to a
  // screen that would just reject every action on it.
  //
  // Filtered BEFORE grouping by section — filtering after grouping would leave
  // an empty "Manage" section label with nothing underneath it once Settings
  // is the only item removed from that section.
  const visibleNavItems = navItems.filter(item => isTabAccessible(item.key, { canViewAll, isSuperAdmin, isLeadSourceTeam: isLeadCenterVisible(currentTeam, canManageTeam) }));
  const grouped = {};
  visibleNavItems.forEach(item => {
    if (!grouped[item.section]) grouped[item.section] = [];
    grouped[item.section].push(item);
  });

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {/* Decorative ambient background, confined to the content area. Must live
          here inside Layout's own JSX — NOT passed in from App.jsx, which indexes
          children positionally (children[0] = topbar controls, children[1] = page). */}
      <BackgroundNetwork />
      <TaskCarryForwardNotifier />
      <TeamMoveNotifier />

      {sidebarOpen && <div className="mobile-overlay" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        {/* Its own row, in normal flow, ABOVE the brand block — not an
            absolutely-positioned overlay. An overlay's position is measured
            against the full-width layout and stops matching the content once
            the sidebar (and the logo inside it) shrinks down to the collapsed
            76px rail, which is exactly what made the button collide with the
            logo in that state. A row can't collide with what's below it. */}
        <div className="sidebar-toolbar">
          <div className="sidebar-toggle-switch" title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <input
              type="checkbox"
              id="sidebar-toggle"
              checked={!sidebarCollapsed}
              onChange={() => setSidebarCollapsed(c => !c)}
            />
            <label htmlFor="sidebar-toggle" />
          </div>
        </div>

        <div className="sidebar-brand">
          <img src="/logo.png" alt="Logo" style={{ height: '40px', marginBottom: '8px', objectFit: 'contain' }} />
          <h1>iFe Desk</h1>
          <p>{currentTeam ? `${currentTeam.name} Operations` : 'Team Operations'}</p>
        </div>

        <nav className="sidebar-nav">
          {Object.entries(grouped).map(([section, items]) => (
            <React.Fragment key={section}>
              <div className="nav-section-label">{section}</div>
              {items.map(item => (
                <a
                  key={item.key}
                  className={`nav-item ${activeTab === item.key ? 'active' : ''}`}
                  onClick={() => { setActiveTab(item.key); setSidebarOpen(false); }}
                  title={item.label}
                >
                  <item.icon size={20} />
                  <span className="nav-label">{item.label}</span>
                </a>
              ))}
            </React.Fragment>
          ))}
        </nav>

        {/* Same ownership rule as the sidebar stats below: this person's own
            counts, not the team's — local-only mode has no signed-in employee
            to count for, hence the myEmployeeId guard rather than !localOnly. */}
        {myEmployeeId && (
          <div className="sidebar-stats-wrap">
            <div className="sidebar-stats-caption">This Month</div>
            <div className="sidebar-stats">
              <div className="sidebar-stat">
                <span className="sidebar-stat-value">{myScheduledCount}</span>
                <span className="sidebar-stat-label">Scheduled</span>
              </div>
              <div className="sidebar-stat-divider" />
              <div className="sidebar-stat">
                <span className="sidebar-stat-value">{myCompletedCount}</span>
                <span className="sidebar-stat-label">Completed</span>
              </div>
            </div>
          </div>
        )}

        {/* No sign-out control in local-only mode — there is no session to end. */}
        {!localOnly && (
          <div className="sidebar-footer">
            <div className="sidebar-user">
              <div className="user-avatar">{initials(displayName)}</div>
              <div className="sidebar-user-meta">
                <div className="user-name" title={displayName}>{displayName}</div>
                <div className="user-role">{role}</div>
              </div>
              <button
                type="button"
                className="btn-icon sidebar-signout"
                title="Sign out"
                onClick={() => setConfirmSignOut(true)}
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        )}
      </aside>

      {confirmSignOut && (
        <ConfirmDialog
          title="Sign out"
          message="Your cached team data on this device will be cleared and reloaded from the server next time you sign in."
          confirmLabel="Sign out"
          tone="neutral"
          onConfirm={signOut}
          onCancel={() => setConfirmSignOut(false)}
        />
      )}

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu-btn" onClick={() => setSidebarOpen(true)}>
            <Menu size={22} />
          </button>
          <div className="topbar-left">
            <h2>{navItems.find(i => i.key === activeTab)?.label || 'Dashboard'}</h2>
          </div>
          <div className="topbar-right">
            {children[0]?.props?.children}
            <label className="theme-switch" title={theme === 'light' ? 'Dark mode' : 'Light mode'}>
              <input
                type="checkbox"
                className="theme-switch-checkbox"
                checked={theme === 'dark'}
                onChange={toggleTheme}
              />
              <div className="theme-switch-slot">
                <div className="theme-switch-icon-wrapper theme-switch-sun-wrapper">
                  <Sun size={13} className="theme-switch-icon theme-switch-sun-icon" />
                </div>
                <div className="theme-switch-button" />
                <div className="theme-switch-icon-wrapper theme-switch-moon-wrapper">
                  <Moon size={13} className="theme-switch-icon theme-switch-moon-icon" />
                </div>
              </div>
            </label>
            <NotificationPanel />
          </div>
        </header>
        <div className="content-area">
          {children[1]}
        </div>
      </main>
    </div>
  );
}
