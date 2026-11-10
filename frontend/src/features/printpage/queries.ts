import { queryOptions } from '@tanstack/react-query';
import { getPrintPage } from '../../api/generated/print-pages/print-pages';

/** How often a page whose timelapse is still being collected asks again. */
export const pendingPollMs = 15_000;

export const printPageKeys = {
  page: (runId: string) => ['print-pages', runId] as const,
};

export const printPageQuery = (runId: string) =>
  queryOptions({
    queryKey: printPageKeys.page(runId),
    queryFn: ({ signal }) => getPrintPage(runId, { signal }),
    retry: false,
    // The connector uploads the video some time after the print ends; until then the page checks back by itself.
    refetchInterval: (query) => {
      const page = query.state.data;
      return page && !page.timelapse && page.timelapseStatus?.state === 'pending' ? pendingPollMs : false;
    },
  });
