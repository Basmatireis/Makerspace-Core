import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../test/render';
import { BatchFilter, toList, toPatch, type FilterCategory, type FilterValues } from './BatchFilter';

const categories: FilterCategory[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { id: 'open', label: 'Open' },
      { id: 'done', label: 'Done' },
    ],
  },
  {
    key: 'kind',
    label: 'Kind',
    single: true,
    options: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ],
  },
];

function Harness({
  onApply = () => undefined,
  onReset = () => undefined,
  initial = {},
}: {
  onApply?: (values: FilterValues) => void;
  onReset?: () => void;
  initial?: FilterValues;
}) {
  const [applied, setApplied] = useState<FilterValues>(initial);
  return (
    <BatchFilter
      id="things"
      label="Things"
      categories={categories}
      applied={applied}
      onApply={(values) => {
        setApplied(values);
        onApply(values);
      }}
      onReset={() => {
        setApplied({});
        onReset();
      }}
    />
  );
}

describe('BatchFilter', () => {
  it('stages choices until Apply filters and shows the applied count on the trigger', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    renderRoute(<Harness onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('checkbox', { name: 'Open' }));
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    await user.click(screen.getByRole('radio', { name: 'Beta' }));
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(onApply).toHaveBeenCalledWith({ status: ['open', 'done'], kind: ['b'] });
    const trigger = screen.getByRole('button', { name: 'Filters (3 applied)' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('discards staged choices when the panel is reopened and resets all filters', async () => {
    const onReset = vi.fn();
    const user = userEvent.setup();
    renderRoute(<Harness onReset={onReset} initial={{ status: ['open'] }} />);

    await user.click(screen.getByRole('button', { name: 'Filters (1 applied)' }));
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Filters (1 applied)' }));
    expect(screen.getByRole('checkbox', { name: 'Done' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Open' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox', { name: 'Open' })).not.toBeChecked();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderRoute(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Things filters' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('converts between URL parameters and filter values', () => {
    expect(toList('a,b,,c')).toEqual(['a', 'b', 'c']);
    expect(toList(null)).toEqual([]);
    expect(toPatch({ status: ['a', 'b'], kind: [] }, ['status', 'kind', 'missing'])).toEqual({
      status: 'a,b',
      kind: null,
      missing: null,
    });
  });
});
