// scenarios.mjs — canned goals, fixture filesystems, and playback decks.
// The deck IS the "model": an ordered list of responses the adapter plays
// back. Tool calls are real; the reasoning is theatre. Honest about it.

export const SCENARIOS = [
  {
    id: 'fix-greeting',
    title: 'Fix the greeting',
    goal: "Change the greeting in hello.mjs to 'Hello, LinkedIn' and prove it runs.",
    fs: {
      'hello.mjs': 'const greeting = "Hello, world";\nconsole.log(greeting);\n',
      'README.md': '# hello\nTiny fixture repo for the demo.\n',
    },
    commands: {
      // The observation REALLY depends on the file: edit changes what run prints.
      'node hello.mjs': (fs) => {
        const src = fs.get('hello.mjs') || '';
        const m = /const greeting = "([^"]*)"/.exec(src);
        return { stdout: `${m ? m[1] : '???'}\n`, code: 0 };
      },
    },
    pages: {},
    deck: [
      { toolCalls: [{ name: 'todo_write', args: { tasks: ['read hello.mjs', 'edit the greeting', 'run it to verify'] } }] },
      { toolCalls: [{ name: 'read', args: { path: 'hello.mjs' } }] },
      { toolCalls: [{ name: 'edit', args: { path: 'hello.mjs', old_string: 'Hello, world', new_string: 'Hello, LinkedIn' } }] },
      { toolCalls: [{ name: 'bash', args: { command: 'node hello.mjs' } }] },
      { toolCalls: [{ name: 'todo_write', args: { tasks: ['[x] read hello.mjs', '[x] edit the greeting', '[x] run it to verify'] } }] },
      { text: 'Done — greeting updated to "Hello, LinkedIn" and verified by running the file.' },
    ],
    steerHint: 'Try injecting "also add a comment line" while a tool runs.',
  },

  {
    id: 'steered-fetch',
    title: 'Fetch + summarize (steerable)',
    goal: 'Fetch the release notes page and save a summary to notes.md.',
    fs: {},
    commands: {
      'wc -l notes.md': (fs) =>
        fs.has('notes.md')
          ? { stdout: `${fs.get('notes.md').split('\n').filter(Boolean).length} notes.md\n`, code: 0 }
          : { stderr: 'notes.md: no such file\n', code: 1 },
    },
    pages: {
      'https://example.com/release-notes':
        '# Release 2.4\n\n- adds a steering queue for mid-turn input\n- fixes session resume from the log\n- trims the system prompt\n',
    },
    deck: [
      { toolCalls: [{ name: 'todo_write', args: { tasks: ['fetch the release notes', 'write notes.md', 'verify the file'] } }] },
      { toolCalls: [{ name: 'web_fetch', args: { url: 'https://example.com/release-notes' } }] },
      { toolCalls: [{ name: 'write', args: { path: 'notes.md', content: 'Release 2.4: steering queue, session-resume fix, smaller system prompt.\n' } }] },
      { toolCalls: [{ name: 'bash', args: { command: 'wc -l notes.md' } }] },
      { toolCalls: [{ name: 'todo_write', args: { tasks: ['[x] fetch the release notes', '[x] write notes.md', '[x] verify the file'] } }] },
      { text: 'Done — notes.md written and verified (1 line).' },
    ],
    // Where the demo injects steering when you press "Inject" mid-run.
    steerAt: { event: 'tool-call-started', name: 'web_fetch', text: 'keep the summary under 3 lines' },
    steerHint: 'Inject during web_fetch: boundary mode queues it safely; naive mode splices it mid-call and corrupts the transcript.',
  },
];

export function getScenario(id) {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`unknown scenario: '${id}'`);
  return scenario;
}
