import { readFileSync, existsSync } from 'fs';
import { resolve, sep } from 'path';
import { parse } from 'csv-parse/sync';
import chalk from 'chalk';

export function loadTestSuite(config) {
  const projectRoot = process.cwd();
  const csvPath = resolve(projectRoot, config.testSuite.path);

  if (!csvPath.startsWith(projectRoot + sep) && csvPath !== projectRoot) {
    throw new Error(`testSuite.path must be inside the project directory, got: ${config.testSuite.path}`);
  }

  if (!existsSync(csvPath)) {
    throw new Error(`Test suite CSV not found at ${config.testSuite.path}. Check testSuite.path in config.`);
  }

  const raw = readFileSync(csvPath, 'utf8');

  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    delimiter: detectDelimiter(raw),
  });

  const colName = config.testSuite.columns?.name ?? 'Test Case Name';
  const colArea = config.testSuite.columns?.area ?? 'Feature Area';
  const colPriority = config.testSuite.columns?.priority ?? 'Priority';

  const warnedCols = new Set();

  return records.map(row => {
    const name = row[colName];
    const area = row[colArea];
    const priority = row[colPriority];

    if (!name && !warnedCols.has(colName)) {
      console.error(chalk.yellow(`Warning: column "${colName}" not found in CSV — skipping name mapping.`));
      warnedCols.add(colName);
    }
    if (!area && !warnedCols.has(colArea)) {
      console.error(chalk.yellow(`Warning: column "${colArea}" not found in CSV — skipping area mapping.`));
      warnedCols.add(colArea);
    }

    return {
      name: (name ?? '').trim(),
      area: (area ?? '').trim(),
      priority: (priority ?? '').trim(),
    };
  }).filter(t => t.name);
}

function detectDelimiter(raw) {
  const firstLine = raw.split('\n')[0] ?? '';
  const counts = {
    ',': (firstLine.match(/,/g) ?? []).length,
    ';': (firstLine.match(/;/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function findRelevantTests(testSuite, areas) {
  if (!areas || areas.length === 0) return testSuite;

  const lowerAreas = areas.map(a => a.toLowerCase());

  const matched = testSuite.filter(test =>
    lowerAreas.some(area => test.area.toLowerCase().includes(area) || area.includes(test.area.toLowerCase()))
  );

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return matched.sort((a, b) => {
    const pa = priorityOrder[a.priority.toLowerCase()] ?? 3;
    const pb = priorityOrder[b.priority.toLowerCase()] ?? 3;
    return pa - pb;
  });
}
