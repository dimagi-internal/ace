#!/usr/bin/env npx tsx
/**
 * ACE Evaluation Pipeline
 *
 * Runs: IDD → Nova prompts → Generate Learn + Deliver apps → Score both → Report
 *
 * Usage: npx tsx test/eval/run-eval.ts [idd-path]
 *        npx tsx test/eval/run-eval.ts test/eval/sample-idds/malaria-bed-nets.md
 *        npx tsx test/eval/run-eval.ts  (runs all sample IDDs)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { generateApp, buildLearnPrompt, buildDeliverPrompt, type NovaResult } from './nova-client.js';
import { scoreBlueprint, formatScorecard, type ScoreResult } from './scorer.js';

interface EvalResult {
  iddName: string;
  timestamp: string;
  learn: {
    nova: NovaResult;
    score: ScoreResult | null;
    error?: string;
  };
  deliver: {
    nova: NovaResult;
    score: ScoreResult | null;
    error?: string;
  };
  overallScore: number;
  overallMax: number;
  overallPercentage: number;
}

async function evaluateIDD(iddPath: string): Promise<EvalResult> {
  const iddName = basename(iddPath, '.md');
  const idd = readFileSync(iddPath, 'utf-8');
  const timestamp = new Date().toISOString();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Evaluating: ${iddName}`);
  console.log(`${'='.repeat(60)}`);

  // Generate Learn app
  console.log('\n--- Generating Learn app via Nova ---');
  const learnPrompt = buildLearnPrompt(idd);
  const learnResult = await generateApp(learnPrompt);

  if (learnResult.error) {
    console.error(`Learn app generation failed: ${learnResult.error}`);
  } else if (!learnResult.blueprint) {
    console.error('Learn app: no blueprint extracted from response');
  } else {
    console.log(`Learn app generated in ${(learnResult.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tokens: ${learnResult.tokenUsage.inputTokens} in / ${learnResult.tokenUsage.outputTokens} out`);
    const bp = learnResult.blueprint as any;
    console.log(`  App: ${bp.app_name} | Type: ${bp.connect_type} | Modules: ${bp.modules?.length || 0}`);
  }

  // Generate Deliver app
  console.log('\n--- Generating Deliver app via Nova ---');
  const deliverPrompt = buildDeliverPrompt(idd);
  const deliverResult = await generateApp(deliverPrompt);

  if (deliverResult.error) {
    console.error(`Deliver app generation failed: ${deliverResult.error}`);
  } else if (!deliverResult.blueprint) {
    console.error('Deliver app: no blueprint extracted from response');
  } else {
    console.log(`Deliver app generated in ${(deliverResult.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tokens: ${deliverResult.tokenUsage.inputTokens} in / ${deliverResult.tokenUsage.outputTokens} out`);
    const bp = deliverResult.blueprint as any;
    console.log(`  App: ${bp.app_name} | Type: ${bp.connect_type} | Modules: ${bp.modules?.length || 0}`);
  }

  // Score Learn app
  let learnScore: ScoreResult | null = null;
  let learnError: string | undefined;
  if (learnResult.blueprint) {
    console.log('\n--- Scoring Learn app ---');
    try {
      learnScore = await scoreBlueprint(idd, learnResult.blueprint, 'learn');
      console.log(`  Score: ${learnScore.totalScore}/${learnScore.maxScore} (${learnScore.percentage}%)`);
    } catch (e: any) {
      learnError = e.message;
      console.error(`  Scoring failed: ${learnError}`);
    }
  }

  // Score Deliver app
  let deliverScore: ScoreResult | null = null;
  let deliverError: string | undefined;
  if (deliverResult.blueprint) {
    console.log('\n--- Scoring Deliver app ---');
    try {
      deliverScore = await scoreBlueprint(idd, deliverResult.blueprint, 'deliver');
      console.log(`  Score: ${deliverScore.totalScore}/${deliverScore.maxScore} (${deliverScore.percentage}%)`);
    } catch (e: any) {
      deliverError = e.message;
      console.error(`  Scoring failed: ${deliverError}`);
    }
  }

  // Calculate overall
  const learnTotal = learnScore?.totalScore || 0;
  const learnMax = learnScore?.maxScore || 60;
  const deliverTotal = deliverScore?.totalScore || 0;
  const deliverMax = deliverScore?.maxScore || 60;
  const overallScore = learnTotal + deliverTotal;
  const overallMax = learnMax + deliverMax;
  const overallPercentage = Math.round((overallScore / overallMax) * 100);

  return {
    iddName,
    timestamp,
    learn: { nova: learnResult, score: learnScore, error: learnError },
    deliver: { nova: deliverResult, score: deliverScore, error: deliverError },
    overallScore,
    overallMax,
    overallPercentage,
  };
}

function writeReport(results: EvalResult[]): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  lines.push(`# ACE Evaluation Report`);
  lines.push(`**Run:** ${timestamp}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| IDD | Learn Score | Deliver Score | Overall |');
  lines.push('|-----|------------|---------------|---------|');

  for (const r of results) {
    const learnPct = r.learn.score ? `${r.learn.score.percentage}%` : 'FAIL';
    const deliverPct = r.deliver.score ? `${r.deliver.score.percentage}%` : 'FAIL';
    lines.push(`| ${r.iddName} | ${learnPct} | ${deliverPct} | **${r.overallPercentage}%** |`);
  }

  // Detailed results per IDD
  for (const r of results) {
    lines.push('');
    lines.push(`---`);
    lines.push('');
    lines.push(`# ${r.iddName}`);
    lines.push('');

    if (r.learn.score) {
      lines.push(formatScorecard('Learn', r.learn.score));
    } else {
      lines.push(`## Learn App: ${r.learn.error || r.learn.nova.error || 'No blueprint generated'}`);
    }

    lines.push('');

    if (r.deliver.score) {
      lines.push(formatScorecard('Deliver', r.deliver.score));
    } else {
      lines.push(`## Deliver App: ${r.deliver.error || r.deliver.nova.error || 'No blueprint generated'}`);
    }

    // Generation stats
    lines.push('');
    lines.push('## Generation Stats');
    lines.push('');
    lines.push(`| Metric | Learn | Deliver |`);
    lines.push(`|--------|-------|---------|`);
    lines.push(`| Duration | ${(r.learn.nova.durationMs / 1000).toFixed(1)}s | ${(r.deliver.nova.durationMs / 1000).toFixed(1)}s |`);
    lines.push(`| Input tokens | ${r.learn.nova.tokenUsage.inputTokens} | ${r.deliver.nova.tokenUsage.inputTokens} |`);
    lines.push(`| Output tokens | ${r.learn.nova.tokenUsage.outputTokens} | ${r.deliver.nova.tokenUsage.outputTokens} |`);
  }

  // Improvement suggestions
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Improvement Opportunities');
  lines.push('');

  for (const r of results) {
    const weakDimensions: { name: string; score: number; reasoning: string; app: string }[] = [];

    for (const [app, data] of [['Learn', r.learn] as const, ['Deliver', r.deliver] as const]) {
      if (!data.score) continue;
      for (const [key, dim] of Object.entries(data.score.dimensions)) {
        if (dim.score < 8) {
          weakDimensions.push({
            name: key.replace(/_/g, ' '),
            score: dim.score,
            reasoning: dim.reasoning,
            app,
          });
        }
      }
    }

    if (weakDimensions.length > 0) {
      lines.push(`### ${r.iddName}`);
      weakDimensions.sort((a, b) => a.score - b.score);
      for (const d of weakDimensions) {
        lines.push(`- **${d.app} / ${d.name}** (${d.score}/10): ${d.reasoning}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const sampleDir = join(import.meta.dirname, 'sample-idds');
  const resultsDir = join(import.meta.dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });

  let iddPaths: string[];

  if (args.length > 0) {
    iddPaths = args;
  } else {
    // Run all sample IDDs
    const files = readdirSync(sampleDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) {
      console.error('No sample IDDs found in test/eval/sample-idds/');
      process.exit(1);
    }
    iddPaths = files.map(f => join(sampleDir, f));
  }

  console.log(`Running ACE evaluation on ${iddPaths.length} IDD(s)...`);

  const results: EvalResult[] = [];
  for (const iddPath of iddPaths) {
    const result = await evaluateIDD(iddPath);
    results.push(result);
  }

  // Write report
  const report = writeReport(results);
  const reportName = `eval-${new Date().toISOString().slice(0, 10)}.md`;
  const reportPath = join(resultsDir, reportName);
  writeFileSync(reportPath, report);

  // Write raw results JSON
  const jsonPath = join(resultsDir, reportName.replace('.md', '.json'));
  const jsonResults = results.map(r => ({
    ...r,
    learn: { ...r.learn, nova: { ...r.learn.nova, rawText: undefined } },
    deliver: { ...r.deliver, nova: { ...r.deliver.nova, rawText: undefined } },
  }));
  writeFileSync(jsonPath, JSON.stringify(jsonResults, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('EVALUATION COMPLETE');
  console.log('='.repeat(60));

  for (const r of results) {
    const learnPct = r.learn.score ? `${r.learn.score.percentage}%` : 'FAIL';
    const deliverPct = r.deliver.score ? `${r.deliver.score.percentage}%` : 'FAIL';
    console.log(`  ${r.iddName}: Learn ${learnPct} | Deliver ${deliverPct} | Overall ${r.overallPercentage}%`);
  }

  console.log(`\nReport: ${reportPath}`);
  console.log(`JSON:   ${jsonPath}`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
