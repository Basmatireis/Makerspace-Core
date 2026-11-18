import { describe, expect, it } from 'vitest';
import type { TemplateDocument } from './model';
import { sampleDocument, sampleSchema } from './testFixtures';
import {
  conditionPaths,
  insertionPath,
  listPaths,
  loopAliases,
  matchesQuery,
  redactedIn,
  spliceToken,
  variableToken,
} from './variables';

const withLoop = (as: string): TemplateDocument => {
  const doc = sampleDocument();
  const rep = doc.body.find((b) => b.id === 'rep');
  if (rep?.type === 'repeat') rep.as = as;
  return doc;
};

describe('variable insertion', () => {
  it('writes plain paths as they are', () => {
    expect(insertionPath(sampleDocument(), 'request.number')).toBe('request.number');
  });
  it('writes a field of a list with the alias of a loop over that list in the document', () => {
    expect(insertionPath(withLoop('line'), 'items[].amount')).toBe('line.amount');
    expect(loopAliases(withLoop('line'), 'items')).toEqual(['line']);
  });
  it('falls back to the singular of the list when no loop uses it', () => {
    const doc = sampleDocument();
    doc.body = doc.body.filter((b) => b.id !== 'rep');
    expect(loopAliases(doc, 'items')).toEqual([]);
    expect(insertionPath(doc, 'items[].amount')).toBe('item.amount');
    expect(insertionPath(doc, 'order.lines[].text')).toBe('line.text');
  });
  it('splices the token over the selection and puts the caret behind it', () => {
    expect(spliceToken('Hello world', 6, 11, '{{x}}')).toEqual({ value: 'Hello {{x}}', caret: 11 });
    expect(spliceToken('ab', 1, 1, '{{x}}')).toEqual({ value: 'a{{x}}b', caret: 6 });
    expect(spliceToken('ab', 2, 0, 'X')).toEqual({ value: 'X', caret: 1 });
    expect(variableToken('request.number')).toBe('{{request.number}}');
  });
});

describe('schema helpers', () => {
  it('offers single values and the fields of loops in the document for conditions', () => {
    expect(conditionPaths(withLoop('line'), sampleSchema())).toEqual([
      'request.number',
      'request.total',
      'line.description',
      'line.amount',
    ]);
  });
  it('lists the loop sources', () => {
    expect(listPaths(sampleSchema())).toEqual(['items']);
  });
  it('finds redacted paths that a node uses through its loop name', () => {
    const doc = withLoop('line');
    const tbl = {
      id: 'tbl',
      type: 'table' as const,
      source: 'items',
      as: 'line',
      repeatHeader: true,
      columns: [{ header: 'A', value: '{{line.amount | currency}}', width: 1, align: 'left' as const }],
      totals: [],
    };
    expect(redactedIn(doc, tbl, ['items[].amount', 'request.total'])).toEqual(['items[].amount']);
    expect(redactedIn(doc, tbl, [])).toEqual([]);
  });
  it('matches words of a search in any order', () => {
    expect(matchesQuery('number req', 'request.number', 'Request number')).toBe(true);
    expect(matchesQuery('total', 'request.number', 'Request number')).toBe(false);
    expect(matchesQuery('', 'x')).toBe(true);
  });
});
