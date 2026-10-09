import React, { useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { FileDown, CalendarDays, CheckCircle2, Clock, TrendingUp, ArrowRightCircle, Inbox, XCircle } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { getTaskPercent, getTaskPendingPercent, isCarriedForward, getEffectiveStatus } from '../lib/taskProgress';
import PeriodToggle from '../components/PeriodToggle';
import {
  drawKpiCards, drawDonutChart, drawHorizontalBars,
  drawTrendChart, drawLegend, sectionHeading, PDF_COLORS,
} from '../lib/pdfCharts';
import { buildCoverImage, stampCover } from '../lib/reportCover';
import { STATUS_LABEL, leadStatusKey, parseDate, formatDate } from '../lib/leadFields';
import { getCountryFromPhone } from '../lib/phoneCountry';

// Hours are stored as numbers; render them compactly (2 not 2.0, 1.5 stays 1.5)
function fmtHrs(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

function sumTargeted(list) {
  return list.reduce((s, t) => s + (Number(t.targetedTime) || 0), 0);
}

function sumBooked(list) {
  return list.reduce((s, t) => s + (Number(t.timeTaken) || 0), 0);
}

function ProgressBar({ value, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
      <div style={{ flex: 1, height: 8, borderRadius: 4, background: '#e2e8f0', overflow: 'hidden', minWidth: 50 }}>
        <div style={{ width: `${value}%`, height: '100%', borderRadius: 4, background: color, transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ fontSize: '0.82rem', fontWeight: 700, color, minWidth: 40, textAlign: 'right' }}>{value}%</span>
    </div>
  );
}

// Helper to get readable status label — pending completion % is derived from
// hours logged. A carried-forward original reads as "Carried Forward" rather
// than "N% Pending" — its own hours/status are frozen at whatever they were
// when it was forwarded, so a raw percentage here would be misleading; the
// real remaining work is tracked under its next-month clone now.
//
// These three take tasksById because getEffectiveStatus follows the
// carryForwardTo chain — if this task's successor has since been completed,
// it correctly reads "Completed" here too, not "Carried Forward" forever.
function getStatusLabel(task, tasksById) {
  const effStatus = getEffectiveStatus(task, tasksById);
  if (effStatus === 'completed') return 'Completed';
  if (effStatus === 'carried_forward') return 'Carried Forward';
  return `${getTaskPendingPercent(task)}% Pending`;
}

function getStatusBadgeClass(task, tasksById) {
  const effStatus = getEffectiveStatus(task, tasksById);
  if (effStatus === 'completed') return 'badge-success';
  // badge-info (blue), not badge-warning — badge-warning renders IDENTICALLY
  // to badge-pending (same underlying color tokens), which would make
  // "Carried Forward" visually indistinguishable from plain "Pending" and
  // defeat the point. Blue also matches the "carried forward FROM previous
  // month" badge already used in Schedule/TasksCompleted's title cell.
  if (effStatus === 'carried_forward') return 'badge-info';
  return 'badge-pending';
}

function getStatusColor(task, tasksById) {
  const effStatus = getEffectiveStatus(task, tasksById);
  if (effStatus === 'completed') return '#16a34a';
  if (effStatus === 'carried_forward') return '#0284c7'; // matches --info
  return '#7c3aed';
}

export default function MonthlyReport({ selectedMonth, selectedYear, selectedWebsite }) {
  const { tasks, tasksById, employees, websites, leads, getEmployeeName, getWebsiteName, getCategoryColor, unitLabel, unitLabelPlural, currentTeam } = useApp();
  const { canViewAll } = useAuth();
  const { notify } = useNotification();
  const reportRef = useRef(null);
  // 'month' uses the month+year picked in the topbar; 'year' covers all 12 months
  const [period, setPeriod] = useState('month');
  const [exporting, setExporting] = useState(false);
  // Admin-only (see the dropdown below) — a member's own data is already all
  // they ever see, so there's nothing here for them to narrow down.
  const [filterEmployee, setFilterEmployee] = useState('all');
  const isYearView = period === 'year';

  const monthName = isYearView
    ? `Full Year ${selectedYear}`
    : new Date(selectedYear, selectedMonth - 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  const filteredTasks = useMemo(() => {
    return tasks.filter(t =>
      (isYearView || t.month === selectedMonth) &&
      t.year === selectedYear &&
      (selectedWebsite === 'all' || t.websiteId === selectedWebsite) &&
      (filterEmployee === 'all' || t.assignedTo === filterEmployee)
    );
  }, [tasks, isYearView, selectedMonth, selectedYear, selectedWebsite, filterEmployee]);

  const totalTasks = filteredTasks.length;
  const completedTasks = filteredTasks.filter(t => t.status === 'completed').length;
  const carriedForwardTasks = filteredTasks.filter(isCarriedForward).length;
  // "Pending" now specifically means genuinely still open — no forward
  // motion taken — so it no longer silently absorbs carried-forward tasks.
  // completed + pending + carriedForwardTasks === totalTasks, always.
  const pendingTasks = totalTasks - completedTasks - carriedForwardTasks;
  // Unchanged: carrying a task forward doesn't mean it got done in this
  // period, so the rate keeps counting it as not-done, same as before.
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Hours scheduled (targeted) vs actually booked
  const totalTargetedHrs = sumTargeted(filteredTasks);
  const totalBookedHrs = sumBooked(filteredTasks);
  const completedBookedHrs = sumBooked(filteredTasks.filter(t => t.status === 'completed'));
  const hoursRate = totalTargetedHrs > 0 ? Math.round((totalBookedHrs / totalTargetedHrs) * 100) : 0;

  // Month-by-month rollup, only shown in the full-year view
  const monthlyRollup = useMemo(() => {
    if (!isYearView) return [];
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const monthTasks = filteredTasks.filter(t => t.month === m);
      const done = monthTasks.filter(t => t.status === 'completed').length;
      const carried = monthTasks.filter(isCarriedForward).length;
      return {
        month: new Date(selectedYear, i).toLocaleString('default', { month: 'short' }),
        total: monthTasks.length,
        completed: done,
        pending: monthTasks.length - done - carried,
        carriedForward: carried,
        targetedHrs: sumTargeted(monthTasks),
        bookedHrs: sumBooked(monthTasks),
        rate: monthTasks.length > 0 ? Math.round((done / monthTasks.length) * 100) : 0,
      };
    }).filter(r => r.total > 0);
  }, [isYearView, filteredTasks, selectedYear]);

  const categoryBreakdown = useMemo(() => {
    const map = {};
    filteredTasks.forEach(t => {
      const cat = t.category || 'General';
      if (!map[cat]) map[cat] = { total: 0, completed: 0, carriedForward: 0, items: [] };
      map[cat].total++;
      map[cat].items.push(t);
      if (t.status === 'completed') map[cat].completed++;
      else if (isCarriedForward(t)) map[cat].carriedForward++;
    });
    return Object.entries(map).map(([name, data]) => ({
      name, total: data.total, completed: data.completed,
      pending: data.total - data.completed - data.carriedForward,
      carriedForward: data.carriedForward,
      targetedHrs: sumTargeted(data.items),
      bookedHrs: sumBooked(data.items),
      rate: data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0,
    }));
  }, [filteredTasks]);

  const employeeBreakdown = useMemo(() => {
    const map = {};
    filteredTasks.forEach(t => {
      const name = getEmployeeName(t.assignedTo);
      if (!map[name]) map[name] = { total: 0, completed: 0, carriedForward: 0, items: [] };
      map[name].total++;
      map[name].items.push(t);
      if (t.status === 'completed') map[name].completed++;
      else if (isCarriedForward(t)) map[name].carriedForward++;
    });
    return Object.entries(map).map(([name, data]) => ({
      name, total: data.total, completed: data.completed,
      pending: data.total - data.completed - data.carriedForward,
      carriedForward: data.carriedForward,
      targetedHrs: sumTargeted(data.items),
      bookedHrs: sumBooked(data.items),
      rate: data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0,
    })).sort((a, b) => b.total - a.total);
  }, [filteredTasks, getEmployeeName]);

  const websiteBreakdown = useMemo(() => {
    const map = {};
    filteredTasks.forEach(t => {
      const name = getWebsiteName(t.websiteId);
      if (!map[name]) map[name] = { total: 0, completed: 0, carriedForward: 0, items: [] };
      map[name].total++;
      map[name].items.push(t);
      if (t.status === 'completed') map[name].completed++;
      else if (isCarriedForward(t)) map[name].carriedForward++;
    });
    return Object.entries(map).map(([name, data]) => ({
      name, total: data.total, completed: data.completed,
      pending: data.total - data.completed - data.carriedForward,
      carriedForward: data.carriedForward,
      targetedHrs: sumTargeted(data.items),
      bookedHrs: sumBooked(data.items),
      rate: data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0,
    }));
  }, [filteredTasks, getWebsiteName]);

  // All 12 months of the selected year (website filter applied) — drives the
  // trend chart, which is plotted even in monthly view so it is never blank.
  const yearTrend = useMemo(() => {
    const inYear = tasks.filter(t =>
      t.year === selectedYear &&
      (selectedWebsite === 'all' || t.websiteId === selectedWebsite) &&
      (filterEmployee === 'all' || t.assignedTo === filterEmployee)
    );
    return Array.from({ length: 12 }, (_, i) => {
      const monthTasks = inYear.filter(t => t.month === i + 1);
      return {
        label: new Date(selectedYear, i).toLocaleString('default', { month: 'short' }),
        scheduled: monthTasks.length,
        completed: monthTasks.filter(t => t.status === 'completed').length,
      };
    });
  }, [tasks, selectedYear, selectedWebsite, filterEmployee]);

  const completedList = useMemo(() => {
    return filteredTasks.filter(t => t.status === 'completed').map(t => ({
      ...t, employeeName: getEmployeeName(t.assignedTo), websiteName: getWebsiteName(t.websiteId),
    }));
  }, [filteredTasks, getEmployeeName, getWebsiteName]);

  const pendingList = useMemo(() => {
    return filteredTasks.filter(t => t.status !== 'completed').map(t => ({
      ...t, employeeName: getEmployeeName(t.assignedTo), websiteName: getWebsiteName(t.websiteId),
    }));
  }, [filteredTasks, getEmployeeName, getWebsiteName]);

  // Lead Center enquiries for this same reporting period. A lead has no
  // website/employee of its own (Lead Center has no such fields), so neither
  // selectedWebsite nor filterEmployee apply here — only the month/year this
  // report is scoped to. getUTC*, matching Lead Center's own period filter
  // and formatDate, so a late-in-the-day enquiry lands in the same month here
  // as it does on the Lead Center page itself.
  //
  // leads itself is a single shared, company-wide table — never team-scoped
  // (see Layout.jsx's own Lead Center nav visibility rule) — so without this
  // check every team's Monthly Report would show the exact same enquiries,
  // regardless of which team is actually being reported on. Gated the same
  // way Lead Center's nav item is: is_lead_source_team, not the team's
  // editable name.
  const enquiriesList = useMemo(() => {
    if (!currentTeam?.is_lead_source_team) return [];
    return leads
      .filter(l => {
        const d = parseDate(l.createdAt);
        if (!d) return false;
        return (isYearView || d.getUTCMonth() + 1 === selectedMonth) && d.getUTCFullYear() === selectedYear;
      })
      .sort((a, b) => parseDate(a.createdAt) - parseDate(b.createdAt));
  }, [leads, isYearView, selectedMonth, selectedYear, currentTeam]);

  // Same three buckets as Lead Center's own KPI row, so "Converted" means the
  // exact same thing in both places.
  const enquiryStats = {
    total: enquiriesList.length,
    converted: enquiriesList.filter(l => l.converted === 'yes').length,
    notConverted: enquiriesList.filter(l => l.converted === 'no').length,
  };

  // === PDF EXPORT ===
  // Wrapped so a failure surfaces as a toast instead of silently producing no
  // file — this used to fail with nothing shown to the user at all.
  const exportPDF = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await buildPDF();
    } catch (err) {
      console.error('PDF export failed:', err);
      notify('error', 'PDF Export Failed', err?.message || 'Could not generate the report.');
    } finally {
      setExporting(false);
    }
  };

  const buildPDF = async () => {
    // Every page is portrait A4, cover included — the cover template is drawn on
    // a 1:1.414 canvas so it fills the same page size as the content pages.
    const doc = new jsPDF('p', 'mm', 'a4');

    // ---------- page 1: cover from the SVG template ----------
    // The template has one text slot for the period — an employee filter
    // rides along in the same slot rather than needing its own, so a
    // filtered export reads as "September 2026 - Ajaykumar" on the cover,
    // making it unmistakable this PDF is one person's report, not the team's.
    const { dataUrl: coverPng } = await buildCoverImage({
      periodLabel: filterEmployee !== 'all' ? `${monthName} - ${getEmployeeName(filterEmployee)}` : monthName,
      generatedLabel: `Generated: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    });
    stampCover(doc, coverPng);

    // ---------- page 2 onward: content ----------
    doc.addPage('a4', 'p');
    const pageWidth = doc.internal.pageSize.getWidth();
    const M = 14;                          // page margin
    const contentW = pageWidth - M * 2;
    let y = 24;

    // Executive Summary — the four dashboard cards, then the remaining metrics
    y = sectionHeading(doc, 'Executive Summary', M, y);
    y = drawKpiCards(doc, {
      x: M, y, width: contentW,
      cards: [
        { label: 'Total Scheduled', value: totalTasks, color: '#2563eb' },
        { label: 'Completed', value: completedTasks, color: '#16a34a' },
        { label: 'Pending', value: pendingTasks, color: '#d97706' },
        { label: 'Carried Fwd', value: carriedForwardTasks, color: '#0284c7' },
        { label: 'Completion Rate', value: `${completionRate}%`, color: PDF_COLORS.PURPLE },
      ],
    }) + 9;

    autoTable(doc, {
      startY: y,
      head: [['Metric', 'Value']],
      body: [
        ['Hours Scheduled (Targeted)', `${fmtHrs(totalTargetedHrs)} h`],
        ['Hours Booked (All Tasks)', `${fmtHrs(totalBookedHrs)} h`],
        ['Hours Booked (Completed Tasks)', `${fmtHrs(completedBookedHrs)} h`],
        ['Hours Utilisation', `${hoursRate}%`],
        ['Active Employees', employeeBreakdown.length.toString()],
        [`Active ${unitLabelPlural}`, websiteBreakdown.length.toString()],
      ],
      theme: 'grid',
      headStyles: { fillColor: [124, 58, 237], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      alternateRowStyles: { fillColor: [245, 243, 255] },
      margin: { left: M, right: M },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 80 } },
    });
    y = doc.lastAutoTable.finalY + 12;

    // Month-by-month rollup (full-year view only)
    if (monthlyRollup.length > 0) {
      if (y > 210) { doc.addPage('a4', 'p'); y = 24; }
      y = sectionHeading(doc, 'Month-by-Month Summary', M, y);
      autoTable(doc, {
        startY: y,
        head: [['Month', 'Scheduled', 'Completed', 'Pending', 'Carried Fwd', 'Target Hrs', 'Booked Hrs', 'Completion %']],
        body: monthlyRollup.map(m => [m.month, m.total, m.completed, m.pending, m.carriedForward, fmtHrs(m.targetedHrs), fmtHrs(m.bookedHrs), `${m.rate}%`]),
        foot: [['Total', totalTasks, completedTasks, pendingTasks, fmtHrs(totalTargetedHrs), fmtHrs(totalBookedHrs), `${completionRate}%`]],
        theme: 'grid',
        headStyles: { fillColor: [124, 58, 237], textColor: 255, fontStyle: 'bold', fontSize: 9 },
        footStyles: { fillColor: [237, 233, 254], textColor: [15, 23, 42], fontStyle: 'bold', fontSize: 9 },
        bodyStyles: { fontSize: 9 },
        alternateRowStyles: { fillColor: [245, 243, 255] },
        margin: { left: 14, right: 14 },
      });
      y = doc.lastAutoTable.finalY + 12;
    }

    // Category Breakdown — donut of the task split
    if (categoryBreakdown.length > 0) {
      if (y > 185) { doc.addPage('a4', 'p'); y = 24; }
      y = sectionHeading(doc, 'Breakdown by Category', M, y);
      const donutSlices = [...categoryBreakdown]
        .sort((a, b) => b.total - a.total)
        .map(c => ({ label: c.name, value: c.total, color: getCategoryColor(c.name) }));
      y = drawDonutChart(doc, {
        x: M, y, size: 46, slices: donutSlices, legendWidth: contentW - 54,
      }) + 9;
      autoTable(doc, {
        startY: y,
        head: [['Category', 'Scheduled', 'Completed', 'Pending', 'Carried Fwd', 'Target Hrs', 'Booked Hrs', 'Completion %']],
        body: categoryBreakdown.map(c => [c.name, c.total, c.completed, c.pending, c.carriedForward, fmtHrs(c.targetedHrs), fmtHrs(c.bookedHrs), `${c.rate}%`]),
        theme: 'grid',
        headStyles: { fillColor: [124, 58, 237], textColor: 255, fontStyle: 'bold', fontSize: 9 },
        bodyStyles: { fontSize: 9 },
        alternateRowStyles: { fillColor: [245, 243, 255] },
        margin: { left: 14, right: 14 },
      });
      y = doc.lastAutoTable.finalY + 12;
    }

    // Employee Breakdown — assigned vs completed per person
    if (employeeBreakdown.length > 0) {
      const chartH = employeeBreakdown.length * 9 + 14;
      if (y + chartH > 250) { doc.addPage('a4', 'p'); y = 24; }
      y = sectionHeading(doc, 'Breakdown by Employee', M, y);
      const empSeries = [
        { key: 'assigned', name: 'Assigned', color: '#2563eb' },
        { key: 'completed', name: 'Completed', color: '#16a34a' },
      ];
      y = drawLegend(doc, { x: M, y, series: empSeries }) + 3;
      y = drawHorizontalBars(doc, {
        x: M, y, width: contentW,
        rows: employeeBreakdown.map(e => ({ label: e.name, assigned: e.total, completed: e.completed })),
        series: empSeries,
      }) + 9;
      autoTable(doc, {
        startY: y,
        head: [['Employee', 'Assigned', 'Completed', 'Pending', 'Carried Fwd', 'Target Hrs', 'Booked Hrs', 'Completion %']],
        body: employeeBreakdown.map(e => [e.name, e.total, e.completed, e.pending, e.carriedForward, fmtHrs(e.targetedHrs), fmtHrs(e.bookedHrs), `${e.rate}%`]),
        theme: 'grid',
        headStyles: { fillColor: [124, 58, 237], textColor: 255, fontStyle: 'bold', fontSize: 9 },
        bodyStyles: { fontSize: 9 },
        alternateRowStyles: { fillColor: [245, 243, 255] },
        margin: { left: 14, right: 14 },
      });
      y = doc.lastAutoTable.finalY + 12;
    }

    // Website Breakdown — month-by-month trend across the selected year
    if (websiteBreakdown.length > 0) {
      if (y + 72 > 250) { doc.addPage('a4', 'p'); y = 24; }
      y = sectionHeading(doc, `Breakdown by ${unitLabel}`, M, y, '#06b6d4');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `Month-by-month trend - ${selectedYear}${selectedWebsite !== 'all' ? ` · ${getWebsiteName(selectedWebsite)}` : ` · all ${unitLabelPlural.toLowerCase()}`}`,
        M, y,
      );
      y += 5;
      const trendSeries = [
        { key: 'scheduled', name: 'Scheduled', color: PDF_COLORS.PURPLE },
        { key: 'completed', name: 'Completed', color: '#16a34a' },
      ];
      y = drawLegend(doc, { x: M, y, series: trendSeries }) + 4;
      y = drawTrendChart(doc, {
        x: M, y, width: contentW, height: 50, points: yearTrend, series: trendSeries,
      }) + 9;
      autoTable(doc, {
        startY: y,
        head: [[unitLabel, 'Scheduled', 'Completed', 'Pending', 'Carried Fwd', 'Target Hrs', 'Booked Hrs', 'Completion %']],
        body: websiteBreakdown.map(w => [w.name, w.total, w.completed, w.pending, w.carriedForward, fmtHrs(w.targetedHrs), fmtHrs(w.bookedHrs), `${w.rate}%`]),
        theme: 'grid',
        headStyles: { fillColor: [6, 182, 212], textColor: 255, fontStyle: 'bold', fontSize: 9 },
        bodyStyles: { fontSize: 9 },
        alternateRowStyles: { fillColor: [236, 253, 245] },
        margin: { left: 14, right: 14 },
      });
      y = doc.lastAutoTable.finalY + 12;
    }

    // Completed Tasks Detail
    if (completedList.length > 0) {
      if (y > 200) { doc.addPage('a4', 'p'); y = 24; }
      y = sectionHeading(doc, 'Completed Tasks - Detail', M, y, '#10b981');
      autoTable(doc, {
        startY: y,
        head: [['#', 'Task', 'Category', 'Employee', unitLabel, 'Hrs Target/Booked', 'Completed', 'Proof URL']],
        body: completedList.map((t, i) => [
          i + 1, t.title, t.category || 'General', t.employeeName, t.websiteName,
          `${fmtHrs(t.targetedTime)} / ${fmtHrs(t.timeTaken)}`,
          t.completedDate ? new Date(t.completedDate).toLocaleDateString('en-IN') : '—',
          // Keep the real URL as the cell value; the hooks below swap the shown
          // text to "View Link". Reading it back off the cell (rather than
          // indexing completedList by row) is what keeps this correct when a
          // row is split across a page break.
          t.completionUrl && t.completionUrl.startsWith('http') ? t.completionUrl : (t.completionUrl || '—'),
        ]),
        theme: 'grid',
        headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        bodyStyles: { fontSize: 8 },
        alternateRowStyles: { fillColor: [236, 253, 245] },
        margin: { left: 14, right: 14 },
        columnStyles: { 0: { cellWidth: 10 }, 5: { cellWidth: 22 }, 7: { cellWidth: 22 } },
        didParseCell: (data) => {
          if (data.section !== 'body' || data.column.index !== 7) return;
          const url = typeof data.cell.raw === 'string' ? data.cell.raw : '';
          if (url.startsWith('http')) {
            data.cell.text = ['View Link'];
            data.cell.styles.textColor = [37, 99, 235]; // Blue link color
            data.cell.styles.fontStyle = 'bold';
          }
        },
        didDrawCell: (data) => {
          if (data.section !== 'body' || data.column.index !== 7) return;
          const url = typeof data.cell.raw === 'string' ? data.cell.raw : '';
          if (url.startsWith('http')) {
            doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url });
          }
        }
      });
      y = doc.lastAutoTable.finalY + 12;
    }

    // Pending Tasks Detail (with status %)
    if (pendingList.length > 0) {
      if (y > 200) { doc.addPage('a4', 'p'); y = 24; }
      y = sectionHeading(doc, 'Pending Tasks - Detail', M, y, '#f59e0b');
      autoTable(doc, {
        startY: y,
        head: [['#', 'Task', 'Category', 'Assigned To', unitLabel, 'Priority', 'Hrs Target/Booked', 'Status']],
        body: pendingList.map((t, i) => [
          i + 1, t.title, t.category || 'General', t.employeeName, t.websiteName,
          (t.priority || 'medium').charAt(0).toUpperCase() + (t.priority || 'medium').slice(1),
          `${fmtHrs(t.targetedTime)} / ${fmtHrs(t.timeTaken)}`,
          getStatusLabel(t, tasksById),
        ]),
        theme: 'grid',
        headStyles: { fillColor: [245, 158, 11], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        bodyStyles: { fontSize: 8 },
        alternateRowStyles: { fillColor: [255, 251, 235] },
        margin: { left: 14, right: 14 },
        columnStyles: { 0: { cellWidth: 10 } },
      });
      // This used to be the last section, so nothing read `y` afterward and
      // it was left stale here. Now that Enquiries can follow it, its own
      // page-break check below needs this to reflect where Pending Tasks'
      // table actually ended, not wherever it started.
      y = doc.lastAutoTable.finalY + 12;
    }

    // Lead Center Enquiries — this reporting period's leads, alongside the
    // task activity above. Same columns as the Lead Center table itself,
    // minus the admin-only selection/delete controls (no place in a report).
    // Message is deliberately left unconstrained below so it wraps to full
    // text rather than being clipped — a PDF has no hover tooltip to reveal
    // the rest, unlike the 2-line clamp used on the Lead Center page itself.
    if (enquiriesList.length > 0) {
      if (y > 170) { doc.addPage('a4', 'p'); y = 24; }
      y = sectionHeading(doc, 'Lead Center Enquiries', M, y, '#2563eb');
      // Same three buckets as Lead Center's own KPI row, so this overview and
      // the detail table right after it can never disagree.
      y = drawKpiCards(doc, {
        x: M, y, width: contentW,
        cards: [
          { label: 'Total Received', value: enquiryStats.total, color: '#2563eb' },
          { label: 'Converted', value: enquiryStats.converted, color: '#16a34a' },
          { label: 'Not Converted', value: enquiryStats.notConverted, color: '#e11d48' },
        ],
      }) + 9;
      autoTable(doc, {
        startY: y,
        head: [['#', 'Name', 'Company', 'Contact', 'Country', 'Message', 'Status', 'Source', 'Date']],
        body: enquiriesList.map((l, i) => [
          i + 1,
          l.name || '—',
          l.company || '—',
          [l.email, l.phone].filter(Boolean).join('\n') || '—',
          getCountryFromPhone(l.phone) || '—',
          l.message || '—',
          STATUS_LABEL[leadStatusKey(l)],
          l.sourceUrl && l.sourceUrl.startsWith('http') ? l.sourceUrl : (l.sourceUrl || '—'),
          formatDate(l.createdAt),
        ]),
        theme: 'grid',
        headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        bodyStyles: { fontSize: 8, valign: 'top' },
        alternateRowStyles: { fillColor: [239, 246, 255] },
        margin: { left: 14, right: 14 },
        columnStyles: {
          0: { cellWidth: 8 },
          1: { cellWidth: 18 },
          2: { cellWidth: 18 },
          3: { cellWidth: 22 },
          // Wide enough that "Philippines" (the longest common country name
          // this table will realistically show) fits without an awkward
          // mid-word wrap at 8pt.
          4: { cellWidth: 20 },
          // 5 (Message) deliberately has no cellWidth — autoTable gives it
          // whatever width remains after the others, so a long message wraps
          // onto more lines instead of being cut off.
          // Wide enough that "Not Converted" fits on one line at 8pt.
          6: { cellWidth: 20 },
          7: { cellWidth: 14 },
          8: { cellWidth: 12 },
        },
        didParseCell: (data) => {
          if (data.section !== 'body' || data.column.index !== 7) return;
          const url = typeof data.cell.raw === 'string' ? data.cell.raw : '';
          if (url.startsWith('http')) {
            data.cell.text = ['View Link'];
            data.cell.styles.textColor = [37, 99, 235];
            data.cell.styles.fontStyle = 'bold';
          }
        },
        didDrawCell: (data) => {
          if (data.section !== 'body' || data.column.index !== 7) return;
          const url = typeof data.cell.raw === 'string' ? data.cell.raw : '';
          if (url.startsWith('http')) {
            doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url });
          }
        },
      });
    }

    // Footer on the content pages — the cover has its own branded band
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 2; i <= totalPages; i++) {
      doc.setPage(i);
      // read per page — page 1 is landscape, the rest portrait
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.3);
      doc.line(M, ph - 12, pw - M, ph - 12);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(`IFE - ${monthName}${filterEmployee !== 'all' ? ` - ${getEmployeeName(filterEmployee)}` : ''}`, M, ph - 7.5);
      doc.text(`Page ${i - 1} of ${totalPages - 1}`, pw - M, ph - 7.5, { align: 'right' });
    }

    const employeeSuffix = filterEmployee !== 'all' ? `-${getEmployeeName(filterEmployee).replace(/\s+/g, '-')}` : '';
    doc.save(`${isYearView ? 'Yearly' : 'Monthly'}-Report-${monthName.replace(/\s+/g, '-')}${employeeSuffix}.pdf`);
  };

  return (
    <div className="animate-in" ref={reportRef}>
      <div className="page-header">
        <div>
          <h3>{isYearView ? 'Yearly Report' : 'Monthly Report'} - {monthName}</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
            {selectedWebsite !== 'all' ? getWebsiteName(selectedWebsite) : `All ${unitLabelPlural}`}
            {filterEmployee !== 'all' && ` • ${getEmployeeName(filterEmployee)}`}
            {' '}• Generated on {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Employee Filter — hidden for a plain member, whose own data is
              already all they ever see; shown for both admin and viewer, who
              both see everyone's via RLS. Scopes the whole report AND the
              PDF export below it. */}
          {canViewAll && (
            <select className="form-select" style={{ padding: '6px 12px', fontSize: '0.82rem' }} value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
              <option value="all">All Employees</option>
              {employees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
            </select>
          )}
          <PeriodToggle period={period} onChange={setPeriod} year={selectedYear} />
          <button className="btn btn-primary" onClick={exportPDF} disabled={exporting || (totalTasks === 0 && enquiriesList.length === 0)}>
            <FileDown size={16} /> {exporting ? 'Generating…' : 'Export as PDF'}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="kpi-grid" style={{ marginBottom: '24px' }}>
        <div className="kpi-card blue"><div className="kpi-icon blue"><CalendarDays size={22} /></div><div className="kpi-content"><div className="kpi-label">Total Scheduled</div><div className="kpi-value">{totalTasks}</div></div></div>
        <div className="kpi-card green"><div className="kpi-icon green"><CheckCircle2 size={22} /></div><div className="kpi-content"><div className="kpi-label">Completed</div><div className="kpi-value">{completedTasks}</div></div></div>
        <div className="kpi-card amber"><div className="kpi-icon amber"><Clock size={22} /></div><div className="kpi-content"><div className="kpi-label">Pending</div><div className="kpi-value">{pendingTasks}</div></div></div>
        <div className="kpi-card info"><div className="kpi-icon info"><ArrowRightCircle size={22} /></div><div className="kpi-content"><div className="kpi-label">Carried Forward</div><div className="kpi-value">{carriedForwardTasks}</div></div></div>
        <div className="kpi-card purple"><div className="kpi-icon purple"><TrendingUp size={22} /></div><div className="kpi-content"><div className="kpi-label">Completion Rate</div><div className="kpi-value">{completionRate}%</div></div></div>
      </div>

      {/* Month-by-Month (full-year view only) */}
      {monthlyRollup.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}><div className="card-body">
          <h4 style={{ marginBottom: '16px' }}>Month-by-Month Summary - {selectedYear}</h4>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Month</th><th>Scheduled</th><th>Completed</th><th>Pending</th><th>Carried Forward</th><th>Target Hrs</th><th>Booked Hrs</th><th>Progress</th></tr></thead>
              <tbody>
                {monthlyRollup.map(m => (
                  <tr key={m.month}>
                    <td style={{ fontWeight: 600 }}>{m.month}</td>
                    <td>{m.total}</td>
                    <td><span style={{ color: 'var(--success)', fontWeight: 600 }}>{m.completed}</span></td>
                    <td><span style={{ color: 'var(--warning)', fontWeight: 600 }}>{m.pending}</span></td>
                    <td><span style={{ color: 'var(--info)', fontWeight: 600 }}>{m.carriedForward}</span></td>
                    <td>{fmtHrs(m.targetedHrs)} h</td>
                    <td><span style={{ color: m.bookedHrs > m.targetedHrs ? 'var(--danger)' : 'inherit' }}>{fmtHrs(m.bookedHrs)} h</span></td>
                    <td><ProgressBar value={m.rate} color="var(--primary)" /></td>
                  </tr>
                ))}
                <tr style={{ background: 'var(--primary-bg)', fontWeight: 700 }}>
                  <td style={{ fontWeight: 700 }}>Total</td>
                  <td>{totalTasks}</td>
                  <td>{completedTasks}</td>
                  <td>{pendingTasks}</td>
                  <td>{carriedForwardTasks}</td>
                  <td>{fmtHrs(totalTargetedHrs)} h</td>
                  <td>{fmtHrs(totalBookedHrs)} h</td>
                  <td><ProgressBar value={completionRate} color="var(--primary)" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div></div>
      )}

      {/* Category Breakdown */}
      {categoryBreakdown.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}><div className="card-body">
          <h4 style={{ marginBottom: '16px' }}>Breakdown by Category</h4>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table"><thead><tr><th>Category</th><th>Scheduled</th><th>Completed</th><th>Pending</th><th>Carried Forward</th><th>Target Hrs</th><th>Booked Hrs</th><th>Progress</th></tr></thead>
            <tbody>{categoryBreakdown.map(c => (<tr key={c.name}><td style={{ fontWeight: 600 }}>{c.name}</td><td>{c.total}</td><td><span style={{ color: 'var(--success)', fontWeight: 600 }}>{c.completed}</span></td><td><span style={{ color: 'var(--warning)', fontWeight: 600 }}>{c.pending}</span></td><td><span style={{ color: 'var(--info)', fontWeight: 600 }}>{c.carriedForward}</span></td><td>{fmtHrs(c.targetedHrs)} h</td><td><span style={{ color: c.bookedHrs > c.targetedHrs ? 'var(--danger)' : 'inherit' }}>{fmtHrs(c.bookedHrs)} h</span></td><td><ProgressBar value={c.rate} color="var(--primary)" /></td></tr>))}</tbody>
          </table>
          </div>
        </div></div>
      )}

      {/* Employee Breakdown */}
      {employeeBreakdown.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}><div className="card-body">
          <h4 style={{ marginBottom: '16px' }}>Breakdown by Employee</h4>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table"><thead><tr><th>Employee</th><th>Assigned</th><th>Completed</th><th>Pending</th><th>Carried Forward</th><th>Target Hrs</th><th>Booked Hrs</th><th>Progress</th></tr></thead>
            <tbody>{employeeBreakdown.map(e => (<tr key={e.name}><td><div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, var(--primary), var(--secondary))', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 700, flexShrink: 0 }}>{e.name.charAt(0)}</span><span style={{ fontWeight: 600 }}>{e.name}</span></div></td><td>{e.total}</td><td><span style={{ color: 'var(--success)', fontWeight: 600 }}>{e.completed}</span></td><td><span style={{ color: 'var(--warning)', fontWeight: 600 }}>{e.pending}</span></td><td><span style={{ color: 'var(--info)', fontWeight: 600 }}>{e.carriedForward}</span></td><td>{fmtHrs(e.targetedHrs)} h</td><td><span style={{ color: e.bookedHrs > e.targetedHrs ? 'var(--danger)' : 'inherit' }}>{fmtHrs(e.bookedHrs)} h</span></td><td><ProgressBar value={e.rate} color="var(--secondary)" /></td></tr>))}</tbody>
          </table>
          </div>
        </div></div>
      )}

      {/* Website Breakdown */}
      {websiteBreakdown.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}><div className="card-body">
          <h4 style={{ marginBottom: '16px' }}>{`Breakdown by ${unitLabel}`}</h4>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table"><thead><tr><th>{unitLabel}</th><th>Scheduled</th><th>Completed</th><th>Pending</th><th>Carried Forward</th><th>Target Hrs</th><th>Booked Hrs</th><th>Progress</th></tr></thead>
            <tbody>{websiteBreakdown.map(w => (<tr key={w.name}><td style={{ fontWeight: 600 }}>{w.name}</td><td>{w.total}</td><td><span style={{ color: 'var(--success)', fontWeight: 600 }}>{w.completed}</span></td><td><span style={{ color: 'var(--warning)', fontWeight: 600 }}>{w.pending}</span></td><td><span style={{ color: 'var(--info)', fontWeight: 600 }}>{w.carriedForward}</span></td><td>{fmtHrs(w.targetedHrs)} h</td><td><span style={{ color: w.bookedHrs > w.targetedHrs ? 'var(--danger)' : 'inherit' }}>{fmtHrs(w.bookedHrs)} h</span></td><td><ProgressBar value={w.rate} color="var(--success)" /></td></tr>))}</tbody>
          </table>
          </div>
        </div></div>
      )}

      {/* Completed Tasks Detail */}
      {completedList.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}><div className="card-body">
          <h4 style={{ marginBottom: '16px', color: 'var(--success)' }}>Completed Tasks ({completedList.length})</h4>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table"><thead><tr><th>#</th><th>Task</th><th>Category</th><th>Employee</th><th>{unitLabel}</th><th>Target Hrs</th><th>Booked Hrs</th><th>Completed On</th><th>Proof URL</th></tr></thead>
            <tbody>
              {completedList.map((t, i) => {
                const over = (Number(t.timeTaken) || 0) > (Number(t.targetedTime) || 0) && (Number(t.targetedTime) || 0) > 0;
                return (
                  <tr key={t.id} style={{ background: 'var(--success-bg)' }}><td>{i + 1}</td><td style={{ fontWeight: 600 }}>{t.title}</td><td><span className="badge badge-completed">{t.category}</span></td><td>{t.employeeName}</td><td>{t.websiteName}</td><td style={{ whiteSpace: 'nowrap' }}>{fmtHrs(t.targetedTime)} h</td><td style={{ whiteSpace: 'nowrap', color: over ? 'var(--danger)' : 'inherit', fontWeight: over ? 600 : 400 }}>{fmtHrs(t.timeTaken)} h{over ? ' ⚠' : ''}</td><td style={{ fontSize: '0.82rem' }}>{t.completedDate ? new Date(t.completedDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td><td>{t.completionUrl ? <a href={t.completionUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.82rem' }}>View ↗</a> : '—'}</td></tr>
                );
              })}
              <tr style={{ background: 'var(--primary-bg)', fontWeight: 700 }}>
                <td colSpan={5} style={{ textAlign: 'right', fontWeight: 700 }}>Total</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtHrs(sumTargeted(completedList))} h</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtHrs(sumBooked(completedList))} h</td>
                <td colSpan={2}></td>
              </tr>
            </tbody>
          </table>
          </div>
        </div></div>
      )}

      {/* In-Progress Tasks Detail */}
      {pendingList.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}><div className="card-body">
          <h4 style={{ marginBottom: '16px', color: 'var(--warning)' }}>Pending Tasks ({pendingList.length})</h4>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table"><thead><tr><th>#</th><th>Task</th><th>Category</th><th>Assigned To</th><th>{unitLabel}</th><th>Priority</th><th>Target Hrs</th><th>Booked Hrs</th><th>Status</th></tr></thead>
            <tbody>
              {pendingList.map((t, i) => {
                const over = (Number(t.timeTaken) || 0) > (Number(t.targetedTime) || 0) && (Number(t.targetedTime) || 0) > 0;
                return (
                  <tr key={t.id}><td>{i + 1}</td><td style={{ fontWeight: 600 }}>{t.title}</td><td><span className="badge badge-info">{t.category}</span></td><td>{t.employeeName}</td><td>{t.websiteName}</td><td><span className={`badge badge-${t.priority || 'medium'}`}>{t.priority || 'Medium'}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtHrs(t.targetedTime)} h</td>
                  <td style={{ whiteSpace: 'nowrap', color: over ? 'var(--danger)' : 'inherit', fontWeight: over ? 600 : 400 }}>{fmtHrs(t.timeTaken)} h{over ? ' ⚠' : ''}</td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span className={`badge ${getStatusBadgeClass(t, tasksById)}`}>{getStatusLabel(t, tasksById)}</span>
                      <div style={{ width: '80px', background: 'var(--border)', borderRadius: '4px', height: '5px', overflow: 'hidden' }}>
                        {/* 100% under a resolved "Completed" label, not this row's own
                            (possibly 0%) hours — same reasoning as Tasks Completed's bar. */}
                        <div style={{ width: `${getEffectiveStatus(t, tasksById) === 'completed' ? 100 : getTaskPercent(t)}%`, background: getStatusColor(t, tasksById), height: '100%', transition: 'width 0.3s ease' }}></div>
                      </div>
                    </div>
                  </td></tr>
                );
              })}
              <tr style={{ background: 'var(--primary-bg)', fontWeight: 700 }}>
                <td colSpan={6} style={{ textAlign: 'right', fontWeight: 700 }}>Total</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtHrs(sumTargeted(pendingList))} h</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtHrs(sumBooked(pendingList))} h</td>
                <td></td>
              </tr>
            </tbody>
          </table>
          </div>
        </div></div>
      )}

      {/* Lead Center Enquiries — this reporting period's leads, same columns
          as the Lead Center table itself minus the admin-only selection/
          delete controls. Message is shown in full here (no 2-line clamp) —
          this is a report, not a scannable list, so there is no reason to
          hide anything behind a hover tooltip the way Lead Center itself does. */}
      {enquiriesList.length > 0 && (
        <div className="card" style={{ marginBottom: '20px' }}><div className="card-body">
          <h4 style={{ marginBottom: '16px', color: 'var(--primary)' }}>Lead Center Enquiries ({enquiriesList.length})</h4>
          {/* Same three buckets as Lead Center's own KPI row, so this overview
              and the detail table beneath it can never disagree. */}
          <div className="kpi-grid" style={{ marginBottom: '20px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <div className="kpi-card blue">
              <div className="kpi-icon blue"><Inbox size={20} /></div>
              <div className="kpi-content"><div className="kpi-label">Total Received</div><div className="kpi-value">{enquiryStats.total}</div></div>
            </div>
            <div className="kpi-card green">
              <div className="kpi-icon green"><CheckCircle2 size={20} /></div>
              <div className="kpi-content"><div className="kpi-label">Converted</div><div className="kpi-value">{enquiryStats.converted}</div></div>
            </div>
            <div className="kpi-card red">
              <div className="kpi-icon red"><XCircle size={20} /></div>
              <div className="kpi-content"><div className="kpi-label">Not Converted</div><div className="kpi-value">{enquiryStats.notConverted}</div></div>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table"><thead><tr><th>#</th><th>Name</th><th>Company</th><th>Contact</th><th>Country</th><th>Message</th><th>Status</th><th>Source</th><th>Date</th></tr></thead>
            <tbody>
              {enquiriesList.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{l.name || '—'}</td>
                  <td>{l.company || '—'}</td>
                  <td style={{ fontSize: '0.82rem' }}>
                    {l.email && <div>{l.email}</div>}
                    {l.phone && <div style={{ color: 'var(--text-muted)' }}>{l.phone}</div>}
                    {!l.email && !l.phone && '—'}
                  </td>
                  <td style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}>{getCountryFromPhone(l.phone) || '—'}</td>
                  <td style={{ minWidth: '240px', fontSize: '0.82rem', whiteSpace: 'pre-wrap' }}>{l.message || '—'}</td>
                  <td>
                    {l.converted === 'yes' ? <span className="badge badge-success">Converted</span>
                      : l.converted === 'no' ? <span className="badge badge-danger" title={l.convertedReason || undefined}>Not Converted</span>
                      : <span className="badge badge-pending">Pending Review</span>}
                  </td>
                  <td>
                    {l.sourceUrl ? <a href={l.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.82rem' }}>View ↗</a> : '—'}
                  </td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDate(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div></div>
      )}

      {totalTasks === 0 && enquiriesList.length === 0 && (
        <div className="empty-state"><CalendarDays size={48} /><h4>No data for {monthName}</h4><p>Schedule tasks or wait for enquiries for this {isYearView ? 'year' : 'month'} to see the report</p></div>
      )}
    </div>
  );
}
