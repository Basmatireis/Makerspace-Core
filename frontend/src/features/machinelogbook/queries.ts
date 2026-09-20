import { queryOptions } from '@tanstack/react-query';
import { getMachineLogbookOverview, getMachineLogbookStatistics } from '../../api/generated/machine-logbook/machine-logbook';
import { getMachineJob, listMachineJobReviewQueue, listMachineJobs, searchMachineJobOperators } from '../../api/generated/machine-jobs/machine-jobs';
import { listMachineTypes, listMachines } from '../../api/generated/machines/machines';
import { getMaterial, listMaterials, listMaterialTransactions } from '../../api/generated/inventory/inventory';
import { listOrganizations, searchBillingParties } from '../../api/generated/organizations/organizations';
import { listPricingGroups } from '../../api/generated/pricing/pricing';
import type { GetMachineLogbookStatisticsParams, ListMachineJobsParams, ListMachinesParams, ListMaterialsParams, ListOrganizationsParams } from '../../api/generated/models';

export const machineLogbookKeys = {
  all: ['machine-logbook'] as const,
  overview: () => [...machineLogbookKeys.all, 'overview'] as const,
  jobs: (params: ListMachineJobsParams) => [...machineLogbookKeys.all, 'jobs', params] as const,
  job: (id: string) => [...machineLogbookKeys.all, 'job', id] as const,
  review: () => [...machineLogbookKeys.all, 'review'] as const,
  machines: (params: ListMachinesParams) => [...machineLogbookKeys.all, 'machines', params] as const,
  machineTypes: () => [...machineLogbookKeys.all, 'machine-types'] as const,
  materials: (params: ListMaterialsParams) => [...machineLogbookKeys.all, 'materials', params] as const,
  material: (id: string) => [...machineLogbookKeys.all, 'material', id] as const,
  transactions: (id: string, page: number) => [...machineLogbookKeys.all, 'transactions', id, page] as const,
  organizations: (params: ListOrganizationsParams) => [...machineLogbookKeys.all, 'organizations', params] as const,
  pricing: () => [...machineLogbookKeys.all, 'pricing'] as const,
  statistics: (params: GetMachineLogbookStatisticsParams) => [...machineLogbookKeys.all, 'statistics', params] as const,
};

export const overviewQuery = () => queryOptions({ queryKey: machineLogbookKeys.overview(), queryFn: () => getMachineLogbookOverview() });
export const jobsQuery = (params: ListMachineJobsParams) => queryOptions({ queryKey: machineLogbookKeys.jobs(params), queryFn: () => listMachineJobs(params) });
export const jobQuery = (id: string) => queryOptions({ queryKey: machineLogbookKeys.job(id), queryFn: () => getMachineJob(id) });
export const reviewQuery = () => queryOptions({ queryKey: machineLogbookKeys.review(), queryFn: () => listMachineJobReviewQueue() });
export const machinesQuery = (params: ListMachinesParams) => queryOptions({ queryKey: machineLogbookKeys.machines(params), queryFn: () => listMachines(params) });
export const machineTypesQuery = () => queryOptions({ queryKey: machineLogbookKeys.machineTypes(), queryFn: () => listMachineTypes() });
export const materialsQuery = (params: ListMaterialsParams) => queryOptions({ queryKey: machineLogbookKeys.materials(params), queryFn: () => listMaterials(params) });
export const materialQuery = (id: string) => queryOptions({ queryKey: machineLogbookKeys.material(id), queryFn: () => getMaterial(id) });
export const transactionsQuery = (id: string, page: number) => queryOptions({ queryKey: machineLogbookKeys.transactions(id, page), queryFn: () => listMaterialTransactions(id, { page, pageSize: 25 }) });
export const organizationsQuery = (params: ListOrganizationsParams) => queryOptions({ queryKey: machineLogbookKeys.organizations(params), queryFn: () => listOrganizations(params) });
export const pricingQuery = () => queryOptions({ queryKey: machineLogbookKeys.pricing(), queryFn: () => listPricingGroups() });
export const statisticsQuery = (params: GetMachineLogbookStatisticsParams) => queryOptions({ queryKey: machineLogbookKeys.statistics(params), queryFn: () => getMachineLogbookStatistics(params) });
export const billingPartySearchQuery = (search: string) => queryOptions({ queryKey: [...machineLogbookKeys.all, 'billing-parties', search], queryFn: () => searchBillingParties({ search, limit: 25 }) });
export const operatorSearchQuery = (search: string) => queryOptions({ queryKey: [...machineLogbookKeys.all, 'operators', search], queryFn: () => searchMachineJobOperators({ search, limit: 25 }) });
