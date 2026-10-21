import { Tile } from '@carbon/react';
import type { PersonalJobMonth } from '../../api/generated/models';
import { ScaleTypes, SimpleBarChart } from '../../app/charting';

const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const monthLabel = (month: string) => monthFormat.format(new Date(`${month}-01T00:00:00Z`));

/** Carbon Charts live behind React.lazy: this module is the only dashboard file that imports them. */
export default function JobsChart({ months }: { months: PersonalJobMonth[] }) {
  const title = 'Your jobs per month';
  const rows = months.map((month) => ({ label: monthLabel(month.month), jobs: month.jobs }));
  return (
    <Tile className="db-chart">
      <h3 className="db-tile__eyebrow">{title}</h3>
      <SimpleBarChart
        data={rows.map((row) => ({ group: 'Jobs', key: row.label, value: row.jobs }))}
        options={{
          title: '',
          axes: {
            left: { mapsTo: 'value', scaleType: ScaleTypes.LINEAR },
            bottom: { mapsTo: 'key', scaleType: ScaleTypes.LABELS },
          },
          height: '240px',
          legend: { enabled: false },
          toolbar: { enabled: false },
          accessibility: { svgAriaLabel: title },
        }}
      />
      <table className="cds--visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Jobs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.jobs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Tile>
  );
}
