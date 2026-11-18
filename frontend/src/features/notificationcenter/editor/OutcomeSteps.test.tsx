import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationRuleSignageShownOn } from '../../../api/generated/models';
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

describe('ThenStep signage action', () => {
  const definition = {
    ...printerRule.definition,
    actions: [
      {
        channel: 'signage',
        delayMinutes: 0,
        recipients: [],
        title: 'Down',
        signage: { durationMinutes: 15, tone: 'warning' },
      },
    ],
    escalation: null,
  } as never;
  const render = (signageShownOn?: NotificationRuleSignageShownOn, signageLinks = true) =>
    renderRoute(
      <ThenStep
        catalog={catalogFixture}
        definition={definition}
        lookup={lookup}
        edit={vi.fn()}
        signageShownOn={signageShownOn}
        signageLinks={signageLinks}
      />,
    );

  it('lists the displays and groups that show the rule', () => {
    render({
      displays: [{ id: 'd1', name: 'Entrance', allRules: false }],
      groups: [{ id: 'g1', name: 'Hallway', allRules: true }],
    });
    expect(screen.getByRole('link', { name: 'Entrance' })).toBeInTheDocument();
    expect(screen.getByText(/\(all notices\)/)).toBeInTheDocument();
    expect(screen.queryByText('Choose displays')).not.toBeInTheDocument();
  });

  it('names the displays without links for someone who cannot open signage', () => {
    render({ displays: [{ id: 'd1', name: 'Entrance', allRules: false }], groups: [] }, false);
    expect(screen.getByText('Entrance')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Entrance' })).not.toBeInTheDocument();
  });

  it('says so when no display shows the rule', () => {
    render({ displays: [], groups: [] });
    expect(screen.getByText(/No display shows this rule's notices yet/)).toBeInTheDocument();
  });

  it('hints at choosing after saving for a new rule', () => {
    render(undefined);
    expect(screen.getByText(/Once the rule is saved/)).toBeInTheDocument();
  });
});
