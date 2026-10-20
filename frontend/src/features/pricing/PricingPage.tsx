import {
  Link as CarbonLink,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { materialTypesQuery } from '../machinelogbook/inventoryQueries';
import { machineTypesQuery, pricingQuery } from '../machinelogbook/queries';
import { listOrganizations } from '../../api/generated/organizations/organizations';
import { pricingGaps, rateSelectors } from './selectors';
import { RatesTab } from './RatesTab';
import { RoleMappingTab } from './RoleMappingTab';

const TABS = ['rates', 'roles', 'organizations'] as const;

function OrganizationsTab({ defaultName }: { defaultName: string }) {
  const query = useQuery({
    queryKey: ['organizations', 'pricing-overview'],
    queryFn: () => listOrganizations({ page: 1, pageSize: 100 }),
  });
  return (
    <TableContainer
      title="Organizations"
      description="An organization's pricing group wins over the roles of its members. Change it on the organization's page."
    >
      <Table aria-label="Organizations and their pricing groups">
        <TableHead>
          <TableRow>
            <TableHeader>Organization</TableHeader>
            <TableHeader className="mj-hide-narrow">Kind</TableHeader>
            <TableHeader>Pricing group</TableHeader>
            <TableHeader>Status</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {query.isPending && (
            <TableRow>
              <TableCell colSpan={4}>Loading…</TableCell>
            </TableRow>
          )}
          {query.isError && (
            <TableRow>
              <TableCell colSpan={4}>The organizations could not be loaded.</TableCell>
            </TableRow>
          )}
          {query.data?.items.map((organization) => (
            <TableRow key={organization.id}>
              <TableCell>
                <CarbonLink as={Link} to={`/organizations/${organization.id}`}>
                  {organization.name}
                </CarbonLink>
              </TableCell>
              <TableCell className="mj-hide-narrow">{organization.kind}</TableCell>
              <TableCell>
                {organization.pricingGroup?.name ?? <span className="mj-secondary">Default ({defaultName})</span>}
              </TableCell>
              <TableCell>
                <Tag type={organization.active ? 'green' : 'warm-gray'} size="sm">
                  {organization.active ? 'Active' : 'Inactive'}
                </Tag>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function PricingPage() {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const canMachines = hasPermission(user, PermissionId.machinesread);
  const canInventory = hasPermission(user, PermissionId.inventoryread);
  const canEdit = hasPermission(user, PermissionId.pricingmanage);
  const canOrganizations = hasPermission(user, PermissionId.organizationsread);
  const pricing = useQuery(pricingQuery());
  const machineTypes = useQuery({ ...machineTypesQuery(), enabled: canMachines });
  const materialTypes = useQuery({ ...materialTypesQuery(), enabled: canInventory });
  const tabs = TABS.filter((id) => id !== 'organizations' || canOrganizations);
  const tab = Math.max(0, tabs.indexOf((params.get('tab') ?? 'rates') as (typeof TABS)[number]));
  const groups = pricing.data?.items ?? [];
  const selectors = rateSelectors(machineTypes.data?.items ?? [], materialTypes.data ?? []);
  const gaps = pricingGaps(groups, selectors).length;
  const defaultName = groups.find((group) => group.isDefault)?.name ?? 'none';
  return (
    <PageShell
      className="sales-page"
      title="Pricing"
      description="Rates per pricing group, which group prices which role, and the organizations' groups."
      width="wide"
      breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Pricing' }]}
    >
      {pricing.isPending ? (
        <FullPageLoading label="Loading pricing" />
      ) : pricing.isError ? (
        <ErrorState message="The pricing could not be loaded." onRetry={() => pricing.refetch()} />
      ) : (
        <Tabs
          selectedIndex={tab}
          onChange={({ selectedIndex }) =>
            setParams(selectedIndex === 0 ? {} : { tab: tabs[selectedIndex] }, { replace: true })
          }
        >
          <TabList aria-label="Pricing sections" contained>
            <Tab>
              Groups &amp; rates
              {gaps > 0 && (
                <Tag type="red" size="sm" className="sales-tab-count">
                  {gaps}
                </Tag>
              )}
            </Tab>
            <Tab>Role mapping</Tab>
            {canOrganizations && <Tab>Organizations</Tab>}
          </TabList>
          <TabPanels>
            <TabPanel className="sales-tab-panel">
              <RatesTab
                groups={groups}
                selectors={selectors}
                canEdit={canEdit}
                partial={!canMachines || !canInventory}
              />
            </TabPanel>
            <TabPanel className="sales-tab-panel">
              <RoleMappingTab groups={groups} canEdit={canEdit} />
            </TabPanel>
            {canOrganizations && (
              <TabPanel className="sales-tab-panel">
                <OrganizationsTab defaultName={defaultName} />
              </TabPanel>
            )}
          </TabPanels>
        </Tabs>
      )}
    </PageShell>
  );
}
