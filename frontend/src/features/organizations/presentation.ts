import type { OrganizationKind } from '../../api/generated/models';

export const organizationKindLabels: Record<OrganizationKind, string> = {
  company: 'Company',
  institute: 'Institute',
  association: 'Association',
  other: 'Other',
};

export const organizationKinds = Object.keys(organizationKindLabels) as OrganizationKind[];

export const organizationPaths = {
  list: () => '/organizations',
  detail: (id: string) => `/organizations/${encodeURIComponent(id)}`,
};
