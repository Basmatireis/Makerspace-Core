import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Machine } from '../../../api/generated/models';
import { server } from '../../../test/server';
import { testQueryClient } from '../../../test/render';
import { processes } from '../printerTestData';
import { printFileMissingMessage } from '../recording/recordingText';
import { MachineProblemsNotice } from './MachineProblemsNotice';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../../auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

const now = '2026-11-25T12:00:00Z';
function machine(id: string, name: string, attention: Machine['attention']): Machine {
  return {
    id,
    name,
    process: processes[0],
    status: 'active',
    automaticCollectionEnabled: true,
    jobCount: 1,
    runtimeSeconds: 0,
    failureRate: '0',
    attention,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const storageMessage =
  "The printer's file storage does not answer, so print files and timelapses are not fetched. Restarting the printer usually helps (ftps_timeout).";

function renderNotice() {
  server.use(
    http.get('*/api/v1/machines', () =>
      HttpResponse.json({
        items: [
          machine('0192f6f8-743e-7c77-a349-cd07c3e8c101', 'Bambu H2D', [
            { code: 'printer_storage_unavailable', message: storageMessage },
            { code: 'runs_unassigned', message: 'A recorded run waits for a job.' },
          ]),
          machine('0192f6f8-743e-7c77-a349-cd07c3e8c102', 'Bambu X1C', []),
        ],
        page: 1,
        pageSize: 100,
        total: 2,
      }),
    ),
  );
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter>
        <MachineProblemsNotice />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MachineProblemsNotice', () => {
  it('names the printer whose storage cannot be reached and links to it', async () => {
    auth.permissions = ['machines.read'];
    renderNotice();
    expect(await screen.findByText('A printer needs attention')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bambu H2D' })).toHaveAttribute(
      'href',
      '/workshop/machines/0192f6f8-743e-7c77-a349-cd07c3e8c101',
    );
    expect(screen.getByText(/does not answer/)).toBeInTheDocument();
    expect(screen.queryByText(/waits for a job/)).not.toBeInTheDocument();
    expect(screen.queryByText('Bambu X1C')).not.toBeInTheDocument();
  });

  it('stays hidden without permission to read machines', () => {
    auth.permissions = ['machine_jobs.read'];
    const { container } = renderNotice();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('printFileMissingMessage', () => {
  it('explains a print file the printer storage did not hand out', () => {
    expect(
      printFileMissingMessage({ state: 'missing', reason: 'artifact_retrieval_failed', detail: 'ftps_timeout' }),
    ).toMatch(/stopped answering/);
    expect(printFileMissingMessage({ state: 'pending', reason: 'consumption_pending', detail: null })).toBeNull();
    expect(printFileMissingMessage(null)).toBeNull();
  });
});
