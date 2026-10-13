import React, { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { CalendarDays, CheckCircle2, Clock, TrendingUp, Users, Globe, ArrowUpRight, Activity, ChevronDown, ArrowRightCircle } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Sector,
  AreaChart, Area
} from 'recharts';
import { motion } from 'framer-motion';
import AnimatedCounter from '../components/AnimatedCounter';
import WelcomeBanner from '../components/WelcomeBanner';
import WorldMap from '../components/WorldMap';
import { lighten } from '../lib/categories';
import { isCarriedForward } from '../lib/taskProgress';
import { isLeadCenterVisible } from '../lib/leadCenterAccess';

// Pops the hovered slice out of the ring
function renderActiveSlice(props) {
  return <Sector {...props} outerRadius={props.outerRadius + 9} />;
}

export default function Dashboard({ onCategoryDrill, onStatusDrill, onNavigateToLeads }) {
  const { tasks, employees, websites, leads, getEmployeeName, getWebsiteName, getCategoryColor, unitLabel, unitLabelPlural, currentTeam } = useApp();
  const { canViewAll, canManageTeam } = useAuth();
  const [viewMode, setViewMode] = useState('overall'); // overall | monthly
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [filterWebsite, setFilterWebsite] = useState('all');
  // Admin-only (see the dropdown below) — a member's own data is already all
  // they ever see, so there's nothing for them to filter down further.
  const [filterEmployee, setFilterEmployee] = useState('all');
  const [activeSlice, setActiveSlice] = useState(null);

  // Apply filters based on view mode
  const filteredTasks = useMemo(() => {
    let result = tasks;
    if (filterWebsite !== 'all') {
      result = result.filter(t => t.websiteId === filterWebsite);
    }
    if (filterEmployee !== 'all') {
      result = result.filter(t => t.assignedTo === filterEmployee);
    }
    if (viewMode === 'monthly') {
      result = result.filter(t => t.month === filterMonth && t.year === filterYear);
    }
    return result;
  }, [tasks, viewMode, filterMonth, filterYear, filterWebsite, filterEmployee]);

  const totalTasks = filteredTasks.filter(t => !t.isAdditional).length;
  const completedTasks = filteredTasks.filter(t => !t.isAdditional && t.status === 'completed').length;
  const carriedForwardTasks = filteredTasks.filter(t => !t.isAdditional && isCarriedForward(t)).length;
  // Excludes carried-forward tasks — "Pending" now means genuinely still
  // open, not just "not completed". Overall view spans every month, so this
  // is exactly where the old single-bucket count was most misleading.
  const pendingTasks = filteredTasks.filter(t => !t.isAdditional && t.status !== 'completed' && !isCarriedForward(t)).length;
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Chart: Scheduled vs Completed by Website
  const websiteChartData = useMemo(() => {
    const map = {};
    filteredTasks.filter(t => !t.isAdditional).forEach(t => {
      const id = t.websiteId || 'unassigned';
      if (!map[id]) map[id] = { websiteId: t.websiteId || 'all', name: getWebsiteName(t.websiteId), scheduled: 0, completed: 0 };
      map[id].scheduled++;
      if (t.status === 'completed') map[id].completed++;
    });
    return Object.values(map);
  }, [filteredTasks, getWebsiteName]);

  // Chart: Category distribution — sorted biggest-first so the legend reads well
  const categoryData = useMemo(() => {
    const map = {};
    filteredTasks.forEach(t => {
      const cat = t.category || 'General';
      if (!map[cat]) map[cat] = 0;
      map[cat]++;
    });
    const total = Object.values(map).reduce((s, v) => s + v, 0);
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        name,
        value,
        percent: total > 0 ? (value / total) * 100 : 0,
        // Colour comes from the category itself, so it stays put as counts shift
        baseColor: getCategoryColor(name),
      }));
  }, [filteredTasks, getCategoryColor]);

  // Shared by every chart that drills into Schedule (category donut, website
  // bars, trend points, employee bars) — each click means "show me exactly
  // this slice". category defaults to 'all' when a click isn't about a
  // category; employee defaults to whatever's currently selected here
  // (usually 'all', but an admin's own employee filter should carry into
  // Schedule rather than silently reset it) — either way both are always
  // passed explicitly, never left unset for a stale filter to linger.
  const drillIntoSchedule = ({ category = 'all', employee = filterEmployee, period, month, year, website }) => {
    if (!onCategoryDrill) return;
    onCategoryDrill({
      category,
      employee,
      period: period ?? (viewMode === 'monthly' ? 'month' : 'year'),
      month: month ?? (viewMode === 'monthly' ? filterMonth : undefined),
      year: year ?? filterYear,
      website: website ?? filterWebsite,
    });
  };

  // Clicking a category opens the Schedule tab filtered to it. 'Overall' spans
  // every year, so it drills into the full year currently selected here.
  const drillIntoCategory = (categoryName) => {
    if (!categoryName) return;
    drillIntoSchedule({ category: categoryName });
  };

  // Clicking either bar for a website opens Schedule scoped to that website —
  // both "Scheduled" and "Completed" land in the same place, since the point
  // is browsing that website's tasks, not one specific status.
  const drillIntoWebsite = (websiteId) => {
    if (!websiteId) return;
    drillIntoSchedule({ website: websiteId });
  };

  // Clicking a point on the trend chart opens Schedule for exactly that
  // month, regardless of which line (Scheduled/Completed) was under the
  // cursor — recharts hands back the whole data point, so both are available
  // in the tooltip either way.
  const drillIntoTrendPoint = (rawMonth, rawYear) => {
    if (!rawMonth || !rawYear) return;
    drillIntoSchedule({ month: rawMonth, year: rawYear, period: 'month' });
  };

  // Clicking any of an employee's three bar segments opens Schedule filtered
  // to that person, over the same period/website currently shown here.
  const drillIntoEmployee = (employeeId) => {
    if (!employeeId) return;
    drillIntoSchedule({ employee: employeeId });
  };

  // Same idea, for the KPI cards — opens Tasks Completed pre-filtered to that
  // status, over the same period/website currently shown here.
  const drillIntoStatus = (status) => {
    if (!onStatusDrill) return;
    onStatusDrill({
      status,
      period: viewMode === 'monthly' ? 'month' : 'year',
      month: viewMode === 'monthly' ? filterMonth : undefined,
      year: filterYear,
      website: filterWebsite,
    });
  };

  // Chart: Employee Performance
  const employeeData = useMemo(() => {
    const map = {};
    filteredTasks.forEach(t => {
      const id = t.assignedTo || 'unassigned';
      if (!map[id]) map[id] = { employeeId: t.assignedTo || 'all', name: getEmployeeName(t.assignedTo), total: 0, completed: 0, additional: 0 };
      if (t.isAdditional) {
        if (t.status === 'completed') {
          map[id].additional++;
        }
      } else {
        map[id].total++;
        if (t.status === 'completed') map[id].completed++;
      }
    });
    return Object.values(map).sort((a, b) => (b.total + b.additional) - (a.total + a.additional));
  }, [filteredTasks, getEmployeeName]);

  // Chart: Monthly Trend (last 12 months for overall, last 6 for monthly)
  const trendData = useMemo(() => {
    const count = viewMode === 'overall' ? 12 : 6;
    const baseMonth = viewMode === 'monthly' ? filterMonth : new Date().getMonth() + 1;
    const baseYear = viewMode === 'monthly' ? filterYear : new Date().getFullYear();
    const months = [];
    for (let i = count - 1; i >= 0; i--) {
      let m = baseMonth - i;
      let y = baseYear;
      while (m <= 0) { m += 12; y--; }
      const monthTasks = tasks.filter(t =>
        !t.isAdditional &&
        t.month === m && t.year === y &&
        (filterWebsite === 'all' || t.websiteId === filterWebsite) &&
        (filterEmployee === 'all' || t.assignedTo === filterEmployee)
      );
      const monthName = new Date(y, m - 1).toLocaleString('default', { month: 'short' });
      months.push({
        name: `${monthName} ${y.toString().slice(2)}`,
        scheduled: monthTasks.length,
        completed: monthTasks.filter(t => t.status === 'completed').length,
        // Carried alongside the display label so a click can drill into the
        // exact month without having to re-parse "Jul 26" back into numbers.
        rawMonth: m,
        rawYear: y,
      });
    }
    return months;
  }, [tasks, viewMode, filterMonth, filterYear, filterWebsite, filterEmployee]);

  // Recent Activity (across all time)
  const recentActivity = useMemo(() => {
    return [...tasks]
      .filter(t => t.status === 'completed' && t.completedDate && (filterEmployee === 'all' || t.assignedTo === filterEmployee))
      .sort((a, b) => new Date(b.completedDate) - new Date(a.completedDate))
      .slice(0, 6);
  }, [tasks, filterEmployee]);

  const customTooltipStyle = {
    backgroundColor: '#fff', border: '1px solid #e2e8f0',
    borderRadius: '10px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
    padding: '10px 14px', fontSize: '0.85rem',
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
  };

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show">
      <motion.div variants={itemVariants}>
        <WelcomeBanner />
      </motion.div>

      {/* View Controls */}
      <motion.div variants={itemVariants} style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {/* View Toggle */}
        <div className="seg" role="group" aria-label="Dashboard view">
          <button
            type="button"
            className={`seg-btn ${viewMode === 'overall' ? 'is-active' : ''}`}
            aria-pressed={viewMode === 'overall'}
            onClick={() => setViewMode('overall')}
          >Overall</button>
          <button
            type="button"
            className={`seg-btn ${viewMode === 'monthly' ? 'is-active' : ''}`}
            aria-pressed={viewMode === 'monthly'}
            onClick={() => setViewMode('monthly')}
          >Monthly</button>
        </div>

        {/* Month/Year Picker (only in monthly mode) */}
        {viewMode === 'monthly' && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterMonth} onChange={(e) => setFilterMonth(parseInt(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (<option key={i + 1} value={i + 1}>{new Date(2000, i).toLocaleString('default', { month: 'long' })}</option>))}
            </select>
            <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterYear} onChange={(e) => setFilterYear(parseInt(e.target.value))}>
              {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        )}

        {/* Website Filter */}
        <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterWebsite} onChange={(e) => setFilterWebsite(e.target.value)}>
          <option value="all">{`All ${unitLabelPlural}`}</option>
          {websites.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>

        {/* Employee Filter — hidden for a plain member, whose own data is
            already all they ever see; shown for both admin and viewer, who
            both see everyone's via RLS. */}
        {canViewAll && (
          <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
            <option value="all">All Employees</option>
            {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
          </select>
        )}
      </motion.div>

      {/* Header Area */}
      <motion.div variants={itemVariants} className="page-header" style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '1.4rem' }}>
          {viewMode === 'overall'
            ? 'Overall Progress'
            : new Date(filterYear, filterMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' })
          }
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '2px' }}>
          {viewMode === 'overall' ? 'Aggregated data across all months' : 'Filtered data for the selected month'}
          {filterWebsite !== 'all' ? ` • ${getWebsiteName(filterWebsite)}` : ` • All ${unitLabelPlural}`}
          {filterEmployee !== 'all' && ` • ${getEmployeeName(filterEmployee)}`}
          <span style={{ color: 'var(--text-light)' }}> • click a card below to see those tasks</span>
        </p>
      </motion.div>

      {/* KPI Cards */}
      <motion.div variants={itemVariants} className="kpi-grid">
        <div className="kpi-card blue clickable" onClick={() => drillIntoStatus('all')} title="View these tasks in Tasks Completed">
          <div className="kpi-icon blue"><CalendarDays size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Total Scheduled</div>
            <div className="kpi-value"><AnimatedCounter to={totalTasks} /></div>
          </div>
        </div>
        <div className="kpi-card green clickable" onClick={() => drillIntoStatus('completed')} title="View these tasks in Tasks Completed">
          <div className="kpi-icon green"><CheckCircle2 size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Completed</div>
            <div className="kpi-value"><AnimatedCounter to={completedTasks} /></div>
          </div>
        </div>
        <div className="kpi-card amber clickable" onClick={() => drillIntoStatus('pending')} title="View these tasks in Tasks Completed">
          <div className="kpi-icon amber"><Clock size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Pending</div>
            <div className="kpi-value"><AnimatedCounter to={pendingTasks} /></div>
          </div>
        </div>
        <div className="kpi-card info clickable" onClick={() => drillIntoStatus('carried_forward')} title="View these tasks in Tasks Completed">
          <div className="kpi-icon info"><ArrowRightCircle size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Carried Forward</div>
            <div className="kpi-value"><AnimatedCounter to={carriedForwardTasks} /></div>
          </div>
        </div>
        <div className="kpi-card purple">
          <div className="kpi-icon purple"><TrendingUp size={24} /></div>
          <div className="kpi-content">
            <div className="kpi-label">Completion Rate</div>
            <div className="kpi-value"><AnimatedCounter to={completionRate} />%</div>
          </div>
        </div>
      </motion.div>

      {/* Charts Row 1 */}
      <div className="charts-grid">
        <div className="chart-card">
          <h4>
            {`Scheduled vs Completed (by ${unitLabel})`}
            {websiteChartData.length > 0 && (
              <span style={{ fontWeight: 500, fontSize: '0.72rem', color: 'var(--text-light)', marginLeft: '8px' }}>
                click to open in Schedule
              </span>
            )}
          </h4>
          {websiteChartData.length > 0 ? (
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={websiteChartData} barGap={4}>
                  <defs>
                    <linearGradient id="barWebScheduled" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--primary-light)" />
                      <stop offset="100%" stopColor="var(--primary)" />
                    </linearGradient>
                    <linearGradient id="barWebCompleted" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--success-light)" />
                      <stop offset="100%" stopColor="var(--success)" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--bg-hover)' }} />
                  {/* Either bar for a website opens the same place — the point
                      is browsing that website's tasks, not one status. */}
                  <Bar dataKey="scheduled" name="Scheduled" fill="url(#barWebScheduled)" radius={[6, 6, 0, 0]} barSize={32} activeBar={{ stroke: 'var(--primary)', strokeWidth: 2 }} style={{ cursor: 'pointer' }} onClick={(data) => drillIntoWebsite(data.websiteId)} />
                  <Bar dataKey="completed" name="Completed" fill="url(#barWebCompleted)" radius={[6, 6, 0, 0]} barSize={32} activeBar={{ stroke: 'var(--success)', strokeWidth: 2 }} style={{ cursor: 'pointer' }} onClick={(data) => drillIntoWebsite(data.websiteId)} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty-state" style={{ padding: '40px' }}><p>No data for this period</p></div>
          )}
        </div>
        <div className="chart-card">
          <h4>
            Task Distribution (by Category)
            {categoryData.length > 0 && (
              <span style={{ fontWeight: 500, fontSize: '0.72rem', color: 'var(--text-light)', marginLeft: '8px' }}>
                click to open in Schedule
              </span>
            )}
          </h4>
          {categoryData.length > 0 ? (
            // Slice labels are omitted on purpose — with 10+ categories they
            // collide around the donut. The legend beside it carries the names.
            <div className="pie-with-legend">
              <div className="pie-chart-area">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <defs>
                      {categoryData.map((c, idx) => (
                        <linearGradient key={c.name} id={`pie${idx}`} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor={lighten(c.baseColor)} />
                          <stop offset="100%" stopColor={c.baseColor} />
                        </linearGradient>
                      ))}
                    </defs>
                    <Pie
                      data={categoryData}
                      cx="50%" cy="50%"
                      innerRadius={52} outerRadius={86}
                      paddingAngle={3}
                      dataKey="value"
                      style={{ cursor: 'pointer', outline: 'none' }}
                      onMouseEnter={(_, idx) => setActiveSlice(idx)}
                      onMouseLeave={() => setActiveSlice(null)}
                      onClick={(_, idx) => drillIntoCategory(categoryData[idx]?.name)}
                      {...(activeSlice !== null ? { activeIndex: activeSlice, activeShape: renderActiveSlice } : {})}
                    >
                      {categoryData.map((_, idx) => {
                        const dimmed = activeSlice !== null && activeSlice !== idx;
                        return (
                          <Cell
                            key={idx}
                            fill={`url(#pie${idx})`}
                            stroke="var(--bg-card)"
                            strokeWidth={2}
                            opacity={dimmed ? 0.35 : 1}
                            style={{
                              filter: dimmed ? 'blur(2.5px)' : 'drop-shadow(0px 4px 6px rgba(0,0,0,0.1))',
                              transition: 'opacity 0.2s ease, filter 0.2s ease',
                              outline: 'none',
                            }}
                          />
                        );
                      })}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="pie-legend">
                {categoryData.map((c, idx) => {
                  const dimmed = activeSlice !== null && activeSlice !== idx;
                  return (
                    <li
                      key={c.name}
                      className="pie-legend-item"
                      title={`${c.name} - ${c.value} task${c.value !== 1 ? 's' : ''} (${c.percent.toFixed(0)}%) · click to view in Schedule`}
                      onMouseEnter={() => setActiveSlice(idx)}
                      onMouseLeave={() => setActiveSlice(null)}
                      onClick={() => drillIntoCategory(c.name)}
                      style={{ cursor: 'pointer', opacity: dimmed ? 0.4 : 1, transition: 'opacity 0.2s ease' }}
                    >
                      <span className="pie-legend-dot" style={{ background: c.baseColor }} />
                      <span className="pie-legend-name">{c.name}</span>
                      <span className="pie-legend-value">{c.percent.toFixed(0)}%</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="empty-state" style={{ padding: '40px' }}><p>No data for this period</p></div>
          )}
        </div>
      </div>
 
      {/* Charts Row 2 */}
      <div className="charts-grid">
        <div className="chart-card">
          <h4>
            {viewMode === 'overall' ? 'Yearly Trend (Last 12 Months)' : 'Monthly Trend (Last 6 Months)'}
            {trendData.length > 0 && (
              <span style={{ fontWeight: 500, fontSize: '0.72rem', color: 'var(--text-light)', marginLeft: '8px' }}>
                click a month to open in Schedule
              </span>
            )}
          </h4>
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              {/* This Recharts build's click event carries activeTooltipIndex
                  but not activePayload, so the clicked month is looked up by
                  index into trendData rather than read off the event itself. */}
              <AreaChart data={trendData} style={{ cursor: 'pointer' }} onClick={(e) => {
                const idx = e?.activeTooltipIndex ?? e?.activeIndex;
                const point = idx !== undefined ? trendData[Number(idx)] : undefined;
                if (point) drillIntoTrendPoint(point.rawMonth, point.rawYear);
              }}>
                <defs>
                  <linearGradient id="gScheduled" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gCompleted" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--success)" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="var(--success)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--bg-hover)', stroke: 'var(--border-glass)' }} />
                <Area type="monotone" dataKey="scheduled" stroke="var(--primary)" fill="url(#gScheduled)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--primary)', strokeWidth: 0 }} activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2, fill: 'var(--primary)' }} name="Scheduled" />
                <Area type="monotone" dataKey="completed" stroke="var(--success)" fill="url(#gCompleted)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--success)', strokeWidth: 0 }} activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2, fill: 'var(--success)' }} name="Completed" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="chart-card">
          <h4>
            Employee Performance
            {employeeData.length > 0 && (
              <span style={{ fontWeight: 500, fontSize: '0.72rem', color: 'var(--text-light)', marginLeft: '8px' }}>
                click to open in Schedule
              </span>
            )}
          </h4>
          {employeeData.length > 0 ? (
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={employeeData} layout="vertical" margin={{ top: 0, right: 0, left: -20, bottom: 0 }} barGap={2}>
                  <defs>
                    <linearGradient id="barTotal" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="var(--primary-light)" />
                      <stop offset="100%" stopColor="var(--primary)" />
                    </linearGradient>
                    <linearGradient id="barCompleted" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="var(--success-light)" />
                      <stop offset="100%" stopColor="var(--success)" />
                    </linearGradient>
                    <linearGradient id="barAdditional" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#38bdf8" />
                      <stop offset="100%" stopColor="var(--info)" />
                    </linearGradient>
                  </defs>
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={100} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--bg-hover)' }} />
                  {/* Any of the three segments for an employee opens the same
                      place — browsing that person's tasks, not one status. */}
                  <Bar dataKey="total" name="Assigned" fill="url(#barTotal)" radius={[0, 4, 4, 0]} barSize={12} activeBar={{ stroke: 'var(--primary)', strokeWidth: 1 }} style={{ cursor: 'pointer' }} onClick={(data) => drillIntoEmployee(data.employeeId)} />
                  <Bar dataKey="completed" name="Completed" fill="url(#barCompleted)" radius={[0, 4, 4, 0]} barSize={12} activeBar={{ stroke: 'var(--success)', strokeWidth: 1 }} style={{ cursor: 'pointer' }} onClick={(data) => drillIntoEmployee(data.employeeId)} />
                  <Bar dataKey="additional" name="Additional Completed" fill="url(#barAdditional)" radius={[0, 4, 4, 0]} barSize={12} activeBar={{ stroke: 'var(--info)', strokeWidth: 1 }} style={{ cursor: 'pointer' }} onClick={(data) => drillIntoEmployee(data.employeeId)} />
                  {/* Deliberately placed AFTER the bars (recharts paints SVG
                      children in DOM order) — this chart's bars are long
                      enough to run edge-to-edge for most employees, so a
                      grid drawn underneath (the usual approach, and what
                      every other chart on this page does) is invisible for
                      almost its whole length. Drawn on top instead, at
                      reduced opacity so it doesn't fight the bar colors. */}
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--chart-grid)" strokeOpacity={0.7} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty-state" style={{ padding: '40px' }}><p>No employee data</p></div>
          )}
        </div>
      </div>

      {/* Enquiries by Country — Lead Center stays a single, shared,
          company-wide resource, never duplicated per team, so this card
          (and the button that jumps straight to Lead Center) only appears
          while it's actually reachable for this team/role. Same
          isLeadCenterVisible check Layout.jsx's own nav item and App.jsx's
          isTabAccessible both use. */}
      {isLeadCenterVisible(currentTeam, canManageTeam) && (
        <div className="card" style={{ marginTop: '8px' }}>
          <div className="card-body">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
              <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                <Globe size={18} style={{ color: 'var(--primary)' }} /> Enquiries by Country
              </h4>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onNavigateToLeads}
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                View Details <ArrowUpRight size={14} />
              </button>
            </div>
            <WorldMap leads={leads} compact />
          </div>
        </div>
      )}

      {/* Recent Activity */}
      {recentActivity.length > 0 && (
        <div className="card" style={{ marginTop: '8px' }}>
          <div className="card-body">
            <h4 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={18} style={{ color: 'var(--success)' }} /> Recent Completions
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {recentActivity.map(task => (
                <div key={task.id} style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 14px', background: 'var(--success-bg)',
                  borderRadius: 'var(--radius-md)', borderLeft: '3px solid var(--success)'
                }}>
                  <CheckCircle2 size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{task.title}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: '8px' }}>
                      by {getEmployeeName(task.assignedTo)} • {getWebsiteName(task.websiteId)}
                    </span>
                  </div>
                  {task.completionUrl && (
                    <a href={task.completionUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '2px' }}>
                      View <ArrowUpRight size={12} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="card" style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-glass)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        padding: '12px 16px',
        backdropFilter: 'var(--bg-glass-blur)',
        fontSize: '0.85rem',
        margin: 0
      }}>
        {label && <p style={{ fontWeight: 700, marginBottom: '8px', color: 'var(--text-primary)' }}>{label}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {payload.map((p, idx) => {
            let color = p.name === 'Assigned' || p.name === 'Scheduled' ? 'var(--primary)' : 
                        p.name === 'Completed' ? 'var(--success)' : 
                        p.name === 'Additional Completed' ? 'var(--info)' : p.payload?.baseColor || p.color || 'var(--primary)';
            if (color.startsWith('url')) color = p.payload?.baseColor || 'var(--primary)'; // Fallback for gradient fills
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: color }} />
                <span style={{ color: 'var(--text-secondary)' }}>{p.name}:</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--text-primary)' }}>{p.value}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return null;
};
