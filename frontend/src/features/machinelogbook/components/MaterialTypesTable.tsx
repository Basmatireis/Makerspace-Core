import type { ReactNode } from 'react';
import { Button, Link as CarbonLink, Tag } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { MaterialType, MaterialUnit } from '../../../api/generated/models';
import { materialTypesQuery } from '../inventoryQueries';
import { DirectoryTable, useUrlState, type Column } from '../shared/DirectoryTable';
import { QueryBoundary } from '../shared/QueryBoundary';
import { processConfig } from '../processConfig';
import { unitLabel } from './inventoryShared';

const units: MaterialUnit[] = ['g', 'm', 'ml', 'cm2', 'm2', 'piece'];

type Props = { id: string; switcher?: ReactNode; canManage: boolean; onAdd: () => void; onEdit: (materialType: MaterialType) => void };

/** Material types as a Directory-style table, filtered by unit and active state. */
export function MaterialTypesTable(props: Props) {
  const query = useQuery(materialTypesQuery());
  return <QueryBoundary query={query} errorMessage="The material types could not be loaded.">{(types) => <MaterialTypesTableContent {...props} types={types} />}</QueryBoundary>;
}

function MaterialTypesTableContent({ id, switcher, canManage, onAdd, onEdit, types }: Props & { types: MaterialType[] }) {
  const url = useUrlState(id);
  const unitIds = url.list('unit');
  const stateIds = url.list('state');
  const rows = types.filter((row) => (unitIds.length === 0 || unitIds.includes(row.unit))
    && (stateIds.length === 0 || stateIds.includes(row.active ? 'active' : 'inactive')));

  const columns: Column<MaterialType>[] = [
    {
      key: 'name', header: 'Material type', sortValue: (row) => row.name,
      render: (row) => canManage
        ? <CarbonLink as="button" type="button" className="mj-link-button" onClick={() => onEdit(row)}>{row.name}</CarbonLink>
        : <span>{row.name}</span>,
    },
    { key: 'unit', header: 'Unit', narrow: true, sortValue: (row) => row.unit, render: (row) => unitLabel(row.unit) },
    { key: 'processes', header: 'Processes', sortValue: (row) => row.processes.join(','), render: (row) => row.processes.map((process) => processConfig[process].label).join(', ') },
    { key: 'materials', header: 'Materials', narrow: true, sortValue: (row) => row.materialCount, firstDirection: 'DESC', render: (row) => row.materialCount },
    { key: 'rules', header: 'Price rules', narrow: true, sortValue: (row) => row.pricingRuleCount, firstDirection: 'DESC', render: (row) => row.pricingRuleCount },
    { key: 'status', header: 'Status', narrow: true, sortValue: (row) => row.active ? 0 : 1, render: (row) => row.active ? <Tag type="green" size="sm">Active</Tag> : <Tag type="gray" size="sm">Inactive</Tag> },
  ];

  return (
    <DirectoryTable
      id={id} label="Material types" columns={columns} rows={rows} totalCount={types.length} switcher={switcher}
      searchText={(row) => row.name}
      defaultSort={{ key: 'name', direction: 'ASC' }}
      onRowClick={canManage ? onEdit : undefined}
      toolbarAction={canManage ? <Button kind="primary" size="lg" onClick={onAdd}>Add material type</Button> : undefined}
      filterCategories={[
        { key: 'unit', label: 'Unit', options: units.map((unit) => ({ id: unit, label: unitLabel(unit) })) },
        { key: 'state', label: 'Status', options: [{ id: 'active', label: 'Active' }, { id: 'inactive', label: 'Inactive' }] },
      ]}
      empty={{
        title: 'No material types yet', description: 'Add the kinds of material the makerspace uses, such as PLA or PETG. Prices are set per material type.',
        action: canManage ? <Button kind="tertiary" onClick={onAdd}>Add material type</Button> : undefined,
      }}
    />
  );
}
