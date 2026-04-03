/**
 * Structural validator for Nova blueprints.
 * Hard pass/fail checks — no LLM judgment. These are things that
 * WILL break if wrong.
 */

export interface ValidationResult {
  passed: boolean;
  errors: string[];     // Hard failures — app won't work
  warnings: string[];   // Soft issues — app works but degraded
  connectReadiness: ConnectReadiness;
}

export interface ConnectReadiness {
  canDeriveLearnModules: boolean;
  canDeriveDeliverUnits: boolean;
  canDeriveTasks: boolean;
  canDeriveAssessments: boolean;
  canDeriveValidationRules: boolean;
  missingForConnect: string[];
}

const RESERVED_CASE_PROPERTIES = [
  'case_id', 'case_type', 'case_name', 'date_opened', 'date_modified',
  'owner_id', 'external_id', 'closed', 'name',
];

export function validateBlueprint(
  blueprint: Record<string, unknown>,
  appType: 'learn' | 'deliver',
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const bp = blueprint as any;

  // ========== TOP-LEVEL CHECKS ==========

  if (!bp.app_name || typeof bp.app_name !== 'string') {
    errors.push('MISSING: app_name is required');
  }

  if (!bp.connect_type) {
    errors.push(`MISSING: connect_type not set (expected "${appType}")`);
  } else if (bp.connect_type !== appType) {
    errors.push(`WRONG: connect_type is "${bp.connect_type}" but expected "${appType}"`);
  }

  if (!Array.isArray(bp.modules) || bp.modules.length === 0) {
    errors.push('MISSING: modules array is empty or missing');
    return { passed: false, errors, warnings, connectReadiness: emptyReadiness() };
  }

  // ========== MODULE CHECKS ==========

  for (const mod of bp.modules) {
    const modName = mod.name || '(unnamed module)';

    if (!mod.name) {
      errors.push(`MISSING: module name`);
    }

    if (!Array.isArray(mod.forms) || mod.forms.length === 0) {
      errors.push(`${modName}: no forms`);
      continue;
    }

    for (const form of mod.forms) {
      const formName = form.name || '(unnamed form)';
      const formPath = `${modName} → ${formName}`;

      if (!form.name) errors.push(`${modName}: form missing name`);

      if (!['registration', 'followup', 'survey'].includes(form.type)) {
        errors.push(`${formPath}: invalid form type "${form.type}" (must be registration/followup/survey)`);
      }

      // Case type required for registration/followup
      if (['registration', 'followup'].includes(form.type) && !mod.case_type) {
        errors.push(`${formPath}: type is "${form.type}" but module has no case_type`);
      }

      if (!Array.isArray(form.questions) || form.questions.length === 0) {
        errors.push(`${formPath}: no questions`);
        continue;
      }

      // Check questions
      const questionIds = new Set<string>();
      let hasCaseName = false;

      for (const q of form.questions) {
        if (!q.id) {
          errors.push(`${formPath}: question missing id`);
          continue;
        }

        if (questionIds.has(q.id)) {
          errors.push(`${formPath}: duplicate question id "${q.id}"`);
        }
        questionIds.add(q.id);

        // Type checks
        if (!q.type) {
          errors.push(`${formPath}: question "${q.id}" missing type`);
        }

        // Select without options
        if (['select1', 'select'].includes(q.type)) {
          if (!Array.isArray(q.options) || q.options.length === 0) {
            errors.push(`${formPath}: "${q.id}" is ${q.type} but has no options`);
          }
        }

        // Hidden without calculate or default_value
        if (q.type === 'hidden' && !q.calculate && !q.default_value) {
          errors.push(`${formPath}: "${q.id}" is hidden but has no calculate or default_value`);
        }

        // Case name
        if (q.is_case_name) hasCaseName = true;

        // Reserved case properties
        if (q.case_property && RESERVED_CASE_PROPERTIES.includes(q.case_property)) {
          errors.push(`${formPath}: "${q.id}" uses reserved case property "${q.case_property}"`);
        }

        // Label without label text
        if (q.type !== 'hidden' && q.type !== 'label' && !q.label) {
          warnings.push(`${formPath}: "${q.id}" (${q.type}) has no label`);
        }
      }

      // Registration must have case_name
      if (form.type === 'registration' && !hasCaseName) {
        errors.push(`${formPath}: registration form has no question with is_case_name: true`);
      }

      // Close case on non-followup
      if (form.close_case && form.type !== 'followup') {
        errors.push(`${formPath}: close_case on non-followup form`);
      }
    }
  }

  // ========== LEARN APP SPECIFIC ==========

  if (appType === 'learn') {
    // Should NOT have case management
    if (bp.case_types && Array.isArray(bp.case_types) && bp.case_types.length > 0) {
      warnings.push('Learn app has case_types defined — Learn apps typically have no case management');
    }

    // Every form should be survey type
    for (const mod of bp.modules) {
      for (const form of mod.forms || []) {
        if (form.type !== 'survey') {
          warnings.push(`${mod.name} → ${form.name}: Learn app form should be "survey" type, got "${form.type}"`);
        }
      }
    }
  }

  // ========== DELIVER APP SPECIFIC ==========

  if (appType === 'deliver') {
    // Must have case types
    if (!bp.case_types || !Array.isArray(bp.case_types) || bp.case_types.length === 0) {
      errors.push('Deliver app has no case_types — Deliver apps need case management');
    } else {
      for (const ct of bp.case_types) {
        if (!ct.name) errors.push('Case type missing name');
        if (!ct.case_name_property) errors.push(`Case type "${ct.name || '?'}": missing case_name_property`);
      }
    }

    // Must have at least one registration form
    const hasRegistration = bp.modules.some((m: any) =>
      m.forms?.some((f: any) => f.type === 'registration')
    );
    if (!hasRegistration) {
      errors.push('Deliver app has no registration form — how do cases get created?');
    }
  }

  // ========== CONNECT READINESS ==========

  const connectReadiness = checkConnectReadiness(bp, appType);

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    connectReadiness,
  };
}

function checkConnectReadiness(bp: any, appType: 'learn' | 'deliver'): ConnectReadiness {
  const missing: string[] = [];

  // Learn modules — need: name, description per module
  let canDeriveLearnModules = false;
  if (appType === 'learn') {
    const modulesWithConfig = bp.modules.filter((m: any) =>
      m.forms?.some((f: any) => f.learn_module || f.assessment)
    );
    canDeriveLearnModules = modulesWithConfig.length === bp.modules.length;
    if (!canDeriveLearnModules) {
      const missingModules = bp.modules.filter((m: any) =>
        !m.forms?.some((f: any) => f.learn_module)
      );
      for (const m of missingModules) {
        missing.push(`Learn module "${m.name}": missing learn_module config on forms`);
      }
    }

    // Check learn_module has description
    for (const mod of bp.modules) {
      for (const form of mod.forms || []) {
        if (form.learn_module && !form.learn_module.description) {
          missing.push(`"${mod.name} → ${form.name}": learn_module missing description`);
        }
      }
    }
  }

  // Assessments — need: score_question that references an actual hidden question
  let canDeriveAssessments = false;
  if (appType === 'learn') {
    const formsWithAssessment = bp.modules.flatMap((m: any) =>
      (m.forms || []).map((f: any) => ({ mod: m, form: f }))
    ).filter(({ form }: any) => form.assessment);

    canDeriveAssessments = formsWithAssessment.length > 0;

    for (const { mod, form } of formsWithAssessment) {
      const assessment = form.assessment;
      if (!assessment.score_question) {
        missing.push(`"${mod.name} → ${form.name}": assessment missing score_question`);
        canDeriveAssessments = false;
      } else {
        // Verify the score question exists
        const scoreQ = (form.questions || []).find((q: any) => q.id === assessment.score_question);
        if (!scoreQ) {
          missing.push(`"${mod.name} → ${form.name}": assessment.score_question "${assessment.score_question}" doesn't match any question`);
          canDeriveAssessments = false;
        } else if (scoreQ.type !== 'hidden') {
          missing.push(`"${mod.name} → ${form.name}": score question "${scoreQ.id}" should be hidden, got "${scoreQ.type}"`);
        } else if (!scoreQ.calculate) {
          missing.push(`"${mod.name} → ${form.name}": score question "${scoreQ.id}" has no calculate expression`);
          canDeriveAssessments = false;
        }
      }

      if (assessment.passing_score === undefined || assessment.passing_score === null) {
        missing.push(`"${mod.name} → ${form.name}": assessment missing passing_score`);
      }
    }

    // All learn modules should have assessments
    const totalForms = bp.modules.reduce((sum: number, m: any) => sum + (m.forms?.length || 0), 0);
    if (formsWithAssessment.length < totalForms) {
      missing.push(`Only ${formsWithAssessment.length}/${totalForms} forms have assessment config — all learn forms should be assessable`);
    }
  }

  // Deliver units — need: deliver_unit config on forms
  let canDeriveDeliverUnits = false;
  if (appType === 'deliver') {
    const formsWithDeliverUnit = bp.modules.flatMap((m: any) =>
      (m.forms || []).filter((f: any) => f.connect?.deliver_unit || f.deliver_unit)
    );
    canDeriveDeliverUnits = formsWithDeliverUnit.length > 0;

    // ALL deliver forms should have deliver_unit
    const totalForms = bp.modules.reduce((sum: number, m: any) => sum + (m.forms?.length || 0), 0);
    if (formsWithDeliverUnit.length < totalForms) {
      missing.push(`Only ${formsWithDeliverUnit.length}/${totalForms} forms have deliver_unit — all deliver forms should track delivery`);
    }
  }

  // Tasks — need: task config on service/followup forms
  let canDeriveTasks = false;
  if (appType === 'deliver') {
    const formsWithTask = bp.modules.flatMap((m: any) =>
      (m.forms || []).filter((f: any) => f.connect?.task || f.task)
    );
    canDeriveTasks = formsWithTask.length > 0;

    // Service delivery and followup forms should have tasks
    const serviceFollowupForms = bp.modules.flatMap((m: any) =>
      (m.forms || []).filter((f: any) => f.type === 'followup')
    );
    if (serviceFollowupForms.length > 0 && formsWithTask.length === 0) {
      missing.push('No follow-up forms have task config — CHW task completion won\'t be tracked');
    }
  }

  // Validation rules — can we derive DeliverUnitFlagRules / FormJsonValidationRules?
  let canDeriveValidationRules = false;
  if (appType === 'deliver') {
    // Check if forms have constraints, calculated status fields, or close_case conditions
    const formsWithValidation = bp.modules.flatMap((m: any) =>
      (m.forms || []).filter((f: any) => {
        const hasConstraints = (f.questions || []).some((q: any) => q.constraint);
        const hasStatusCalc = (f.questions || []).some((q: any) =>
          q.type === 'hidden' && q.calculate && q.case_property
        );
        const hasCloseCase = f.close_case && f.close_case.question;
        return hasConstraints || hasStatusCalc || hasCloseCase;
      })
    );
    canDeriveValidationRules = formsWithValidation.length > 0;
    if (!canDeriveValidationRules) {
      missing.push('No forms have validation constraints or status tracking — cannot derive Connect validation rules');
    }
  }

  return {
    canDeriveLearnModules,
    canDeriveDeliverUnits,
    canDeriveTasks,
    canDeriveAssessments,
    canDeriveValidationRules,
    missingForConnect: missing,
  };
}

function emptyReadiness(): ConnectReadiness {
  return {
    canDeriveLearnModules: false,
    canDeriveDeliverUnits: false,
    canDeriveTasks: false,
    canDeriveAssessments: false,
    canDeriveValidationRules: false,
    missingForConnect: ['Blueprint has no modules — cannot assess Connect readiness'],
  };
}

export function formatValidationResult(result: ValidationResult, appType: string): string {
  const lines: string[] = [];

  lines.push(`### ${appType} Structural Validation`);
  lines.push('');

  if (result.passed) {
    lines.push(`**Status: PASSED** (${result.warnings.length} warnings)`);
  } else {
    lines.push(`**Status: FAILED** (${result.errors.length} errors, ${result.warnings.length} warnings)`);
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('**Errors (will break):**');
    for (const e of result.errors) lines.push(`- ${e}`);
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('**Warnings:**');
    for (const w of result.warnings) lines.push(`- ${w}`);
  }

  // Connect readiness
  lines.push('');
  lines.push('**Connect Integration Readiness:**');
  const cr = result.connectReadiness;
  const checks = [
    ['Learn Modules', cr.canDeriveLearnModules],
    ['Assessments', cr.canDeriveAssessments],
    ['Deliver Units', cr.canDeriveDeliverUnits],
    ['Tasks', cr.canDeriveTasks],
    ['Validation Rules', cr.canDeriveValidationRules],
  ] as const;

  for (const [name, ok] of checks) {
    if (appType === 'Learn' && ['Deliver Units', 'Tasks', 'Validation Rules'].includes(name)) continue;
    if (appType === 'Deliver' && ['Learn Modules', 'Assessments'].includes(name)) continue;
    lines.push(`- ${ok ? '✅' : '❌'} ${name}`);
  }

  if (cr.missingForConnect.length > 0) {
    lines.push('');
    lines.push('**Missing for Connect setup:**');
    for (const m of cr.missingForConnect) lines.push(`- ${m}`);
  }

  return lines.join('\n');
}
