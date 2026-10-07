// engine.mjs — a toy agent loop, under glass.
//
// This is NOT a real agent. The "model" is a deterministic playback deck,
// not an LLM. What is real: the loop shape, the boundaries, the queues,
// the tool dispatch, the append-only session log, and the corruption that
// naive mid-turn injection produces.
//
// The loop: user prompt → boundary → model turn → tool-call dispatch →
// observation → boundary → repeat — until the model returns text.

export const BOUNDARY = Object.freeze({
  MODEL_REQUEST: 'model-request', // drain steering before every model call
  WOULD_STOP: 'would-stop',       // drain follow-ups only when the turn ends
});

export const INJECT = Object.freeze({
  BOUNDARY: 'boundary',   // correct: buffer input, inject at boundaries
  IMMEDIATE: 'immediate', // naive: splice input wherever the loop happens to be
});

// ---------------------------------------------------------------------------
// Session log — an append-only transcript. One JSONL "file" per session;
// resume = replay the messages lines back into a fresh message list.
// ---------------------------------------------------------------------------

export class SessionLog {
  constructor({ cwd = 'demo-workdir', sessionId = 'sim-session' } = {}) {
    this.lines = [];
    this.append('session', { version: 1, session_id: sessionId, cwd, created_at: 'simulated' });
  }

  append(type, payload = {}) {
    this.lines.push({ type, ...payload });
  }

  // Every completed turn appends exactly one messages line.
  appendTurn(messages) {
    if (!messages.length) return;
    this.append('messages', { messages });
  }

  toJSONL() {
    return this.lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  }

  // Resume support: flatten every messages line into one message list.
  static readMessages(jsonl) {
    return jsonl
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === 'messages')
      .flatMap((line) => line.messages);
  }
}

// ---------------------------------------------------------------------------
// AgentRun — one turn in flight, ever (single-flight, like a real harness).
// ---------------------------------------------------------------------------

export class AgentRun {
  constructor({ model, registry, deps, inject = INJECT.BOUNDARY, sessionId } = {}) {
    this.model = model; // async (messages, ctx) => { text } | { toolCalls: [{name, args}] }
    this.registry = registry;
    this.deps = deps; // harness state: fs, taskStore, commands, pages, emit
    this.inject = inject;
    this.queues = { steering: [], followUp: [] };
    this.messages = [];
    this.turnMessages = []; // messages produced this turn → logged at turn end
    this.log = new SessionLog({ sessionId });
    this._pendingCalls = new Set(); // toolCall ids awaiting their observation
    this._aborted = false;
    this.corrupted = false;
    this.corruptionNote = null;
  }

  // The user pressed Enter mid-turn. Boundary mode buffers for the next
  // model-request boundary; immediate mode splices right now — which is
  // exactly how naive terminals corrupt the message list.
  steer(text) {
    if (!text) return;
    if (this.inject === INJECT.IMMEDIATE) this._spliceNow(text);
    else this.queues.steering.push(text);
  }

  followUp(text) {
    if (text) this.queues.followUp.push(text);
  }

  // Cooperative abort: stop at the next boundary, drop everything pending.
  abort() {
    this._aborted = true;
    this.queues.steering.length = 0;
    this.queues.followUp.length = 0;
  }

  _pushMessage(msg) {
    this.messages.push(msg);
    this.turnMessages.push(msg);
  }

  _spliceNow(text) {
    if (this._pendingCalls.size > 0) {
      this.corrupted = true;
      this.corruptionNote =
        `user message landed while ${this._pendingCalls.size} tool call(s) ` +
        'were still awaiting their observation — the transcript now has a ' +
        'user turn between a call and its result.';
    }
    this._pushMessage({ role: 'user', content: text, spliced: true });
  }

  async *run(prompt) {
    yield { type: 'turn-started', prompt };
    this._pushMessage({ role: 'user', content: prompt });
    let step = 0;

    while (true) {
      // Boundary: MODEL_REQUEST — the only place steering may enter.
      const steering = this.queues.steering.splice(0);
      if (steering.length) {
        for (const text of steering) this._pushMessage({ role: 'user', content: text, steered: true });
        yield { type: 'steering-applied', texts: steering, at: BOUNDARY.MODEL_REQUEST };
      }
      yield { type: 'boundary', boundary: BOUNDARY.MODEL_REQUEST, step };
      if (this._aborted) {
        this.log.appendTurn(this.turnMessages); // a crashed/aborted turn keeps what it finished
        yield { type: 'aborted', keptMessages: this.turnMessages.length };
        return;
      }

      const out = await this.model(this.messages, { step, deps: this.deps });

      if (out.text !== undefined) {
        // Text return is the only stop signal — no max-steps knob.
        this._pushMessage({ role: 'assistant', content: out.text });
        yield { type: 'assistant-text', text: out.text };

        // Boundary: WOULD_STOP — follow-ups (and abort) are honoured here.
        yield { type: 'boundary', boundary: BOUNDARY.WOULD_STOP, step };
        const followUps = this.queues.followUp.splice(0);
        if (this._aborted) {
          this.log.appendTurn(this.turnMessages);
          yield { type: 'aborted', keptMessages: this.turnMessages.length };
          return;
        }
        if (!followUps.length) {
          this.log.appendTurn(this.turnMessages);
          yield { type: 'turn-finished', steps: step + 1, corrupted: this.corrupted, corruptionNote: this.corruptionNote };
          return;
        }
        for (const text of followUps) this._pushMessage({ role: 'user', content: text, followUp: true });
        yield { type: 'follow-up-applied', texts: followUps };
        continue;
      }

      // Model asked for tools. The assistant message carries the calls;
      // each call must be answered by exactly one tool message before any
      // other role — that invariant is what naive injection breaks.
      const toolCalls = out.toolCalls.map((call, i) => ({ id: `call_${step}_${i}`, ...call }));
      this._pushMessage({ role: 'assistant', toolCalls });
      for (const call of toolCalls) this._pendingCalls.add(call.id);
      yield { type: 'tool-calls-requested', calls: toolCalls };

      for (const call of toolCalls) {
        yield { type: 'tool-call-started', call };
        const res = await this.registry.call(call.name, call.args, this.deps);
        this._pendingCalls.delete(call.id);
        const content = res.ok ? res.output : res.error;
        this._pushMessage({ role: 'tool', toolCallId: call.id, name: call.name, content });
        yield { type: 'tool-result', call, ok: res.ok, content };
      }
      step += 1;
    }
  }
}

// Transcript sanity check used by tests and the report: every assistant
// toolCall must be matched by its tool result before any other role speaks.
export function validateTranscript(messages) {
  const pending = new Map();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) pending.set(call.id, call.name);
    } else if (msg.role === 'tool') {
      pending.delete(msg.toolCallId);
    } else if (pending.size > 0) {
      return {
        valid: false,
        reason: `${msg.role} message appeared while tool call(s) ` +
          [...pending.values()].join(', ') + ' awaited observations',
      };
    }
  }
  return pending.size === 0
    ? { valid: true }
    : { valid: false, reason: `tool call(s) never answered: ${[...pending.values()].join(', ')}` };
}
