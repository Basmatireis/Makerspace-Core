import { Tab, TabList, TabPanel, TabPanels, Tabs, Tag } from '@carbon/react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Machine } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';

export function MachinePageShell({ machine, printer = false, actions, children }: { machine: Machine; printer?: boolean; actions?: ReactNode; children: ReactNode }) {
  const navigate = useNavigate();
  return <Tabs selectedIndex={printer ? 1 : 0} onChange={({ selectedIndex }) => navigate(`/machine-logbook/machines/${machine.id}${selectedIndex === 1 ? '/printer' : ''}`)}><PageShell title={machine.name} titleAdornment={<Tag type={machine.status === 'active' ? 'green' : 'gray'}>{machine.status}</Tag>} description={machine.machineType.name} breadcrumbs={[{ label: 'Machines', to: '/machine-logbook/machines' }, { label: machine.name }]} actions={actions} tabs={<TabList aria-label="Machine sections"><Tab>Overview</Tab><Tab>Printer configuration</Tab></TabList>} width="wide" className="machine-logbook-page detail-page machine-catalog"><TabPanels><TabPanel className="machine-detail-tab-panel">{!printer && children}</TabPanel><TabPanel className="machine-detail-tab-panel">{printer && children}</TabPanel></TabPanels></PageShell></Tabs>;
}
