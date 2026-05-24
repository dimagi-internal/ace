import type { DecisionsLog, DecisionRow } from "./decisions-schema.js";
import { effectiveValue } from "./decisions-schema.js";
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
  const yamlEffective = effectiveValue(yamlRow);

  if (parsedRow.value !== undefined && parsedRow.value !== yamlEffective) {
    if (parsedRow.value === yamlRow["ai-default"]) {
      // Parsed value matches the AI default — revert: clear the override
      // and flip status back to applied.
      const { override: _unused, override_reasoning: _unused2, ...withoutOverride } = updated;
      void _unused;
      void _unused2;
      updated = { ...withoutOverride, status: "ai-default" };
    } else {
      updated = {
        ...updated,
        override: parsedRow.value,
        status: "overridden",
      };
    }
    report.defaultsOverridden.push({
      id: yamlRow.id,
      from: yamlEffective,
      to: parsedRow.value,
    });
  }

  if (parsedRow.override_reasoning !== undefined) {
    updated = { ...updated, override_reasoning: parsedRow.override_reasoning };
  }

  if (parsedRow.options) {
    const existing = new Set(updated.options);
    const newlyAdded: string[] = [];
    for (const opt of parsedRow.options) {
      if (!existing.has(opt)) {
        newlyAdded.push(opt);
        existing.add(opt);
      }
    }
    if (newlyAdded.length > 0) {
      updated = {
        ...updated,
        options: [...updated.options, ...newlyAdded],
      };
      for (const opt of newlyAdded) {
        report.optionsAdded.push({ id: yamlRow.id, option: opt });
      }
    }
  }

  return updated;
}
