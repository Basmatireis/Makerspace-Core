/* eslint-disable react-refresh/only-export-components -- the table and its URL-state hook belong together */
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Button, DataTable, Pagination, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarMenu, TableToolbarSearch,
} from '@carbon/react';
import { useSearchParams } from 'react-router-dom';
import { EmptyState } from '../../../app/PageState';
import { BatchFilter, toPatch, type FilterCategory, type FilterValues } from './BatchFilter';

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Makes the column sortable. */
  sortValue?: (row: T) => string | number;
  /** First sort direction when the column is chosen. */
  firstDirection?: 'ASC' | 'DESC';
  /** Hidden below 42rem; the first column repeats such details as secondary lines. */
  narrow?: boolean;
};

export type Option = { id: string; label: string };
export const selectedOptions = (options: Option[], ids: string[]) => options.filter((option) => ids.includes(option.id));

/** Filter, search and page state of one table, kept in URL parameters under a prefix so several tables can share a page. */
export function useUrlState(prefix: string) {
  const [params, setParams] = useSearchParams();
  const name = (key: string) => `${prefix}${key}`;
  const get = (key: string) => params.get(name(key)) ?? '';
  const list = (key: string) => get(key).split(',').filter(Boolean);
  const set = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(name(key), value); else next.delete(name(key)); }
    if (!('page' in patch)) next.delete(name('page'));
    return next;
  }, { replace: true });
  const setList = (key: string, items: Option[] | null | undefined) => set({ [key]: (items ?? []).map((item) => item.id).join(',') || null });
  const clear = (keys: string[]) => set(Object.fromEntries(keys.map((key) => [key, null])));
  return { get, list, set, setList, clear, params };
}

type Props<T extends { id: string }> = {
  /** Unique per page: element ids, aria labels and the URL parameter prefix. */
  id: string;
  label: string;
  columns: Column<T>[];
  /** Rows after the filter panel's filters; search, sort and paging happen here. */
  rows: T[];
  /** Rows before any filter or search, to tell "nothing yet" from "nothing found". */
  totalCount: number;
  searchText: (row: T) => string;
  defaultSort: { key: string; direction: 'ASC' | 'DESC' };
  /** Columns of the batch filter panel; each category key is also the URL parameter (under the table prefix) it is stored in. */
  filterCategories?: FilterCategory[];
  toolbarAction?: ReactNode;
  /** Section switcher shown at the start of the toolbar, when sibling tables share a page. */
  switcher?: ReactNode;
  /** Overflow items (`TableToolbarAction`) shown in a menu before the primary action. */
  toolbarMenu?: ReactNode;
  empty: { title: string; description: string; action?: ReactNode };
  pageSizes?: number[];
  /** Makes whole rows clickable (mouse convenience); the row must also offer a keyboard-reachable control that does the same. */
  onRowClick?: (row: T) => void;
};

/**
 * Directory-style table shared by every inventory list: expandable search, icon-only filter toggle with an inline
 * panel, primary action in the toolbar, client-side sort over the full filtered list, pagination in the container.
 */
export function DirectoryTable<T extends { id: string }>({
  id, label, columns, rows, totalCount, searchText, defaultSort, filterCategories, toolbarAction, toolbarMenu, switcher, empty, pageSizes = [10, 25, 50], onRowClick,
}: Props<T>) {
  const url = useUrlState(id);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState(defaultSort);
  const search = url.get('q');
  const filterKeys = (filterCategories ?? []).flatMap((category) => category.keys ?? [category.key]);
  const applied: FilterValues = Object.fromEntries(filterKeys.map((key) => [key, url.list(key)]));

  const visible = useMemo(() => {
    const column = columns.find((item) => item.key === sort.key);
    const direction = sort.direction === 'ASC' ? 1 : -1;
    const term = search.toLowerCase();
    const filtered = term ? rows.filter((row) => searchText(row).toLowerCase().includes(term)) : [...rows];
    if (!column?.sortValue) return filtered;
    const value = column.sortValue;
    return filtered.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * direction;
    });
  }, [rows, columns, sort, search, searchText]);

  const pageSize = pageSizes.includes(Number(url.get('pageSize'))) ? Number(url.get('pageSize')) : pageSizes[0];
  const page = Math.max(1, Math.min(Number(url.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const pageRows = visible.slice((page - 1) * pageSize, page * pageSize);
  const rowsById = new Map(pageRows.map((row) => [row.id, row]));
  const tableRows = pageRows.map((row) => ({ id: row.id }));
  const headers = columns.map(({ key, header }) => ({ key, header }));
  const sortBy = (column: Column<T>) => setSort((current) => current.key === column.key
    ? { key: column.key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' }
    : { key: column.key, direction: column.firstDirection ?? 'ASC' });
  const clearAll = () => { url.clear([...filterKeys, 'q']); setSearchKey((key) => key + 1); };

  return (
    <DataTable key={`${page}-${pageSize}-${sort.key}-${sort.direction}`} rows={tableRows} headers={headers}>
      {({ rows: dataRows, headers: tableHeaders, getRowProps, getTableProps }) => (
        <TableContainer className="mj-table-container">
          <TableToolbar aria-label={`${label} table toolbar`}>
            {switcher}
            <TableToolbarContent>
              <TableToolbarSearch
                key={searchKey}
                id={`${id}-search`}
                labelText={`Search ${label.toLowerCase()}`}
                placeholder={`Search ${label.toLowerCase()}`}
                defaultValue={search}
                onChange={(_event, value) => url.set({ q: value ?? '' })}
                onClear={() => url.set({ q: null })}
              />
              {filterCategories && filterCategories.length > 0 && (
                <BatchFilter
                  id={id} label={label} categories={filterCategories} applied={applied}
                  onApply={(values) => url.set(toPatch(values, filterKeys))} onReset={() => url.clear(filterKeys)}
                />
              )}
              {toolbarMenu && <TableToolbarMenu iconDescription="More actions">{toolbarMenu}</TableToolbarMenu>}
              {toolbarAction}
            </TableToolbarContent>
          </TableToolbar>
          <Table {...getTableProps()} aria-label={label}>
            <TableHead>
              <TableRow>
                {tableHeaders.map((header) => {
                  const column = columns.find((item) => item.key === header.key);
                  if (!column) return null;
                  const className = column.narrow ? 'mj-hide-narrow' : undefined;
                  return column.sortValue ? (
                    <TableHeader
                      key={header.key} className={className} isSortable isSortHeader={sort.key === column.key}
                      sortDirection={sort.key === column.key ? sort.direction : 'NONE'} onClick={() => sortBy(column)}
                    >
                      {header.header}
                    </TableHeader>
                  ) : <TableHeader key={header.key} className={className}>{header.header}</TableHeader>;
                })}
              </TableRow>
            </TableHead>
            <TableBody>
              {dataRows.map((tableRow) => {
                const row = rowsById.get(tableRow.id);
                if (!row) return null;
                const { key, ...rowProps } = getRowProps({ row: tableRow });
                return (
                  <TableRow
                    key={key} {...rowProps} className={onRowClick ? 'mj-row-clickable' : undefined}
                    onClick={onRowClick ? (event: MouseEvent<HTMLElement>) => { if (!(event.target as HTMLElement).closest('a, button, input, label')) onRowClick(row); } : undefined}
                  >
                    {columns.map((column) => (
                      <TableCell key={column.key} className={column.narrow ? 'mj-hide-narrow' : undefined}>{column.render(row)}</TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {visible.length === 0 && (totalCount === 0
            ? <EmptyState title={empty.title} description={empty.description} action={empty.action} />
            : <EmptyState title={`No ${label.toLowerCase()} found`} description="Try different search terms or filters." action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>} />)}
          <Pagination
            page={page} pageSize={pageSize} pageSizes={pageSizes} totalItems={visible.length}
            onChange={({ page: nextPage, pageSize: nextSize }) => url.set({ page: String(nextPage), pageSize: String(nextSize) })}
          />
        </TableContainer>
      )}
    </DataTable>
  );
}
