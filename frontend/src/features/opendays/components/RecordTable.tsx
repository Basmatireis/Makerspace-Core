import type { ReactNode } from 'react';
import {
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
import { EmptyState } from '../../../app/PageState';

export type RecordColumn<T> = {
  key: string;
  header: string;
  className?: string;
  /** The first column is the row's keyboard target: a button that selects the row. */
  primary?: boolean;
  render: (row: T) => ReactNode;
};

type RecordTableProps<T> = {
  label: string;
  rows: T[];
  columns: RecordColumn<T>[];
  getId: (row: T) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSearch: (value: string) => void;
  toolbar?: ReactNode;
  empty: { title: string; description?: string };
};

/** A plain Carbon table with search whose rows select a record for the detail panel. */
export function RecordTable<T>({
  label,
  rows,
  columns,
  getId,
  selectedId,
  onSelect,
  onSearch,
  toolbar,
  empty,
}: RecordTableProps<T>) {
  return (
    <TableContainer className="od-record-table">
      <TableToolbar aria-label={`${label} toolbar`}>
        <TableToolbarContent>
          <TableToolbarSearch
            persistent
            id={`${label}-search`}
            labelText={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}`}
            onChange={(_event: unknown, value?: string) => onSearch(value ?? '')}
          />
          {toolbar}
        </TableToolbarContent>
      </TableToolbar>
      <Table aria-label={label}>
        <TableHead>
          <TableRow>
            {columns.map((column) => (
              <TableHeader key={column.key} className={column.className}>
                {column.header}
              </TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => {
            const id = getId(row);
            return (
              <TableRow key={id} isSelected={id === selectedId} onClick={() => onSelect(id)}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.className}>
                    {column.primary ? (
                      <button type="button" className="od-row-button" aria-pressed={id === selectedId}>
                        {column.render(row)}
                      </button>
                    ) : (
                      column.render(row)
                    )}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {rows.length === 0 && <EmptyState title={empty.title} description={empty.description} />}
    </TableContainer>
  );
}
