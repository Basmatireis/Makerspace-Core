import { Button, IconButton, Search } from '@carbon/react';
import { Column, Edit, List } from '@carbon/icons-react';
import { BatchFilter, type FilterCategory, type FilterValues } from '../../app/BatchFilter';

export type TaskView = 'list' | 'board';

interface Props {
  search: string;
  onSearch: (value: string) => void;
  filterCategories: FilterCategory[];
  filters: FilterValues;
  onFilters: (values: FilterValues) => void;
  canWriteTodo: boolean;
  onWriteTicket: () => void;
  onNewTodo: () => void;
  /** Present only on a group tab where the caller leads the group or manages working groups. */
  onEditColumns?: () => void;
  /** Whether the board is offered (a group tab). */
  boardAvailable: boolean;
  view: TaskView;
  onView: (view: TaskView) => void;
}

export function TaskToolbar(props: Props) {
  return (
    <div className="wg-toolbar">
      <div className="wg-toolbar__search">
        <Search
          id="wg-task-search"
          size="md"
          labelText="Search tickets and to-dos"
          placeholder="Search"
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
          onClear={() => props.onSearch('')}
        />
      </div>
      <BatchFilter
        id="wg-tasks"
        label="Tickets and to-dos"
        categories={props.filterCategories}
        applied={props.filters}
        onApply={props.onFilters}
        onReset={() => props.onFilters({})}
      />
      <div className="wg-toolbar__actions">
        <Button kind="tertiary" size="md" onClick={props.onWriteTicket}>
          Write a ticket
        </Button>
        {props.canWriteTodo && (
          <Button kind="primary" size="md" onClick={props.onNewTodo}>
            New to-do
          </Button>
        )}
        {props.onEditColumns && (
          <IconButton kind="ghost" size="md" label="Edit columns" onClick={props.onEditColumns}>
            <Edit />
          </IconButton>
        )}
        {props.boardAvailable && (
          <div className="wg-toolbar__views" role="group" aria-label="View">
            <IconButton
              kind={props.view === 'list' ? 'secondary' : 'ghost'}
              size="md"
              label="List view"
              aria-pressed={props.view === 'list'}
              onClick={() => props.onView('list')}
            >
              <List />
            </IconButton>
            <IconButton
              kind={props.view === 'board' ? 'secondary' : 'ghost'}
              size="md"
              label="Board view"
              aria-pressed={props.view === 'board'}
              onClick={() => props.onView('board')}
            >
              <Column />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
