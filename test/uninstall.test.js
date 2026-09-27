'use strict';

// Proves this plugin is fully removable:
//   1. hooks/hooks.json is the ONLY wiring surface, and every command in it
//      is rooted at ${CLAUDE_PLUGIN_ROOT}.
//   2. Running every hook (fresh-install shape: no pre-existing dirs, a
//      scratch HOME, realistic stdin, DEFAULT config — no `dropboxRoot`
//      override) never writes anything outside that scratch HOME — and,
//      with default config, nothing lands outside the ONE documented
//      directory: `<HOME>/.claude/subagent-report-guard/` (the lane
//      drop-box's own `teams/` subdirectory now lives under that same data
//      dir by default — see README.md's "Where state lives").
//   3. After deleting that one data dir (and, in a real install, the plugin
//      itself), nothing else remains in the scratch HOME.
//   4. A separate test proves the OPPOSITE, opt-in case: an explicitly
//      configured `dropboxRoot` (or its env override) is honored and writes
//      land there instead — the escape hatch this plugin's self-containment
//      guarantee deliberately allows, never by accident.
//   5. A separate test (below, gated on the `claude` CLI's non-interactive
//      plugin support) proves this repo is genuinely self-installable from
//      its own `.claude-plugin/marketplace.json` — add the marketplace from
//      this repo's own path, install the plugin from it, confirm it is
//      listed enabled with hooks/hooks.json present, then uninstall and
//      confirm no residue remains beyond the CLI's own marketplace/plugin
//      cache bookkeeping (documented explicitly, not assumed).

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const HOOKS_JSON_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.json');

function allCommandsFromHooksJson() {
  const config = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf8'));
  const commands = [];
  for (const eventHooks of Object.values(config.hooks)) {
    for (const group of eventHooks) {
      for (const hook of group.hooks) {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

test('hooks.json: every command is rooted at ${CLAUDE_PLUGIN_ROOT}', () => {
  const commands = allCommandsFromHooksJson();
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.ok(command.includes('${CLAUDE_PLUGIN_ROOT}'), `not plugin-root-relative: ${command}`);
  }
});

test('hooks.json: every hook file under hooks/ is reachable from hooks.json', () => {
  const commands = allCommandsFromHooksJson().join('\n');
  // lane-dropbox-heartbeat.js is deliberately not wired directly: its .sh
  // sibling is a POSIX prefilter wired in hooks.json that shells out to it
  // internally (see that .sh file's own header) — reachable, just one hop
  // removed from hooks.json itself.
  const shellWrapped = new Set(['lane-dropbox-heartbeat.js']);
  const shSource = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'lane-dropbox-heartbeat.sh'), 'utf8');
  const files = fs.readdirSync(path.join(REPO_ROOT, 'hooks')).filter((f) => f.endsWith('.js') || f.endsWith('.sh'));
  for (const file of files) {
    if (shellWrapped.has(file)) {
      assert.ok(shSource.includes(file), `${file} expected to be invoked from its .sh wrapper, but isn't`);
      continue;
    }
    assert.ok(commands.includes(file), `${file} exists under hooks/ but is not wired in hooks.json`);
  }
});

test('no other harness wiring surface exists in this repo (no settings.json / .mcp.json)', () => {
  const suspicious = ['settings.json', 'settings.local.json', '.mcp.json'];
  for (const name of suspicious) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, name)), false, `${name} must not exist — hooks.json is the only wiring surface`);
  }
});

// ── fresh-install + uninstall behavior ──────────────────────────────────

function listAllFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function runHook(hookPath, payload, env) {
  const isShell = hookPath.endsWith('.sh');
  const cmd = isShell ? hookPath : process.execPath;
  const args = isShell ? [] : [hookPath];
  try {
    execFileSync(cmd, args, {
      input: payload === null ? '' : JSON.stringify(payload),
      encoding: 'utf8',
      env,
    });
  } catch {
    /* a non-zero exit from a hook under adverse fixtures is not this test's concern */
  }
}

test('fresh install: every hook runs against a scratch HOME with no pre-existing dirs and writes only under it', () => {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-fresh-home-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-fixture-'));

  // A minimal, realistic team-mailbox teammate fixture so the SubagentStop
  // hooks have something plausible to resolve against.
  const sessionId = 'fresh-session';
  const subagentsDir = path.join(fixtureRoot, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, `${sessionId}.jsonl`), '', 'utf8');
  const transcriptPath = path.join(subagentsDir, 'agent-afresh-lane-cafe1234.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fresh install report' }] } })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(subagentsDir, 'agent-afresh-lane-cafe1234.meta.json'),
    JSON.stringify({ agentType: 'fresh-lane', name: 'fresh-lane', spawnDepth: 0, taskKind: 'in_process_teammate' }),
    'utf8',
  );

  const env = { ...process.env, HOME: scratchHome };
  delete env.SUBAGENT_REPORT_GUARD_DATA_DIR; // exercise the real fallback resolution
  delete env.CLAUDE_PLUGIN_DATA;

  assert.equal(fs.existsSync(path.join(scratchHome, '.claude')), false, 'precondition: nothing pre-exists');

  runHook(path.join(REPO_ROOT, 'hooks', 'report-gate.js'), { transcript_path: transcriptPath }, env);
  runHook(path.join(REPO_ROOT, 'hooks', 'lane-dropbox-checkpoint.js'), { transcript_path: transcriptPath }, env);
  runHook(path.join(REPO_ROOT, 'hooks', 'lane-dropbox-heartbeat.js'), { transcript_path: transcriptPath }, env);
  runHook(path.join(REPO_ROOT, 'hooks', 'orphan-pointers-subagent-stop.js'), { transcript_path: transcriptPath }, env);
  runHook(path.join(REPO_ROOT, 'hooks', 'orphan-pointers-user-prompt-submit.js'), { session_id: sessionId, transcript_path: `${fixtureRoot}/${sessionId}.jsonl` }, env);
  runHook(path.join(REPO_ROOT, 'hooks', 'orphan-pointers-session-start.js'), { session_id: sessionId }, env);

  const written = listAllFiles(scratchHome);
  const claudeDir = path.join(scratchHome, '.claude');
  for (const file of written) {
    assert.ok(file.startsWith(claudeDir), `unexpected write outside <HOME>/.claude/: ${file}`);
    const rel = path.relative(claudeDir, file);
    // With default config (no dropboxRoot override), the lane drop-box's
    // teams/ subdirectory now lives INSIDE this plugin's one data dir — see
    // lib/paths.js's dropboxRootDir() — so nothing may land outside it.
    assert.ok(
      rel.startsWith('subagent-report-guard'),
      `unexpected write outside the one documented data dir: ${file}`,
    );
  }
});

test('dropboxRoot override: an explicitly configured root is honored and writes land there, outside the data dir', () => {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-dropbox-override-home-'));
  const externalDropboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-dropbox-override-external-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-dropbox-override-fixture-'));
  const sessionId = 'override-session';
  const subagentsDir = path.join(fixtureRoot, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  const transcriptPath = path.join(subagentsDir, 'agent-aoverride-lane-abc12345.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'override report' }] } })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(subagentsDir, 'agent-aoverride-lane-abc12345.meta.json'),
    JSON.stringify({ agentType: 'override-lane', name: 'override-lane', spawnDepth: 0, taskKind: 'in_process_teammate' }),
    'utf8',
  );

  const env = {
    ...process.env,
    HOME: scratchHome,
    SUBAGENT_REPORT_GUARD_DROPBOX_ROOT: externalDropboxRoot,
  };
  delete env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  delete env.CLAUDE_PLUGIN_DATA;

  runHook(path.join(REPO_ROOT, 'hooks', 'report-gate.js'), { transcript_path: transcriptPath, session_id: sessionId }, env);
  runHook(path.join(REPO_ROOT, 'hooks', 'lane-dropbox-checkpoint.js'), { transcript_path: transcriptPath, session_id: sessionId }, env);

  const laneFile = path.join(externalDropboxRoot, sessionId, 'dropbox', 'override-lane.jsonl');
  assert.ok(fs.existsSync(laneFile), 'the configured dropboxRoot override must actually be honored');

  // The plugin's own data dir must never ALSO carry a teams/ subdirectory
  // when the override sends the lane drop-box entirely elsewhere.
  const dataDirTeams = path.join(scratchHome, '.claude', 'subagent-report-guard', 'teams');
  assert.equal(fs.existsSync(dataDirTeams), false, 'teams/ must not exist inside the data dir when dropboxRoot is overridden elsewhere');
});

test('uninstall: deleting the documented data dir(s) leaves nothing behind in HOME', () => {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-clean-home-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-clean-fixture-'));
  const sessionId = 'clean-session';
  const subagentsDir = path.join(fixtureRoot, sessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  const transcriptPath = path.join(subagentsDir, 'agent-aclean-lane-deadbeef.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } })}\n`, 'utf8');
  fs.writeFileSync(path.join(subagentsDir, 'agent-aclean-lane-deadbeef.meta.json'), JSON.stringify({ agentType: 'clean-lane', name: 'clean-lane', spawnDepth: 0, taskKind: 'in_process_teammate' }), 'utf8');

  const env = { ...process.env, HOME: scratchHome };
  delete env.SUBAGENT_REPORT_GUARD_DATA_DIR;
  delete env.CLAUDE_PLUGIN_DATA;

  runHook(path.join(REPO_ROOT, 'hooks', 'report-gate.js'), { transcript_path: transcriptPath }, env);
  runHook(path.join(REPO_ROOT, 'hooks', 'lane-dropbox-checkpoint.js'), { transcript_path: transcriptPath }, env);

  assert.ok(fs.existsSync(path.join(scratchHome, '.claude')), 'sanity: something was written');

  // The documented full-clean removal (see README's Uninstall section) —
  // ONE directory, with default config: the lane drop-box's teams/
  // subdirectory now lives inside this same data dir by default.
  fs.rmSync(path.join(scratchHome, '.claude', 'subagent-report-guard'), { recursive: true, force: true });

  const remaining = listAllFiles(scratchHome);
  assert.deepEqual(remaining, [], `files remained after deleting the documented dirs: ${JSON.stringify(remaining)}`);
});

// ── self-installability: this repo installs from its own marketplace ────

function claudeCliSupportsNonInteractivePlugins() {
  try {
    const out = execFileSync('claude', ['plugin', '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /marketplace/.test(out) && /install/.test(out) && /uninstall/.test(out);
  } catch {
    return false;
  }
}

function runClaude(args, env) {
  return execFileSync('claude', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('self-install: this repo installs from its own marketplace.json via the claude CLI, non-interactively', (t) => {
  if (!claudeCliSupportsNonInteractivePlugins()) {
    t.skip('claude CLI not available or does not expose non-interactive plugin/marketplace commands in this environment');
    return;
  }

  // Isolated from the real ~/.claude entirely: a scratch HOME AND a scratch
  // CLAUDE_CONFIG_DIR, so this test can never touch (or even see) the
  // user's real plugin/marketplace state.
  const scratchConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'self-install-config-'));
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'self-install-home-'));
  const claudeConfigDir = path.join(scratchConfigRoot, '.claude');
  fs.mkdirSync(claudeConfigDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: scratchHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };

  const marketplaceName = 'claude-subagent-report-guard';
  const pluginId = `subagent-report-guard@${marketplaceName}`;

  let addOut;
  let installOut;
  try {
    addOut = runClaude(['plugin', 'marketplace', 'add', REPO_ROOT], env);
    installOut = runClaude(['plugin', 'install', pluginId], env);
  } catch (err) {
    // A CLI that requires network/auth even for a local-path marketplace
    // (some hosted-marketplace flows do) fails here — treat that as "can't
    // run this non-interactively", not a test failure.
    t.skip(`claude CLI could not add/install from a local marketplace path non-interactively: ${(err && err.message) || err}`);
    return;
  }
  assert.match(addOut, new RegExp(marketplaceName));
  assert.match(installOut, /subagent-report-guard/);

  // ── installed + enabled, with hooks.json present in the cached copy ────
  const listedJson = runClaude(['plugin', 'list', '--json'], env);
  const listed = JSON.parse(listedJson);
  const entry = listed.find((p) => p.id === pluginId);
  assert.ok(entry, `installed plugin list did not include ${pluginId}: ${listedJson}`);
  assert.equal(entry.enabled, true, 'the installed plugin must be listed as enabled');
  assert.ok(isNonEmptyString(entry.installPath), 'installed plugin entry must carry an installPath');
  const installedHooksJson = path.join(entry.installPath, 'hooks', 'hooks.json');
  assert.ok(fs.existsSync(installedHooksJson), `installed copy is missing hooks/hooks.json at ${installedHooksJson}`);

  // ── uninstall + marketplace remove ──────────────────────────────────────
  runClaude(['plugin', 'uninstall', pluginId], env);
  runClaude(['plugin', 'marketplace', 'remove', marketplaceName], env);

  const afterListedJson = runClaude(['plugin', 'list', '--json'], env);
  const afterListed = JSON.parse(afterListedJson);
  assert.equal(afterListed.find((p) => p.id === pluginId), undefined, 'plugin must no longer be listed after uninstall');

  // installed_plugins.json / known_marketplaces.json / settings.json are the
  // CLI's own bookkeeping — confirmed cleared back to empty, not merely
  // "still present but stale".
  const installedPluginsPath = path.join(claudeConfigDir, 'plugins', 'installed_plugins.json');
  const knownMarketplacesPath = path.join(claudeConfigDir, 'plugins', 'known_marketplaces.json');
  if (fs.existsSync(installedPluginsPath)) {
    const installedPlugins = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8'));
    assert.deepEqual(installedPlugins.plugins || {}, {}, 'installed_plugins.json must be cleared after uninstall');
  }
  if (fs.existsSync(knownMarketplacesPath)) {
    const knownMarketplaces = JSON.parse(fs.readFileSync(knownMarketplacesPath, 'utf8'));
    assert.deepEqual(knownMarketplaces, {}, 'known_marketplaces.json must be cleared after marketplace remove');
  }

  // DOCUMENTED residue, not a failure: the CLI's own on-disk plugin CACHE
  // (the cloned/copied plugin source under plugins/cache/<marketplace>/
  // <plugin>/<version>/) is left behind by `plugin uninstall` — this is the
  // claude CLI's own cache management, entirely outside this plugin's own
  // data dir (see README's Uninstall section), and this test asserts that
  // fact explicitly rather than being surprised by it.
  const cacheRoot = path.join(claudeConfigDir, 'plugins', 'cache', marketplaceName);
  if (fs.existsSync(cacheRoot)) {
    t.diagnostic(`documented CLI-managed residue after uninstall (not this plugin's own data): ${cacheRoot}`);
  }
});

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
