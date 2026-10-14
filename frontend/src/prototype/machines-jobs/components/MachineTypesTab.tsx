import { useState } from 'react';
import { Button, DataTable, Modal, OverflowMenu, OverflowMenuItem, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, Tag, TextInput } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { EmptyState } from '../../../app/PageState';
import { useStore } from '../store';
import type { MachineType } from '../types';

const headers = [{ key: 'name', header: 'Name' }, { key: 'status', header: 'Status' }, { key: 'machines', header: 'Machines' }];

function TypeNameModal({ type, open, onClose }: { type?: MachineType; open: boolean; onClose: () => void }) {
  const store = useStore();
  const [name, setName] = useState(type?.name ?? '');
  const trimmed = name.trim();
  const taken = Boolean(trimmed) && store.machineTypes.some((item) => item.id !== type?.id && item.name.toLowerCase() === trimmed.toLowerCase());
  const submit = () => {
    if (!trimmed || taken) return;
    store.saveMachineType({ id: type?.id, name: trimmed, active: type?.active ?? true });
    store.notify({ kind: 'success', title: type ? 'Machine type renamed' : 'Machine type added', subtitle: trimmed });
    onClose();
  };
  if (!open) return null;
  return (
    <Modal open size="xs" modalHeading={type ? 'Rename machine type' : 'Add machine type'} primaryButtonText={type ? 'Rename' : 'Add type'} secondaryButtonText="Cancel" primaryButtonDisabled={!trimmed || taken || trimmed === type?.name} preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={submit}>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <TextInput id="type-name" labelText="Name" value={name} autoComplete="off" data-modal-primary-focus invalid={taken} invalidText="This name is already used." onChange={(event) => setName(event.target.value)} />
      </form>
    </Modal>
  );
}

export function MachineTypesTab() {
  const store = useStore();
  const canManage = store.can('machines.manage');
  const [dialog, setDialog] = useState<{ type?: MachineType } | null>(null);
  const count = (id: string) => store.machines.filter((machine) => machine.machineTypeId === id).length;
  const toggle = (type: MachineType) => {
    store.saveMachineType({ id: type.id, name: type.name, active: !type.active });
    store.notify({ kind: 'success', title: type.active ? 'Machine type deactivated' : 'Machine type activated', subtitle: type.name });
  };

  return (
    <div className="mj-tab-panel">
      <p className="mj-secondary">Inactive types stay on existing machines but can't be chosen for new ones.</p>
      <DataTable rows={store.machineTypes.map((type) => ({ id: type.id, name: type.name, status: type.active ? 'Active' : 'Inactive', machines: count(type.id) }))} headers={headers}>
        {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => (
          <TableContainer className="mj-table-container">
            <TableToolbar aria-label="Machine types toolbar">
              <TableToolbarContent>
                {canManage && <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setDialog({})}>Add type</Button>}
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} aria-label="Machine types">
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => <TableHeader key={header.key}>{header.header}</TableHeader>)}
                  {canManage && <TableHeader aria-label="Actions" />}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const type = store.machineTypes.find((item) => item.id === row.id)!;
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    <TableRow key={key} {...rowProps}>
                      <TableCell>{type.name}</TableCell>
                      <TableCell><Tag size="sm" type={type.active ? 'green' : 'gray'}>{type.active ? 'Active' : 'Inactive'}</Tag></TableCell>
                      <TableCell>{count(type.id)}</TableCell>
                      {canManage && (
                        <TableCell className="cds--table-column-menu">
                          <OverflowMenu aria-label={`Actions for ${type.name}`} flipped size="sm">
                            <OverflowMenuItem itemText="Rename" onClick={() => setDialog({ type })} />
                            <OverflowMenuItem itemText={type.active ? 'Deactivate' : 'Activate'} onClick={() => toggle(type)} />
                          </OverflowMenu>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {store.machineTypes.length === 0 && <EmptyState title="No machine types yet" description="Add a type to start adding machines." />}
          </TableContainer>
        )}
      </DataTable>
      <TypeNameModal key={dialog?.type?.id ?? 'new'} type={dialog?.type} open={Boolean(dialog)} onClose={() => setDialog(null)} />
    </div>
  );
}
