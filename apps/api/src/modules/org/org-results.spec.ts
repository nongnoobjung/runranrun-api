import { parseDuration, parseResultsCsv } from './org-results.service';

describe('parseDuration', () => {
  it('reads h:mm:ss, mm:ss, fractions and plain seconds', () => {
    expect(parseDuration('1:52:08')).toBe(6_728_000);
    expect(parseDuration('52:08')).toBe(3_128_000);
    expect(parseDuration('1:52:08.4')).toBe(6_728_400);
    expect(parseDuration('01:02:03,25')).toBe(3_723_250);
    expect(parseDuration('3600')).toBe(3_600_000);
  });

  it('is null when blank and NaN when unreadable', () => {
    expect(parseDuration('  ')).toBeNull();
    expect(parseDuration('1:75:00')).toBeNaN();
    expect(parseDuration('12:60')).toBeNaN();
    expect(parseDuration('abc')).toBeNaN();
    expect(parseDuration('0:00')).toBeNaN();
  });
});

describe('parseResultsCsv', () => {
  it('finds columns by name and infers FIN or DNF', () => {
    const parsed = parseResultsCsv('﻿Bib,Name,Chip Time,Gun Time\r\n0001,A,1:50:00,1:50:30\r\n0002,B,,\r\n\r\n');
    expect(parsed).toEqual({
      rows: [
        { line: 2, bib: '0001', status: 'FIN', chipMs: 6_600_000, gunMs: 6_630_000 },
        { line: 3, bib: '0002', status: 'DNF', chipMs: null, gunMs: null },
      ],
      errors: [],
    });
  });

  it('reports unusable lines and refuses files without the needed columns', () => {
    const parsed = parseResultsCsv('bib,status,chip_time\n,FIN,1:00:00\n0003,WALK,\n0004,FIN,\n0005,FIN,1:xx\n');
    expect('errors' in parsed && parsed.errors.map((e) => e.code)).toEqual(['MISSING_BIB', 'INVALID_STATUS', 'MISSING_TIME', 'INVALID_TIME']);
    expect(parseResultsCsv('name,time\nA,1:00\n')).toEqual({ error: 'The CSV needs a bib column and chip_time, gun_time or status' });
  });
});
