import {
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
  Tag,
} from '@carbon/react';
import type { ManagedDevice } from '../../../api/generated/models';
import { formatDateTime } from '../../../app/dateTime';

export function DeviceTable({
  devices,
  canManage,
  onEdit,
  onRotate,
  onConfirm,
}: {
  devices: ManagedDevice[];
  canManage: boolean;
  onEdit: (device: ManagedDevice) => void;
  onRotate: (device: ManagedDevice) => void;
  onConfirm: (kind: 'revoke' | 'delete', device: ManagedDevice) => void;
}) {
  const headers = [
    { key: 'name', header: 'Device name' },
    { key: 'type', header: 'Device type' },
    { key: 'status', header: 'Status' },
    { key: 'lastSeen', header: 'Last seen' },
    { key: 'expires', header: 'Token expiration' },
    { key: 'actions', header: '' },
  ];
  const rows = devices.map((device) => ({
    id: device.id,
    name: device.name,
    type: device.deviceTypeName,
    status: device.status,
    lastSeen: device.lastSeenAt ? formatDateTime(device.lastSeenAt) : 'Never',
    expires: device.expiresAt ? formatDateTime(device.expiresAt) : 'No expiration',
    actions: device,
  }));
  return (
    <DataTable rows={rows} headers={headers}>
      {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
        <TableContainer title="Registered devices">
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
              {tableRows.map((row) => (
                <TableRow {...getRowProps({ row })} key={row.id}>
                  {row.cells.map((cell) => (
                    <TableCell key={cell.id}>
                      {cell.info.header === 'status' ? (
                        <StatusTag status={String(cell.value)} />
                      ) : cell.info.header === 'actions' && canManage ? (
                        <DeviceMenu
                          device={cell.value as ManagedDevice}
                          onEdit={onEdit}
                          onRotate={onRotate}
                          onConfirm={onConfirm}
                        />
                      ) : (
                        String(cell.value)
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </DataTable>
  );
}

function DeviceMenu({
  device,
  onEdit,
  onRotate,
  onConfirm,
}: {
  device: ManagedDevice;
  onEdit: (device: ManagedDevice) => void;
  onRotate: (device: ManagedDevice) => void;
  onConfirm: (kind: 'revoke' | 'delete', device: ManagedDevice) => void;
}) {
  return (
    <OverflowMenu aria-label={`Actions for ${device.name}`} flipped>
      <OverflowMenuItem itemText="Edit" onClick={() => onEdit(device)} />
      {device.status !== 'revoked' && <OverflowMenuItem itemText="Rotate token" onClick={() => onRotate(device)} />}
      {device.status !== 'revoked' ? (
        <OverflowMenuItem isDelete itemText="Revoke" onClick={() => onConfirm('revoke', device)} />
      ) : (
        <OverflowMenuItem isDelete itemText="Delete" onClick={() => onConfirm('delete', device)} />
      )}
    </OverflowMenu>
  );
}

function StatusTag({ status }: { status: string }) {
  const type = status === 'active' ? 'green' : status === 'expired' ? 'warm-gray' : 'red';
  return <Tag type={type}>{status[0].toUpperCase() + status.slice(1)}</Tag>;
}
