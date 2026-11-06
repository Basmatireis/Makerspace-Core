import { useState, type ReactNode } from 'react';
import {
  Button,
  IconButton,
  InlineNotification,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Tag,
  Tile,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffingRules } from '../../api/generated/models';
import { listOpenDayEligibilityRoles } from '../../api/generated/open-days/open-days';
import { updateStaffingRules } from '../../api/generated/supervisors/supervisors';
import { ApiError } from '../../api/http-client';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import {
  isDirty,
  isValid,
  MAX_EXCEPTIONS,
  NUMBER_LIMITS,
  exceptionNote,
  toDraft,
  toRequest,
  validateDraft,
  type NumberField,
  type RulesDraft,
} from './staffingRules';
import { staffingDashboardOptions, staffingKeys, staffingRulesOptions } from './staffingQueries';

type EditState = { draft: RulesDraft; baseVersion: number };

function Card({
  title,
  systemRole,
  description,
  children,
}: {
  title: string;
  systemRole?: boolean;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Tile className="st-card">
      <div className="st-card__head">
        <h3>{title}</h3>
        {systemRole && (
          <Tag type="outline" size="sm">
            System role
          </Tag>
        )}
      </div>
      <p className="st-card__description">{description}</p>
      {children}
    </Tile>
  );
}

const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

/**
 * The staffing rules: minimums per membership, the trainee threshold, the open-day rules and exceptions by extra
 * role. Editing needs `open_days.manage`; everyone else with the page reads them. The draft lives apart from the
 * saved rules, so a rules change by someone else never overwrites it and a stale save shows as a conflict.
 */
export function StaffingRulesTab({ canEdit }: { canEdit: boolean }) {
  const client = useQueryClient();
  const rulesQuery = useQuery(staffingRulesOptions());
  const dashboard = useQuery(staffingDashboardOptions(undefined));
  const roles = useQuery({
    queryKey: ['open-days', 'eligibility-roles'],
    queryFn: ({ signal }) => listOpenDayEligibilityRoles({ signal }),
    enabled: canEdit,
  });
  const [edit, setEdit] = useState<EditState | null>(null);
  const save = useMutation({
    // A stale save means someone else saved first: fetch their rules so Discard shows them.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409)
        void client.invalidateQueries({ queryKey: staffingKeys.rules });
    },
    mutationFn: (request: { draft: RulesDraft; baseVersion: number }) =>
      updateStaffingRules(toRequest(request.draft, request.baseVersion)),
    onSuccess: async (saved: StaffingRules) => {
      client.setQueryData(staffingKeys.rules, saved);
      setEdit(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: staffingKeys.dashboards }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });

  if (rulesQuery.isPending) return <FullPageLoading label="Loading staffing rules" />;
  if (rulesQuery.isError || !rulesQuery.data) {
    return (
      <ErrorState
        title="Unable to load the staffing rules"
        message="Check the connection and try again."
        onRetry={() => void rulesQuery.refetch()}
      />
    );
  }

  const rules = rulesQuery.data;
  const draft = edit?.draft ?? toDraft(rules);
  const dirty = edit !== null && isDirty(edit.draft, rules);
  // Someone saved other rules while this draft was open: keep the draft, but saving would overwrite theirs.
  const superseded = edit !== null && dirty && edit.baseVersion !== rules.version;
  const conflict = save.error instanceof ApiError && save.error.status === 409;
  const errors = validateDraft(draft);
  const rows = dashboard.data?.supervisors ?? [];
  const count = (membership: 'supervisor' | 'trainee') => rows.filter((row) => row.membership === membership).length;

  const change = (patch: Partial<RulesDraft>) => {
    save.reset();
    setEdit({ draft: { ...draft, ...patch }, baseVersion: edit?.baseVersion ?? rules.version });
  };
  const discard = () => {
    save.reset();
    setEdit(null);
  };

  const usedRoleIds = new Set(draft.exceptions.map((exception) => exception.roleId));
  const freeRoles = (roles.data?.items ?? []).filter((role) => !usedRoleIds.has(role.id));
  const setException = (index: number, patch: Partial<RulesDraft['exceptions'][number]>) =>
    change({
      exceptions: draft.exceptions.map((exception, position) =>
        position === index ? { ...exception, ...patch } : exception,
      ),
    });

  const numberField = (field: NumberField, label: string, helperText: string) => (
    <NumberInput
      id={`staffing-${field}`}
      label={label}
      helperText={helperText}
      min={NUMBER_LIMITS[field].min}
      max={NUMBER_LIMITS[field].max}
      step={1}
      allowEmpty
      readOnly={!canEdit}
      hideSteppers={!canEdit}
      value={draft[field]}
      invalid={Boolean(errors.numbers[field])}
      invalidText={errors.numbers[field]}
      onChange={(_event: unknown, state: { value: string | number }) =>
        change({ [field]: state.value === '' ? '' : String(state.value) })
      }
    />
  );

  return (
    <form
      className="st-rules"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (edit && dirty && isValid(errors) && !superseded)
          save.mutate({ draft: edit.draft, baseVersion: edit.baseVersion });
      }}
    >
      <p className="st-intro">
        Supervisor, Trainee and Visitor are system roles like Master: they cannot be renamed or deleted, and every
        person has exactly one of them. Their permissions are edited under Settings › Roles. Everything the app decides
        from these roles is set here.
      </p>
      <div className="st-grid">
        <Card
          title="Supervisor"
          systemRole
          description={`Members who run open days. They take supervisor places; an empty supervisor place makes an open day short-staffed. ${people(count('supervisor'))}.`}
        >
          {numberField('supervisorMinimum', 'Open days per semester', '0 switches the minimum off.')}
        </Card>
        <Card
          title="Trainee"
          systemRole
          description={`New members in their first semester. They take trainee places; empty trainee places never warn. ${people(count('trainee'))}.`}
        >
          <div className="st-fields st-fields--2">
            {numberField('traineeMinimum', 'Open days per semester', 'Trainee and supervisor places both count.')}
            {numberField(
              'traineeReadyAfter',
              'Ready for supervisor after',
              'Open days staffed as trainee. Promotion stays a manual step.',
            )}
          </div>
        </Card>
        <Card
          title="Visitor"
          systemRole
          description="Everyone else, mostly students on open days. Visitors cannot sign up for places and have no minimum."
        >
          <p className="st-secondary">
            Visitors see their Lab Rules status, the upcoming open days and the planned support.
          </p>
        </Card>
        <Card title="Open days" description="Rules for every open day, whatever role someone has.">
          <div className="st-fields">
            {numberField(
              'warningWindowDays',
              'Warn about missing supervisors (days ahead)',
              'Short-staffed open days within this window are marked red and shown to supervisors as "Supervisor needed".',
            )}
            <RadioButtonGroup
              legendText="Counting towards the minimum"
              helperText="By timeslot, a long Saturday with three timeslots counts three times for someone who staffs all three. By open day it counts once."
              name="staffing-count-by"
              orientation="vertical"
              valueSelected={draft.countBy}
              readOnly={!canEdit}
              onChange={(value) => change({ countBy: value === 'open_day' ? 'open_day' : 'timeslot' })}
            >
              <RadioButton id="staffing-count-timeslot" value="timeslot" labelText="Every timeslot counts" />
              <RadioButton id="staffing-count-open-day" value="open_day" labelText="Every open day counts once" />
            </RadioButtonGroup>
            <RadioButtonGroup
              legendText="Sign-up deadline when a period has none"
              name="staffing-default-deadline"
              orientation="vertical"
              valueSelected={draft.defaultDeadline}
              readOnly={!canEdit}
              onChange={(value) =>
                change({ defaultDeadline: value === 'two_weeks_before_end' ? 'two_weeks_before_end' : 'period_end' })
              }
            >
              <RadioButton id="staffing-deadline-end" value="period_end" labelText="End of the period" />
              <RadioButton
                id="staffing-deadline-two-weeks"
                value="two_weeks_before_end"
                labelText="Two weeks before the end"
              />
            </RadioButtonGroup>
          </div>
        </Card>
        <Card
          title="Exceptions by extra role"
          description="People with one of these extra roles get their own minimum. If several apply, the lowest one counts."
        >
          {draft.exceptions.length === 0 ? (
            <p className="st-secondary">No exceptions. Everyone gets the minimum of their system role.</p>
          ) : (
            <ul className="st-exceptions">
              {draft.exceptions.map((exception, index) => {
                const options = [
                  { id: exception.roleId, name: exception.roleName },
                  ...freeRoles.map((role) => ({ id: role.id, name: role.name })),
                ];
                return (
                  <li key={exception.roleId} className="st-exception">
                    <Select
                      id={`staffing-exception-role-${index}`}
                      labelText={`Extra role ${index + 1}`}
                      hideLabel
                      value={exception.roleId}
                      disabled={!canEdit}
                      onChange={(event) => {
                        const role = options.find((option) => option.id === event.target.value);
                        if (role) setException(index, { roleId: role.id, roleName: role.name });
                      }}
                    >
                      {options.map((option) => (
                        <SelectItem key={option.id} value={option.id} text={option.name} />
                      ))}
                    </Select>
                    <NumberInput
                      id={`staffing-exception-minimum-${index}`}
                      label={`Open days per semester for ${exception.roleName}`}
                      hideLabel
                      min={0}
                      max={20}
                      step={1}
                      allowEmpty
                      readOnly={!canEdit}
                      hideSteppers={!canEdit}
                      value={exception.minimum}
                      invalid={Boolean(errors.exceptions[exception.roleId])}
                      invalidText={errors.exceptions[exception.roleId]}
                      onChange={(_event: unknown, state: { value: string | number }) =>
                        setException(index, { minimum: state.value === '' ? '' : String(state.value) })
                      }
                    />
                    {canEdit && (
                      <IconButton
                        label={`Remove exception for ${exception.roleName}`}
                        kind="ghost"
                        size="md"
                        onClick={() =>
                          change({ exceptions: draft.exceptions.filter((_item, position) => position !== index) })
                        }
                      >
                        <TrashCan />
                      </IconButton>
                    )}
                    <small className="st-exception__note">{exceptionNote(exception, rows, draft)}</small>
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit && (
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Add}
              disabled={freeRoles.length === 0 || draft.exceptions.length >= MAX_EXCEPTIONS}
              onClick={() => {
                const role = freeRoles[0];
                if (role)
                  change({ exceptions: [...draft.exceptions, { roleId: role.id, roleName: role.name, minimum: '0' }] });
              }}
            >
              Add exception
            </Button>
          )}
        </Card>
      </div>
      {superseded && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="The rules changed meanwhile"
          subtitle="Someone else saved new rules. Discard your changes to see them."
        />
      )}
      {save.isError && !superseded && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={conflict ? 'The rules changed meanwhile' : 'Rules not saved'}
          subtitle={
            conflict
              ? 'Someone else saved new rules before you. Discard your changes to load them, then edit again.'
              : save.error instanceof ApiError
                ? save.error.message
                : 'Check the connection and try again.'
          }
        />
      )}
      {canEdit && (
        <div className={`st-savebar${dirty ? ' is-dirty' : ''}`} role="region" aria-label="Save staffing rules">
          <p aria-live="polite">
            {dirty ? 'Unsaved changes. They apply to everyone right away when saved.' : 'All rules saved.'}
          </p>
          <Button kind="secondary" size="xl" type="button" disabled={!dirty || save.isPending} onClick={discard}>
            Discard
          </Button>
          <Button
            kind="primary"
            size="xl"
            type="submit"
            disabled={!dirty || !isValid(errors) || save.isPending || superseded}
          >
            {save.isPending ? 'Saving…' : 'Save rules'}
          </Button>
        </div>
      )}
    </form>
  );
}
