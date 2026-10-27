import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import type { PublicSurvey, Survey } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const surveyId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const survey = (overrides: Partial<Survey> = {}): Survey => ({
  id: surveyId,
  name: 'Visit feedback',
  description: null,
  status: 'published',
  anonymous: true,
  title: 'How was your visit?',
  introduction: null,
  revision: 1,
  questions: [],
  trigger: null,
  responseCount: 0,
  linkCount: 0,
  version: 2,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

function asStaff(...permissions: PermissionId[]) {
  server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))));
}

describe('survey list', () => {
  it('renders rows and sends status, sort and paging to the API', async () => {
    const requests: URL[] = [];
    asStaff(PermissionId.surveysread, PermissionId.surveysmanage);
    server.use(
      http.get('*/api/v1/surveys', ({ request }) => {
        requests.push(new URL(request.url));
        return HttpResponse.json({ items: [survey({ responseCount: 4, linkCount: 2 })], total: 1 });
      }),
    );
    renderRoute(<App />, '/settings/surveys?status=closed&sort=name:ASC');
    expect(await screen.findByRole('link', { name: 'Visit feedback' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New survey' })).toBeInTheDocument();
    const params = requests.at(-1)!.searchParams;
    expect(params.get('status')).toBe('closed');
    expect(params.get('sort')).toBe('name');
    expect(params.get('order')).toBe('asc');
    expect(params.get('limit')).toBe('10');
    expect(params.get('offset')).toBe('0');
  });

  it('hides creation without the manage permission', async () => {
    asStaff(PermissionId.surveysread);
    server.use(http.get('*/api/v1/surveys', () => HttpResponse.json({ items: [survey()], total: 1 })));
    renderRoute(<App />, '/settings/surveys');
    expect(await screen.findByRole('link', { name: 'Visit feedback' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New survey' })).not.toBeInTheDocument();
  });
});

describe('survey detail', () => {
  const open = async (responseCount: number) => {
    asStaff(PermissionId.surveysread, PermissionId.surveysmanage);
    server.use(http.get('*/api/v1/surveys/:id', () => HttpResponse.json(survey({ responseCount }))));
    renderRoute(<App />, `/settings/surveys/${surveyId}`);
    await screen.findByRole('heading', { name: 'Visit feedback' });
  };

  it('disables edit and delete and explains why once responses exist', async () => {
    await open(3);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect((await screen.findAllByText(/already has 3 responses/)).length).toBeGreaterThan(0);
  });

  it('enables edit and delete without responses', async () => {
    await open(0);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});

const option = (id: string, position: number, label: string) => ({ id, position, label });
const publicSurvey: PublicSurvey = {
  title: 'Feedback',
  introduction: null,
  anonymous: true,
  expiresAt: null,
  questions: [
    { id: 'q1', position: 1, kind: 'yes_no', prompt: 'Did you print?', required: true, options: [], condition: null },
    {
      id: 'q2',
      position: 2,
      kind: 'free_text',
      prompt: 'What did you print?',
      required: true,
      options: [],
      condition: {
        questionId: 'q1',
        questionPosition: 1,
        operator: 'eq',
        optionIds: [],
        booleanValue: true,
        numericValue: null,
      },
    },
    {
      id: 'q3',
      position: 3,
      kind: 'single_choice',
      prompt: 'Come back?',
      required: false,
      options: [option('o1', 1, 'Sure'), option('o2', 2, 'Maybe')],
      condition: null,
    },
  ],
};

describe('public survey page', () => {
  it('hides a conditional question and never submits its answer', async () => {
    let body: { answers: { questionId: string }[] } | undefined;
    server.use(
      http.get('*/api/v1/public/survey-links/tok', () => HttpResponse.json(publicSurvey)),
      http.post('*/api/v1/public/survey-links/tok', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/survey/link/tok');
    expect(await screen.findByText(/Did you print\?/)).toBeInTheDocument();
    expect(screen.queryByText(/What did you print\?/)).not.toBeInTheDocument();

    await user.click(screen.getByText('Yes'));
    await user.type(await screen.findByLabelText(/What did you print\?/), 'A benchy');
    await user.click(screen.getByText('No'));
    expect(screen.queryByText(/What did you print\?/)).not.toBeInTheDocument();
    await user.click(screen.getByText('Sure'));
    await user.click(screen.getByRole('button', { name: 'Submit response' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body!.answers.map((answer) => answer.questionId)).toEqual(['q1', 'q3']);
    expect(await screen.findByText('Your response has been recorded.')).toBeInTheDocument();
  });

  it('does not submit while a visible required question is unanswered', async () => {
    let posted = false;
    server.use(
      http.get('*/api/v1/public/surveys/inv', () => HttpResponse.json(publicSurvey)),
      http.post('*/api/v1/public/surveys/inv', () => {
        posted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/survey/inv');
    await user.click(await screen.findByRole('button', { name: 'Submit response' }));
    expect(await screen.findByText('An answer is required.')).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it.each([
    ['survey_link_inactive', 'This link has been deactivated.'],
    ['survey_link_expired', 'This link has expired.'],
    ['survey_link_full', 'This survey has received all the responses it can take.'],
    ['survey_unavailable', 'This survey is not accepting answers any more.'],
  ])('explains the %s state of a share link', async (code, message) => {
    server.use(
      http.get('*/api/v1/public/survey-links/tok', () =>
        HttpResponse.json({ code, message: 'Gone.' }, { status: 410 }),
      ),
    );
    renderRoute(<App />, '/survey/link/tok');
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});
