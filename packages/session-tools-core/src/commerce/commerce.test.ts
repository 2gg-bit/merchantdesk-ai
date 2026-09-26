import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMERCE_TOOL_DEFS } from './tools.ts';
import { initializeCommerce, provisionGrant, readLedger, readSeed, replayCommerce, SeedSchema } from './storage.ts';
import { appendAgentAudit, readAgentAudit, startCommerceRun, summarizeAgentAudit } from './journal.ts';
import type { SessionToolContext } from '../context.ts';
import seedData from '../../../../examples/commerce/seed.json';

const seed = SeedSchema.parse(seedData);
let workspacePath: string;
let ctx: SessionToolContext;
function grant(sessionId: string, role: 'support' | 'operations' | 'analyst' = 'support', orders = ['DEMO-1001'], limit = 8900) {
  provisionGrant(workspacePath, { sessionId, role, orderIds: orders, maxRefundCents: limit, expiresAt: Date.now() + 3600_000 });
  return { workspacePath, sessionId } as SessionToolContext;
}
async function call(name: string, args: unknown, context = ctx) {
  const result = await COMMERCE_TOOL_DEFS.find(d => d.name === name)!.handler!(context, args);
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
  return { error: !!result.isError, text, value: result.isError ? undefined : JSON.parse(text) };
}
const refund = (requestId = 'refund-1', amountCents = 1000) => ({ orderId: 'DEMO-1001', amountCents, reason: 'Test adjustment', requestId });

beforeEach(() => { workspacePath = mkdtempSync(join(tmpdir(), 'merchantdesk-test-')); initializeCommerce(workspacePath, seed); ctx = grant('support-a'); });
afterEach(() => { rmSync(workspacePath, { recursive: true, force: true }); });

describe('commerce authorization and factual inputs', () => {
  test('catalog respects price and stock filters and returns source IDs', async () => {
    const result = await call('commerce_search_products', { query: '通勤', maxPriceCents: 15000, inStockOnly: true });
    expect(result.value.products.map((p: { id: string }) => p.id)).toEqual(['SKU-TEA-01']);
    expect(result.value.products[0].version).toBe(0);
    expect((await call('commerce_get_policy', {})).value.policies[0].id).toBe('shipping');
  });
  test('unprovisioned sessions fail closed', async () => {
    expect((await call('commerce_search_products', {}, { ...ctx, sessionId: 'unknown' })).text).toContain('ACCESS_DENIED');
  });
  test('order reads cannot cross session grants', async () => {
    expect((await call('commerce_get_order', { orderId: 'DEMO-1002' })).text).toContain('ACCESS_DENIED');
    const other = grant('support-b', 'support', ['DEMO-1002']);
    expect((await call('commerce_get_order', { orderId: 'DEMO-1002' }, other)).error).toBe(false);
    expect((await call('commerce_get_order', { orderId: 'DEMO-1001' }, other)).error).toBe(true);
  });
  test('model arguments cannot override runtime identity or inject traversal', async () => {
    expect((await call('commerce_get_order', { orderId: 'DEMO-1001', sessionId: 'support-b' })).error).toBe(true);
    expect((await call('commerce_get_order', { orderId: '../DEMO-1001' })).error).toBe(true);
    expect((await call('commerce_get_policy', {}, { ...ctx, sessionId: '../support-a' })).error).toBe(true);
  });
  test('expired grants are rechecked on every call', async () => {
    const path = join(workspacePath, 'commerce/grants/support-a.json');
    const expired = JSON.parse(readFileSync(path, 'utf8')); expired.expiresAt = Date.now() - 1;
    writeFileSync(path, JSON.stringify(expired));
    expect((await call('commerce_get_order', { orderId: 'DEMO-1001' })).text).toContain('ACCESS_DENIED');
  });
  test('workspace state is isolated even when session IDs are equal', async () => {
    const other = mkdtempSync(join(tmpdir(), 'merchantdesk-other-'));
    try {
      initializeCommerce(other, seed);
      expect((await call('commerce_get_order', { orderId: 'DEMO-1001' }, { ...ctx, workspacePath: other })).error).toBe(true);
      expect(readLedger(other)).toEqual([]);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe('durable money and stock mutations', () => {
  test('refund retry is idempotent and a changed payload conflicts', async () => {
    expect((await call('commerce_refund_order', refund())).value.replayed).toBe(false);
    expect((await call('commerce_refund_order', refund())).value.replayed).toBe(true);
    expect((await call('commerce_refund_order', refund('refund-1', 2000))).text).toContain('IDEMPOTENCY_CONFLICT');
    expect(readLedger(workspacePath)).toHaveLength(1);
    expect(replayCommerce(readSeed(workspacePath), readLedger(workspacePath)).orders[0]!.refundedCents).toBe(1000);
  });
  test('refund cannot exceed session budget, paid amount or order scope', async () => {
    expect((await call('commerce_refund_order', refund('over', 8901))).error).toBe(true);
    expect((await call('commerce_refund_order', { ...refund(), orderId: 'DEMO-1002' })).error).toBe(true);
    expect((await call('commerce_refund_order', refund('full', 8900))).error).toBe(false);
    expect((await call('commerce_refund_order', refund('extra', 1))).error).toBe(true);
  });
  test('fractional and negative money rejected, analysts cannot write', async () => {
    expect((await call('commerce_refund_order', refund('fraction', 0.5))).error).toBe(true);
    expect((await call('commerce_refund_order', refund('negative', -1))).error).toBe(true);
    expect((await call('commerce_refund_order', refund(), grant('analyst', 'analyst'))).error).toBe(true);
  });
  test('splitting a refund cannot bypass the cumulative session budget', async () => {
    const limited = grant('limited', 'support', ['DEMO-1001'], 1500);
    expect((await call('commerce_refund_order', refund('first', 1000), limited)).error).toBe(false);
    expect((await call('commerce_refund_order', refund('second', 1000), limited)).text).toContain('REFUND_SESSION_BUDGET_EXCEEDED');
    expect((await call('commerce_refund_order', refund('first', 1000), limited)).value.replayed).toBe(true);
  });
  test('separate MCP-like processes cannot duplicate a refund', async () => {
    const source = new URL('./tools.ts', import.meta.url).href;
    const script = `import { COMMERCE_TOOL_DEFS } from ${JSON.stringify(source)};
      const result = await COMMERCE_TOOL_DEFS.find(d => d.name === 'commerce_refund_order').handler(
        { workspacePath: process.argv[1], sessionId: 'support-a' },
        { orderId: 'DEMO-1001', amountCents: 1000, requestId: 'process-retry', reason: 'test' });
      if (result.isError) { console.error(result); process.exit(1); }`;
    const processes = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, '-e', script, workspacePath], { stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(processes.map(p => p.exited));
    expect(codes).toEqual(Array(6).fill(0));
    expect(readLedger(workspacePath)).toHaveLength(1);
  });
  test('parallel duplicate refunds commit once', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => call('commerce_refund_order', refund())));
    expect(results.every(r => !r.error)).toBe(true);
    expect(results.filter(r => !r.value.replayed)).toHaveLength(1);
    expect(readLedger(workspacePath)).toHaveLength(1);
  });
  test('concurrent distinct refunds cannot over-refund', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call('commerce_refund_order', refund(`parallel-${i}`))));
    expect(results.filter(r => !r.error)).toHaveLength(8);
    expect(replayCommerce(readSeed(workspacePath), readLedger(workspacePath)).orders[0]!.refundedCents).toBe(8000);
  });
  test('stock writes require operations role and optimistic concurrency', async () => {
    const args = { productId: 'SKU-TEA-01', delta: -1, expectedVersion: 0, reason: 'Stock count', requestId: 'stock-1' };
    expect((await call('commerce_adjust_inventory', args)).error).toBe(true);
    const ops = grant('ops', 'operations');
    const results = await Promise.all([call('commerce_adjust_inventory', args, ops), call('commerce_adjust_inventory', { ...args, requestId: 'stock-2' }, ops)]);
    expect(results.filter(r => !r.error)).toHaveLength(1);
    expect(results.find(r => r.error)!.text).toContain('VERSION_CONFLICT');
    expect((await call('commerce_adjust_inventory', args, ops)).value.replayed).toBe(true);
    expect((await call('commerce_adjust_inventory', { ...args, delta: -1000, expectedVersion: 1, requestId: 'negative' }, ops)).text).toContain('INVALID_STOCK');
  });
  test('torn tail recovery preserves committed transactions', async () => {
    await call('commerce_refund_order', refund());
    appendFileSync(join(workspacePath, 'commerce/ledger.jsonl'), '{"type":"refu');
    expect(readLedger(workspacePath)).toHaveLength(1);
    expect((await call('commerce_refund_order', refund('second'))).error).toBe(false);
    expect(readLedger(workspacePath)).toHaveLength(2);
  });
  test('interior ledger corruption fails closed rather than silently dropping money', async () => {
    appendFileSync(join(workspacePath, 'commerce/ledger.jsonl'), 'broken\n');
    expect((await call('commerce_refund_order', refund())).error).toBe(true);
    expect(readFileSync(join(workspacePath, 'commerce/ledger.jsonl'), 'utf8')).toBe('broken\n');
  });
  test('audit cannot read another session business events', async () => {
    await call('commerce_refund_order', refund());
    expect((await call('commerce_audit', {}, grant('second'))).value.businessEvents).toHaveLength(0);
    expect((await call('commerce_audit', {})).value.businessEvents).toHaveLength(1);
  });
});

describe('execution journal, recovery and cost attribution', () => {
  test('replays lifecycle, reports pending tools, omits raw tool secrets', () => {
    const run = startCommerceRun({ workspacePath, sessionId: ctx.sessionId, model: 'model-a', connection: 'provider-a' })!;
    appendAgentAudit(run.audit, { type: 'text_delta', text: '正在查询' });
    appendAgentAudit(run.audit, { type: 'tool_start', toolName: 'commerce_get_order', toolUseId: 'tool-1', input: { apiKey: 'DO_NOT_LOG' } });
    appendAgentAudit(run.audit, { type: 'permission_request', requestId: 'permission-1', toolName: 'commerce_refund_order', command: 'SECRET_COMMAND' });
    const restarted = startCommerceRun({ workspacePath, sessionId: ctx.sessionId, model: 'model-b' })!;
    expect(restarted.recovery?.status).toBe('incomplete');
    expect(restarted.recovery?.pendingToolIds).toEqual(['tool-1']);
    const raw = readFileSync(join(workspacePath, 'sessions', ctx.sessionId, 'commerce-events.jsonl'), 'utf8');
    expect(raw).not.toContain('DO_NOT_LOG'); expect(raw).not.toContain('SECRET_COMMAND');
    expect(raw).toContain('正在查询');
  });
  test('attributes costs by model and connection, deduplicates completion, preserves failures', () => {
    const run = startCommerceRun({ workspacePath, sessionId: ctx.sessionId, model: 'model-a', connection: 'provider-a' })!;
    appendAgentAudit(run.audit, { type: 'typed_error', error: { code: 'provider_error', message: 'Provider failed' } });
    const complete = { type: 'complete', usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.002 } };
    appendAgentAudit(run.audit, complete); appendAgentAudit(run.audit, complete);
    appendAgentAudit(run.audit, { type: 'run_finished', status: 'completed' });
    let result = summarizeAgentAudit(readAgentAudit(workspacePath, ctx.sessionId).records);
    expect(result.lastRun?.status).toBe('failed'); expect(result.costs[0]!.reportedCostUsd).toBe(0.002);
    expect(result.costs[0]!.inputTokens).toBe(20); expect(result.errors).toBe(1);
    const second = startCommerceRun({ workspacePath, sessionId: ctx.sessionId, model: 'model-b', connection: 'provider-b' })!;
    appendAgentAudit(second.audit, { type: 'complete', usage: { inputTokens: 3, outputTokens: 2 } });
    result = summarizeAgentAudit(readAgentAudit(workspacePath, ctx.sessionId).records);
    expect(result.costs).toHaveLength(2); expect(result.costs[1]!.unpricedRuns).toBe(1);
  });
  test('crash tail is repaired on a new run and normal workspaces are opt-in', () => {
    const run = startCommerceRun({ workspacePath, sessionId: ctx.sessionId })!;
    appendAgentAudit(run.audit, { type: 'run_finished', status: 'interrupted' });
    appendFileSync(join(workspacePath, 'sessions', ctx.sessionId, 'commerce-events.jsonl'), '{');
    expect(readAgentAudit(workspacePath, ctx.sessionId).partialTail).toBe(true);
    expect(startCommerceRun({ workspacePath, sessionId: ctx.sessionId })!.recovery?.status).toBe('interrupted');
    expect(readAgentAudit(workspacePath, ctx.sessionId).partialTail).toBe(false);
    expect(startCommerceRun({ workspacePath: join(workspacePath, 'unconfigured'), sessionId: 'plain' })).toBeNull();
  });
});
