// Monthly / Full Year switch used by Schedule, Tasks Completed and Monthly
// Report. 'month' uses the month+year picked in the topbar; 'year' widens the
// view to all 12 months of the selected year.
export default function PeriodToggle({ period, onChange, year }) {
  const isYear = period === 'year';
  return (
    <div className="seg" role="group" aria-label="Reporting period">
      <button
        type="button"
        className={`seg-btn ${!isYear ? 'is-active' : ''}`}
        aria-pressed={!isYear}
        onClick={() => onChange('month')}
      >Monthly</button>
      <button
        type="button"
        className={`seg-btn ${isYear ? 'is-active' : ''}`}
        aria-pressed={isYear}
        onClick={() => onChange('year')}
      >Full Year {year}</button>
    </div>
  );
}
