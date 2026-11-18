import vectorFile from '../../../../api/testdata/signage-announcement-contrast.json';
import { describe, expect, it } from 'vitest';
import { announcementTextColor, lookOf } from './announcementLook';

const cases = vectorFile.cases as { color: string; textColor: string | null }[];

describe('announcementTextColor', () => {
  it('has vectors', () => expect(cases.length).toBeGreaterThan(5));
  it.each(cases)('$color gives $textColor', ({ color, textColor }) => {
    expect(announcementTextColor(color)).toBe(textColor);
  });
  it('accepts upper case and refuses anything but #rrggbb', () => {
    expect(announcementTextColor('#0F62FE')).toBe('#ffffff');
    expect(announcementTextColor('red')).toBeNull();
    expect(announcementTextColor('#fff')).toBeNull();
  });
});

describe('lookOf', () => {
  it('derives the text colour and keeps the image', () => {
    expect(lookOf('#f1c21b', '/x')).toEqual({ color: '#f1c21b', textColor: '#161616', imageUrl: '/x' });
    expect(lookOf(null, null)).toEqual({ color: null, textColor: null, imageUrl: null });
  });
});
