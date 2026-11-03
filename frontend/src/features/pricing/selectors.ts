import type {
  Material,
  MaterialPrice,
  MaterialType,
  MaterialUnit,
  PricingGroup,
  PricingRule,
  Process,
  RunMeasureKey,
} from '../../api/generated/models';
import { measureRateLabel, unitText } from '../machinelogbook/processConfig';

export type RateSection = 'machine' | 'measure' | 'material' | 'article';

/** The groups of rows of the rates table, in order. */
export const RATE_SECTIONS: { id: RateSection; title: string }[] = [
  { id: 'machine', title: 'Machine time · per hour' },
  { id: 'measure', title: 'Measures · per block' },
  { id: 'material', title: 'Materials used on machines · per unit' },
  { id: 'article', title: 'Articles sold from stock · per unit' },
];

/** One row of the rates matrix: something that has a price per pricing group. */
export type RateSelector = {
  key: string;
  section: RateSection;
  label: string;
  description: string;
  unit: string;
  kind: PricingRule['kind'];
  processId?: string;
  materialTypeId?: string;
  materialId?: string;
  measure?: RunMeasureKey;
  /** Articles only: the prices the article has now, per group (own price or the rate of its machine-use type). */
  prices?: MaterialPrice[];
};

export function rateSelectors(
  processes: Process[],
  materialTypes: MaterialType[],
  articles: Material[] = [],
): RateSelector[] {
  const machines = processes
    .filter((process) => process.active)
    .flatMap((process): RateSelector[] => [
      {
        key: `runtime-${process.id}`,
        section: 'machine',
        label: `${process.name} runtime`,
        description: 'Per hour of machine time',
        unit: '€/h',
        kind: 'machine_runtime',
        processId: process.id,
      },
      ...process.measures.map((measure): RateSelector => ({
        key: `measure-${process.id}-${measure.key}`,
        section: 'measure',
        label: `${process.name} · ${measure.label}`,
        description: `Per block of ${measure.blockSize} ${measure.unit}`,
        unit: measureRateLabel(measure),
        kind: 'machine_measure',
        processId: process.id,
        measure: measure.key,
      })),
    ]);
  // Material rates price what machines use; types without machine use are sold only as articles.
  const materials = materialTypes
    .filter((type) => type.active && type.machineUse)
    .map((type): RateSelector => ({
      key: `material-${type.id}`,
      section: 'material',
      label: type.name,
      description: `Per ${unitText(type.unit as MaterialUnit)} of material`,
      unit: `€/${unitText(type.unit as MaterialUnit)}`,
      kind: 'material',
      materialTypeId: type.id,
    }));
  const stock = articles
    .filter((article) => article.active)
    .sort((a, b) => a.displayId.localeCompare(b.displayId, 'en', { numeric: true }))
    .map((article): RateSelector => ({
      key: `article-${article.id}`,
      section: 'article',
      label: `${article.displayId} · ${article.name}`,
      description: `${article.materialTypeName} · per ${unitText(article.unit)}`,
      unit: `€/${unitText(article.unit)}`,
      kind: 'stock_article',
      materialId: article.id,
      prices: article.prices ?? [],
    }));
  return [...machines, ...materials, ...stock];
}

/** The active rule of a group for a selector. */
export const ruleOf = (group: PricingGroup, selector: RateSelector): PricingRule | undefined =>
  group.rules.find(
    (rule) =>
      rule.active &&
      rule.kind === selector.kind &&
      (rule.processId ?? undefined) === selector.processId &&
      (rule.materialTypeId ?? undefined) === selector.materialTypeId &&
      (rule.materialId ?? undefined) === selector.materialId &&
      (rule.measure ?? undefined) === selector.measure,
  );

/** The rate of an article's machine-use type that prices it in a group while it has no price of its own. */
export const fallbackOf = (group: PricingGroup, selector: RateSelector): MaterialPrice | undefined =>
  selector.prices?.find((price) => price.pricingGroupId === group.id && price.source === 'material_type');

/** Active groups that lack a rate for a selector. Articles are not gaps: without a price they are not sold. */
export const pricingGaps = (groups: PricingGroup[], selectors: RateSelector[]) =>
  groups
    .filter((group) => group.active)
    .flatMap((group) =>
      selectors
        .filter((selector) => selector.section !== 'article' && !ruleOf(group, selector))
        .map((selector) => ({ group, selector })),
    );
