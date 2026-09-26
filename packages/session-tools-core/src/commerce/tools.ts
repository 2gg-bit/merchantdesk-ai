/** MerchantDesk addition: same handlers across Claude, Pi and the session MCP server. */
import { z } from 'zod';
import type { SessionToolContext } from '../context.ts';
import type { SessionToolDef } from '../tool-defs.ts';
import { errorResponse, successResponse } from '../response.ts';
import { appendLedger, IdSchema, readGrant, readLedger, readSeed, replayCommerce, withCommerceLock, type LedgerEvent } from './storage.ts';
import { readAgentAudit, summarizeAgentAudit } from './journal.ts';

const SearchSchema = z.object({ query: z.string().max(200).optional(), maxPriceCents: z.number().int().nonnegative().optional(), inStockOnly: z.boolean().optional(), limit: z.number().int().min(1).max(20).optional() }).strict();
const OrderSchema = z.object({ orderId: IdSchema }).strict();
const RefundSchema = z.object({ orderId: IdSchema, amountCents: z.number().int().positive().max(100_000_000), reason: z.string().trim().min(1).max(500), requestId: IdSchema.describe('Stable idempotency key. Reuse exactly the same key and arguments after a timeout.') }).strict();
const InventorySchema = z.object({ productId: IdSchema, delta: z.number().int().min(-1_000_000).max(1_000_000).refine(n => n !== 0), expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(500), requestId: IdSchema }).strict();
const EmptySchema = z.object({}).strict();

function define<T extends z.ZodRawShape>(name: string, description: string, schema: z.ZodObject<T>, readOnly: boolean, execute: (ctx: SessionToolContext, args: z.infer<z.ZodObject<T>>) => unknown | Promise<unknown>): SessionToolDef {
  return {
    name, description, inputSchema: schema, executionMode: 'registry', safeMode: readOnly ? 'allow' : 'block', readOnly,
    handler: async (ctx, args) => {
      try {
        // Validate again here: not all provider adapters validate tool arguments themselves.
        const parsed = schema.parse(args);
        readGrant(ctx.workspacePath, ctx.sessionId);
        const value = await execute(ctx, parsed);
        return successResponse(JSON.stringify(value, null, 2));
      } catch (error) {
        return errorResponse(error instanceof z.ZodError ? 'INVALID_ARGUMENT_OR_CONFIGURATION: schema validation failed.' : error instanceof Error ? error.message : 'COMMERCE_ERROR');
      }
    },
  };
}

function authorizedOrder(ctx: SessionToolContext, orderId: string) {
  const grant = readGrant(ctx.workspacePath, ctx.sessionId);
  if (!grant.orderIds.includes(orderId)) throw new Error('ACCESS_DENIED: order is outside this session scope.');
  return grant;
}

function previousRequest(events: LedgerEvent[], next: LedgerEvent) {
  const previous = events.find(e => e.sessionId === next.sessionId && e.requestId === next.requestId);
  if (!previous) return null;
  const { at: _previousAt, ...a } = previous;
  const { at: _nextAt, ...b } = next;
  if (JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(b).sort())) throw new Error('IDEMPOTENCY_CONFLICT: requestId was already used with different arguments.');
  return previous;
}

export const COMMERCE_TOOL_DEFS: SessionToolDef[] = [
  define('commerce_search_products', 'Search the MerchantDesk demo catalog for factual product descriptions and recommendations. Returns price in CNY cents, stock and inventory version. Never invent product claims.', SearchSchema, true, (ctx, args) => {
    const state = replayCommerce(readSeed(ctx.workspacePath), readLedger(ctx.workspacePath));
    const terms = (args.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return { mode: state.mode, currency: state.currency, products: state.products.filter(p =>
      terms.every(term => [p.id, p.name, p.category, p.description, ...p.features].join(' ').toLocaleLowerCase().includes(term)) &&
      (args.maxPriceCents === undefined || p.priceCents <= args.maxPriceCents) && (!args.inStockOnly || p.stock > 0)
    ).slice(0, args.limit ?? 10) };
  }),
  define('commerce_get_policy', 'Read the configured MerchantDesk demo store policies before answering shipping, returns or after-sales questions. These are demo policies, not a real merchant promise.', EmptySchema, true, ctx => ({ mode: 'demo', policies: readSeed(ctx.workspacePath).policies })),
  define('commerce_get_order', 'Look up an order in the runtime-bound session grant. Supplying a different session, workspace or customer identity is not permitted.', OrderSchema, true, (ctx, args) => {
    authorizedOrder(ctx, args.orderId);
    const order = replayCommerce(readSeed(ctx.workspacePath), readLedger(ctx.workspacePath)).orders.find(o => o.id === args.orderId);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    return { mode: 'demo', currency: 'CNY', order };
  }),
  define('commerce_refund_order', 'Record a DEMO refund; never moves real money. Requires support/operations role, session order scope, refund limit and write permission. Explain amount and reason to the operator before use. Use a stable requestId for retries; currency is CNY cents. Does not restock inventory.', RefundSchema, false, (ctx, args) => withCommerceLock(ctx.workspacePath, () => {
    const grant = authorizedOrder(ctx, args.orderId);
    if (grant.role === 'analyst') throw new Error('ACCESS_DENIED: this role cannot refund.');
    if (args.amountCents > grant.maxRefundCents) throw new Error('REFUND_LIMIT_EXCEEDED');
    const events = readLedger(ctx.workspacePath);
    const event: LedgerEvent = { type: 'refund', sessionId: ctx.sessionId, requestId: args.requestId, reason: args.reason, at: Date.now(), orderId: args.orderId, amountCents: args.amountCents };
    const previous = previousRequest(events, event);
    if (previous) return { mode: 'demo', replayed: true, refund: previous };
    const spent = events.reduce((sum, e) => sum + (e.type === 'refund' && e.sessionId === ctx.sessionId ? e.amountCents : 0), 0);
    if (spent + args.amountCents > grant.maxRefundCents) throw new Error('REFUND_SESSION_BUDGET_EXCEEDED');
    const order = replayCommerce(readSeed(ctx.workspacePath), events).orders.find(o => o.id === args.orderId);
    if (!order || order.status === 'cancelled') throw new Error('ORDER_NOT_REFUNDABLE');
    if (order.refundedCents + args.amountCents > order.paidCents) throw new Error('REFUND_EXCEEDS_REMAINING_PAID_AMOUNT');
    appendLedger(ctx.workspacePath, event);
    return { mode: 'demo', replayed: false, refund: event, remainingRefundableCents: order.paidCents - order.refundedCents - args.amountCents };
  })),
  define('commerce_adjust_inventory', 'Adjust DEMO stock, operations role only. First search products to get expectedVersion. Stale versions and negative stock are rejected. Retry with the same requestId after transport errors.', InventorySchema, false, (ctx, args) => withCommerceLock(ctx.workspacePath, () => {
    if (readGrant(ctx.workspacePath, ctx.sessionId).role !== 'operations') throw new Error('ACCESS_DENIED: operations role required.');
    const events = readLedger(ctx.workspacePath);
    const event: LedgerEvent = { type: 'inventory', sessionId: ctx.sessionId, requestId: args.requestId, reason: args.reason, at: Date.now(), productId: args.productId, delta: args.delta, expectedVersion: args.expectedVersion };
    const previous = previousRequest(events, event);
    if (previous) return { mode: 'demo', replayed: true, adjustment: previous };
    const product = replayCommerce(readSeed(ctx.workspacePath), events).products.find(p => p.id === args.productId);
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    if (product.version !== args.expectedVersion) throw new Error('VERSION_CONFLICT: read current stock and ask the operator to review the new adjustment.');
    if (product.stock + args.delta < 0 || product.stock + args.delta > 1_000_000) throw new Error('INVALID_STOCK');
    appendLedger(ctx.workspacePath, event);
    return { mode: 'demo', replayed: false, adjustment: event, stock: product.stock + args.delta, version: product.version + 1 };
  })),
  define('commerce_audit', 'Summarize ONLY the current session: execution status, pending tools, failures, permission requests, provider-reported model cost and demo business mutations. Missing provider prices are unknown, not zero-cost. Use the transcript for human quality review.', EmptySchema, true, ctx => {
    const audit = readAgentAudit(ctx.workspacePath, ctx.sessionId);
    return { sessionId: ctx.sessionId, ...summarizeAgentAudit(audit.records), partialTailIgnored: audit.partialTail, businessEvents: readLedger(ctx.workspacePath).filter(e => e.sessionId === ctx.sessionId) };
  }),
];
