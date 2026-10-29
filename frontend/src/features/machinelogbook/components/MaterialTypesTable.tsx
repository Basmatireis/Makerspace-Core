import { useState, type ReactNode } from 'react';
import { Button, Link as CarbonLink, Tag } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { MaterialKind, MaterialType } from '../../../api/generated/models';
import { DeleteMaterialTypeModal } from '../dialogs/DeleteMaterialTypeModal';
import { KindChoiceModal } from '../dialogs/KindChoiceModal';
import { MaterialTypeFormModal } from '../dialogs/MaterialTypeFormModal';
import { materialTypesQuery } from '../inventoryQueries';
import { processConfig, processOptions } from '../processConfig';
import { DirectoryTable, useUrlState, type Column } from '../shared/DirectoryTable';
import { QueryBoundary } from '../shared/QueryBoundary';
import { ArticleKindTag, articleKinds, kindNames, unitLabel } from './inventoryShared';

type Dialog =
  | { name: 'choose' }
  | { name: 'form'; kind?: MaterialKind; type?: MaterialType }
  | { name: 'delete'; type: MaterialType };

const choiceLabels: Record<MaterialKind, string> = {
  filament: 'Filament material type',
  consumable: 'Consumable material type',
  part: 'Part category',
};

function TypesTable({
  types,
  canManage,
  switcher,
}: {
  types: MaterialType[];
  canManage: boolean;
  switcher: ReactNode;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const url = useUrlState('');
  const kindIds = url.list('kind');
  const processIds = url.list('process');
  const statusIds = url.list('status');
  const rows = types.filter(
    (row) =>
      (kindIds.length === 0 || kindIds.includes(row.kind)) &&
      (processIds.length === 0 || processIds.some((process) => (row.processes as string[]).includes(process))) &&
      (statusIds.length === 0 || statusIds.includes(row.active ? 'active' : 'inactive')),
  );
  const close = () => setDialog(null);

  const columns: Column<MaterialType>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (row) => row.name,
      render: (row) =>
        canManage ? (
          <CarbonLink
            as="button"
            type="button"
            className="mj-link-button"
            onClick={() => setDialog({ name: 'form', type: row })}
          >
            {row.name}
          </CarbonLink>
        ) : (
          row.name
        ),
    },
    {
      key: 'kind',
      header: 'Kind',
      sortValue: (row) => row.kind,
      render: (row) => <ArticleKindTag kind={row.kind} />,
    },
    { key: 'unit', header: 'Unit', narrow: true, sortValue: (row) => row.unit, render: (row) => unitLabel(row.unit) },
    {
      key: 'processes',
      header: 'Processes',
      narrow: true,
      render: (row) => row.processes.map((process) => processConfig[process].label).join(', ') || '—',
    },
    {
      key: 'articles',
      header: 'Articles',
      narrow: true,
      sortValue: (row) => row.materialCount,
      firstDirection: 'DESC',
      render: (row) => row.materialCount,
    },
    {
      key: 'rules',
      header: 'Price rules',
      narrow: true,
      sortValue: (row) => row.pricingRuleCount,
      firstDirection: 'DESC',
      render: (row) => row.pricingRuleCount,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (row) => (row.active ? 0 : 1),
      render: (row) => (
        <Tag type={row.active ? 'green' : 'gray'} size="sm">
          {row.active ? 'Active' : 'Inactive'}
        </Tag>
      ),
    },
  ];

  return (
    <>
      <DirectoryTable
        switcher={switcher}
        id="types"
        urlPrefix=""
        label="Types and categories"
        columns={columns}
        rows={rows}
        totalCount={types.length}
        searchText={(row) =>
          [
            row.name,
            kindNames[row.kind],
            unitLabel(row.unit),
            ...row.processes.map((process) => processConfig[process].label),
            row.active ? 'Active' : 'Inactive',
          ].join(' ')
        }
        defaultSort={{ key: 'name', direction: 'ASC' }}
        onRowClick={canManage ? (row) => setDialog({ name: 'form', type: row }) : undefined}
        filterCategories={[
          { key: 'kind', label: 'Kind', options: articleKinds.map((id) => ({ id, label: choiceLabels[id] })) },
          { key: 'process', label: 'Process', options: processOptions.map(({ id, label }) => ({ id, label })) },
          {
            key: 'status',
            label: 'Status',
            options: [
              { id: 'active', label: 'Active' },
              { id: 'inactive', label: 'Inactive' },
            ],
          },
        ]}
        toolbarAction={
          canManage ? (
            <Button renderIcon={Add} onClick={() => setDialog({ name: 'choose' })}>
              New type or category
            </Button>
          ) : undefined
        }
        empty={{
          title: 'No types or categories yet',
          description: 'Material types group filament and consumables; part categories group parts.',
        }}
      />
      {dialog?.name === 'choose' && (
        <KindChoiceModal
          heading="New type or category"
          kinds={articleKinds}
          labels={choiceLabels}
          onClose={close}
          onChoose={(kind) => setDialog({ name: 'form', kind })}
        />
      )}
      {dialog?.name === 'form' && (
        <MaterialTypeFormModal
          open
          onClose={close}
          materialType={dialog.type}
          kind={dialog.kind}
          onDelete={dialog.type ? () => setDialog({ name: 'delete', type: dialog.type as MaterialType }) : undefined}
        />
      )}
      {dialog?.name === 'delete' && <DeleteMaterialTypeModal materialType={dialog.type} onClose={close} />}
    </>
  );
}

export function MaterialTypesTable(props: Omit<Parameters<typeof TypesTable>[0], 'types'>) {
  const query = useQuery(materialTypesQuery());
  return (
    <QueryBoundary query={query} errorMessage="The types could not be loaded.">
      {(types) => <TypesTable {...props} types={types} />}
    </QueryBoundary>
  );
}
