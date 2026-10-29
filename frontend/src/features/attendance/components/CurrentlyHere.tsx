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
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Tag,
} from '@carbon/react';
import { useState } from 'react';
import type { AttendanceHold, Visit } from '../../../api/generated/models';
import { formatTime } from '../../../app/dateTime';
import { checkInMethodLabel } from '../presentation';

const headers = [
  { key: 'person', header: 'Person' },
  { key: 'since', header: 'Checked in' },
  { key: 'method', header: 'Via' },
  { key: 'actions', header: '' },
];

export function CurrentlyHere({
  visits,
  holds,
  canAssist,
  canCorrect,
  canConfirm,
  busy,
  onCheckOut,
  onVoid,
  onConfirm,
  onCancelHold,
}: {
  visits: Visit[];
  /** Held check-ins: people at the entrance whose Lab Rules still need a sign-off. Listed first. */
  holds: AttendanceHold[];
  canAssist: boolean;
  canCorrect: boolean;
  canConfirm: boolean;
  busy: boolean;
  onCheckOut: (visit: Visit) => void;
  onVoid: (visit: Visit) => void;
  onConfirm: (hold: AttendanceHold) => void;
  onCancelHold: (hold: AttendanceHold) => void;
}) {
  const [search, setSearch] = useState('');
  const hasActions = canAssist || canCorrect || canConfirm;
  const term = search.trim().toLowerCase();
  // The name and the check-in method label (the "Via" cell) both count.
  const matches = (name: string, method: string) =>
    `${name} ${checkInMethodLabel(method)}`.toLowerCase().includes(term);
  const shownHolds = [...holds]
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .filter((hold) => matches(hold.displayName, hold.checkInMethod));
  const shownVisits = [...visits]
    .sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))
    .filter((visit) => matches(visit.displayName, visit.checkInMethod));
  const rows = [
    ...shownHolds.map((hold) => ({
      id: hold.id,
      person: hold.displayName,
      since: `Waiting since ${formatTime(hold.requestedAt)}`,
      method: checkInMethodLabel(hold.checkInMethod),
      actions: '',
    })),
    ...shownVisits.map((visit) => ({
      id: visit.id,
      person: visit.displayName,
      since: formatTime(visit.checkedInAt),
      method: checkInMethodLabel(visit.checkInMethod),
      actions: '',
    })),
  ];
  const total = visits.length + holds.length;
  const description =
    holds.length > 0
      ? `${visits.length} checked in · ${holds.length} awaiting sign-off`
      : `${visits.length} checked in`;
  const visibleHeaders = hasActions ? headers : headers.filter((header) => header.key !== 'actions');

  return (
    <DataTable rows={rows} headers={visibleHeaders}>
      {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
        <TableContainer title="Currently here" description={description}>
          <TableToolbar>
            <TableToolbarContent>
              <TableToolbarSearch
                persistent
                placeholder="Search by name or method"
                onChange={(event) => setSearch(typeof event === 'string' ? event : event.target.value)}
              />
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
              {tableRows.map((row) => {
                // DataTable renders its previous rows once more after a visit disappeared (checked out, voided).
                const hold = shownHolds.find((item) => item.id === row.id);
                const visit = shownVisits.find((item) => item.id === row.id);
                if (!hold && !visit) return null;
                const name = (hold ?? visit)!.displayName;
                return (
                  <TableRow {...getRowProps({ row })} key={row.id}>
                    {row.cells.map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cell.info.header === 'actions' ? 'cds--table-column-menu' : undefined}
                      >
                        {cell.info.header === 'actions' ? (
                          hold ? (
                            (canConfirm && hold.laborordnungRequestId) || canAssist ? (
                              <OverflowMenu size="sm" flipped iconDescription={`Actions for ${name}`}>
                                {canConfirm && hold.laborordnungRequestId && (
                                  <OverflowMenuItem itemText="Confirm Lab Rules" onClick={() => onConfirm(hold)} />
                                )}
                                {canAssist && (
                                  <OverflowMenuItem
                                    itemText="Cancel check-in"
                                    isDelete
                                    disabled={busy}
                                    onClick={() => onCancelHold(hold)}
                                  />
                                )}
                              </OverflowMenu>
                            ) : null
                          ) : canAssist || canCorrect ? (
                            <OverflowMenu size="sm" flipped iconDescription={`Actions for ${name}`}>
                              {canAssist && (
                                <OverflowMenuItem itemText="Check out" onClick={() => onCheckOut(visit!)} />
                              )}
                              {canCorrect && (
                                <OverflowMenuItem
                                  itemText="Void record"
                                  isDelete
                                  hasDivider={canAssist}
                                  onClick={() => onVoid(visit!)}
                                />
                              )}
                            </OverflowMenu>
                          ) : null
                        ) : cell.info.header === 'person' && hold ? (
                          <span className="attendance-person">
                            {cell.value}
                            <Tag type="red" size="sm">
                              Awaiting sign-off
                            </Tag>
                          </span>
                        ) : (
                          cell.value
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <p className="attendance-empty">{total === 0 ? 'Nobody is checked in.' : 'Nobody matches the search.'}</p>
          )}
        </TableContainer>
      )}
    </DataTable>
  );
}
