export type FilterOption = { id: string; label: string };
export type FilterGroup<K extends string> = { key: K; label: string; options: FilterOption[] };
export type FilterSelection<K extends string> = Partial<Record<K, string[]>>;

/** How many options are chosen across all categories. */
export function countFilterChoices<K extends string>(values: FilterSelection<K>): number {
  return Object.values<string[] | undefined>(values).reduce((sum, chosen) => sum + (chosen?.length ?? 0), 0);
}
