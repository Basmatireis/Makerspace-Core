import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationCatalog, NotificationRule } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import {
  balanceRule,
  catalogFixture,
  categoriesFixture,
  printerRule,
  printerRuleId,
} from '../../test/notificationCenter';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const prusa = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const bambu = '0192f6f8-743e-7c77-a349-cd07c3e8e002';
const machines = [
  { value: prusa, label: 'Prusa CORE One' },
  { value: bambu, label: 'Bambu H2D' },
];

/** The catalog's printer trigger, with machine scope and the machine field a machine-bound trigger has. */
const scopedCatalog: NotificationCatalog = {
  ...catalogFixture,
  triggers: catalogFixture.triggers.map((trigger) => ({
    ...trigger,
    machineScope: true,
    fields: [{ key: 'machine', label: 'Machine', type: 'enum', options: machines, unit: null }, ...trigger.fields],
  })),
};

function serve(rule: NotificationRule, catalog: NotificationCatalog = scopedCatalog) {
  server.use(
    http.get('*/api/v1/auth/me', () =>
      HttpResponse.json(
        currentUserFixture([PermissionId.notification_rulesread, PermissionId.notification_rulesmanage]),
      ),
    ),
    http.get('*/api/v1/notification-rules/catalog', () => HttpResponse.json(catalog)),
    http.get('*/api/v1/notification-rules', () => HttpResponse.json({ items: [rule, balanceRule] })),
    http.get('*/api/v1/notification-rules/:ruleId', () => HttpResponse.json(rule)),
    http.get('*/api/v1/notification-categories', () => HttpResponse.json({ items: categoriesFixture })),
  );
}

describe('machine scope of an event rule', () => {
  it('saves the chosen machines in the trigger and names them in the sentence', async () => {
    serve(printerRule);
    let body: { definition: { trigger: { machines?: string[] } } } | undefined;
    server.use(
      http.put('*/api/v1/notification-rules/:ruleId', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(printerRule);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);

    expect(await screen.findByRole('radio', { name: 'All machines' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Selected machines' }));
    await user.click(await screen.findByRole('combobox', { name: /Only these machines/ }));
    await user.click(await screen.findByRole('option', { name: /Bambu H2D/ }));

    expect(await screen.findByTestId('plain-words')).toHaveTextContent(
      'When a printer reports an error (only on Bambu H2D)',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body!.definition.trigger.machines).toEqual([bambu]);
  });

  it('drops the machines again when All machines is chosen', async () => {
    serve({
      ...printerRule,
      definition: { ...printerRule.definition, trigger: { ...printerRule.definition.trigger, machines: [prusa] } },
    });
    let body: { definition: { trigger: { machines?: string[] } } } | undefined;
    server.use(
      http.put('*/api/v1/notification-rules/:ruleId', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(printerRule);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);

    expect(await screen.findByRole('radio', { name: 'Selected machines' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'All machines' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body!.definition.trigger).not.toHaveProperty('machines');
  });

  it('refuses to save "Selected machines" with no machine chosen', async () => {
    serve(printerRule);
    let saved = false;
    server.use(
      http.put('*/api/v1/notification-rules/:ruleId', () => {
        saved = true;
        return HttpResponse.json(printerRule);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);

    await user.click(await screen.findByRole('radio', { name: 'Selected machines' }));
    expect(screen.queryByText(/reacts to every machine/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose at least one machine')).toBeInTheDocument();
    expect(saved).toBe(false);

    await user.click(screen.getByRole('radio', { name: 'All machines' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toBe(true));
  });

  it('offers no machine choice for a trigger without machine scope', async () => {
    serve(printerRule, catalogFixture);
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);
    await screen.findByTestId('plain-words');
    expect(screen.queryByRole('radio', { name: 'All machines' })).not.toBeInTheDocument();
  });
});
