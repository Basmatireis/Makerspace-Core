import type { MachineProcess, MaterialType, MaterialUnit, RunMeasures, WorkItemConsumption } from '../../api/generated/models';

/**
 * What each machine process records and how its run form looks. One config drives all run forms: the form
 * shows the measure fields, the ink group and the area helper a process asks for, never a form per process.
 */
export type ProcessConfig = {
  label: string;
  description: string;
  /** Run measures the process records (priced per block). */
  measures: (keyof RunMeasures)[];
  /** One ml field per active ink material of the process (UV printing). */
  inkGroup: boolean;
  /** Width x height x count helper for square-centimetre material (cutting). */
  areaHelper: boolean;
  /** Only FDM printers have a printer setup (profile, spool inputs, connector) and spools. */
  printerSetup: boolean;
};

export const processConfig: Record<MachineProcess, ProcessConfig> = {
  fdm_printing: { label: 'FDM 3D printing', description: 'Filament printers with spools, a printer setup and optional connector; consumption in grams.', measures: [], inkGroup: false, areaHelper: false, printerSetup: true },
  embroidery: { label: 'Embroidery', description: 'Runtime and an exact stitch count, priced per 1000 stitches; stabilizer in metres.', measures: ['stitches'], inkGroup: false, areaHelper: false, printerSetup: false },
  uv_printing: { label: 'UV printing', description: 'Runtime, ink in ml per colour (C, M, Y, K, W) and substrates in cm² or metres.', measures: [], inkGroup: true, areaHelper: false, printerSetup: false },
  laser_cutting: { label: 'Laser cutting', description: 'Mostly time tracking; sheet material in cm², customer material stays free.', measures: [], inkGroup: false, areaHelper: true, printerSetup: false },
  vinyl_cutting: { label: 'Vinyl cutting', description: 'Plotter runtime (0 €/h where not charged) and foil in cm².', measures: [], inkGroup: false, areaHelper: true, printerSetup: false },
  other: { label: 'Other', description: 'Runtime and free material usage.', measures: [], inkGroup: false, areaHelper: false, printerSetup: false },
};

export const processOptions = (Object.keys(processConfig) as MachineProcess[]).map((id) => ({ id, label: processConfig[id].label, description: processConfig[id].description }));

export const isFdm = (process: MachineProcess | undefined | null) => process === 'fdm_printing';

export const measureLabels: Record<keyof RunMeasures, string> = { stitches: 'Stitches' };
/** Rate unit text of a measure rule: "€ per 1000 stitches". */
export const measureRateLabel = (measure: keyof RunMeasures, blockSize: number | null | undefined) => `€ per ${blockSize ?? 1000} ${measure}`;

export const unitText = (unit: MaterialUnit) => (unit === 'm2' ? 'm²' : unit === 'cm2' ? 'cm²' : unit === 'piece' ? 'pcs' : unit);

/** Input step of a quantity in this unit: grams are whole numbers, everything else may be fractional. */
export const quantityStep = (unit: MaterialUnit | undefined) => (unit === undefined || unit === 'g' || unit === 'piece' ? 1 : 0.01);

/** Materials the picker may offer for a machine process: active ones whose type includes the process, plus the one already chosen. */
export function materialsForProcess<M extends { id: string; active: boolean; materialTypeId: string; unit: MaterialUnit }>(
  materials: M[], types: Pick<MaterialType, 'id' | 'processes'>[] | undefined, process: MachineProcess | undefined, keepId?: string, config?: ProcessConfig,
): M[] {
  const processesOf = new Map((types ?? []).map((type) => [type.id, type.processes]));
  return materials.filter((material) => {
    if (material.id === keepId) return true;
    if (!material.active) return false;
    // Without the type list or the machine process the backend decides.
    if (process && types && !(processesOf.get(material.materialTypeId) ?? []).includes(process)) return false;
    // The ink group has its own rows for the ml materials.
    return !(config?.inkGroup && material.unit === 'ml');
  });
}

const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const fixed2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

type ConsumedLine = { materialTypeName: string; unit: MaterialUnit; quantity: string | number };

/** "12,400 stitches · 0.4 m Stabilizer", "3.20 ml UV ink · 180 cm² DTF paper"; FDM shows grams as before. Null when nothing was recorded. */
export function consumptionSummary(materials: ConsumedLine[], measures?: RunMeasures | null): string | null {
  const parts: string[] = [];
  if (measures?.stitches != null) parts.push(`${integer.format(measures.stitches)} stitches`);
  for (const line of materials) {
    const quantity = line.unit === 'ml' ? fixed2.format(Number(line.quantity)) : number.format(Number(line.quantity));
    parts.push(`${quantity} ${unitText(line.unit)} ${line.materialTypeName}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Sums usages per material type and unit. */
export function sumUsages(usages: { materialTypeName: string; unit: MaterialUnit; quantity: string }[]): ConsumedLine[] {
  const totals = new Map<string, ConsumedLine>();
  for (const usage of usages) {
    const key = `${usage.materialTypeName}/${usage.unit}`;
    const current = totals.get(key);
    totals.set(key, { materialTypeName: usage.materialTypeName, unit: usage.unit, quantity: (current ? Number(current.quantity) : 0) + Number(usage.quantity) });
  }
  return [...totals.values()];
}

export const jobConsumption = (job: { measures: RunMeasures; runs: { state: string; usages: { materialTypeName: string; unit: MaterialUnit; quantity: string }[]; measures: RunMeasures }[] }) =>
  consumptionSummary(sumUsages(job.runs.filter((run) => run.state !== 'replaced').flatMap((run) => run.usages)), job.measures);

export const workItemConsumption = (consumption: WorkItemConsumption | undefined) => consumption ? consumptionSummary(consumption.materials, consumption.measures) : null;
