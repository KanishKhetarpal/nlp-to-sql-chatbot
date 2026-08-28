import { Injectable } from '@nestjs/common';
import { QueryResult } from './execution.types';

/** Beyond this, a cell is cut short so one long value cannot wreck the table. */
const MAX_CELL_WIDTH = 40;

/**
 * Renders a result set for a person to read.
 *
 * The summary is computed, not generated: it states what came back and nothing
 * more. Asking a model to describe the rows would cost a second round trip and
 * could describe them wrongly, which is a bad trade for a sentence whose whole
 * job is to be trustworthy.
 */
@Injectable()
export class ResultFormatterService {
  /** A fixed-width table, sized to its contents. */
  toTable(result: QueryResult): string {
    if (result.columns.length === 0) {
      return '(no columns)';
    }

    const cells = result.rows.map((row) =>
      result.columns.map((column) => this.render(row[column])),
    );

    const widths = result.columns.map((column, index) =>
      Math.max(
        column.length,
        ...cells.map((row) => row[index]?.length ?? 0),
        // Guards the spread above against an empty result set.
        0,
      ),
    );

    const line = (values: string[]) =>
      values.map((value, index) => value.padEnd(widths[index])).join('  ');

    const rendered = [
      line(result.columns),
      widths.map((width) => '-'.repeat(width)).join('  '),
      ...cells.map(line),
    ];

    if (result.rows.length === 0) {
      rendered.push('(no rows)');
    }

    return rendered.join('\n');
  }

  /** One sentence describing what came back. */
  summarize(result: QueryResult): string {
    if (result.rowCount === 0) {
      return 'No rows matched.';
    }

    // A single cell is almost always the answer to a "how many" question, so
    // it reads better stated outright than described as a one-row table.
    if (result.rowCount === 1 && result.columns.length === 1) {
      const value = this.render(result.rows[0][result.columns[0]]);
      return `${result.columns[0]}: ${value}`;
    }

    if (result.rowCount === 1) {
      const pairs = result.columns
        .map((column) => `${column} = ${this.render(result.rows[0][column])}`)
        .join(', ');
      return `1 row — ${pairs}`;
    }

    const noun = `${result.rowCount} rows`;
    const columns = `${result.columns.length} column${result.columns.length === 1 ? '' : 's'} (${result.columns.join(', ')})`;

    return result.truncated
      ? `${noun} shown, cut off at the row limit — ${columns}.`
      : `${noun}, ${columns}.`;
  }

  /**
   * Renders one value as text.
   *
   * NULL is spelled out rather than left blank, because an empty cell and a
   * missing value look identical in a table and mean different things.
   */
  private render(value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const text =
      typeof value === 'object' ? JSON.stringify(value) : String(value);

    return text.length > MAX_CELL_WIDTH
      ? `${text.slice(0, MAX_CELL_WIDTH - 1)}…`
      : text;
  }
}
