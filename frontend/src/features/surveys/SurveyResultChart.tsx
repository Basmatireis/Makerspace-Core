import { ScaleTypes, SimpleBarChart } from '../../app/charting';

export type ChartRow = { label: string; value: number };

/** Carbon Charts live behind React.lazy: this module is the only survey file that imports them. */
export default function SurveyResultChart({
  title,
  rows,
  valueHeader,
}: {
  title: string;
  rows: ChartRow[];
  valueHeader: string;
}) {
  return (
    <>
      <SimpleBarChart
        data={rows.map((row) => ({ group: valueHeader, key: row.label, value: row.value }))}
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
            <th scope="col">Answer</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
