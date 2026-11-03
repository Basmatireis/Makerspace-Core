import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

type User = ReturnType<typeof userEvent.setup>;

/** Opens the catalog picker of material row `row` (0-based) in `dialog` and picks the article named `name`. */
export async function pickMaterial(user: User, dialog: HTMLElement, name: string, row = 0) {
  const open = within(dialog).getAllByRole('button', { name: /^(Select material|Change)$/ });
  await user.click(open[row]);
  const picker = await screen.findByRole('dialog', { name: 'Select material' });
  await user.click(await within(picker).findByRole('radio', { name: `Select ${name}` }));
}

/** Opens the picker of row `row` and records the recipient's own material with a label. */
export async function pickOwnMaterial(user: User, dialog: HTMLElement, label: string, row = 0) {
  const open = within(dialog).getAllByRole('button', { name: /^(Select material|Change)$/ });
  await user.click(open[row]);
  const picker = await screen.findByRole('dialog', { name: 'Select material' });
  await user.type(within(picker).getByLabelText('Label'), label);
  await user.click(within(picker).getByRole('button', { name: 'Use' }));
}

/** The article names the open picker lists, in order. */
export async function pickerNames() {
  const picker = await screen.findByRole('dialog', { name: 'Select material' });
  const table = await within(picker).findByRole('table', { name: 'Materials in stock' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[2]?.textContent ?? '');
}
