import { csvField, csvRow, toCsv, UTF8_BOM } from './csv';

describe('csvField', () => {
  it('leaves a plain value alone', () => {
    expect(csvField('Tiền điện')).toBe('Tiền điện');
    expect(csvField(1500000)).toBe('1500000');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes a value carrying a comma', () => {
    expect(csvField('Ăn uống, đi lại')).toBe('"Ăn uống, đi lại"');
  });

  it('doubles an embedded quote', () => {
    expect(csvField('Quỹ "dự phòng"')).toBe('"Quỹ ""dự phòng"""');
  });

  it('quotes a value carrying a newline', () => {
    expect(csvField('dòng 1\ndòng 2')).toBe('"dòng 1\ndòng 2"');
  });

  // A note beginning `=` is a formula to Excel and Sheets, so it would run on
  // open. The tab neutralises it while keeping the text readable.
  describe('formula injection', () => {
    it.each(['=1+1', '+1', '-1', '@SUM(A1)'])('neutralises %s', (input) => {
      expect(csvField(input)).toBe(`\t${input}`);
    });

    it('still quotes a neutralised value that also needs quoting', () => {
      expect(csvField('=cmd|"/c calc"!A1')).toBe('"\t=cmd|""/c calc""!A1"');
    });

    // A minus sign only leads a FORMULA at the start of the cell. A negative
    // amount is the app's most ordinary value and must stay a number.
    it('leaves a negative number as a number', () => {
      expect(csvField(-1500)).toBe('\t-1500');
    });
  });
});

describe('csvRow', () => {
  it('joins fields with commas', () => {
    expect(csvRow(['a', 1, null, true])).toBe('a,1,,true');
  });
});

describe('toCsv', () => {
  it('leads with a BOM so Excel reads Vietnamese correctly', () => {
    expect(toCsv(['name'], [['Tiền điện']]).startsWith(UTF8_BOM)).toBe(true);
  });

  it('writes a header row then one row per record, CRLF-separated', () => {
    const csv = toCsv(
      ['name', 'amount'],
      [
        ['Tiền điện', 500000],
        ['Tiền nước', 120000],
      ],
    );

    expect(csv).toBe(
      `${UTF8_BOM}name,amount\r\nTiền điện,500000\r\nTiền nước,120000\r\n`,
    );
  });

  it('writes just the header when there is nothing to export', () => {
    expect(toCsv(['name'], [])).toBe(`${UTF8_BOM}name\r\n`);
  });
});
