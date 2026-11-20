import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkingGroupBudget,
  WorkingGroupBudgetPeriod,
  WorkingGroupProject,
  WorkingGroupPurchase,
  WorkingGroupSummary,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixturePersonId, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const printId = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a001';
const pid = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8d${String(n).padStart(3, '0')}`;
const itemId = pid(500);
const offerA = pid(601);
const offerB = pid(602);
const ada = { personId: fixturePersonId, displayName: 'Ada Lovelace' };
const grace = { personId: otherPersonId, displayName: 'Grace Hopper' };

const group: WorkingGroupSummary = {
  id: printId,
  name: 'Printing',
  description: '',
  lead: grace,
  memberCount: 3,
  machineCount: 0,
  isMember: true,
  isLead: false,
};

const period: WorkingGroupBudgetPeriod = {
  id: periodId,
  name: 'Year 2026',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  totalAmount: '1000.00',
  closed: false,
  current: true,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const budget: WorkingGroupBudget = {
  period,
  groups: [
    { groupId: printId, groupName: 'Printing', given: '400.00', spent: '50.00', reserved: '30.00', free: '320.00' },
  ],
  totals: {
    totalAmount: '1000.00',
    givenSum: '400.00',
    keptBack: '600.00',
    spentSum: '50.00',
    reservedSum: '30.00',
    freeSum: '320.00',
  },
};

const project = (n: number, over: Partial<WorkingGroupProject> = {}): WorkingGroupProject => ({
  id: pid(n),
  groupId: printId,
  groupName: 'Printing',
  title: `Project ${n}`,
  goal: 'Build a laser',
  benefit: 'Faster cuts',
  startsOn: '2026-03-01',
  endsOn: '2026-04-01',
  people: 5,
  plannedIncome: '0.00',
  alcohol: false,
  advanceRequested: false,
  status: 'draft',
  requester: ada,
  totals: { planned: '300.00', inPurchases: '0.00', spent: '0.00', left: '300.00' },
  wirefNeeded: false,
  wirefRequestPending: false,
  hasRequestPdf: false,
  canEdit: true,
  canSubmit: true,
  canDecide: false,
  canComplete: false,
  items: [
    {
      id: itemId,
      position: 1,
      text: 'Laser tube',
      plannedAmount: '300.00',
      needsOffers: false,
      offers: [],
      purchases: [],
    },
  ],
  checklist: { complete: true, open: [] },
  history: [],
  createdAt: '2026-02-01T10:00:00Z',
  version: 4,
  ...over,
});

const purchase = (n: number, over: Partial<WorkingGroupPurchase> = {}): WorkingGroupPurchase => ({
  id: pid(n),
  groupId: printId,
  groupName: 'Printing',
  periodId,
  periodName: 'Year 2026',
  periodClosed: false,
  item: `Item ${n}`,
  quantity: 1,
  unitPrice: '20.00',
  estimatedTotal: '20.00',
  how: 'central',
  status: 'wanted',
  requester: ada,
  needsProject: false,
  hasAttachment: false,
  hasReceipt: false,
  createdAt: '2026-03-01T10:00:00Z',
  canApprove: false,
  canDecline: false,
  canHandInReceipt: false,
  canMarkArrived: false,
  canMarkRefunded: false,
  canDelete: false,
  version: 3,
  ...over,
});

interface Served {
  bodies: Record<string, unknown[]>;
}

function serve(
  permissions: PermissionId[],
  options: {
    member?: boolean;
    projects?: WorkingGroupProject[];
    purchases?: WorkingGroupPurchase[];
    signature?: boolean;
  } = {},
): Served {
  const served: Served = { bodies: {} };
  const record = async (name: string, request: Request) => {
    (served.bodies[name] ??= []).push(await request.json());
  };
  const projects = options.projects ?? [];
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/working-groups', () =>
      HttpResponse.json({ items: [{ ...group, isMember: options.member ?? true }] }),
    ),
    http.get('*/api/v1/working-group-budget-periods', () => HttpResponse.json({ items: [period] })),
    http.get('*/api/v1/working-group-budget', () => HttpResponse.json(budget)),
    http.get('*/api/v1/working-group-purchases', () => HttpResponse.json({ items: options.purchases ?? [] })),
    http.get('*/api/v1/working-group-finance-rules', () =>
      HttpResponse.json({ projectThreshold: '500.00', offersThreshold: '200.00', projectRequests: [], version: 1 }),
    ),
    http.get('*/api/v1/working-group-projects', () => HttpResponse.json({ items: projects })),
    http.get('*/api/v1/working-group-projects/:id', ({ params }) => {
      const found = projects.find((entry) => entry.id === params.id);
      return found ? HttpResponse.json(found) : HttpResponse.json({ code: 'not_found', message: 'x' }, { status: 404 });
    }),
    http.get('*/api/v1/working-group-finance-signature', () =>
      options.signature
        ? new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
        : HttpResponse.json({ code: 'not_found', message: 'none' }, { status: 404 }),
    ),
    ...(['submit', 'return', 'decline', 'approve', 'wiref-decision', 'paid-from', 'send-to-wiref'] as const).map(
      (action) =>
        http.post(`*/api/v1/working-group-projects/:id/${action}`, async ({ request }) => {
          await record(action, request);
          if (action === 'approve' && (served.bodies.approve?.length ?? 0) === 1 && !options.signature) {
            const body = served.bodies.approve[0] as { form?: { signature?: string } };
            if (!body.form?.signature) {
              return HttpResponse.json({ code: 'signature_required', message: 'x' }, { status: 422 });
            }
          }
          return HttpResponse.json(projects[0] ?? project(1));
        }),
    ),
    http.delete('*/api/v1/working-group-projects/:id/offers/:offerId', ({ params }) => {
      (served.bodies.deleteOffer ??= []).push(params.offerId);
      return HttpResponse.json(projects[0] ?? project(1));
    }),
    http.post('*/api/v1/working-group-purchases/:id/to-project', async ({ request }) => {
      await record('to-project', request);
      return HttpResponse.json(project(77, { title: 'From a purchase' }));
    }),
  );
  return served;
}

const member = [PermissionId.working_groupsread];
const financeManager = [PermissionId.working_groupsread, PermissionId.working_group_financesmanage];

const OriginalImage = globalThis.Image;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('Image', OriginalImage);
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe('working group projects', () => {
  it('groups the list and shows the purchase when a sub-row is selected', async () => {
    const user = userEvent.setup();
    serve(member, {
      projects: [project(1, { status: 'draft' }), project(2, { status: 'submitted', title: 'Laser upgrade' })],
      purchases: [purchase(11, { projectId: pid(1), status: 'planned' })],
    });
    renderRoute(<App />, '/working-groups/projects');

    expect(await screen.findByRole('heading', { name: /Waiting for approval/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Drafts/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Item 11/ }));
    expect(await screen.findByText('Purchase · Printing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open project' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Laser upgrade/ }));
    expect(await screen.findByRole('button', { name: 'Open project' })).toBeInTheDocument();
  });

  it('tells a non-member what projects are for', async () => {
    serve(member, { member: false });
    renderRoute(<App />, '/working-groups/projects');
    expect(await screen.findByText('Projects are for the members of a working group.')).toBeInTheDocument();
  });

  it('disables the hand-in while the checklist is open and selects the item from its link', async () => {
    const user = userEvent.setup();
    serve(member, {
      projects: [project(1, { checklist: { complete: false, open: [`item_needs_purchase:${itemId}`] } })],
    });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    expect(await screen.findByRole('button', { name: 'Hand in for approval' })).toBeDisabled();
    await user.click(screen.getByRole('link', { name: /A purchase with a link or PDF: Laser tube/ }));
    expect(await screen.findByText('Cost plan item')).toBeInTheDocument();
  });

  it('requires a reason to return a project', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, { projects: [project(1, { status: 'submitted', canDecide: true })] });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.click(await screen.findByRole('button', { name: 'Return with a comment' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Return' }));
    expect(await within(dialog).findByText('Write a reason.')).toBeInTheDocument();
    expect(served.bodies.return).toBeUndefined();
    await user.type(within(dialog).getByLabelText('Comment'), 'Add offers');
    await user.click(within(dialog).getByRole('button', { name: 'Return' }));
    await waitFor(() => expect(served.bodies.return).toEqual([{ expectedVersion: 4, reason: 'Add offers' }]));
  });

  it('records the WiRef decision with the chosen offer', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, {
      projects: [
        project(1, {
          status: 'wiref',
          canDecide: true,
          items: [
            {
              id: itemId,
              position: 1,
              text: 'Laser tube',
              plannedAmount: '300.00',
              needsOffers: true,
              offers: [
                { id: offerA, shop: 'Shop A', price: '290.00', hasFile: false },
                { id: offerB, shop: 'Shop B', price: '310.00', hasFile: false },
              ],
              purchases: [],
            },
          ],
        }),
      ],
    });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.click(await screen.findByRole('button', { name: 'WiRef approved it' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('WiRef number'), 'W-12');
    await user.selectOptions(within(dialog).getByLabelText('Offer for Laser tube'), offerB);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(served.bodies['wiref-decision']).toEqual([
        { expectedVersion: 4, number: 'W-12', chosenOffers: [{ itemId, offerId: offerB }] },
      ]),
    );
  });

  it('changes where the project is paid from inline', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, { projects: [project(1, { status: 'running', paidFrom: 'group' })] });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.selectOptions(await screen.findByLabelText('Paid from'), 'external');
    await waitFor(() => expect(served.bodies['paid-from']).toEqual([{ expectedVersion: 4, paidFrom: 'external' }]));
  });

  it('turns a purchase into a project and opens it', async () => {
    const user = userEvent.setup();
    const served = serve(member, {
      projects: [],
      purchases: [purchase(11, { needsProject: true })],
    });
    renderRoute(<App />, '/working-groups/purchases');

    await user.click(await screen.findByRole('button', { name: /Item 11/ }));
    await user.click(await screen.findByRole('button', { name: 'Turn into a project' }));
    await waitFor(() => expect(served.bodies['to-project']).toEqual([{ expectedVersion: 3 }]));
  });
});

describe('approving with a signature', () => {
  const approvable = () => project(1, { status: 'submitted', canDecide: true });

  const openExternal = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /External source/ }));
    return dialog;
  };

  it('sends an uploaded signature image', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, { projects: [approvable()] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,QUJD');
    URL.createObjectURL = vi.fn(() => 'blob:signature');
    URL.revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 200;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    const dialog = await openExternal(user);
    await user.click(within(dialog).getByRole('tab', { name: 'Upload an image' }));
    await user.upload(
      within(dialog).getByLabelText('Signature image'),
      new File(['x'], 'sign.png', { type: 'image/png' }),
    );
    await within(dialog).findByAltText('Signature preview');
    await user.click(within(dialog).getByRole('button', { name: 'Approve and send to the WiRef' }));
    await waitFor(() => expect(served.bodies.approve).toHaveLength(1));
    const body = served.bodies.approve[0] as { paidFrom: string; form: { signature: string; projectName: string } };
    expect(body.paidFrom).toBe('external');
    expect(body.form.signature).toBe('QUJD');
    expect(body.form.projectName).toBe('Project 1');
  });

  it('uses the saved signature of the finance manager', async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => 'blob:saved');
    URL.revokeObjectURL = vi.fn();
    const served = serve(financeManager, { projects: [approvable()], signature: true });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    const dialog = await openExternal(user);
    await user.click(await within(dialog).findByRole('tab', { name: 'Saved signature' }));
    await user.click(within(dialog).getByRole('button', { name: 'Approve and send to the WiRef' }));
    await waitFor(() => expect(served.bodies.approve).toHaveLength(1));
    expect((served.bodies.approve[0] as { form: { useSavedSignature: boolean } }).form.useSavedSignature).toBe(true);
  });

  it('shows the message when the signature is missing', async () => {
    const user = userEvent.setup();
    serve(financeManager, { projects: [approvable()] });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    const dialog = await openExternal(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve and send to the WiRef' }));
    expect(
      await within(dialog).findByText('Add a signature before the request goes to the WiRef.'),
    ).toBeInTheDocument();
  });
});

const withOffers = (over: Partial<WorkingGroupProject> = {}) =>
  project(1, {
    items: [
      {
        id: itemId,
        position: 1,
        text: 'Laser tube',
        plannedAmount: '300.00',
        needsOffers: true,
        offers: [
          { id: offerA, shop: 'Shop A', price: '290.00', hasFile: false },
          { id: offerB, shop: 'Shop B', price: '310.00', hasFile: false },
        ],
        purchases: [],
      },
    ],
    ...over,
  });

describe('removing an offer', () => {
  it('asks first and removes the offer', async () => {
    const user = userEvent.setup();
    const served = serve(member, { projects: [withOffers()] });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.click(await screen.findByText('Laser tube'));
    const buttons = await screen.findAllByRole('button', { name: 'Remove offer' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]);
    const dialog = await screen.findByRole('alertdialog');
    expect(served.bodies.deleteOffer).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Remove offer' }));
    await waitFor(() => expect(served.bodies.deleteOffer).toEqual([offerB]));
  });

  it('offers no removal to someone who may not edit the plan', async () => {
    const user = userEvent.setup();
    serve(member, { projects: [withOffers({ canEdit: false, canSubmit: false, status: 'submitted' })] });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.click(await screen.findByText('Laser tube'));
    await screen.findByText('Shop A · €290.00', { exact: false });
    expect(screen.queryByRole('button', { name: 'Remove offer' })).not.toBeInTheDocument();
  });
});

describe('sending to the WiRef', () => {
  const pending = (over: Partial<WorkingGroupProject> = {}) =>
    project(1, { status: 'running', wirefNeeded: true, wirefRequestPending: true, ...over });

  it('sends directly when a signature is stored', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, { projects: [pending({ signatureMissing: false })] });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.click(await screen.findByRole('button', { name: 'Send to the WiRef' }));
    await waitFor(() => expect(served.bodies['send-to-wiref']).toEqual([{ expectedVersion: 4 }]));
  });

  it('asks for a signature first when none is stored and sends the saved one', async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => 'blob:saved');
    URL.revokeObjectURL = vi.fn();
    const served = serve(financeManager, { projects: [pending({ signatureMissing: true })], signature: true });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.click(await screen.findByRole('button', { name: 'Send to the WiRef' }));
    const dialog = await screen.findByRole('dialog');
    expect(served.bodies['send-to-wiref']).toBeUndefined();
    await user.click(await within(dialog).findByRole('tab', { name: 'Saved signature' }));
    await user.click(within(dialog).getByRole('button', { name: 'Send to the WiRef' }));
    await waitFor(() =>
      expect(served.bodies['send-to-wiref']).toEqual([{ expectedVersion: 4, useSavedSignature: true }]),
    );
  });

  it('does not send without a signature', async () => {
    const user = userEvent.setup();
    const served = serve(financeManager, { projects: [pending({ signatureMissing: true })] });
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);

    await user.click(await screen.findByRole('button', { name: 'Send to the WiRef' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send to the WiRef' }));
    expect(
      await within(dialog).findByText('Add a signature before the request goes to the WiRef.'),
    ).toBeInTheDocument();
    expect(served.bodies['send-to-wiref']).toBeUndefined();
  });
});

describe('purchases on a cost plan item', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    renderRoute(<App />, `/working-groups/projects/${pid(1)}`);
    await user.click(await screen.findByText('Laser tube'));
    await screen.findByText('Cost plan item');
  };

  it('is not offered to a member who neither leads nor requested the draft', async () => {
    const user = userEvent.setup();
    serve(member, { projects: [project(1, { canEdit: false, canSubmit: false })] });
    await open(user);
    expect(screen.queryByRole('button', { name: 'Add the purchase' })).not.toBeInTheDocument();
  });

  it('is offered to the requester of a draft', async () => {
    const user = userEvent.setup();
    serve(member, { projects: [project(1)] });
    await open(user);
    expect(screen.getByRole('button', { name: 'Add the purchase' })).toBeInTheDocument();
  });

  it('is not offered to the requester after the hand-in', async () => {
    const user = userEvent.setup();
    serve(member, { projects: [project(1, { status: 'submitted', canEdit: false, canSubmit: false })] });
    await open(user);
    expect(screen.queryByRole('button', { name: 'Add the purchase' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make a purchase' })).not.toBeInTheDocument();
  });

  it('is not offered to a finance manager on a draft they do not own', async () => {
    const user = userEvent.setup();
    serve(financeManager, { projects: [project(1, { canEdit: true, canSubmit: false })] });
    await open(user);
    expect(screen.queryByRole('button', { name: 'Add the purchase' })).not.toBeInTheDocument();
  });

  it('is a normal purchase while the project runs', async () => {
    const user = userEvent.setup();
    serve(member, { projects: [project(1, { status: 'running', canEdit: false, canSubmit: false })] });
    await open(user);
    expect(screen.getByRole('button', { name: 'Make a purchase' })).toBeInTheDocument();
  });
});
