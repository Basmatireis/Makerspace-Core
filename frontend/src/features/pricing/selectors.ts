import type {
  MaterialType,
  MaterialUnit,
  PricingGroup,
  PricingRule,
  Process,
  RunMeasureKey,
} from '../../api/generated/models';
import { measureRateLabel, unitText } from '../machinelogbook/processConfig';

/** One row of the rates matrix: something that has a price per pricing group. */
export type RateSelector = {
  key: string;
  label: string;
  description: string;
  unit: string;
  kind: PricingRule['kind'];
  processId?: string;
  materialTypeId?: string;
  measure?: RunMeasureKey;
};

export function rateSelectors(processes: Process[], materialTypes: MaterialType[]): RateSelector[] {
  const machines = processes
    .filter((process) => process.active)
    .flatMap((process): RateSelector[] => [
      {
        key: `runtime-${process.id}`,
        label: `${process.name} runtime`,
        description: 'Per hour of machine time',
        unit: '€/h',
        kind: 'machine_runtime',
        processId: process.id,
      },
      ...process.measures.map((measure): RateSelector => ({
        key: `measure-${process.id}-${measure.key}`,
        label: `${process.name} · ${measure.label}`,
        description: `Per block of ${measure.blockSize} ${measure.unit}`,
        unit: measureRateLabel(measure),
        kind: 'machine_measure',
        processId: process.id,
        measure: measure.key,
      })),
    ]);
  const materials = materialTypes
    .filter((type) => type.active)
    .map((type): RateSelector => ({
      key: `material-${type.id}`,
      label: type.name,
      description: `Per ${unitText(type.unit as MaterialUnit)} of material`,
      unit: `€/${unitText(type.unit as MaterialUnit)}`,
      kind: 'material',
      materialTypeId: type.id,
    }));
  return [...machines, ...materials];
}

/** The active rule of a group for a selector. */
export const ruleOf = (group: PricingGroup, selector: RateSelector): PricingRule | undefined =>
  group.rules.find(
    (rule) =>
      rule.active &&
      rule.kind === selector.kind &&
      (rule.processId ?? undefined) === selector.processId &&
      (rule.materialTypeId ?? undefined) === selector.materialTypeId &&
      (rule.measure ?? undefined) === selector.measure,
  );

/** Active groups that lack a rate for a selector. */
export const pricingGaps = (groups: PricingGroup[], selectors: RateSelector[]) =>
  groups
    .filter((group) => group.active)
    .flatMap((group) =>
      selectors.filter((selector) => !ruleOf(group, selector)).map((selector) => ({ group, selector })),
    );
