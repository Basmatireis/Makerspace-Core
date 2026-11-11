import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
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
const visit = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a941',
  personId: '0192f6f8-743e-7c77-a349-cd07c3e8a942',
  displayName: 'Grace Hopper',
  checkedInAt: '2026-10-09T12:00:00Z',
  checkedOutAt: null,
  status: 'checked_in',
  checkInMethod: 'email_code',
  checkOutMethod: null,
  admissionDecision: 'admitted',
  correctionReason: null,
  version: 1,
};

function mockKiosk(methods: string[] = ['pin', 'email_code']) {
  server.use(
    http.get('*/api/v1/terminal/context', () =>
      HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        allowTapCheckout: true,
        offerSurveysAtCheckout: false,
        kioskResetSeconds: 60,
        checkInMethods: methods,
        checkOutMethods: methods,
        capabilities: ['nfc'],
        staffDestination: 'login',
      }),
    ),
    http.get('*/api/v1/terminal/presence', () => HttpResponse.json({ items: [], count: 0 })),
    http.get('*/api/v1/terminal/lab-rules', () =>
      HttpResponse.json({ id: versionId, humanRevision: '2026-09', effectiveAt: '2026-09-01T00:00:00Z' }),
    ),
  );
}

async function requestCode(user: ReturnType<typeof userEvent.setup>, requests: unknown[]) {
  server.use(
    http.post('*/api/v1/terminal/email-code', async ({ request }) => {
      requests.push(await request.json());
      return new HttpResponse(null, { status: 202 });
    }),
  );
  await user.click(await screen.findByRole('button', { name: 'Check in' }));
  await user.type(await screen.findByLabelText('Email'), 'grace@example.test');
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  const code = await screen.findByLabelText('Code');
  expect(code).toHaveFocus();
  // The on-screen keypad enters the digits, so the tablet keyboard stays closed.
  expect(code).toHaveAttribute('inputmode', 'none');
  expect(screen.getByRole('group', { name: 'Code keypad' })).toBeInTheDocument();
  // The register callout and the method switcher make room for the code and its keypad.
  expect(screen.queryByText('First time here?')).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Email code' })).toBeNull();
  return code;
}

describe('kiosk check-in with an emailed code', () => {
  it('offers the email code first, mails a code and checks the person in with it', async () => {
    const mails: unknown[] = [];
    const bodies: unknown[] = [];
    mockKiosk();
    server.use(
      http.post('*/api/v1/terminal/check-in/email-code', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(visit, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    expect(await screen.findByRole('tab', { name: 'Email code' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Login name and PIN' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));

    const code = await requestCode(user, mails);
    expect(mails).toEqual([{ email: 'grace@example.test' }]);
    const submit = screen.getAllByRole('button', { name: 'Check in' }).at(-1) as HTMLElement;
    expect(submit).toBeDisabled();
    await user.type(code, '12345a6');
    expect(code).toHaveValue('123456');
    await user.click(submit);

    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
    expect(bodies).toEqual([{ email: 'grace@example.test', code: '123456' }]);
  });

  it('says so when the code is wrong or expired and lets the person ask for a new one', async () => {
    const mails: unknown[] = [];
    mockKiosk(['email_code']);
    server.use(
      http.post('*/api/v1/terminal/check-in/email-code', () =>
        HttpResponse.json({ code: 'invalid_credentials', message: 'Invalid' }, { status: 401 }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    const code = await requestCode(user, mails);
    await user.type(code, '000000');
    await user.click(screen.getAllByRole('button', { name: 'Check in' }).at(-1) as HTMLElement);

    expect(await screen.findByText('The code is not correct or has expired.')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(mails).toHaveLength(2);
  });

  it('resubmits the same code after the person confirmed the Lab Rules', async () => {
    const mails: unknown[] = [];
    const bodies: Record<string, unknown>[] = [];
    mockKiosk(['email_code']);
    server.use(
      http.post('*/api/v1/terminal/check-in/email-code', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return 'confirmLabRulesVersionId' in body
          ? HttpResponse.json(visit, { status: 201 })
          : HttpResponse.json({ code: 'lab_rules_confirmation_required', message: 'Confirm' }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    const code = await requestCode(user, mails);
    await user.type(code, '123456');
    await user.click(screen.getAllByRole('button', { name: 'Check in' }).at(-1) as HTMLElement);

    expect(await screen.findByRole('heading', { name: 'Lab Rules, revision 2026-09' })).toBeInTheDocument();
    await user.click(
      screen.getByRole('checkbox', { name: 'I have read the Lab Rules (revision 2026-09) and agree to follow them' }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm and check in' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Grace!' })).toBeInTheDocument();
    expect(bodies).toEqual([
      { email: 'grace@example.test', code: '123456' },
      { email: 'grace@example.test', code: '123456', confirmLabRulesVersionId: versionId },
    ]);
    expect(mails).toHaveLength(1);
  });
});
