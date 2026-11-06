import {
  Button,
  Pagination,
  ProgressBar,
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
import { Download } from '@carbon/icons-react';
import type { StaffingStatus, SupervisorRow } from '../../api/generated/models';
import { EmptyState } from '../../app/PageState';
import { TableFilters } from '../../app/components/TableFilters';
import {
  activeFilterCount,
  labRulesGroup,
  labRulesLabel,
  membershipLabel,
  nextOpenDayText,
  type FilterDef,
  type SortKey,
  type SortState,
  type StaffingFilterValues,
} from './staffing';

const PAGE_SIZES = [10, 25, 50, 100];

const COLUMNS: Array<{ key: SortKey; header: string; className?: string }> = [
  { key: 'name', header: 'Name' },
  { key: 'membership', header: 'System role', className: 'st-col--role' },
  { key: 'progress', header: 'This semester' },
  { key: 'status', header: 'Status', className: 'st-col--status' },
  { key: 'next', header: 'Next open day', className: 'st-col--next' },
  { key: 'labRules', header: 'Lab rules', className: 'st-col--lab' },
];

type TagColor = 'green' | 'red' | 'purple' | 'warm-gray' | 'gray';

const STATUS_TAGS: Record<StaffingStatus, { label: (row: SupervisorRow) => string; type: TagColor }> = {
  fulfilled: { label: () => 'Minimum reached', type: 'green' },
  missing: { label: (row) => `${row.missing} missing`, type: 'red' },
  ready: { label: () => 'Ready for supervisor', type: 'purple' },
  excused: { label: () => 'Excused', type: 'warm-gray' },
  no_minimum: { label: () => 'No minimum', type: 'gray' },
};

export function StatusTag({ row }: { row: SupervisorRow }) {
  const tag = STATUS_TAGS[row.status];
  return (
    <Tag type={tag.type} size="sm">
      {tag.label(row)}
    </Tag>
  );
}

type Props = {
  /** Rows after search, filters and sorting; the table slices out the current page. */
  rows: SupervisorRow[];
  filterDefs: FilterDef[];
  search: string;
  filters: StaffingFilterValues;
  sort: SortState;
  page: number;
  pageSize: number;
  selectedId: string | null;
  hasAnyRows: boolean;
  onSearch: (value: string) => void;
  onFilters: (values: StaffingFilterValues) => void;
  onSort: (key: SortKey) => void;
  onPage: (page: number, pageSize: number) => void;
  onSelect: (personId: string) => void;
  onExport: () => void;
};

/** The people of a semester against their minimum. A row selects the person for the detail panel. */
export function StaffingTable({
  rows,
  filterDefs,
  search,
  filters,
  sort,
  page,
  pageSize,
  selectedId,
  hasAnyRows,
  onSearch,
  onFilters,
  onSort,
  onPage,
  onSelect,
  onExport,
}: Props) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filtered = search.trim() !== '' || activeFilterCount(filters) > 0;

  return (
    <TableContainer className="st-table">
      <TableToolbar aria-label="People toolbar">
        <TableToolbarContent>
          <TableToolbarSearch
            persistent
            id="staffing-search"
            labelText="Search people"
            placeholder="Search by name, role or status"
            value={search}
            onChange={(_event, value) => onSearch(value ?? '')}
            onClear={() => onSearch('')}
          />
          <TableFilters label="Staffing filters" defs={filterDefs} values={filters} onChange={onFilters} />
          <Button
            kind="ghost"
            size="lg"
            renderIcon={Download}
            disabled={rows.length === 0}
            onClick={onExport}
            className="st-export"
          >
            Export CSV
          </Button>
        </TableToolbarContent>
      </TableToolbar>
      <Table aria-label="People this semester">
        <TableHead>
          <TableRow>
            {COLUMNS.map((column) => (
              <TableHeader
                key={column.key}
                className={column.className}
                isSortable
                isSortHeader={sort?.key === column.key}
                sortDirection={sort?.key === column.key ? (sort.direction === 'asc' ? 'ASC' : 'DESC') : 'NONE'}
                onClick={() => onSort(column.key)}
              >
                {column.header}
              </TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {pageRows.map((row) => {
            const selected = row.personId === selectedId;
            const signedUp = row.staffed + row.booked;
            const next = nextOpenDayText(row);
            return (
              <TableRow key={row.personId} isSelected={selected} onClick={() => onSelect(row.personId)}>
                <TableCell>
                  <button type="button" className="st-row-button" aria-pressed={selected}>
                    <span className="st-name">
                      <span>{row.name}</span>
                      {row.extraRoles.length > 0 && <small>{row.extraRoles.join(', ')}</small>}
                      <small className="st-name__phone">
                        {membershipLabel(row.membership)} · {signedUp} of {row.minimum}
                      </small>
                    </span>
                  </button>
                </TableCell>
                <TableCell className="st-col--role">
                  <Tag type={row.membership === 'trainee' ? 'teal' : 'cool-gray'} size="sm">
                    {membershipLabel(row.membership)}
                  </Tag>
                </TableCell>
                <TableCell>
                  <div className="st-count">
                    <span>
                      <strong>{signedUp}</strong> of {row.minimum}
                    </span>
                    {row.minimum > 0 && (
                      <ProgressBar
                        label={`${row.name}: signed up for ${signedUp} of ${row.minimum} open days`}
                        hideLabel
                        size="small"
                        value={Math.min(signedUp, row.minimum)}
                        max={row.minimum}
                        status={signedUp >= row.minimum ? 'finished' : 'active'}
                      />
                    )}
                  </div>
                </TableCell>
                <TableCell className="st-col--status">
                  <StatusTag row={row} />
                </TableCell>
                <TableCell className="st-col--next">
                  {next || <span className="st-secondary">Nothing coming up</span>}
                </TableCell>
                <TableCell className="st-col--lab">
                  {labRulesGroup(row) === 'not_confirmed' ? (
                    <Tag type="red" size="sm">
                      {labRulesLabel(row)}
                    </Tag>
                  ) : (
                    labRulesLabel(row)
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {rows.length === 0 && (
        <EmptyState
          title={filtered ? 'No people found' : 'Nobody to staff yet'}
          description={
            filtered
              ? 'Try different search terms or filters.'
              : hasAnyRows
                ? 'Nothing to show.'
                : 'Supervisors and trainees appear here. Visitors do not staff open days.'
          }
        />
      )}
      <Pagination
        page={currentPage}
        pageSize={pageSize}
        totalItems={rows.length}
        pageSizes={PAGE_SIZES}
        onChange={({ page: nextPage, pageSize: nextPageSize }) => onPage(nextPage, nextPageSize)}
      />
    </TableContainer>
  );
}
