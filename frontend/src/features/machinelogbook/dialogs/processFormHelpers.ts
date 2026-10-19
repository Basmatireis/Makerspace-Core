import type { MachineJobUsage, MachineJobUsageInput, RunMeasures } from '../../../api/generated/models';
import { processConfig } from '../processConfig';
import type { MachineProcess } from '../../../api/generated/models';

/** Process specific parts of a run form: the stitch count and one ml value per UV ink material. */
export type ProcessValues = { stitches: number | ''; ink: Record<string, number | ''> };

export const blankProcessValues = (): ProcessValues => ({ stitches: '', ink: {} });

/** Run measures to send for a process; stitches are whole numbers, empty means not recorded. */
export function toMeasures(values: Pick<ProcessValues, 'stitches'>, process: MachineProcess | undefined): RunMeasures {
  const measures: RunMeasures = {};
  if (process && processConfig[process].measures.includes('stitches') && values.stitches !== '' && Number.isFinite(Number(values.stitches))) {
    measures.stitches = Math.max(0, Math.round(Number(values.stitches)));
  }
  return measures;
}

/** Ink entries become usages with two decimals; empty or zero rows were not used. */
export function inkUsageInputs(ink: ProcessValues['ink']): MachineJobUsageInput[] {
  return Object.entries(ink)
    .filter(([, value]) => value !== '' && Number(value) > 0)
    .map(([materialId, value]) => ({ ownership: 'makerspace', materialId, spoolId: null, externalMaterialName: null, quantity: Number(value).toFixed(2), quantityBasis: 'actual' }));
}

/** Splits existing usages of an ink process into ink values (ml materials) and the remaining usages. */
export function splitInkUsages(usages: MachineJobUsage[], process: MachineProcess | undefined): { ink: ProcessValues['ink']; rest: MachineJobUsage[] } {
  if (!process || !processConfig[process].inkGroup) return { ink: {}, rest: usages };
  const ink: ProcessValues['ink'] = {};
  const rest: MachineJobUsage[] = [];
  for (const usage of usages) {
    if (usage.unit === 'ml' && usage.materialId && usage.ownership === 'makerspace') ink[usage.materialId] = Number(usage.quantity);
    else rest.push(usage);
  }
  return { ink, rest };
}
