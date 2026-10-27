import { Checkbox, CheckboxGroup, Select, SelectItem, Stack } from '@carbon/react';
import { canBeConditionSource, hasOptions, operatorsFor, type DraftCondition, type DraftQuestion } from './surveyModel';

type Props = {
  index: number;
  questions: DraftQuestion[];
  onChange: (condition: DraftCondition | null) => void;
};

function defaultCondition(source: DraftQuestion): DraftCondition {
  return {
    sourceKey: source.key,
    operator: operatorsFor(source.kind)[0].value,
    optionKeys: [],
    numericValue: source.ratingMin,
    booleanValue: true,
  };
}

/** "Show only if…" for one question; the source can only be an earlier question that is not free text. */
export function ConditionEditor({ index, questions, onChange }: Props) {
  const sources = questions.slice(0, index).filter((question) => canBeConditionSource(question.kind));
  const condition = questions[index].condition;
  const source = sources.find((question) => question.key === condition?.sourceKey);
  const id = `survey-condition-${index}`;
  if (sources.length === 0)
    return (
      <p className="settings-section__description">
        Add an earlier choice, rating or yes/no question to make this one conditional.
      </p>
    );
  const sourceNumber = (question: DraftQuestion) => questions.indexOf(question) + 1;
  return (
    <Stack gap={4}>
      <Checkbox
        id={`${id}-enabled`}
        labelText="Show only if an earlier answer matches"
        checked={Boolean(condition)}
        onChange={(_, data) => onChange(data.checked ? defaultCondition(sources[sources.length - 1]) : null)}
      />
      {condition && source && (
        <div className="survey-condition">
          <Select
            id={`${id}-source`}
            labelText="Earlier question"
            value={source.key}
            onChange={(event) => {
              const next = sources.find((question) => question.key === event.target.value);
              if (next) onChange(defaultCondition(next));
            }}
          >
            {sources.map((question) => (
              <SelectItem
                key={question.key}
                value={question.key}
                text={`${sourceNumber(question)}. ${question.prompt || 'Untitled question'}`}
              />
            ))}
          </Select>
          <Select
            id={`${id}-operator`}
            labelText="Answer"
            value={condition.operator}
            onChange={(event) => onChange({ ...condition, operator: event.target.value as DraftCondition['operator'] })}
          >
            {operatorsFor(source.kind).map((operator) => (
              <SelectItem key={operator.value} value={operator.value} text={operator.label} />
            ))}
          </Select>
          {hasOptions(source.kind) && (
            <CheckboxGroup legendText="Options">
              {source.options
                .filter((option) => option.label.trim())
                .map((option) => (
                  <Checkbox
                    key={option.key}
                    id={`${id}-option-${option.key}`}
                    labelText={option.label}
                    checked={condition.optionKeys.includes(option.key)}
                    onChange={(_, data) =>
                      onChange({
                        ...condition,
                        optionKeys: data.checked
                          ? [...condition.optionKeys, option.key]
                          : condition.optionKeys.filter((key) => key !== option.key),
                      })
                    }
                  />
                ))}
            </CheckboxGroup>
          )}
          {source.kind === 'rating' && (
            <Select
              id={`${id}-number`}
              labelText="Rating"
              value={String(condition.numericValue)}
              onChange={(event) => onChange({ ...condition, numericValue: Number(event.target.value) })}
            >
              {Array.from({ length: Math.max(0, source.ratingMax - source.ratingMin + 1) }, (_, i) => (
                <SelectItem key={i} value={String(source.ratingMin + i)} text={String(source.ratingMin + i)} />
              ))}
            </Select>
          )}
          {source.kind === 'yes_no' && (
            <Select
              id={`${id}-boolean`}
              labelText="Value"
              value={String(condition.booleanValue)}
              onChange={(event) => onChange({ ...condition, booleanValue: event.target.value === 'true' })}
            >
              <SelectItem value="true" text="Yes" />
              <SelectItem value="false" text="No" />
            </Select>
          )}
        </div>
      )}
    </Stack>
  );
}
