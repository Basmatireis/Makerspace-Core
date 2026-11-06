import { InlineLoading, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, Tile } from '@carbon/react';
import { Checkmark } from '@carbon/icons-react';
import type { NotificationCatalogCollection, NotificationRuleDryRun } from '../../../api/generated/models';
import type { DryRunState } from './useDryRun';

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function Match({ matched }: { matched: boolean }) {
  return matched ? (
    <Checkmark size={16} aria-label="Gets through" className="nc-match" />
  ) : (
    <span aria-label="Does not get through" className="nc-miss">
      –
    </span>
  );
}

/** Quiet status line: the answer is being recalculated, or the server could not evaluate the draft. */
export function DryRunStatus({ dry }: { dry: DryRunState }) {
  if (dry.problem) {
    return (
      <p className="nc-note" role="status" data-testid="dry-run-problem">
        The preview could not be calculated yet: {dry.problem}
      </p>
    );
  }
  if (dry.updating) return <InlineLoading className="nc-updating" description="Updating the preview" status="active" />;
  return null;
}

/** The example items the rule would look at, with a mark where they get through. */
export function DryRunTile({
  dry,
  collection,
}: {
  dry: NotificationRuleDryRun;
  collection: NotificationCatalogCollection;
}) {
  const labels = new Map(collection.fields.map((field) => [field.key, field.label]));
  const keys = [...new Set(dry.items.flatMap((item) => Object.keys(item.values)))].slice(0, 3);
  const summaryLabels = new Map(collection.summaryFields.map((field) => [field.key, field.label]));
  const summary = dry.summary;
  return (
    <Tile>
      <h3 className="nc-preview__heading">Dry run</h3>
      <p className="nc-note nc-note--first" data-testid="dry-run-head">
        {summary ? (
          <>
            <strong>
              {dry.matchedItems} of {dry.totalItems}
            </strong>{' '}
            {collection.plural} count.{' '}
            {Object.entries(summary.values).map(([key, value]) => (
              <span key={key}>
                {summaryLabels.get(key) ?? key}: <strong>{value}</strong>.{' '}
              </span>
            ))}
            {summary.pass ? 'The conditions hold: one message.' : 'The conditions do not hold: nothing is sent.'}
          </>
        ) : (
          <>
            <strong>
              {dry.matchedItems} of {dry.totalItems}
            </strong>{' '}
            {collection.plural} get through, so {dry.matchedItems}{' '}
            {plural(dry.matchedItems, 'separate message', 'separate messages')} per action.
          </>
        )}
      </p>
      {dry.items.length > 0 && (
        <Table size="sm" aria-label={`Example ${collection.plural}`} useZebraStyles={false}>
          <TableHead>
            <TableRow>
              <TableHeader>{collection.one.charAt(0).toUpperCase() + collection.one.slice(1)}</TableHeader>
              {keys.map((key) => (
                <TableHeader key={key}>{labels.get(key) ?? key}</TableHeader>
              ))}
              <TableHeader>
                <span className="cds--visually-hidden">Result</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {dry.items.map((item, index) => (
              <TableRow key={`${item.name}-${index}`} className={item.matched ? undefined : 'nc-dry--no'}>
                <TableCell>{item.name}</TableCell>
                {keys.map((key) => (
                  <TableCell key={key}>{item.values[key] ?? ''}</TableCell>
                ))}
                <TableCell>
                  <Match matched={item.matched} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="nc-note">
        Example {collection.plural} only. Each run looks at all {dry.totalItems}.
      </p>
    </Tile>
  );
}

/** Who passes the recipient conditions right now: a list of people, or one verdict about the signed-in person. */
export function RecipientTile({ dry, personal }: { dry: NotificationRuleDryRun; personal: boolean }) {
  if (dry.recipients.length === 0) return null;
  if (personal) {
    const holds = dry.recipients.every((recipient) => recipient.passed);
    return (
      <Tile>
        <h3 className="nc-preview__heading">About you right now</h3>
        <Tag type={holds ? 'green' : 'gray'} size="md">
          {holds ? 'Holds: you would get it' : "Doesn't hold: you get nothing until it does"}
        </Tag>
        <p className="nc-note">Checked again at every run with your current numbers.</p>
      </Tile>
    );
  }
  return (
    <Tile>
      <h3 className="nc-preview__heading">Each recipient</h3>
      <p className="nc-note nc-note--first">Checked per person. Whoever doesn&apos;t match is skipped.</p>
      <Table size="sm" aria-label="Recipient conditions" useZebraStyles={false}>
        <TableHead>
          <TableRow>
            <TableHeader>Recipient</TableHeader>
            <TableHeader>
              <span className="cds--visually-hidden">Result</span>
            </TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {dry.recipients.map((recipient, index) => (
            <TableRow key={`${recipient.name}-${index}`} className={recipient.passed ? undefined : 'nc-dry--no'}>
              <TableCell>{recipient.name}</TableCell>
              <TableCell>
                <Match matched={recipient.passed} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Tile>
  );
}

/** The "How often" tile: the server's estimate of messages per action in 30 days, or why there is none. */
export function EstimateTile({ dry }: { dry: DryRunState }) {
  const data = dry.data;
  return (
    <Tile>
      <h3 className="nc-preview__heading">How often</h3>
      {data && data.estimate30 !== null ? (
        <div className="nc-estimate">
          <span className="nc-estimate__big" data-testid="estimate">
            {data.estimate30}
          </span>
          <span className="nc-note nc-note--first">
            messages per action in the last 30 days, judged by what really happened.
          </span>
        </div>
      ) : (
        !dry.updating && !dry.problem && <p className="nc-note nc-note--first">No estimate for this rule yet.</p>
      )}
      {data?.estimateNote && <p className="nc-note">{data.estimateNote}</p>}
      {data && data.estimate30 !== null && data.estimate30 > 60 && (
        <p className="nc-note nc-note--warn">
          That is a lot. Consider a condition or a limit so people don&apos;t start muting it.
        </p>
      )}
      <DryRunStatus dry={dry} />
    </Tile>
  );
}
