import readline from 'node:readline';

const isTTY = process.stdout.isTTY;

// ── ANSI color helpers ──────────────────────────────────────────────────────
const colors = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

/**
 * Print an aligned table to stdout.
 * @param {string[]} headers - Column header labels.
 * @param {Array<string[]>} rows - Array of row arrays.
 */
export function table(headers, rows) {
  // Calculate column widths
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => {
      const val = row[i] !== undefined ? String(row[i]) : '';
      return Math.max(max, val.length);
    }, 0);
    return Math.max(h.length, maxRow);
  });

  // Format a single row with padding
  const formatRow = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(colWidths[i])).join('  ');

  // Header
  console.log(
    `${colors.bold}${formatRow(headers)}${colors.reset}`
  );

  // Separator
  console.log(
    colWidths.map((w) => '─'.repeat(w)).join('──')
  );

  // Data rows
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

/**
 * Print a success message with a green checkmark.
 */
export function success(msg) {
  console.log(`${colors.green}\u2714${colors.reset} ${msg}`);
}

/**
 * Print an error message with a red X.
 */
export function error(msg) {
  console.error(`${colors.red}\u2718${colors.reset} ${msg}`);
}

/**
 * Print a warning message with a yellow indicator.
 */
export function warn(msg) {
  console.warn(`${colors.yellow}\u26A0${colors.reset} ${msg}`);
}

/**
 * Print an info message with a blue indicator.
 */
export function info(msg) {
  console.log(`${colors.blue}\u2139${colors.reset} ${msg}`);
}

/**
 * Print data as formatted JSON.
 */
export function json(data) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Prompt the user for a yes/no confirmation.
 * Returns a promise that resolves to true (yes) or false (no).
 */
export async function confirm(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}
