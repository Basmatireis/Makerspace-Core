import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('../../app/pdf/renderPdf', () => ({
  renderPdf: async (url: string, container: HTMLElement, _signal: AbortSignal, onFirstPage: () => void) => {
    container.textContent = `Mock PDF viewer ${url}`;
    onFirstPage();
  },
}));

const versionId = '0192f6f8-743e-7c77-a349-cd07c3e8a950';
const newVersionId = '0192f6f8-743e-7c77-a349-cd07c3e8a951';
const visit = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a941',
  personId: '0192f6f8-743e-7c77-a349-cd07c3e8a942',
  displayName: 'Grace Hopper',
  checkedInAt: '2026-10-09T12:00:00Z',
  checkedOutAt: null,
  status: 'checked_in',
  checkInMethod: 'pin',
  checkOutMethod: null,
  admissionDecision: 'admitted',
  correctionReason: null,
  version: 1,
};

function mockKiosk(rules = { id: versionId, humanRevision: '2026-09', effectiveAt: '2026-09-01T00:00:00Z' }) {
  let current = rules;
  server.use(
    http.get('*/api/v1/terminal/context', () =>
      HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        allowTapCheckout: true, offerSurveysAtCheckout: false, kioskResetSeconds: 60,
        checkInAssurance: 'low',
        checkOutAssurance: 'low',
        authenticationMethods: ['pin'],
        capabilities: ['nfc'],
        staffDestination: 'login',
      }),
    ),
    http.get('*/api/v1/terminal/presence', () => HttpResponse.json({ items: [], count: 0 })),
    http.get('*/api/v1/terminal/lab-rules', () => HttpResponse.json(current)),
  );
  return {
    publishNewRevision: () => {
      current = { id: newVersionId, humanRevision: '2026-10', effectiveAt: '2026-10-01T00:00:00Z' };
    },
  };
}

async function submitPin(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Check in' }));
  await user.type(await screen.findByLabelText('Login name'), 'grace');
  for (const digit of '123456') await user.click(screen.getByRole('button', { name: digit }));
  await user.click(screen.getAllByRole('button', { name: 'Check in' }).at(-1) as HTMLElement);
}

const refused = (code: string) =>
  HttpResponse.json({ code, message: 'Lab Rules confirmation needed' }, { status: 409 });

describe('kiosk Lab Rules confirmation', () => {
  it('shows the rules to a person who must confirm, then checks them in with the same credentials', async () => {
    const bodies: Record<string, unknown>[] = [];
    mockKiosk();
    server.use(
      http.post('*/api/v1/terminal/check-in/pin', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return 'confirmLabRulesVersionId' in body
          ? HttpResponse.json(visit, { status: 201 })
          : refused('lab_rules_confirmation_required');
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await submitPin(user);

    expect(await screen.findByRole('heading', { name: 'Lab Rules, revision 2026-09' })).toBeInTheDocument();
    expect(await screen.findByText('Mock PDF viewer /api/v1/terminal/lab-rules.pdf')).toBeInTheDocument();
    // Confirmation is mandatory for this role: there is no way to postpone it.
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm and check in' });
    expect(confirm).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: 'I have read the Lab Rules (revision 2026-09) and agree to follow them' }),
    );
    await user.click(confirm);

    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
    expect(bodies).toEqual([
      { loginName: 'grace', pin: '123456' },
      { loginName: 'grace', pin: '123456', confirmLabRulesVersionId: versionId },
    ]);
  });

  it('lets a role that only gets a warning check in later without confirming', async () => {
    const bodies: Record<string, unknown>[] = [];
    mockKiosk();
    server.use(
      http.post('*/api/v1/terminal/check-in/pin', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return body.deferLabRules
          ? HttpResponse.json({ ...visit, admissionDecision: 'warning' }, { status: 201 })
          : refused('lab_rules_confirmation_suggested');
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await submitPin(user);

    await user.click(await screen.findByRole('button', { name: 'Later' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
    expect(bodies.at(-1)).toEqual({ loginName: 'grace', pin: '123456', deferLabRules: true });
  });

  it('reloads the rules and asks again when a newer revision became effective while reading', async () => {
    const kiosk = mockKiosk();
    server.use(
      http.post('*/api/v1/terminal/check-in/pin', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.confirmLabRulesVersionId === versionId) {
          kiosk.publishNewRevision();
          return refused('lab_rules_version_outdated');
        }
        if (body.confirmLabRulesVersionId === newVersionId) return HttpResponse.json(visit, { status: 201 });
        return refused('lab_rules_confirmation_required');
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await submitPin(user);

    await user.click(await screen.findByRole('checkbox', { name: /revision 2026-09/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm and check in' }));

    expect(await screen.findByRole('heading', { name: 'Lab Rules, revision 2026-10' })).toBeInTheDocument();
    expect(screen.getByText('The Lab Rules changed')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /revision 2026-10/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirm and check in' })).toBeDisabled();
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Confirm and check in' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
  });

  it('drops the entered credentials when the person leaves the rules screen', async () => {
    mockKiosk();
    server.use(http.post('*/api/v1/terminal/check-in/pin', () => refused('lab_rules_confirmation_required')));
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await submitPin(user);
    await user.click(await screen.findByRole('button', { name: 'Back' }));

    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(screen.getByLabelText('Login name')).toHaveValue(''));
    expect(screen.getByText('0 digits · 6–12')).toBeInTheDocument();
  });
});
