import { useState } from 'react';
import {
  Button,
  DataTable,
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tag,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompetencyCategory, Training } from '../../api/generated/models';
import { deleteCompetencyCategory, deleteTraining } from '../../api/generated/trainings/trainings';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { SettingsLoading, SettingsPageLayout } from '../settings/SettingsPageLayout';
import { SettingsTabs } from '../settings/SettingsTabs';
import { machineTypesQuery } from '../machinelogbook/queries';
import { CategoryFormModal, TrainingFormModal } from './CatalogFormModals';
import { competencyCategoriesOptions, trainingKeys, trainingsOptions } from './queries';

/** Settings → Trainings & competencies: the trainings people are recorded for and the public categories they feed. */
export function TrainingsSettingsPage() {
  return (
    <SettingsPageLayout page="trainings" width="wide">
      <SettingsTabs
        label="Trainings and competencies"
        tabs={[
          { key: 'trainings', label: 'Trainings', panel: <TrainingsPanel /> },
          { key: 'competencies', label: 'Competencies', panel: <CategoriesPanel /> },
        ]}
      />
    </SettingsPageLayout>
  );
}

function deleteError(error: unknown, inUse: string): string | undefined {
  if (!error) return undefined;
  if (error instanceof ApiError && error.data?.code?.endsWith('_in_use')) return inUse;
  if (error instanceof ApiError && error.data?.code === 'stale_write')
    return 'It changed meanwhile. Reload and try again.';
  return 'Check your connection and try again.';
}

function ActiveTag({ active }: { active: boolean }) {
  return active ? <Tag type="green">Active</Tag> : <Tag type="warm-gray">Inactive</Tag>;
}

function TrainingsPanel() {
  const client = useQueryClient();
  const currentUser = useCurrentUser();
  const canReadMachineTypes = hasPermission(currentUser, PermissionId.machinesread);
  const trainings = useQuery(trainingsOptions);
  const categories = useQuery(competencyCategoriesOptions);
  const machineTypes = useQuery({ ...machineTypesQuery(), enabled: canReadMachineTypes });
  const [editing, setEditing] = useState<Training | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Training | null>(null);
  const remove = useMutation({
    mutationFn: (training: Training) => deleteTraining(training.id, { expectedVersion: training.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: trainingKeys.all });
      setDeleting(null);
    },
  });

  if (trainings.isPending || categories.isPending) return <SettingsLoading label="Loading trainings" />;
  if (trainings.isError || categories.isError)
    return <ErrorState title="Trainings unavailable" message="Reload the page to try again." />;
  const categoryNames = new Map(categories.data.items.map((category) => [category.id, category.name]));
  const headers = [
    { key: 'name', header: 'Training' },
    { key: 'competencies', header: 'Competencies' },
    { key: 'records', header: 'People' },
    { key: 'status', header: 'Status' },
    { key: 'actions', header: '' },
  ];
  const rows = trainings.data.items.map((training) => ({ id: training.id, ...headerless(training) }));
  const byId = new Map(trainings.data.items.map((training) => [training.id, training]));

  return (
    <>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer
            title="Trainings"
            description="People's training status is set on their person page. Deactivate trainings that are no longer given."
          >
            <TableToolbar>
              <TableToolbarContent>
                <Button renderIcon={Add} onClick={() => setEditing('new')}>
                  Add training
                </Button>
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => (
                    <TableHeader {...getHeaderProps({ header })} key={header.key}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={headers.length}>No trainings yet.</TableCell>
                  </TableRow>
                )}
                {tableRows.map((row) => {
                  const training = byId.get(row.id)!;
                  return (
                    <TableRow {...getRowProps({ row })} key={row.id}>
                      <TableCell>{training.name}</TableCell>
                      <TableCell>
                        <div className="competency-tags">
                          {training.competencyIds.map((id) => (
                            <Tag key={id} type="teal" size="sm">
                              {categoryNames.get(id) ?? 'Unknown'}
                            </Tag>
                          ))}
                          {training.competencyIds.length === 0 && '—'}
                        </div>
                      </TableCell>
                      <TableCell>{training.recordCount}</TableCell>
                      <TableCell>
                        <ActiveTag active={training.active} />
                      </TableCell>
                      <TableCell>
                        <OverflowMenu
                          aria-label={`Actions for ${training.name}`}
                          iconDescription={`Actions for ${training.name}`}
                          flipped
                        >
                          <OverflowMenuItem itemText="Edit" onClick={() => setEditing(training)} />
                          <OverflowMenuItem
                            isDelete
                            itemText="Delete"
                            disabled={training.recordCount > 0}
                            onClick={() => {
                              remove.reset();
                              setDeleting(training);
                            }}
                          />
                        </OverflowMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
      {editing && (
        <TrainingFormModal
          training={editing === 'new' ? undefined : editing}
          categories={categories.data.items}
          machineTypes={canReadMachineTypes ? (machineTypes.data?.items ?? []) : undefined}
          onClose={() => setEditing(null)}
        />
      )}
      <DestructiveActionDialog
        open={deleting !== null}
        title="Delete training"
        confirmLabel="Delete training"
        pending={remove.isPending}
        error={deleteError(remove.error, 'People hold records of this training. Deactivate it instead.')}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{deleting?.name} is deleted permanently.</p>
      </DestructiveActionDialog>
    </>
  );
}

function CategoriesPanel() {
  const client = useQueryClient();
  const categories = useQuery(competencyCategoriesOptions);
  const [editing, setEditing] = useState<CompetencyCategory | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CompetencyCategory | null>(null);
  const remove = useMutation({
    mutationFn: (category: CompetencyCategory) =>
      deleteCompetencyCategory(category.id, { expectedVersion: category.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: trainingKeys.all });
      setDeleting(null);
    },
  });

  if (categories.isPending) return <SettingsLoading label="Loading competencies" />;
  if (categories.isError)
    return <ErrorState title="Competencies unavailable" message="Reload the page to try again." />;
  const headers = [
    { key: 'name', header: 'Public label' },
    { key: 'sortOrder', header: 'Sort order' },
    { key: 'trainings', header: 'Trainings' },
    { key: 'status', header: 'Status' },
    { key: 'actions', header: '' },
  ];
  const byId = new Map(categories.data.items.map((category) => [category.id, category]));
  const rows = categories.data.items.map((category) => ({ id: category.id, ...headerless(category) }));

  return (
    <>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
          <TableContainer
            title="Competencies"
            description="What open days publicly offer, derived from the trainings of assigned supervisors. Never shows who trains."
          >
            <TableToolbar>
              <TableToolbarContent>
                <Button renderIcon={Add} onClick={() => setEditing('new')}>
                  Add competency
                </Button>
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => (
                    <TableHeader {...getHeaderProps({ header })} key={header.key}>
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={headers.length}>No competencies yet.</TableCell>
                  </TableRow>
                )}
                {tableRows.map((row) => {
                  const category = byId.get(row.id)!;
                  return (
                    <TableRow {...getRowProps({ row })} key={row.id}>
                      <TableCell>{category.name}</TableCell>
                      <TableCell>{category.sortOrder}</TableCell>
                      <TableCell>{category.trainingCount}</TableCell>
                      <TableCell>
                        <ActiveTag active={category.active} />
                      </TableCell>
                      <TableCell>
                        <OverflowMenu
                          aria-label={`Actions for ${category.name}`}
                          iconDescription={`Actions for ${category.name}`}
                          flipped
                        >
                          <OverflowMenuItem itemText="Edit" onClick={() => setEditing(category)} />
                          <OverflowMenuItem
                            isDelete
                            itemText="Delete"
                            disabled={category.trainingCount > 0}
                            onClick={() => {
                              remove.reset();
                              setDeleting(category);
                            }}
                          />
                        </OverflowMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
      {editing && (
        <CategoryFormModal category={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />
      )}
      <DestructiveActionDialog
        open={deleting !== null}
        title="Delete competency"
        confirmLabel="Delete competency"
        pending={remove.isPending}
        error={deleteError(remove.error, 'Trainings feed this competency. Deactivate it instead.')}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{deleting?.name} is deleted permanently.</p>
      </DestructiveActionDialog>
    </>
  );
}

/** DataTable needs one cell value per header; the cells render from the original object instead. */
function headerless(item: { name: string }) {
  return { name: item.name, competencies: '', records: '', status: '', actions: '', sortOrder: '', trainings: '' };
}
