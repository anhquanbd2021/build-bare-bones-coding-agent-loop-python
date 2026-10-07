import { AgentRun, SessionLog, validateTranscript } from './engine.mjs';
import { codingTools, createDeps } from './tools.mjs';
import { makeProvider, PROVIDERS } from './models.mjs';
import { SCENARIOS, getScenario } from './scenarios.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  scenario: $('scenario'), provider: $('provider'), inject: $('inject-mode'),
  run: $('run'), goal: $('goal-preview'), status: $('status'),
  transcript: $('transcript'), steerText: $('steer-text'), steer: $('steer'),
  followUp: $('follow-up'), steerHint: $('steer-hint'), log: $('session-log'),
  corruptBadge: $('corrupt-badge'), resume: $('resume'),
};

for (const s of SCENARIOS) {
  const opt = document.createElement('option');
  opt.value = s.id; opt.textContent = s.title;
  els.scenario.appendChild(opt);
}
for (const p of PROVIDERS) {
  const opt = document.createElement('option');
  opt.value = p.id; opt.textContent = p.label;
  els.provider.appendChild(opt);
}

function refreshMeta() {
  const s = getScenario(els.scenario.value);
  els.goal.textContent = `Goal: "${s.goal}"`;
  els.steerHint.textContent = s.steerHint || '';
}
els.scenario.addEventListener('change', refreshMeta);
refreshMeta();

let current = null; // the in-flight AgentRun
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addEntry(cls, title, body) {
  const li = document.createElement('li');
  li.className = `result ${cls}`;
  const head = document.createElement('div');
  head.className = 'result-head';
  const tag = document.createElement('span');
  tag.className = `badge ${cls}`;
  tag.textContent = title;
  head.appendChild(tag);
  li.appendChild(head);
  if (body) {
    const p = document.createElement('p');
    p.textContent = body;
    li.appendChild(p);
  }
  els.transcript.appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

function setStatus(text, cls = '') {
  els.status.textContent = text;
  els.status.className = `badge ${cls}`;
}

function setRunning(running) {
  els.run.disabled = running;
  els.steer.disabled = !running;
  els.followUp.disabled = !running;
  els.scenario.disabled = running;
  els.provider.disabled = running;
  els.inject.disabled = running;
}

function renderLog(run) {
  els.log.textContent = run.log.lines.length
    ? run.log.toJSONL()
    : '— run the loop to see the log fill —';
  const verdict = validateTranscript(run.messages);
  els.corruptBadge.textContent = verdict.valid ? 'transcript valid' : 'TRANSCRIPT CORRUPTED';
  els.corruptBadge.className = `badge ${verdict.valid ? 'pass' : 'fail'}`;
  els.resume.disabled = run.log.lines.length === 0;
}

async function startRun({ seedMessages = [] } = {}) {
  const scenario = getScenario(els.scenario.value);
  const deps = createDeps({ fs: scenario.fs, commands: scenario.commands, pages: scenario.pages });
  const run = new AgentRun({
    model: makeProvider(els.provider.value, scenario.deck),
    registry: codingTools(),
    deps,
    inject: els.inject.value,
    sessionId: `sim-${Date.now().toString(36)}`,
  });
  for (const msg of seedMessages) {
    run.messages.push(msg); // resumed context does not enter this turn's log
  }
  current = run;
  els.transcript.innerHTML = '';
  renderLog(run);
  setRunning(true);
  setStatus('Running', 'warn');
  if (seedMessages.length) {
    addEntry('info', 'resumed', `${seedMessages.length} message(s) replayed from the session log into context.`);
  }

  try {
    for await (const ev of run.run(scenario.goal)) {
      switch (ev.type) {
        case 'turn-started':
          addEntry('info', 'turn started', `prompt: "${ev.prompt}"`);
          break;
        case 'boundary':
          addEntry('info', `boundary: ${ev.boundary}`,
            ev.boundary === 'model-request'
              ? 'the only safe place for steering to enter the message list'
              : 'turn wants to stop — follow-up queue is drained here');
          break;
        case 'steering-applied':
          addEntry('warn', 'steering injected', ev.texts.join(' | '));
          break;
        case 'follow-up-applied':
          addEntry('warn', 'follow-up became a new step', ev.texts.join(' | '));
          break;
        case 'assistant-text':
          addEntry('pass', 'model returned text', ev.text);
          break;
        case 'tool-calls-requested':
          addEntry('info', 'model requested tools', ev.calls.map((c) => c.name).join(', '));
          break;
        case 'tool-call-started':
          setStatus(`dispatching ${ev.call.name}`, 'warn');
          break;
        case 'tool-result':
          addEntry(ev.ok ? 'info' : 'fail', `tool: ${ev.call.name}`, ev.content.slice(0, 400));
          break;
        case 'aborted':
          addEntry('fail', 'aborted', `turn stopped at a boundary; kept ${ev.keptMessages} message(s) in the log`);
          break;
        case 'turn-finished':
          setStatus('Done', 'pass');
          addEntry(ev.corrupted ? 'fail' : 'pass', 'turn finished',
            ev.corrupted ? `CORRUPTED — ${ev.corruptionNote}` : `${ev.steps} step(s); stop signal was a text return, not a step cap.`);
          break;
      }
      renderLog(run);
      await sleep(450); // gives you a window to steer mid-turn
    }
  } finally {
    setRunning(false);
    renderLog(run);
    if (els.status.textContent === 'Running') setStatus('Stopped', 'warn');
  }
}

els.run.addEventListener('click', () => startRun());
els.steer.addEventListener('click', () => {
  if (current && els.steerText.value.trim()) {
    current.steer(els.steerText.value.trim());
    addEntry('warn', 'you typed mid-turn', `submitted "${els.steerText.value.trim()}" via ${els.inject.value} mode`);
    els.steerText.value = '';
    renderLog(current);
  }
});
els.followUp.addEventListener('click', () => {
  if (current && els.steerText.value.trim()) {
    current.followUp(els.steerText.value.trim());
    addEntry('info', 'follow-up queued', 'held until the loop reaches would-stop');
    els.steerText.value = '';
  }
});
els.resume.addEventListener('click', () => {
  if (!current) return;
  const messages = SessionLog.readMessages(current.log.toJSONL());
  startRun({ seedMessages: messages });
});
