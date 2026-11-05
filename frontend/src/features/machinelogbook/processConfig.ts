import { unitSymbol as unitText } from './units';
import type {
  MaterialType,
  Process,
  ProcessIntegration,
  ProcessMeasure,
  MaterialUnit,
  RunMeasures,
  WorkItemConsumption,
} from '../../api/generated/models';

export const integrationLabel = (integration: ProcessIntegration) =>
  integration === 'fdm_printer' ? '3D printer (FDM)' : 'None';

/** Only processes integrated as an FDM printer have a printer setup (profile, spool inputs, connector) and spools. */
export const isFdm = (process: Pick<Process, 'integration'> | undefined | null) =>
  process?.integration === 'fdm_printer';

/** "Stitches · per 1000 stitch": the measure as a tag or option text. */
export const measureText = (measure: Pick<ProcessMeasure, 'label' | 'unit' | 'blockSize'>) =>
  `${measure.label} · per ${measure.blockSize} ${measure.unit}`;

/** Rate unit text of a measure rule: "€ per 1000 stitch". */
export const measureRateLabel = (measure: Pick<ProcessMeasure, 'unit' | 'blockSize'>) =>
  `€ per ${measure.blockSize} ${measure.unit}`;

/** Reading text of a measure key where no process definition is at hand: "thread_length" becomes "thread length". */
const keyText = (key: string) => key.replace(/_/g, ' ');

export { unitSymbol as unitText } from './units';

/** Materials the picker may offer for a machine's process: active ones whose type includes the process, plus the one already chosen. */
export function materialsForProcess<
  M extends { id: string; active: boolean; materialTypeId: string; unit: MaterialUnit },
>(
  materials: M[],
  types: Pick<MaterialType, 'id' | 'processIds'>[] | undefined,
  process: Pick<Process, 'id'> | undefined,
  keepId?: string,
): M[] {
  const processesOf = new Map((types ?? []).map((type) => [type.id, type.processIds]));
  return materials.filter((material) => {
    if (material.id === keepId) return true;
    if (!material.active) return false;
    // Without the type list or the machine process the backend decides.
    if (process && types && !(processesOf.get(material.materialTypeId) ?? []).includes(process.id)) return false;
    return true;
  });
}

const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const fixed2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

type ConsumedLine = { materialTypeName: string; unit: MaterialUnit; quantity: string | number };

/** "12,400 stitches · 0.4 m Stabilizer", "3.20 ml UV ink · 180 cm² DTF paper"; FDM shows grams as before. Null when nothing was recorded. */
export function consumptionSummary(materials: ConsumedLine[], measures?: RunMeasures | null): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(measures ?? {})) parts.push(`${integer.format(value)} ${keyText(key)}`);
  for (const line of materials) {
    const quantity = line.unit === 'ml' ? fixed2.format(Number(line.quantity)) : number.format(Number(line.quantity));
    parts.push(`${quantity} ${unitText(line.unit)} ${line.materialTypeName}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Sums usages per material type and unit. */
export function sumUsages(
  usages: { materialTypeName: string; unit: MaterialUnit; quantity: string }[],
): ConsumedLine[] {
  const totals = new Map<string, ConsumedLine>();
  for (const usage of usages) {
    const key = `${usage.materialTypeName}/${usage.unit}`;
    const current = totals.get(key);
    totals.set(key, {
      materialTypeName: usage.materialTypeName,
      unit: usage.unit,
      quantity: (current ? Number(current.quantity) : 0) + Number(usage.quantity),
    });
  }
  return [...totals.values()];
}

export const jobConsumption = (job: {
  measures: RunMeasures;
  runs: {
    state: string;
    usages: { materialTypeName: string; unit: MaterialUnit; quantity: string }[];
    measures: RunMeasures;
  }[];
}) =>
  consumptionSummary(
    sumUsages(job.runs.filter((run) => run.state !== 'replaced').flatMap((run) => run.usages)),
    job.measures,
  );

export const workItemConsumption = (consumption: WorkItemConsumption | undefined) =>
  consumption ? consumptionSummary(consumption.materials, consumption.measures) : null;
