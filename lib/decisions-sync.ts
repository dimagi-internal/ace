import type { DecisionsLog, DecisionRow } from "./decisions-schema.js";
import type { ParsedDecisionRow } from "./decisions-parser.js";

export type ChangeReport = {
  defaultsOverridden: Array<{ id: string; from: string; to: string }>;
  optionsAdded: Array<{ id: string; option: string }>;
  parsedNotInYaml: string[];
  yamlNotInParsed: string[];
};

export function mergeDecisions(
  parsed: ParsedDecisionRow[],
  current: DecisionsLog,
): { merged: DecisionsLog; report: ChangeReport } {
  const report: ChangeReport = {
    defaultsOverridden: [],
    optionsAdded: [],
    parsedNotInYaml: [],
    yamlNotInParsed: [],
  };

  const parsedById = new Map<string, ParsedDecisionRow>();
  for (const p of parsed) parsedById.set(p.id, p);

  const yamlIds = new Set(current.decisions.map((d) => d.id));
  for (const p of parsed) {
    if (!yamlIds.has(p.id)) report.parsedNotInYaml.push(p.id);
  }
  for (const d of current.decisions) {
    if (!parsedById.has(d.id)) report.yamlNotInParsed.push(d.id);
  }

  const merged: DecisionsLog = {
    ...current,
    decisions: current.decisions.map((d) => mergeRow(d, parsedById.get(d.id), report)),
  };

  return { merged, report };
}

function mergeRow(
  yamlRow: DecisionRow,
  parsedRow: ParsedDecisionRow | undefined,
  report: ChangeReport,
): DecisionRow {
  if (!parsedRow) return yamlRow;

  let updated: DecisionRow = yamlRow;
  const currentValue = yamlRow.override ?? yamlRow["ai-default"];

  if (parsedRow.default !== undefined && parsedRow.default !== currentValue) {
    const newOptions = [...yamlRow.options_considered];
    if (!newOptions.includes(currentValue)) newOptions.push(currentValue);
    if (!newOptions.includes(parsedRow.default)) newOptions.push(parsedRow.default);
    updated = {
      ...updated,
      override: parsedRow.default,
      status: "overridden",
      options_considered: newOptions,
    };
    report.defaultsOverridden.push({
      id: yamlRow.id,
      from: currentValue,
      to: parsedRow.default,
    });
  }

  if (parsedRow.options_considered) {
    const existing = new Set(updated.options_considered);
    const newlyAdded: string[] = [];
    for (const opt of parsedRow.options_considered) {
      if (!existing.has(opt)) {
        newlyAdded.push(opt);
        existing.add(opt);
      }
    }
    if (newlyAdded.length > 0) {
      updated = {
        ...updated,
        options_considered: [...updated.options_considered, ...newlyAdded],
      };
      for (const opt of newlyAdded) {
        report.optionsAdded.push({ id: yamlRow.id, option: opt });
      }
    }
  }

  return updated;
}
