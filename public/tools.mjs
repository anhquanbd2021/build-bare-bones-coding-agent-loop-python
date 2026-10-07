// tools.mjs — a fake tool registry over an in-memory filesystem.
// Real dispatch, real edit semantics, honest about the sandbox being a Map.

export function createRegistry(defs) {
  const names = Object.keys(defs);
  return {
    names,
    async call(name, args = {}, deps = {}) {
      const tool = defs[name];
      if (!tool) return { ok: false, error: `unknown tool: '${name}'` };
      try {
        return { ok: true, output: await tool(args, deps) };
      } catch (err) {
        // A bad tool call is an observation the model must handle — the
        // equivalent of ModelRetry: explicit, not silent.
        return { ok: false, error: `tool error: ${err.message || err}` };
      }
    },
  };
}

function normalize(text) {
  // The model never sees a BOM or which line-ending convention the file
  // uses — so a match must not fail on characters it could not guess.
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

function collapseWs(text) {
  return text.replace(/\s+/g, ' ');
}

export function editText(raw, oldString, newString) {
  // Exact unique match first; whitespace-collapsed retry only on a miss.
  // 0 hits -> not found; 2+ hits -> ambiguous. Mirrors the real edit tool.
  const body = normalize(raw);
  const needle = normalize(oldString);
  let count = body.split(needle).length - 1;
  let haystack = body;
  let match = needle;
  if (count === 0) {
    const collapsedHaystack = collapseWs(body);
    const collapsedNeedle = collapseWs(needle);
    count = collapsedHaystack.split(collapsedNeedle).length - 1;
    if (count !== 1) {
      return count === 0
        ? { ok: false, error: 'old_string not found (even with whitespace collapsed)' }
        : { ok: false, error: `old_string is ambiguous: ${count} matches` };
    }
    // Fallback hit: re-derive the real slice by locating a tolerant match.
    const idx = tolerantIndexOf(body, needle);
    if (idx === -1) return { ok: false, error: 'old_string not found' };
    const end = idx.end;
    return { ok: true, text: body.slice(0, idx.start) + newString + body.slice(end) };
  }
  if (count !== 1) return { ok: false, error: `old_string is ambiguous: ${count} matches` };
  const at = haystack.indexOf(match);
  return { ok: true, text: haystack.slice(0, at) + newString + haystack.slice(at + match.length) };
}

function tolerantIndexOf(haystack, needle) {
  // Locate needle ignoring run-length of whitespace (but not word order).
  const words = collapseWs(needle).trim().split(' ');
  if (!words.length || !words[0]) return -1;
  for (let i = 0; i <= haystack.length - 1; i++) {
    let pos = i;
    let ok = true;
    for (const word of words) {
      pos = skipWs(haystack, pos);
      if (!haystack.startsWith(word, pos)) { ok = false; break; }
      pos += word.length;
    }
    if (ok) return { start: i === pos ? i : skipWs(haystack, i), end: pos };
  }
  return -1;
}

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

export function createDeps({ fs = {}, commands = {}, pages = {}, emit = () => {} } = {}) {
  return {
    fs: new Map(Object.entries(fs)),
    taskStore: [],
    commands,
    pages,
    emit,
  };
}

export function codingTools() {
  return createRegistry({
    async read({ path, offset = 1, limit = 2000 }, deps) {
      const file = deps.fs.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      const lines = file.split('\n').slice(offset - 1, offset - 1 + limit);
      return lines.join('\n');
    },

    async write({ path, content }, deps) {
      deps.fs.set(path, content);
      return `Wrote ${path} (${content.length} bytes).`;
    },

    async edit({ path, old_string, new_string }, deps) {
      const file = deps.fs.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      const res = editText(file, old_string, new_string);
      if (!res.ok) throw new Error(res.error);
      deps.fs.set(path, res.text);
      return `Edited '${path}' (replaced 1 occurrence).`;
    },

    async bash({ command }, deps) {
      // Simulated shell: only commands the scenario registered will run.
      const handler = deps.commands[command];
      if (!handler) return `Exit code: 127.\n\nstderr:\n${command}: command not found (simulated shell)`;
      const { stdout = '', stderr = '', code = 0 } = handler(deps.fs) || {};
      return `Exit code: ${code}.\n\nstdout:\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ''}`;
    },

    async todo_write({ tasks }, deps) {
      // Overwrite the whole list IN PLACE — the plan can't drift out of
      // context, and every watcher keeps pointing at the same store.
      if (!Array.isArray(tasks)) throw new Error('tasks must be a list');
      deps.taskStore.splice(0, deps.taskStore.length, ...tasks);
      deps.emit({ type: 'task-list-updated', tasks: [...deps.taskStore] });
      return `Updated task list (${tasks.length} task(s)).`;
    },

    async web_fetch({ url }, deps) {
      const body = deps.pages[url];
      if (body === undefined) throw new Error(`HTTP 404 ${url} (no fixture page registered)`);
      const capped = body.length > 8000 ? body.slice(0, 8000) + '\n…[body capped at 8000 chars]' : body;
      return `HTTP 200 ${url}\n\n${capped}`;
    },
  });
}
