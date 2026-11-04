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
} from '@carbon/react';
import { useState } from 'react';
import type { Visit } from '../../../api/generated/models';
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
  canAssist,
  canCorrect,
  onCheckOut,
  onVoid,
}: {
  visits: Visit[];
  canAssist: boolean;
  canCorrect: boolean;
  onCheckOut: (visit: Visit) => void;
  onVoid: (visit: Visit) => void;
}) {
  const [search, setSearch] = useState('');
  const hasActions = canAssist || canCorrect;
  const term = search.trim().toLowerCase();
  // The name and the check-in method label (the "Via" cell) both count.
  const matches = (name: string, method: string) =>
    `${name} ${checkInMethodLabel(method)}`.toLowerCase().includes(term);
  const shownVisits = [...visits]
    .sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))
    .filter((visit) => matches(visit.displayName, visit.checkInMethod));
  const rows = [
    ...shownVisits.map((visit) => ({
      id: visit.id,
      person: visit.displayName,
      since: formatTime(visit.checkedInAt),
      method: checkInMethodLabel(visit.checkInMethod),
      actions: '',
    })),
  ];
  const description = `${visits.length} checked in`;
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
                const visit = shownVisits.find((item) => item.id === row.id);
                if (!visit) return null;
                const name = visit.displayName;
                return (
                  <TableRow {...getRowProps({ row })} key={row.id}>
                    {row.cells.map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cell.info.header === 'actions' ? 'cds--table-column-menu' : undefined}
                      >
                        {cell.info.header === 'actions' ? (
                          canAssist || canCorrect ? (
                            <OverflowMenu size="sm" flipped iconDescription={`Actions for ${name}`}>
                              {canAssist && <OverflowMenuItem itemText="Check out" onClick={() => onCheckOut(visit)} />}
                              {canCorrect && (
                                <OverflowMenuItem
                                  itemText="Void record"
                                  isDelete
                                  hasDivider={canAssist}
                                  onClick={() => onVoid(visit)}
                                />
                              )}
                            </OverflowMenu>
                          ) : null
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
            <p className="attendance-empty">
              {visits.length === 0 ? 'Nobody is checked in.' : 'Nobody matches the search.'}
            </p>
          )}
        </TableContainer>
      )}
    </DataTable>
  );
}
