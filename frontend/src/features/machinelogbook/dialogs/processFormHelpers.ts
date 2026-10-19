import type { MachineJobUsage, MachineJobUsageInput, RunMeasures } from '../../../api/generated/models';
import { decimalNumber, decimalText } from '../../../app/decimalInput';
import { processConfig } from '../processConfig';
import type { MachineProcess } from '../../../api/generated/models';

/** Process specific parts of a run form: the stitch count and one ml value per UV ink material. */
export type ProcessValues = { stitches: string; ink: Record<string, string> };

export const blankProcessValues = (): ProcessValues => ({ stitches: '', ink: {} });

/** Run measures to send for a process; stitches are whole numbers, empty means not recorded. */
export function toMeasures(values: Pick<ProcessValues, 'stitches'>, process: MachineProcess | undefined): RunMeasures {
  const measures: RunMeasures = {};
  const stitches = decimalNumber(values.stitches, { integer: true });
  if (process && processConfig[process].measures.includes('stitches') && stitches !== null) measures.stitches = stitches;
  return measures;
}

/** Ink entries become usages with two decimals; empty or zero rows were not used. */
export function inkUsageInputs(ink: ProcessValues['ink']): MachineJobUsageInput[] {
  return Object.entries(ink)
    .map(([materialId, value]) => [materialId, decimalNumber(value, { places: 2 })] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null && entry[1] > 0)
    .map(([materialId, value]) => ({ ownership: 'makerspace', materialId, spoolId: null, externalMaterialName: null, quantity: value.toFixed(2), quantityBasis: 'actual' }));
}

/** Splits existing usages of an ink process into ink values (ml materials) and the remaining usages. */
export function splitInkUsages(usages: MachineJobUsage[], process: MachineProcess | undefined): { ink: ProcessValues['ink']; rest: MachineJobUsage[] } {
  if (!process || !processConfig[process].inkGroup) return { ink: {}, rest: usages };
  const ink: ProcessValues['ink'] = {};
  const rest: MachineJobUsage[] = [];
  for (const usage of usages) {
    if (usage.unit === 'ml' && usage.materialId && usage.ownership === 'makerspace') ink[usage.materialId] = decimalText(usage.quantity);
    else rest.push(usage);
  }
  return { ink, rest };
}
