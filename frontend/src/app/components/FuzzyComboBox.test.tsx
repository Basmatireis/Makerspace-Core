import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FuzzyComboBox, FuzzySelectField, type SelectOption } from './FuzzyComboBox';

const options: SelectOption[] = [
  { id: 'petg', label: 'PETG Black' },
  { id: 'pla-basic', label: 'PLA Basic Black' },
  { id: 'black-pla', label: 'Black PLA' },
  { id: 'silk', label: 'Silk White' },
];

describe('FuzzyComboBox', () => {
  it('offers only matching items, best match first, and keeps Carbon keyboard selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FuzzyComboBox<SelectOption>
        id="material"
        titleText="Material"
        items={options}
        itemToString={(item) => item?.label ?? ''}
        onChange={onChange}
      />,
    );
    await user.type(screen.getByRole('combobox', { name: 'Material' }), 'black');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Black PLA',
      'PETG Black',
      'PLA Basic Black',
    ]);
    // The best match is highlighted while typing, so Enter takes it; the arrow keys move as usual.
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedItem: options[2] }));
  });

  it('matches characters in order when no substring matches', async () => {
    const user = userEvent.setup();
    render(
      <FuzzyComboBox<SelectOption>
        id="material"
        titleText="Material"
        items={options}
        itemToString={(item) => item?.label ?? ''}
        onChange={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('combobox', { name: 'Material' }), 'swh');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Silk White']);
  });
});

describe('FuzzySelectField', () => {
  function Field() {
    const [value, setValue] = useState<string | null>('silk');
    return (
      <>
        <FuzzySelectField id="spool" titleText="Spool" options={options} value={value} onChange={setValue} />
        <output>{value ?? 'none'}</output>
      </>
    );
  }

  it('shows the selected label and reports the chosen id', async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByRole('combobox', { name: 'Spool' });
    expect(input).toHaveValue('Silk White');
    await user.clear(input);
    await user.type(input, 'pla bas');
    await user.click(screen.getByRole('option', { name: 'PLA Basic Black' }));
    expect(screen.getByRole('status')).toHaveTextContent('pla-basic');
  });
});
