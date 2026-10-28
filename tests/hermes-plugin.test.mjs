/**
 * Drives the Hermes design-hook plugin (skill/hermes-plugin/__init__.py) with a
 * stub plugin context and a fake launcher that records what it was fed.
 * Run: node --test tests/hermes-plugin.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(REPO_ROOT, 'skill/hermes-plugin/__init__.py');

const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;
const SKIP = !HAS_PYTHON ? 'python3 not on PATH' : process.platform === 'win32' ? 'fake launcher is a sh script' : false;

// Loads the plugin from its file path (the dir name is not importable), registers
// it on a stub ctx, calls one hook with the given kwargs, and prints the result.
const DRIVER = `
import importlib.util, json, sys
spec = json.loads(sys.argv[1])
mod_spec = importlib.util.spec_from_file_location("impeccable_design_hook", spec["plugin"])
mod = importlib.util.module_from_spec(mod_spec)
mod_spec.loader.exec_module(mod)
hooks = {}
class Ctx:
    def register_hook(self, name, fn):
        hooks[name] = fn
    def session_cwd(self):
        return spec["cwd"]
mod.register(Ctx())
result = hooks[spec["hook"]](**spec["kwargs"]) if spec.get("hook") else None
print(json.dumps({"registered": sorted(hooks), "result": result}))
`;

const FAKE_LAUNCHER = `#!/bin/sh
cat > "$FAKE_RECORD/stdin.json"
cat "$FAKE_RECORD/stdin.json" >> "$FAKE_RECORD/events.txt"
echo >> "$FAKE_RECORD/events.txt"
env > "$FAKE_RECORD/env.txt"
printf '%s' "$*" > "$FAKE_RECORD/argv.txt"
cat "$FAKE_RECORD/stdout.txt" 2>/dev/null
exit 0
`;

let tmp;
let project;
let record;
let emptyHome;

function call(hook, kwargs, { cwd = project, env = {} } = {}) {
  for (const name of ['stdin.json', 'events.txt', 'env.txt', 'argv.txt']) fs.rmSync(path.join(record, name), { force: true });
  const spec = JSON.stringify({ plugin: PLUGIN, cwd, hook, kwargs });
  const res = spawnSync('python3', ['-c', DRIVER, spec], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HERMES_HOME: emptyHome,
      FAKE_RECORD: record,
      PYTHONDONTWRITEBYTECODE: '1',
      IMPECCABLE_HOOK_DISABLED: '',
      ...env,
    },
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim()).result;
}

function stdout(text) {
  fs.writeFileSync(path.join(record, 'stdout.txt'), text);
}

function spawned() {
  return fs.existsSync(path.join(record, 'stdin.json'));
}

function sentEvent() {
  return JSON.parse(fs.readFileSync(path.join(record, 'stdin.json'), 'utf8'));
}

function installLauncher(root) {
  const scripts = path.join(root, 'skills/impeccable/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'impeccable'), FAKE_LAUNCHER, { mode: 0o755 });
}

describe('hermes design-hook plugin', { skip: SKIP }, () => {
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-hermes-plugin-')));
    project = path.join(tmp, 'project');
    record = path.join(tmp, 'record');
    emptyHome = path.join(tmp, 'empty-home');
    for (const dir of [path.join(project, 'src'), record, emptyHome]) fs.mkdirSync(dir, { recursive: true });
    installLauncher(path.join(project, '.hermes'));
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const POST = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Gradient text in App.tsx' } });

  it('registers both hooks', () => {
    const spec = JSON.stringify({ plugin: PLUGIN, cwd: project });
    const res = spawnSync('python3', ['-c', DRIVER, spec], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).registered, ['pre_verify', 'transform_tool_result']);
  });

  it('ignores tools other than write_file and patch', () => {
    stdout(POST);
    assert.equal(call('transform_tool_result', { tool_name: 'read_file', args: { path: 'src/App.tsx' }, result: '{}' }), null);
    assert.equal(spawned(), false);
  });

  it('leaves an error result untouched', () => {
    stdout(POST);
    assert.equal(call('transform_tool_result', { tool_name: 'write_file', args: { path: 'src/App.tsx' }, result: '{"error": "denied"}' }), null);
    assert.equal(spawned(), false);
  });

  it('adds write_file findings to the result JSON and sends a Claude-shaped Write event', () => {
    stdout(POST);
    const result = '{"bytes_written": 12}';
    const out = call('transform_tool_result', { tool_name: 'write_file', args: { path: 'src/App.tsx' }, result, session_id: 's1' });
    assert.deepEqual(JSON.parse(out), { ...JSON.parse(result), impeccable: 'Gradient text in App.tsx' });
    assert.deepEqual(sentEvent(), {
      hook_event_name: 'PostToolUse',
      cwd: project,
      tool_name: 'Write',
      tool_input: { file_path: path.join(project, 'src/App.tsx') },
      session_id: 's1',
    });
    assert.equal(fs.readFileSync(path.join(record, 'argv.txt'), 'utf8'), 'hook');
    assert.match(fs.readFileSync(path.join(record, 'env.txt'), 'utf8'), /^IMPECCABLE_HOOK_HARNESS=hermes$/m);
  });

  it('maps patch to Edit and prefers the path the tool resolved', () => {
    stdout(POST);
    const resolved = path.join(project, 'src/styles.css');
    const result = JSON.stringify({ success: true, files_modified: [resolved] });
    const out = call('transform_tool_result', { tool_name: 'patch', args: { path: 'elsewhere.css' }, result });
    assert.deepEqual(JSON.parse(out), { ...JSON.parse(result), impeccable: 'Gradient text in App.tsx' });
    const event = sentEvent();
    assert.equal(event.tool_name, 'Edit');
    assert.equal(event.tool_input.file_path, resolved);
    assert.equal('session_id' in event, false);
  });

  it('scans every file a multi-file patch wrote and joins the findings', () => {
    stdout(POST);
    const files = [path.join(project, 'src/a.css'), path.join(project, 'src/b.css')];
    const result = JSON.stringify({ success: true, files_modified: files });
    const out = call('transform_tool_result', { tool_name: 'patch', args: { patch: '*** Begin Patch' }, result });
    assert.equal(JSON.parse(out).impeccable, 'Gradient text in App.tsx\n\nGradient text in App.tsx');
    const events = fs.readFileSync(path.join(record, 'events.txt'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.tool_input.file_path), files);
  });

  it('returns None when the engine has nothing to say', () => {
    stdout('');
    assert.equal(call('transform_tool_result', { tool_name: 'write_file', args: { path: 'src/App.tsx' }, result: '{}' }), null);
    assert.equal(spawned(), true);
  });

  it('appends the findings after a result that is not a JSON object', () => {
    stdout(POST);
    const out = call('transform_tool_result', { tool_name: 'write_file', args: { path: 'src/App.tsx' }, result: 'Wrote src/App.tsx' });
    assert.equal(out, 'Wrote src/App.tsx\n\nGradient text in App.tsx');
  });

  it('pre_verify passes the Stop block decision through', () => {
    stdout(JSON.stringify({ decision: 'block', reason: 'Deep pass: 2 findings' }));
    const out = call('pre_verify', { session_id: 's2', attempt: 0, changed_paths: ['src/App.tsx'] });
    assert.deepEqual(out, { decision: 'block', reason: 'Deep pass: 2 findings' });
    assert.deepEqual(sentEvent(), { hook_event_name: 'Stop', cwd: project, stop_hook_active: false, session_id: 's2' });
    call('pre_verify', { session_id: 's2', attempt: 1, changed_paths: ['src/App.tsx'] });
    assert.equal(sentEvent().stop_hook_active, false, 'every nudge scans again; the engine dedupes');
  });

  it('pre_verify turns an older engine\'s additionalContext into a continue directive', () => {
    stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Deep pass findings' } }));
    const out = call('pre_verify', { session_id: 's3', attempt: 0, changed_paths: ['src/App.tsx'] });
    assert.deepEqual(out, { action: 'continue', message: 'Deep pass findings' });
  });

  it('pre_verify lets the turn finish on empty output', () => {
    stdout('');
    assert.equal(call('pre_verify', { session_id: 's4', attempt: 0, changed_paths: ['src/App.tsx'] }), null);
  });

  it('spawns nothing when IMPECCABLE_HOOK_DISABLED is set', () => {
    stdout(POST);
    const env = { IMPECCABLE_HOOK_DISABLED: '1' };
    assert.equal(call('transform_tool_result', { tool_name: 'write_file', args: { path: 'src/App.tsx' }, result: '{}' }, { env }), null);
    assert.equal(call('pre_verify', { session_id: 's5', attempt: 0, changed_paths: ['src/App.tsx'] }, { env }), null);
    assert.equal(spawned(), false);
  });

  it('is a no-op where no launcher is reachable', () => {
    stdout(POST);
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    assert.equal(call('transform_tool_result', { tool_name: 'write_file', args: { path: 'a.tsx' }, result: '{}' }, { cwd: outside }), null);
    assert.equal(call('pre_verify', { session_id: 's6', attempt: 0, changed_paths: ['a.tsx'] }, { cwd: outside }), null);
    assert.equal(spawned(), false);
  });

  it('falls back to the launcher in HERMES_HOME', () => {
    stdout(POST);
    const home = path.join(tmp, 'hermes-home');
    installLauncher(home);
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const out = call('transform_tool_result', { tool_name: 'write_file', args: { path: 'a.tsx' }, result: '{}' }, { cwd: outside, env: { HERMES_HOME: home } });
    assert.equal(out, '{"impeccable": "Gradient text in App.tsx"}');
    assert.equal(sentEvent().tool_input.file_path, path.join(outside, 'a.tsx'));
  });
});
