import { lazy, Suspense } from 'react';
import { SkeletonPlaceholder, SkeletonText, Tile } from '@carbon/react';
import type { PersonalJobMonth } from '../../api/generated/models';

// Carbon Charts and their stylesheet load only through this lazy boundary.
const JobsChart = lazy(() => import('./JobsChart'));

export function JobsPerMonth({ months }: { months: PersonalJobMonth[] }) {
  return (
    <Suspense
      fallback={
        <Tile className="db-chart" aria-busy="true">
          <SkeletonText heading width="40%" />
          <SkeletonPlaceholder style={{ inlineSize: '100%', blockSize: '240px' }} />
        </Tile>
      }
    >
      <JobsChart months={months} />
    </Suspense>
  );
}
