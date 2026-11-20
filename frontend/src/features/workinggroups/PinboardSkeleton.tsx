import { SkeletonText, Tile } from '@carbon/react';

/** Holds the place of the dashboard pinboard while its chunk and data load, so the tiles below move only once. */
export default function PinboardSkeleton() {
  return (
    <Tile className="db-pinboard-skeleton" aria-busy="true" aria-label="Loading the pinboard">
      <SkeletonText heading width="10rem" />
      <SkeletonText paragraph lineCount={6} />
    </Tile>
  );
}
