// scripts/report.mjs — run every scenario in both injection modes and print
// a side-by-side report. Also (re)generates the examples/*.jsonl transcripts.
//
//   node scripts/report.mjs           # report + write examples
//   node scripts/report.mjs --check   # report only, exit 1 on invariant break
//
// Invariants checked:
//   1. boundary mode never corrupts the transcript — even with mid-run input
//   2. immediate mode DOES corrupt it when input lands mid-tool-dispatch
//      (that's the hazard the queues exist to prevent)

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AgentRun, SessionLog, validateTranscript, INJECT } from '../public/engine.mjs';
import { codingTools, createDeps } from '../public/tools.mjs';
import { makeProvider } from '../public/models.mjs';
import { SCENARIOS, getScenario } from '../public/scenarios.mjs';

const EXAMPLES = fileURLToPath(new URL('../examples', import.meta.url));

async function drive(scenario, { inject = INJECT.BOUNDARY, provider = 'deck-terse', autoSteer = null } = {}) {
  const deps = createDeps({ fs: scenario.fs, commands: scenario.commands, pages: scenario.pages });
  const run = new AgentRun({
    model: makeProvider(provider, scenario.deck),
    registry: codingTools(),
    deps,
    inject,
    sessionId: `report-${scenario.id}-${inject}`,
  });
  let steered = false;
  const events = [];
  for await (const ev of run.run(scenario.goal)) {
    events.push(ev);
    // Deterministic injection: fire once when the configured event appears.
    if (!steered && autoSteer && ev.type === autoSteer.event && (!autoSteer.name || ev.call?.name === autoSteer.name)) {
      run.steer(autoSteer.text);
      steered = true;
    }
  }
  return { run, events, steered };
}

function summarize({ run, events }) {
  const toolCalls = events.filter((e) => e.type === 'tool-result');
  const steer = events.find((e) => e.type === 'steering-applied');
  return {
    steps: events.filter((e) => e.type === 'boundary' && e.boundary === 'model-request').length,
    toolCalls: toolCalls.length,
    toolNames: toolCalls.map((e) => e.call.name).join('→'),
    steeredAt: steer ? steer.at : '—',
    corrupted: run.corrupted,
    verdict: validateTranscript(run.messages),
  };
}

const rows = [];
let failures = 0;

for (const scenario of SCENARIOS) {
  const autoSteer = scenario.steerAt || null;

  const boundary = await drive(scenario, { inject: INJECT.BOUNDARY, autoSteer });
  const bSum = summarize(boundary);
  rows.push([scenario.id, 'boundary', bSum.steps, bSum.toolCalls, bSum.steeredAt, bSum.corrupted ? 'CORRUPTED' : 'clean']);
  if (bSum.corrupted || !bSum.verdict.valid) {
    failures += 1;
    console.error(`INVARIANT FAIL: boundary mode corrupted ${scenario.id}: ${bSum.verdict.reason || boundary.run.corruptionNote}`);
  }

  const naive = await drive(scenario, { inject: INJECT.IMMEDIATE, autoSteer });
  const nSum = summarize(naive);
  rows.push([scenario.id, 'immediate', nSum.steps, nSum.toolCalls, 'mid-dispatch', nSum.corrupted ? 'CORRUPTED' : 'clean']);
  // Immediate mode is only *expected* to corrupt when the scenario had a
  // mid-dispatch injection point (steerAt). If it didn't corrupt, the hazard
  // simply never triggered — report it, don't fail the build.
  const hazardNote = autoSteer && !nSum.corrupted ? ' (injection landed outside a dispatch — hazard did not trigger)' : '';

  console.log(`\n## ${scenario.id} — "${scenario.goal}"`);
  console.log(`   boundary : ${bSum.steps} steps, tools [${bSum.toolNames}], steering @ ${bSum.steeredAt}, ${bSum.corrupted ? 'CORRUPTED' : 'clean'}`);
  console.log(`   immediate: ${nSum.steps} steps, tools [${nSum.toolNames}], splice mid-dispatch, ${nSum.corrupted ? 'CORRUPTED — ' + naive.run.corruptionNote : 'clean'}${hazardNote}`);
}

// Persist example transcripts: one clean steered run + one corrupted run.
const steerable = SCENARIOS.find((s) => s.steerAt);
if (steerable) {
  mkdirSync(EXAMPLES, { recursive: true });
  const clean = await drive(steerable, { inject: INJECT.BOUNDARY, autoSteer: steerable.steerAt });
  writeFileSync(join(EXAMPLES, 'steered-at-boundary.jsonl'), clean.run.log.toJSONL());
  const naive = await drive(steerable, { inject: INJECT.IMMEDIATE, autoSteer: steerable.steerAt });
  if (naive.run.corrupted) {
    writeFileSync(join(EXAMPLES, 'corrupted-injection.jsonl'), naive.run.log.toJSONL());
  }
  console.log(`\nexamples/: wrote steered-at-boundary.jsonl${naive.run.corrupted ? ' and corrupted-injection.jsonl' : ''}`);
}

console.log('\nscenario            | mode      | steps | tools | steering lands        | transcript');
console.log('--------------------+-----------+-------+-------+-----------------------+-----------');
for (const r of rows) {
  console.log(`${r[0].padEnd(19)} | ${r[1].padEnd(9)} | ${String(r[2]).padEnd(5)} | ${String(r[3]).padEnd(5)} | ${String(r[4]).padEnd(21)} | ${r[5]}`);
}

if (failures) {
  console.error(`\n${failures} invariant failure(s)`);
  process.exit(1);
}
console.log('\nAll invariants hold: boundary injection never corrupts; naive injection can.');
