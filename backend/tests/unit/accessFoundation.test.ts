import { describe, expect, it, vi } from 'vitest';
import { AccessError, AccessService, type AccessUser, type RequestContext } from '../../src/modules/access/index.js';
import { ModelSettingsService } from '../../src/modules/modelSettings/index.js';
import { handleAuthMessage } from '../../src/services/web/agents/authProtocol.js';

function fixture(admin = false) {
  let now = 1000;
  const user: AccessUser = { uid: 'uid-a', projectId: 'test-project', email: 'reviewed@example.test', name: 'Reviewed', isAuthorized: true, isAdmin: admin };
  const verify = vi.fn(async () => ({ uid: 'uid-a', projectId: 'test-project', email: 'signed@example.test', emailVerified: true, expiresAtMs: 2000 }));
  const findByIdentity = vi.fn(async (): Promise<AccessUser | null> => user);
  let request = 0;
  const access = new AccessService({ verify }, { findByIdentity }, () => `request-${++request}`, () => now);
  const repository = { snapshot: vi.fn(() => ({ current: { chat: 'model-a', 'minebot.executor': 'model-b' }, overrides: {} })), set: vi.fn(), reset: vi.fn() };
  return { access, verify, findByIdentity, user, repository, settings: new ModelSettingsService(repository, () => now), advance: () => { now = 3000; } };
}

describe('access boundary', () => {
  it('construction does not verify a token or query a database', () => {
    const f = fixture(); expect(f.verify).not.toHaveBeenCalled(); expect(f.findByIdentity).not.toHaveBeenCalled();
  });
  it.each([undefined, null, '', {}, 'bad token', 'x'.repeat(16385)])('rejects invalid credential input before touching dependencies: %s', async token => {
    const f = fixture(); await expect(f.access.authenticate(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.findByIdentity).not.toHaveBeenCalled();
  });
  it('uses verified UID/project, not an email supplied by a caller, and produces immutable per-request context', async () => {
    const f = fixture(); const a = await f.access.authenticate('token-a'); const b = await f.access.authenticate('token-b');
    expect(f.findByIdentity).toHaveBeenCalledWith('test-project', 'uid-a');
    expect(a.principal.email).toBe('signed@example.test'); expect(a.principal.name).toBe('Reviewed');
    expect(a.requestId).not.toBe(b.requestId); expect(a.capabilities).toEqual(['profile:read']);
    expect(Object.isFrozen(a) && Object.isFrozen(a.principal) && Object.isFrozen(a.capabilities)).toBe(true);
  });
  it.each(['missing', 'disabled', 'wrong-uid', 'wrong-project'])('rejects absent, unreviewed or mismatched grants: %s', async mode => {
    const f = fixture(true);
    f.findByIdentity.mockResolvedValue(mode === 'missing' ? null : { ...f.user,
      isAuthorized: mode !== 'disabled', uid: mode === 'wrong-uid' ? 'other' : f.user.uid,
      projectId: mode === 'wrong-project' ? 'other' : f.user.projectId });
    await expect(f.access.authenticate('token')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not authorize unverified or expired identities', async () => {
    const f = fixture(); f.verify.mockResolvedValueOnce({ uid: 'uid-a', projectId: 'test-project', email: 'x', emailVerified: false, expiresAtMs: 2000 });
    await expect(f.access.authenticate('token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    f.advance(); await expect(f.access.authenticate('token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(f.findByIdentity).not.toHaveBeenCalled();
  });
  it('fails closed on revocation and dependency outages without exposing details', async () => {
    const f = fixture(); f.verify.mockRejectedValueOnce(new AccessError('UNAUTHENTICATED'));
    await expect(f.access.authenticate('token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    f.findByIdentity.mockRejectedValueOnce(new Error('secret DB connection'));
    await expect(f.access.authenticate('token')).rejects.toThrow('AUTH_UNAVAILABLE');
  });
  it('rechecks expiry after a slow grant lookup', async () => {
    const f = fixture(); f.findByIdentity.mockImplementationOnce(async () => { f.advance(); return f.user; });
    await expect(f.access.authenticate('token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('model operation boundary', () => {
  it('rejects unauthenticated, empty-capability and non-admin callers even when invoked without HTTP', async () => {
    const f = fixture(); const user = await f.access.authenticate('token');
    for (const context of [null, user, { ...user, capabilities: [] } as RequestContext]) {
      expect(() => f.settings.update(context, 'chat', 'new-model')).toThrow();
      expect(() => f.settings.reset(context)).toThrow(); expect(() => f.settings.read(context)).toThrow();
    }
    expect(f.repository.set).not.toHaveBeenCalled(); expect(f.repository.reset).not.toHaveBeenCalled(); expect(f.repository.snapshot).not.toHaveBeenCalled();
  });
  it('allows reviewed admin operations on known keys, including minebot keys', async () => {
    const f = fixture(true); const context = await f.access.authenticate('token');
    expect(f.settings.read(context).current.chat).toBe('model-a');
    f.settings.update(context, 'minebot.executor', 'new-model'); f.settings.reset(context);
    expect(f.repository.set).toHaveBeenCalledWith('minebot.executor', 'new-model'); expect(f.repository.reset).toHaveBeenCalledOnce();
  });
  it.each(['__proto__', 'constructor', 'unknown', 'minebot.unknown'])('does not accept arbitrary keys: %s', async key => {
    const f = fixture(true); const context = await f.access.authenticate('token');
    expect(() => f.settings.update(context, key, 'model')).toThrow('Unknown model key'); expect(f.repository.set).not.toHaveBeenCalled();
  });
  it.each(['', ' ', '\nmodel', {}, 'x'.repeat(201)])('rejects invalid model values', async value => {
    const f = fixture(true);
    const context = await f.access.authenticate('token');
    expect(() => f.settings.update(context, 'chat', value)).toThrow('Invalid model name'); expect(f.repository.set).not.toHaveBeenCalled();
  });
  it('an expired request cannot execute a delayed action', async () => {
    const f = fixture(true); const context = await f.access.authenticate('token'); f.advance();
    expect(() => f.settings.update(context, 'chat', 'model')).toThrow('UNAUTHENTICATED');
    expect(f.repository.set).not.toHaveBeenCalled();
  });
});

describe('auth wire protocol', () => {
  it('rejects the email-only protocol and disables public registration', async () => {
    const f = fixture();
    expect(await handleAuthMessage(JSON.stringify({ type: 'auth:check', email: 'admin@example.test' }), f.access)).toMatchObject({ success: false });
    expect(await handleAuthMessage(JSON.stringify({ type: 'auth:init', isAdmin: true }), f.access)).toMatchObject({ success: false, error: 'REGISTRATION_DISABLED' });
    expect(f.findByIdentity).not.toHaveBeenCalled();
  });
  it('uses signed identity and stored grants despite spoofed email or role fields', async () => {
    const f = fixture(); const response = await handleAuthMessage(JSON.stringify({ type: 'auth:check', idToken: 'token', email: 'spoof', isAdmin: true }), f.access);
    expect(response).toEqual({ type: 'auth:response', success: true, userData: { name: 'Reviewed', email: 'signed@example.test', isAdmin: false } });
  });
  it.each(['{', 'null', '[]', '"text"'])('invalid JSON or envelope is handled safely', async raw => {
    const f = fixture(); expect(await handleAuthMessage(raw, f.access)).toMatchObject({ success: false, error: 'INVALID_MESSAGE' }); expect(f.verify).not.toHaveBeenCalled();
  });
});


describe('foundation dependency gate', () => {
  it('accepts the current modules and rejects SDK/platform dependencies in a fixture', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const script = path.resolve('../scripts/check-foundation-boundaries.cjs');
    expect(execFileSync(process.execPath, [script], { encoding: 'utf8' })).toContain('passed');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shannon-boundary-'));
    try {
      fs.mkdirSync(path.join(root, 'access')); fs.mkdirSync(path.join(root, 'modelSettings'));
      fs.mkdirSync(path.join(root, 'execution'));
      fs.writeFileSync(path.join(root, 'execution/index.ts'), 'export {};');
      fs.writeFileSync(path.join(root, 'access/index.ts'), 'export {};');
      fs.writeFileSync(path.join(root, 'modelSettings/index.ts'), 'export {};');
      expect(execFileSync(process.execPath, [script, root], { encoding: 'utf8' })).toContain('passed');
      fs.writeFileSync(path.join(root, 'access/index.ts'), "import fs from 'node:fs';\nconst value = process.env.SECRET;\n");
      expect(() => execFileSync(process.execPath, [script, root], { stdio: 'pipe' })).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});


describe('self-improvement protection for access boundaries', () => {
  it('cannot edit security modules, registration, composition or its own deny policy', async () => {
    const { isMutableRelativePath } = await import('../../src/services/llm/graph/cognitive/selfImprove/mutableCodePolicy.js');
    for (const path of ['src/modules/access/index.ts', 'src/modules/modelSettings/index.ts',
      'src/modules/execution/index.ts', 'src/services/llm/graph/requestExecutionCoordinator.ts',
      'src/services/llm/graph/coordinatedGraphInvocation.ts', 'src/services/llm/graph/shannonGraph.ts',
      'src/services/llm/graph/cognitive/ParallelExecutor.ts', 'src/services/llm/client.ts',
      'src/adapters/access/FirebaseIdentityVerifier.ts', 'src/bootstrap/webAccess.ts', 'src/models/User.ts',
      'src/server.ts', 'src/services/web/client.ts',
      'src/routes/modelRoutes.ts', 'src/routes/accessHttp.ts', 'src/services/web/agents/authAgent.ts',
      'src/services/web/agents/authProtocol.ts', 'src/services/common/WebSocketService.ts',
      'src/services/llm/graph/cognitive/selfImprove/mutableCodePolicy.ts']) {
      expect(isMutableRelativePath(path), path).toBe(false);
    }
    expect(isMutableRelativePath('src/services/minebot/instantSkills/example.ts')).toBe(true);
  });
});

import { selectAllowedTools } from '../../src/modules/access/toolSelection.js';
describe('explicit tool allowlists',()=>{
 const tools=[{name:'read'},{name:'send'}];
 it('empty means no tools, even when internal caller has write tools',()=>expect(selectAllowedTools(tools,[])).toEqual([]));
 it('selects only listed known tools',()=>expect(selectAllowedTools(tools,['read','unknown'])).toEqual([{name:'read'}]));
 it('keeps the internal tool list when policy is omitted, without sharing the array',()=>{expect(selectAllowedTools(tools,undefined)).toEqual(tools);expect(selectAllowedTools(tools,undefined)).not.toBe(tools)});
 it('rejects malformed runtime policies rather than granting all',()=>expect(()=>selectAllowedTools(tools,null as any)).toThrow('INVALID'));
});
