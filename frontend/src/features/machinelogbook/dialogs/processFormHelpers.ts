import type { ProcessMeasure, RunMeasures } from '../../../api/generated/models';
import { decimalNumber } from '../../../app/decimalInput';

/** Typed text of the counted measures of a run form, keyed by the measure keys of the machine's process. */
export type MeasureValues = Record<string, string>;

/** The form text of recorded measures; measures the process defines but the run lacks start empty. */
export const measureValuesFrom = (definitions: ProcessMeasure[], recorded: RunMeasures = {}): MeasureValues =>
  Object.fromEntries(definitions.map(({ key }) => [key, recorded[key] == null ? '' : String(recorded[key])]));

/** Run measures to send: whole numbers of the measures the process defines; empty means not recorded. */
export function toMeasures(values: MeasureValues | undefined, definitions: ProcessMeasure[]): RunMeasures {
  const measures: RunMeasures = {};
  for (const { key } of definitions) {
    const value = decimalNumber(values?.[key] ?? '', { integer: true });
    if (value !== null) measures[key] = value;
  }
  return measures;
}
