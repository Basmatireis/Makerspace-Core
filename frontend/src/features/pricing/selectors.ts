import type {
  MachineType,
  MaterialType,
  MaterialUnit,
  PricingGroup,
  PricingRule,
  RunMeasureKey,
} from '../../api/generated/models';
import { measureLabels, processConfig, unitText } from '../machinelogbook/processConfig';

/** One row of the rates matrix: something that has a price per pricing group. */
export type RateSelector = {
  key: string;
  label: string;
  description: string;
  unit: string;
  kind: PricingRule['kind'];
  machineTypeId?: string;
  materialTypeId?: string;
  measure?: RunMeasureKey;
};

export function rateSelectors(machineTypes: MachineType[], materialTypes: MaterialType[]): RateSelector[] {
  const machines = machineTypes
    .filter((type) => type.active)
    .flatMap((type): RateSelector[] => [
      {
        key: `runtime-${type.id}`,
        label: `${type.name} runtime`,
        description: 'Per hour of machine time',
        unit: '€/h',
        kind: 'machine_runtime',
        machineTypeId: type.id,
      },
      ...processConfig[type.process].measures.map((measure): RateSelector => ({
        key: `measure-${type.id}-${measure}`,
        label: `${type.name} · ${measureLabels[measure]}`,
        description: `Per 1000 ${measure}`,
        unit: `€ per 1000 ${measure}`,
        kind: 'machine_measure',
        machineTypeId: type.id,
        measure: measure as RunMeasureKey,
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
      (rule.machineTypeId ?? undefined) === selector.machineTypeId &&
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
