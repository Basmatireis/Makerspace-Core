import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import {
  balanceRule,
  catalogFixture,
  categoriesFixture,
  newsCategoryId,
  printerRule,
  printerRuleId,
  serviceCategoryId,
} from '../../test/notificationCenter';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

function asStaff(...permissions: PermissionId[]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/notification-rules/catalog', () => HttpResponse.json(catalogFixture)),
    http.get('*/api/v1/notification-rules', () => HttpResponse.json({ items: [printerRule, balanceRule] })),
    http.get('*/api/v1/notification-rules/:ruleId', ({ params }) =>
      HttpResponse.json([printerRule, balanceRule].find((rule) => rule.id === params.ruleId)),
    ),
    http.get('*/api/v1/notification-categories', () => HttpResponse.json({ items: categoriesFixture })),
  );
}

const read = PermissionId.notification_rulesread;
const manage = PermissionId.notification_rulesmanage;

describe('rules list', () => {
  it('shows the rules and narrows them with the section tabs', async () => {
    asStaff(read, manage);
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications');
    expect(await screen.findByText('Printer error')).toBeInTheDocument();
    expect(screen.getByText('Open balance reminder')).toBeInTheDocument();
    expect(screen.getByText("Can't be muted")).toBeInTheDocument();
    expect(screen.getByText('News & events')).toBeInTheDocument();
    expect(screen.getByText('A printer reports an error')).toBeInTheDocument();
    expect(screen.getByText('1 step, first after 20 min')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Turned off (1)' }));
    expect(screen.queryByText('Printer error')).not.toBeInTheDocument();
    expect(screen.getByText('Open balance reminder')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'For each (1)' }));
    expect(screen.getByText('Open balance reminder')).toBeInTheDocument();
  });

  it('saves the on switch at once with the version of the rule', async () => {
    asStaff(read, manage);
    let body: unknown;
    server.use(
      http.put('*/api/v1/notification-rules/:ruleId', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...printerRule, enabled: false, version: 4 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications');
    await user.click(await screen.findByRole('switch', { name: 'Printer error is on' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      expectedVersion: 3,
      enabled: false,
      name: 'Printer error',
      categoryId: serviceCategoryId,
      mandatory: true,
    });
  });

  it('offers no creation and no switching without the manage permission', async () => {
    asStaff(read);
    renderRoute(<App />, '/settings/notifications');
    expect(await screen.findByText('Printer error')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New rule/ })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Printer error is on' })).toBeDisabled();
  });
});

describe('rule editor', () => {
  it('creates an event rule with a condition and an in-app action', async () => {
    asStaff(read, manage);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/notification-rules', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...printerRule, id: '0192f6f8-743e-7c77-a349-cd07c3e8d099', version: 1 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications/rules/new?type=event');
    await user.type(await screen.findByLabelText('Name'), 'Big error');

    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(screen.getByLabelText('Field')).toHaveValue('e.severity');

    await user.click(screen.getByRole('button', { name: 'In-app' }));
    await user.click(screen.getByRole('combobox', { name: /To/ }));
    await user.click(await screen.findByRole('option', { name: /Supervisors of the machine/ }));
    await user.type(screen.getByLabelText('Title'), 'Error on ');
    await user.selectOptions(screen.getByLabelText('Insert a field'), 'machine');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      name: 'Big error',
      categoryId: serviceCategoryId,
      enabled: true,
      definition: {
        trigger: { type: 'event', event: 'printer_error' },
        conditions: { mode: 'all', items: [{ field: 'e.severity', op: 'gte', value: 'low' }] },
        actions: [
          {
            channel: 'in_app',
            recipients: ['machine_supervisors'],
            title: 'Error on {machine}',
            inApp: { appearance: 'toast', level: 'info' },
          },
        ],
      },
    });
  });

  it('explains what is missing instead of sending an incomplete rule', async () => {
    asStaff(read, manage);
    const post = vi.fn();
    server.use(http.post('*/api/v1/notification-rules', () => post()));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications/rules/new?type=event');
    await user.click(await screen.findByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Fix these before saving')).toBeInTheDocument();
    expect(screen.getByText('Give the rule a name.')).toBeInTheDocument();
    expect(screen.getByText('Add at least one action under Then.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows the reason of a rejected save', async () => {
    asStaff(read, manage);
    server.use(
      http.put('*/api/v1/notification-rules/:ruleId', () =>
        HttpResponse.json(
          { code: 'validation_failed', message: 'Request validation failed', details: { reason: 'name: too long' } },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);
    await user.type(await screen.findByLabelText('Name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // Once at the top and once at the field it is about.
    expect(await screen.findAllByText('name: too long')).toHaveLength(2);
  });

  it('shows the plain-words sentence of the rule', async () => {
    asStaff(read, manage);
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);
    const sentence = await screen.findByTestId('plain-words');
    expect(sentence).toHaveTextContent('When a printer reports an error: show an error pop-up');
  });

  it('is view only without the manage permission', async () => {
    asStaff(read);
    renderRoute(<App />, `/settings/notifications/rules/${printerRuleId}`);
    const name = await screen.findByLabelText('Name');
    expect(name).toBeDisabled();
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });
});

describe('categories', () => {
  it('lists the categories with their legal basis', async () => {
    asStaff(read, manage);
    renderRoute(<App />, '/settings/notifications?tab=categories');
    expect(await screen.findByText('Always on')).toBeInTheDocument();
    expect(screen.getByText('Asks for consent')).toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeInTheDocument();
  });

  it('creates a category that needs consent', async () => {
    asStaff(read, manage);
    let body: unknown;
    server.use(
      http.post('*/api/v1/notification-categories', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...categoriesFixture[1], id: newsCategoryId, name: 'Surveys' });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications?tab=categories');
    await user.click(await screen.findByRole('button', { name: /New category/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Surveys');
    await user.type(within(dialog).getByLabelText('What people are told'), 'Requests for feedback.');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ name: 'Surveys', description: 'Requests for feedback.', basis: 'consent' });
  });

  it('asks everyone again when editing a consent category', async () => {
    asStaff(read, manage);
    let body: unknown;
    server.use(
      http.put('*/api/v1/notification-categories/:categoryId', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(categoriesFixture[1]);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications?tab=categories');
    await user.click(await screen.findByText('News & events'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Ask everyone again'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ expectedVersion: 4, name: 'News & events', askAgain: true });
  });

  it('keeps the service category read-only', async () => {
    asStaff(read, manage);
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/notifications?tab=categories');
    await user.click(await screen.findByText('Service & safety'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
