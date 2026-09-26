/** MerchantDesk administrator CLI. Never exposed in the agent tool registry. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { COMMERCE_TOOL_DEFS, initializeCommerce, provisionGrant, readAgentAudit, readLedger, SeedSchema, GrantSchema, summarizeAgentAudit } from '../packages/session-tools-core/src/commerce/index.ts';
import type { SessionToolContext } from '../packages/session-tools-core/src/context.ts';

const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
  workspace: { type: 'string' }, session: { type: 'string' }, orders: { type: 'string' },
  role: { type: 'string' }, 'refund-limit-cents': { type: 'string' }, 'expires-hours': { type: 'string' },
} });
const command = positionals[0];
const seed = SeedSchema.parse(JSON.parse(readFileSync(new URL('../examples/commerce/seed.json', import.meta.url), 'utf8')));

function required(value: string | undefined, name: string) { if (!value) throw new Error(`Missing --${name}`); return value; }

async function demo() {
  const workspacePath = mkdtempSync(join(tmpdir(), 'merchantdesk-demo-'));
  initializeCommerce(workspacePath, seed);
  const sessionId = 'demo-support';
  mkdirSync(join(workspacePath, 'sessions', sessionId), { recursive: true });
  provisionGrant(workspacePath, { sessionId, role: 'support', orderIds: ['DEMO-1001'], maxRefundCents: 8900, expiresAt: Date.now() + 3600_000 });
  // These handlers only consume the runtime session/workspace identity, never model-supplied IDs.
  const ctx = { workspacePath, sessionId } as SessionToolContext;
  const cases = [
    ['commerce_search_products', { query: '通勤', maxPriceCents: 15000, inStockOnly: true }],
    ['commerce_get_policy', {}],
    ['commerce_get_order', { orderId: 'DEMO-1001' }],
    ['commerce_get_order', { orderId: 'DEMO-1002' }],
    ['commerce_refund_order', { orderId: 'DEMO-1001', amountCents: 1000, reason: '演示售后补偿', requestId: 'demo-refund-1' }],
    ['commerce_refund_order', { orderId: 'DEMO-1001', amountCents: 1000, reason: '演示售后补偿', requestId: 'demo-refund-1' }],
    ['commerce_audit', {}],
  ] as const;
  for (const [name, args] of cases) {
    const def = COMMERCE_TOOL_DEFS.find(d => d.name === name)!;
    const result = await def.handler!(ctx, args);
    console.log(JSON.stringify({ tool: name, error: !!result.isError, result: result.content }));
    if (!!result.isError !== (name === 'commerce_get_order' && 'orderId' in args && args.orderId === 'DEMO-1002')) throw new Error(`Unexpected demo result: ${name}`);
  }
  if (readLedger(workspacePath).length !== 1) throw new Error('Demo idempotency failed');
  console.log(`Demo passed. Synthetic data only. Workspace: ${workspacePath}`);
}

try {
  if (command === 'demo') await demo();
  else if (['init', 'grant', 'report'].includes(command ?? '')) {
    const workspacePath = resolve(required(values.workspace, 'workspace'));
    if (!existsSync(join(workspacePath, 'config.json'))) throw new Error('Choose an existing workspace created in the app (config.json is required).');
    if (command === 'init') {
      initializeCommerce(workspacePath, seed);
      console.log('Demo store initialized. No sessions have access yet; use grant. Existing seed is never overwritten.');
    } else {
      const sessionId = required(values.session, 'session');
      // Validation before any path construction also blocks traversal in administrative commands.
      const grant = GrantSchema.parse({ sessionId, role: values.role ?? 'support', orderIds: values.orders?.split(',').filter(Boolean) ?? [], maxRefundCents: Number(values['refund-limit-cents'] ?? 0), expiresAt: Date.now() + Number(values['expires-hours'] ?? 8) * 3600_000 });
      if (!existsSync(join(workspacePath, 'sessions', sessionId, 'session.jsonl'))) throw new Error('Session does not exist in the selected workspace. Use get_session_info in the app to obtain its ID.');
      if (command === 'grant') {
        if (Number(values['expires-hours'] ?? 8) <= 0) throw new Error('expires-hours must be positive');
        provisionGrant(workspacePath, grant);
        console.log(`Granted ${grant.role} to ${sessionId} for ${grant.orderIds.length} orders. Existing grants are never overwritten; remove the old grant explicitly to revoke/replace it.`);
      } else {
        const audit = readAgentAudit(workspacePath, sessionId);
        console.log(JSON.stringify({ sessionId, ...summarizeAgentAudit(audit.records), partialTailIgnored: audit.partialTail, businessEvents: readLedger(workspacePath).filter(e => e.sessionId === sessionId) }, null, 2));
      }
    }
  } else {
    console.log('Usage: bun scripts/commerce.ts demo | init --workspace PATH | grant --workspace PATH --session ID --orders DEMO-1001 --role support --refund-limit-cents 8900 | report --workspace PATH --session ID');
    if (command && command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
