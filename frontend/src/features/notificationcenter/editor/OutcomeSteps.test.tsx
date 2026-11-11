import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { catalogFixture, printerRule } from '../../../test/notificationCenter';
import { renderRoute } from '../../../test/render';
import { ThenStep } from './OutcomeSteps';

const lookup = { machines: new Map(), people: new Map(), roles: new Map() } as never;

function renderThen(channels?: string[]) {
  const catalog = {
    ...catalogFixture,
    triggers: catalogFixture.triggers.map((trigger) =>
      trigger.key === 'printer_error' ? { ...trigger, channels } : trigger,
    ),
  };
  renderRoute(<ThenStep catalog={catalog} definition={printerRule.definition} lookup={lookup} edit={vi.fn()} />);
}

describe('ThenStep channel buttons', () => {
  it('offers every channel when the trigger names none', () => {
    renderThen(undefined);
    expect(screen.getByRole('button', { name: /Signage/i })).toBeInTheDocument();
  });

  it('offers only the channels the trigger allows', () => {
    renderThen(['in_app', 'email']);
    expect(screen.getByRole('button', { name: 'E-mail' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Signage/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tablet/i })).not.toBeInTheDocument();
  });
});
