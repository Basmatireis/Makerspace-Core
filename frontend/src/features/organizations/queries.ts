import { queryOptions } from '@tanstack/react-query';
import {
  getOrganization,
  getOrganizationInvoicingRequirements,
  listOrganizationMembers,
  listOrganizations,
  searchBillingParties,
} from '../../api/generated/organizations/organizations';
import type { ListOrganizationsParams } from '../../api/generated/models';

export const organizationKeys = {
  all: ['organizations'] as const,
  list: (params: ListOrganizationsParams) => [...organizationKeys.all, 'list', params] as const,
  detail: (id: string) => [...organizationKeys.all, 'detail', id] as const,
  members: (id: string) => [...organizationKeys.all, 'members', id] as const,
  requirements: (id: string) => [...organizationKeys.all, 'requirements', id] as const,
  people: (search: string) => [...organizationKeys.all, 'people', search] as const,
};

export const organizationsQuery = (params: ListOrganizationsParams) => queryOptions({
  queryKey: organizationKeys.list(params),
  queryFn: ({ signal }) => listOrganizations(params, { signal }),
});
export const organizationQuery = (id: string) => queryOptions({
  queryKey: organizationKeys.detail(id),
  queryFn: ({ signal }) => getOrganization(id, { signal }),
});
export const organizationMembersQuery = (id: string) => queryOptions({
  queryKey: organizationKeys.members(id),
  queryFn: ({ signal }) => listOrganizationMembers(id, { signal }),
});
/** Needs `orders.read`; the purchase-order flag belongs to the invoicing side of the organization. */
export const organizationRequirementsQuery = (id: string) => queryOptions({
  queryKey: organizationKeys.requirements(id),
  queryFn: ({ signal }) => getOrganizationInvoicingRequirements(id, { signal }),
});
/** People matching a name, for the member picker. Organizations in the result are ignored by the caller. */
export const memberCandidatesQuery = (search: string) => queryOptions({
  queryKey: organizationKeys.people(search),
  queryFn: ({ signal }) => searchBillingParties({ search, limit: 25 }, { signal }),
});
