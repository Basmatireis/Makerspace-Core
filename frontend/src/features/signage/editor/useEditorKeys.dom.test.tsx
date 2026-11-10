import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dropdown, RadioButton, RadioButtonGroup } from '@carbon/react';
import { useEditorKeys, type EditorKeyAction } from './useEditorKeys';

function Harness({ onAction }: { onAction: (action: EditorKeyAction) => void }) {
  useEditorKeys(true, (action) => {
    onAction(action);
    return true;
  });
  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div data-canvas-region tabIndex={0} aria-label="Canvas" role="application" />
      <button type="button">Plain</button>
      <RadioButtonGroup legendText="Choice" name="choice" defaultSelected="a">
        <RadioButton id="a" labelText="A" value="a" />
        <RadioButton id="b" labelText="B" value="b" />
      </RadioButtonGroup>
      <Dropdown
        id="dd"
        titleText="Pick"
        label="Pick"
        items={['one', 'two']}
        itemToString={(item) => item ?? ''}
        selectedItem="one"
      />
    </div>
  );
}

describe('useEditorKeys in the page', () => {
  it('leaves Enter, Delete and arrows on buttons, radio groups and dropdowns alone, but acts on the canvas', async () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Plain' }).focus();
    await user.keyboard('{Enter}{Delete}{Backspace}{ArrowLeft}');
    screen.getByRole('radio', { name: 'A' }).focus();
    await user.keyboard('{ArrowRight}{ArrowDown}');
    const dropdown = screen.getByRole('combobox');
    dropdown.focus();
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(onAction).not.toHaveBeenCalled();

    screen.getByRole('application', { name: 'Canvas' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(onAction).toHaveBeenCalledWith({ kind: 'nudge', dx: -1, dy: 0 });
  });
});
