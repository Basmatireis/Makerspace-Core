import { MultiSelect, Tile } from '@carbon/react';
import { LineChart, ScaleTypes, SimpleBarChart } from '../../../app/charting';
import { formatMoney } from '../shared/format';

export type Granularity = 'week' | 'month';
export type MonthPoint = { month: string; label: string; charges: number; materialCost: number; losses: number };
export type LabelledValue = { label: string; value: number };
/** Runtime hours per machine for one week or month of the period. */
export type RuntimeBucket = { key: string; label: string; hoursByMachine: Record<string, number> };

export type RuntimeMachine = { id: string; name: string; runtimeHours: number };

export type StatisticsChartsData = {
  months: MonthPoint[];
  granularity: Granularity;
  runtime: RuntimeBucket[];
  machines: RuntimeMachine[];
  selectedMachineIds: string[];
  onSelectMachines: (ids: string[]) => void;
  materialByType: LabelledValue[];
};

/** Runtime per selected machine over the weeks or months of the period, for comparing machines. */
function RuntimeTile({ data }: { data: StatisticsChartsData }) {
  const selected = data.machines.filter((machine) => data.selectedMachineIds.includes(machine.id));
  const lineData = selected.flatMap((machine) =>
    data.runtime.map((bucket) => ({
      group: machine.name,
      key: bucket.label,
      value: Math.round((bucket.hoursByMachine[machine.id] ?? 0) * 10) / 10,
    })),
  );
  const unit = data.granularity === 'week' ? 'week' : 'month';
  return (
    <Tile className="mj-stats-chart mj-stats-chart--wide">
      <div className="mj-stats-chart__heading">
        <h2 className="mj-stats-chart__title">Machine runtime per {unit} (hours)</h2>
        <MultiSelect
          id="stats-runtime-machines"
          className="mj-stats-chart__picker"
          titleText="Machines"
          label={selected.length ? `${selected.length} selected` : 'Select machines'}
          size="md"
          autoAlign
          items={data.machines}
          itemToString={(machine) => machine?.name ?? ''}
          sortItems={(items) => [...items]}
          selectedItems={selected}
          onChange={({ selectedItems }) => data.onSelectMachines((selectedItems ?? []).map((machine) => machine.id))}
        />
      </div>
      {selected.length === 0 ? (
        <p className="mj-secondary mj-stats-chart__empty">Select one or more machines to compare their runtime.</p>
      ) : (
        <>
          <LineChart
            data={lineData}
            options={{
              ...baseOptions(`Runtime in hours per ${unit} for ${selected.map((machine) => machine.name).join(', ')}`),
              legend: { enabled: true },
              curve: 'curveMonotoneX' as const,
            }}
          />
          <div className="visually-hidden">
            <table>
              <caption>Machine runtime in hours per {unit}</caption>
              <thead>
                <tr>
                  <th scope="col">{unit === 'week' ? 'Week' : 'Month'}</th>
                  {selected.map((machine) => (
                    <th key={machine.id} scope="col">
                      {machine.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.runtime.map((bucket) => (
                  <tr key={bucket.key}>
                    <td>{bucket.label}</td>
                    {selected.map((machine) => (
                      <td key={machine.id}>{number(bucket.hoursByMachine[machine.id] ?? 0, 1)} h</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Tile>
  );
}

const number = (value: number, digits = 0) =>
  new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(value);

const baseOptions = (label: string) => ({
  title: '',
  axes: {
    left: { mapsTo: 'value', scaleType: ScaleTypes.LINEAR },
    bottom: { mapsTo: 'key', scaleType: ScaleTypes.LABELS },
  },
  height: '280px',
  legend: { enabled: false },
  toolbar: { enabled: false },
  accessibility: { svgAriaLabel: label },
});

function BarTile({
  id,
  title,
  label,
  points,
  format,
  valueHeader,
}: {
  id: string;
  title: string;
  label: string;
  points: LabelledValue[];
  format: (value: number) => string;
  valueHeader: string;
}) {
  const data = points.map((point) => ({ group: title, key: point.label, value: Math.round(point.value * 100) / 100 }));
  return (
    <Tile className="mj-stats-chart">
      <h2 id={id} className="mj-stats-chart__title">
        {title}
      </h2>
      <SimpleBarChart data={data} options={baseOptions(label)} />
      <div className="visually-hidden">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Material type</th>
              <th scope="col">{valueHeader}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.label}>
                <td>{point.label}</td>
                <td>{format(point.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tile>
  );
}

/** Carbon Charts live behind React.lazy: this module is the only place that imports them. */
export default function StatisticsCharts({ data }: { data: StatisticsChartsData }) {
  const { months } = data;
  const lineData = [
    ...months.map((point) => ({
      group: 'Recipient charges',
      key: point.label,
      value: Math.round(point.charges * 100) / 100,
    })),
    ...months.map((point) => ({
      group: 'Material cost',
      key: point.label,
      value: Math.round(point.materialCost * 100) / 100,
    })),
  ];
  const lineOptions = {
    ...baseOptions('Monthly recipient charges and material cost in euro'),
    legend: { enabled: true },
    curve: 'curveMonotoneX' as const,
  };
  return (
    <div className="mj-stats-charts">
      <Tile className="mj-stats-chart mj-stats-chart--wide">
        <h2 className="mj-stats-chart__title">Charges vs. material cost (€)</h2>
        <LineChart data={lineData} options={lineOptions} />
        <div className="visually-hidden">
          <table>
            <caption>Monthly recipient charges versus material cost</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Recipient charges</th>
                <th scope="col">Material cost</th>
              </tr>
            </thead>
            <tbody>
              {months.map((point) => (
                <tr key={point.month}>
                  <td>{point.label}</td>
                  <td>{formatMoney(point.charges)}</td>
                  <td>{formatMoney(point.materialCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
      <RuntimeTile data={data} />
      <BarTile
        id="stats-material"
        title="Material cost by material type (€)"
        label="Material cost in euro per material type"
        points={data.materialByType}
        format={formatMoney}
        valueHeader="Material cost"
      />
      <BarTile
        id="stats-losses"
        title="Losses from corrections and disposal (€)"
        label="Monthly losses from corrections and disposal in euro"
        points={months.map((point) => ({ label: point.label, value: point.losses }))}
        format={formatMoney}
        valueHeader="Loss"
      />
    </div>
  );
}
