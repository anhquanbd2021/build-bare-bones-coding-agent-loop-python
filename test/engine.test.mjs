import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRun, SessionLog, validateTranscript, INJECT, BOUNDARY } from '../public/engine.mjs';
import { codingTools, createDeps } from '../public/tools.mjs';
import { makeProvider } from '../public/models.mjs';
import { getScenario, SCENARIOS } from '../public/scenarios.mjs';

function makeRun(scenarioId, { inject = INJECT.BOUNDARY, provider = 'deck-terse' } = {}) {
  const scenario = getScenario(scenarioId);
  const deps = createDeps({ fs: scenario.fs, commands: scenario.commands, pages: scenario.pages });
  return new AgentRun({
    model: makeProvider(provider, scenario.deck),
    registry: codingTools(),
    deps,
    inject,
  });
}

async function collect(iter, onEvent) {
  const events = [];
  for await (const ev of iter) { events.push(ev); if (onEvent) onEvent(ev); }
  return events;
}

test('loop ends when the model returns text — no step cap involved', async () => {
  const run = makeRun('fix-greeting');
  const events = await collect(run.run('the goal'));
  const last = events.at(-1);
  assert.equal(last.type, 'turn-finished');
  assert.equal(last.corrupted, false);
  assert.equal(validateTranscript(run.messages).valid, true);
  // fix-greeting deck: 5 tool steps + 1 text return
  assert.equal(last.steps, 6);
});

test('every model-request boundary precedes a model turn', async () => {
  const run = makeRun('fix-greeting');
  const events = await collect(run.run('the goal'));
  const boundaries = events.filter((e) => e.type === 'boundary');
  assert.ok(boundaries.filter((b) => b.boundary === BOUNDARY.MODEL_REQUEST).length >= 6);
  assert.equal(boundaries.filter((b) => b.boundary === BOUNDARY.WOULD_STOP).length, 1);
});

test('boundary mode: steering injected mid-turn lands at the next boundary', async () => {
  const scenario = getScenario('steered-fetch');
  const run = makeRun('steered-fetch');
  let fired = false;
  const events = await collect(run.run(scenario.goal), (ev) => {
    if (!fired && ev.type === 'tool-call-started' && ev.call.name === 'web_fetch') {
      run.steer('keep the summary under 3 lines');
      fired = true;
    }
  });
  const applied = events.find((e) => e.type === 'steering-applied');
  assert.ok(applied, 'steering should have been applied');
  assert.equal(applied.at, BOUNDARY.MODEL_REQUEST);
  assert.equal(run.corrupted, false);
  assert.equal(validateTranscript(run.messages).valid, true);
});

test('immediate mode: steering spliced mid-dispatch corrupts the transcript', async () => {
  const scenario = getScenario('steered-fetch');
  const run = makeRun('steered-fetch', { inject: INJECT.IMMEDIATE });
  let fired = false;
  const events = await collect(run.run(scenario.goal), (ev) => {
    if (!fired && ev.type === 'tool-call-started' && ev.call.name === 'web_fetch') {
      run.steer('keep the summary under 3 lines');
      fired = true;
    }
  });
  assert.equal(run.corrupted, true);
  assert.match(run.corruptionNote, /awaiting their observation/);
  assert.equal(validateTranscript(run.messages).valid, false);
  const last = events.at(-1);
  assert.equal(last.corrupted, true);
});

test('immediate mode without mid-dispatch input stays clean', async () => {
  const run = makeRun('fix-greeting', { inject: INJECT.IMMEDIATE });
  const events = await collect(run.run('the goal'));
  assert.equal(events.at(-1).corrupted, false);
});

test('follow-up is held until the would-stop boundary, then becomes a step', async () => {
  const deck = [{ text: 'first answer' }, { text: 'second answer' }];
  const deps = createDeps({});
  const run = new AgentRun({
    model: makeProvider('deck-terse', deck),
    registry: codingTools(),
    deps,
  });
  let fired = false;
  const events = await collect(run.run('the goal'), (ev) => {
    if (!fired && ev.type === 'boundary' && ev.boundary === BOUNDARY.WOULD_STOP) {
      run.followUp('and one more thing');
      fired = true;
    }
  });
  const applied = events.find((e) => e.type === 'follow-up-applied');
  assert.ok(applied);
  assert.deepEqual(applied.texts, ['and one more thing']);
  // Both assistant texts made it into the transcript.
  const texts = events.filter((e) => e.type === 'assistant-text').map((e) => e.text);
  assert.deepEqual(texts, ['first answer', 'second answer']);
});

test('abort clears both queues and keeps the finished prefix in the log', async () => {
  const run = makeRun('fix-greeting');
  let fired = false;
  const events = await collect(run.run('the goal'), (ev) => {
    if (!fired && ev.type === 'boundary' && ev.boundary === BOUNDARY.MODEL_REQUEST) {
      run.steer('this should be dropped');
      run.followUp('this too');
      run.abort();
      fired = true;
    }
  });
  assert.equal(events.at(-1).type, 'aborted');
  assert.equal(run.queues.steering.length, 0);
  assert.equal(run.queues.followUp.length, 0);
  // The aborted turn persisted what it finished (the prompt at minimum).
  assert.ok(run.log.lines.some((l) => l.type === 'messages'));
});

test('session log appends one messages line per turn and resumes by replay', async () => {
  const run = makeRun('fix-greeting');
  await collect(run.run('the goal'));
  const jsonl = run.log.toJSONL();
  assert.match(jsonl, /"type":"session"/);
  assert.match(jsonl, /"type":"messages"/);
  const replayed = SessionLog.readMessages(jsonl);
  assert.deepEqual(replayed, run.messages);
});

test('provider swap changes voice, not the contract', async () => {
  for (const provider of ['deck-terse', 'deck-verbose']) {
    const run = makeRun('fix-greeting', { provider });
    const events = await collect(run.run('the goal'));
    assert.equal(events.at(-1).type, 'turn-finished');
    assert.equal(validateTranscript(run.messages).valid, true);
  }
  const verbose = makeRun('fix-greeting', { provider: 'deck-verbose' });
  const vEvents = await collect(verbose.run('the goal'));
  const vText = vEvents.find((e) => e.type === 'assistant-text').text;
  assert.match(vText, /^Here is my summary/);
});

test('unknown tool name returns an observation, not a crash', async () => {
  const deck = [
    { toolCalls: [{ name: 'nonsense_tool', args: {} }] },
    { text: 'recovered' },
  ];
  const run = new AgentRun({ model: makeProvider('deck-terse', deck), registry: codingTools(), deps: createDeps({}) });
  const events = await collect(run.run('the goal'));
  const result = events.find((e) => e.type === 'tool-result');
  assert.equal(result.ok, false);
  assert.match(result.content, /unknown tool/);
  assert.equal(events.at(-1).type, 'turn-finished');
});

test('all shipped scenarios run clean to completion in boundary mode', async () => {
  for (const s of SCENARIOS) {
    const run = makeRun(s.id);
    const events = await collect(run.run(s.goal));
    assert.equal(events.at(-1).type, 'turn-finished', s.id);
    assert.equal(validateTranscript(run.messages).valid, true, s.id);
  }
});
