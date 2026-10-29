import type { PrivacyCategory } from '../../api/generated/models';

/** The area of the app a category belongs to, as the table shows it. */
export function moduleLabel(id: string): string {
  const text = id.replace(/[_-]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who a category is about, as the "Belongs to" column labels it. */
export const subjectLabels: Record<PrivacyCategory['subject'], string> = {
  person: 'A person',
  account: 'An account',
  none: 'No person',
};

export type Filters = { subjects: string[]; statuses: string[]; areas: string[]; special: string[] };
export const noFilters: Filters = { subjects: [], statuses: [], areas: [], special: [] };

/** The search covers the texts of the category, the area label and the "Belongs to" label the table shows. */
export function matches(category: PrivacyCategory, search: string, filters: Filters): boolean {
  const needle = search.trim().toLowerCase();
  if (
    needle !== '' &&
    ![
      category.id,
      category.name,
      category.description,
      category.contains,
      ...category.fields,
      moduleLabel(category.ownerModuleId),
      subjectLabels[category.subject],
    ].some((text) => text.toLowerCase().includes(needle))
  ) {
    return false;
  }
  if (filters.subjects.length > 0 && !filters.subjects.includes(category.subject)) return false;
  if (filters.statuses.length > 0 && !filters.statuses.includes(category.coverage.policyStatus)) return false;
  if (filters.areas.length > 0 && !filters.areas.includes(category.ownerModuleId)) return false;
  if (filters.special.includes('hold') && !category.coverage.hold) return false;
  if (filters.special.includes('orphaned') && !category.orphaned) return false;
  return true;
}
