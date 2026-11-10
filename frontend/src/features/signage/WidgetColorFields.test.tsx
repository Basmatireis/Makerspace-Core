import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SignageWidget } from '../../api/generated/models';
import { WidgetColorFields } from './WidgetColorFields';
import { defaultWidget } from './widgets';

describe('WidgetColorFields', () => {
  it('sets a widget colour and resets it to the default', async () => {
    const onChange = vi.fn<(widget: SignageWidget) => void>();
    const qr = { ...defaultWidget('qr'), lightColor: '#ffeeaa' } as SignageWidget;
    const { rerender } = render(<WidgetColorFields widget={defaultWidget('qr')} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '#123456' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ darkColor: '#123456' }));
    rerender(<WidgetColorFields widget={qr} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Code background: Reset' }));
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty('lightColor');
    await userEvent.click(screen.getByRole('button', { name: 'Code background: transparent' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lightColor: 'transparent' }));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'Transparent' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ darkColor: 'transparent' }));
  });

  it('shows nothing for widgets without own colours', () => {
    const { container } = render(<WidgetColorFields widget={defaultWidget('clock')} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
