import { InlineNotification, Search, Tag } from '@carbon/react';
import { Locked } from '../icons';
import { useState } from 'react';
import { insertIntoLastField, useInsertRegistry } from '../insertTarget';
import type { VariablesPanelProps } from '../types';
import { insertionPath, matchesQuery, TYPE_NAMES, variableToken } from '../variables';
import { PanelProvider } from './fields/PanelProvider';

/**
 * Variables tab of the left pane: the export's fields with description and example, searchable. A click inserts
 * `{{path}}` at the caret of the text field of the Properties panel that was focused last.
 */
export function VariablesPanel({ doc, schema, onChange }: VariablesPanelProps) {
  const registry = useInsertRegistry();
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<{ kind: 'success' | 'info'; text: string } | null>(null);

  const insert = (path: string) => {
    const written = insertionPath(doc, path);
    const token = variableToken(written);
    if (registry && insertIntoLastField(registry, token)) setNotice({ kind: 'success', text: `Inserted ${token}` });
    else setNotice({ kind: 'info', text: `Click into a text field in Properties first, then pick ${token}` });
  };

  const groups = schema.groups
    .map((g) => ({ ...g, fields: g.fields.filter((f) => matchesQuery(query, f.path, f.description)) }))
    .filter((g) => g.fields.length);
  const filters = schema.filters.filter((f) => matchesQuery(query, f.name, f.description));

  return (
    <div data-testid="variables-panel" className="pdft-panel pdft-vars">
      <PanelProvider doc={doc} schema={schema} onChange={onChange}>
        <Search
          size="sm"
          labelText="Search variables"
          placeholder="Search variables"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="pdft-hint">
          Click a variable to insert it into the text field you edited last. Inside a loop, write the loop name instead
          of the list, e.g. item.amount.
        </p>
        <div role="status" aria-live="polite">
          {notice && (
            <InlineNotification
              kind={notice.kind}
              lowContrast
              hideCloseButton
              title={notice.kind === 'success' ? 'Inserted' : 'No text field'}
              subtitle={notice.text}
            />
          )}
        </div>
        {groups.map((g) => (
          <section key={g.name} aria-label={g.name} className="pdft-vargroup">
            <h3 className="pdft-subhead">
              {g.name}
              {g.description && <span className="pdft-vargroup__desc"> · {g.description}</span>}
            </h3>
            {g.fields.map((f) => (
              <button key={f.path} type="button" className="pdft-var" onClick={() => insert(f.path)}>
                <span className="pdft-var__top">
                  <code className="pdft-mono">{f.path}</code>
                  <span className="pdft-var__type">{TYPE_NAMES[f.type] ?? f.type}</span>
                  {f.permission && (
                    <Tag type="purple" size="sm" renderIcon={Locked} title="Empty for readers without this permission">
                      {f.permission}
                    </Tag>
                  )}
                </span>
                {f.description && <span className="pdft-var__desc">{f.description}</span>}
                {f.example && <span className="pdft-var__example">e.g. {f.example}</span>}
              </button>
            ))}
          </section>
        ))}
        {!groups.length && <p className="pdft-hint">No variable matches.</p>}
        {filters.length > 0 && (
          <section aria-label="Filters" className="pdft-vargroup">
            <h3 className="pdft-subhead">Filters</h3>
            {filters.map((f) => (
              <p key={f.name} className="pdft-filter">
                <code className="pdft-mono">| {f.name}</code> {f.description}
              </p>
            ))}
          </section>
        )}
      </PanelProvider>
    </div>
  );
}
