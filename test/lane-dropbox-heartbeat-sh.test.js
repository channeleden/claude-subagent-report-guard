'use strict';

// lane-dropbox-heartbeat.sh wrapper tests.
//
// The POSIX sh prefilter lane-dropbox-heartbeat.sh skips node spawning when
// there is no subagents/ directory. These tests verify the wrapper:
// 1. SKIP CASE — no subagents dir → node never invoked, exit 0
// 2. FALLTHROUGH CASE — subagents dir exists → node invoked
// 3. MISSING/UNPARSEABLE transcript_path → fail open, invoke node
// 4. Subagent's own transcript path → resolves correctly
// 5. Always exits 0
// 6. Never writes hook decision to stdout

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const WRAPPER_SOURCE = path.join(__dirname, '..', 'hooks', 'lane-dropbox-heartbeat.sh');

// Helper: set up a test environment
function setupTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-wrapper-test-'));
  const stubDir = path.join(tmpDir, 'stub-bin');
  fs.mkdirSync(stubDir, { recursive: true });
  
  const stateFile = path.join(tmpDir, 'node-invocations.txt');
  fs.writeFileSync(stateFile, '', 'utf8');
  
  // Stub node that records invocations via environment variable
  const stubNodePath = path.join(stubDir, 'node');
  const stubNodeScript = `#!/bin/sh
# Stub node that records invocation and stdin to a state file (via env var)
input=$(cat)
{
  echo "invoked"
  echo "$input"
} >> "$NODE_STATE_FILE"
exit 0
`;
  fs.writeFileSync(stubNodePath, stubNodeScript, 'utf8');
  fs.chmodSync(stubNodePath, 0o755);
  
  // Read wrapper source and create a version that uses our stub hook
  const wrapperSource = fs.readFileSync(WRAPPER_SOURCE, 'utf8');
  const stubHookPath = path.join(tmpDir, 'lane-dropbox-heartbeat.js');
  fs.writeFileSync(stubHookPath, 'process.exit(0);', 'utf8');
  
  const testWrapper = wrapperSource.replace(
    /node "\$\(dirname "\$0"\)\/lane-dropbox-heartbeat\.js"/g,
    `node "${stubHookPath}"`
  );
  
  return {
    tmpDir,
    stubDir,
    stateFile,
    testWrapper,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
    wasNodeInvoked() {
      try {
        const content = fs.readFileSync(stateFile, 'utf8');
        return content.includes('invoked');
      } catch {
        return false;
      }
    },
    getNodeStdinLines() {
      try {
        const content = fs.readFileSync(stateFile, 'utf8');
        const lines = content.split('\n').filter(l => l.length > 0);
        const stdinLines = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === 'invoked' && i + 1 < lines.length) {
            stdinLines.push(lines[i + 1]);
            i++;
          }
        }
        return stdinLines;
      } catch {
        return [];
      }
    },
  };
}

// Helper: run the wrapper with a payload and PATH
function runWrapper(wrapperContent, payload, env = {}) {
  const input = payload === null ? '' : JSON.stringify(payload);
  
  const result = spawnSync('sh', ['-c', wrapperContent], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status || 0,
  };
}

// ── SKIP CASE: no subagents directory ────────────────────────────────────

test('sh wrapper: skip case — no subagents dir → node NOT invoked, exit 0', () => {
  const env = setupTestEnv();
  try {
    const sessionDir = path.join(env.tmpDir, 'session-id');
    fs.mkdirSync(sessionDir, { recursive: true });
    
    const payload = {
      transcript_path: path.join(sessionDir, 'session-id.jsonl'),
      session_id: 'test-session',
      tool_name: 'Bash',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0, 'must exit 0 on skip path');
    assert.equal(result.stdout, '', 'must not write to stdout on skip');
    assert.equal(env.wasNodeInvoked(), false, 'node must NOT be invoked when no subagents dir');
  } finally {
    env.cleanup();
  }
});

// ── FALLTHROUGH CASE: subagents directory exists ──────────────────────────

test('sh wrapper: fallthrough case — subagents dir exists → node invoked', () => {
  const env = setupTestEnv();
  try {
    const sessionDir = path.join(env.tmpDir, 'session-id-2');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    
    const payload = {
      transcript_path: path.join(subagentsDir, 'agent-xyz.jsonl'),
      session_id: 'test-session-2',
      tool_name: 'Read',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0, 'must exit 0 on fallthrough');
    assert.equal(result.stdout, '', 'wrapper must not write to stdout');
    assert.equal(env.wasNodeInvoked(), true, 'node MUST be invoked when subagents dir exists');
    
    // Verify payload was passed intact
    const stdinLines = env.getNodeStdinLines();
    assert.ok(stdinLines.length > 0, 'node must receive stdin');
    const receivedPayload = JSON.parse(stdinLines[0]);
    assert.deepEqual(receivedPayload, payload, 'payload must be passed intact to node');
  } finally {
    env.cleanup();
  }
});

// ── MISSING/UNPARSEABLE transcript_path ──────────────────────────────────

test('sh wrapper: missing transcript_path → fail open, invoke node', () => {
  const env = setupTestEnv();
  try {
    const payload = {
      session_id: 'test-session-3',
      tool_name: 'Edit',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0, 'must exit 0 even on missing transcript_path');
    assert.equal(env.wasNodeInvoked(), true, 'must fail open and invoke node');
  } finally {
    env.cleanup();
  }
});

test('sh wrapper: unparseable JSON payload → fail open, invoke node', () => {
  const env = setupTestEnv();
  try {
    const result = runWrapper(env.testWrapper, null, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0, 'must exit 0 on unparseable payload');
    assert.equal(env.wasNodeInvoked(), true, 'must fail open and invoke node');
  } finally {
    env.cleanup();
  }
});

test('sh wrapper: empty transcript_path string → fail open, invoke node', () => {
  const env = setupTestEnv();
  try {
    const payload = {
      transcript_path: '',
      session_id: 'test-session-empty',
      tool_name: 'Bash',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0, 'must exit 0 on empty transcript_path');
    assert.equal(env.wasNodeInvoked(), true, 'must fail open and invoke node');
  } finally {
    env.cleanup();
  }
});

// ── SUBAGENT'S OWN TRANSCRIPT PATH ───────────────────────────────────────

test('sh wrapper: subagent transcript path (with /subagents/) → resolves correctly', () => {
  const env = setupTestEnv();
  try {
    const sessionDir = path.join(env.tmpDir, 'session-id-4');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    
    const payload = {
      transcript_path: path.join(subagentsDir, 'agent-inner.jsonl'),
      session_id: 'test-session-4',
      tool_name: 'Bash',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0, 'must exit 0');
    assert.equal(env.wasNodeInvoked(), true, 'must fall through to node');
  } finally {
    env.cleanup();
  }
});

// ── EXIT CODE 0 ON ALL PATHS ────────────────────────────────────────────

test('sh wrapper: always exits 0, including on various error paths', () => {
  const env = setupTestEnv();
  try {
    const result = runWrapper(env.testWrapper, null, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0, 'must exit 0 even on invalid input');
  } finally {
    env.cleanup();
  }
});

// ── NO HOOK DECISION OUTPUT ─────────────────────────────────────────────

test('sh wrapper: never writes hook decision to stdout', () => {
  const env = setupTestEnv();
  try {
    const sessionDir = path.join(env.tmpDir, 'session-id-5');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    
    const payload = {
      transcript_path: path.join(subagentsDir, 'agent.jsonl'),
      session_id: 'test-session-5',
      tool_name: 'Bash',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.stdout, '', 'wrapper must not write to stdout');
    assert.equal(/\{"decision"/.test(result.stdout), false, 'must not emit decision field');
  } finally {
    env.cleanup();
  }
});

// ── PAYLOAD BYTE-INTEGRITY ─────────────────────────────────────────────

test('sh wrapper: payload passed to node is byte-identical (simple case)', () => {
  const env = setupTestEnv();
  try {
    const sessionDir = path.join(env.tmpDir, 'session-id-6');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    
    const payload = {
      transcript_path: path.join(subagentsDir, 'agent.jsonl'),
      session_id: 'test-session-6',
      tool_name: 'Read',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    const stdinLines = env.getNodeStdinLines();
    assert.ok(stdinLines.length > 0, 'node must receive stdin');
    const receivedPayload = JSON.parse(stdinLines[0]);
    assert.deepEqual(receivedPayload, payload, 'payload must pass intact to node');
  } finally {
    env.cleanup();
  }
});

// ── SESSION DIR DERIVATION ───────────────────────────────────────────────

test('sh wrapper: lead transcript path resolves correctly', () => {
  const env = setupTestEnv();
  try {
    // Structure: root/session-id.jsonl, root/session-id/subagents/
    const sessionId = 'test-session-7';
    const root = env.tmpDir;
    const sessionDir = path.join(root, sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    
    const payload = {
      transcript_path: path.join(root, `${sessionId}.jsonl`),
      session_id: sessionId,
      tool_name: 'Bash',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0);
    assert.equal(env.wasNodeInvoked(), true, 'must resolve lead transcript path correctly');
  } finally {
    env.cleanup();
  }
});

test('sh wrapper: deeply nested subagents path resolves correctly', () => {
  const env = setupTestEnv();
  try {
    const sessionDir = path.join(env.tmpDir, 'session-id-8');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    
    const nestedPath = path.join(subagentsDir, 'agent-xyz-aaaa0001.jsonl');
    const payload = {
      transcript_path: nestedPath,
      session_id: 'test-session-8',
      tool_name: 'Bash',
    };
    
    const result = runWrapper(env.testWrapper, payload, {
      PATH: `${env.stubDir}:${process.env.PATH}`,
      NODE_STATE_FILE: env.stateFile,
    });
    
    assert.equal(result.exitCode, 0);
    assert.equal(env.wasNodeInvoked(), true, 'must resolve session dir correctly');
  } finally {
    env.cleanup();
  }
});

// ── EXEC BIT VERIFICATION ────────────────────────────────────────────────

test('sh wrapper: exec bit is set (100755)', () => {
  const stat = fs.statSync(WRAPPER_SOURCE);
  const isExecutable = (stat.mode & 0o111) !== 0;
  assert.ok(isExecutable, `wrapper must be executable (mode: ${stat.mode.toString(8)})`);
});
