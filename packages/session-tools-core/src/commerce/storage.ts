/** MerchantDesk addition: local demo commerce ledger. No real payment gateway is called. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const CentsSchema = z.number().int().nonnegative().max(100_000_000);
export const SeedSchema = z.object({
  mode: z.literal('demo'),
  currency: z.literal('CNY'),
  products: z.array(z.object({
    id: IdSchema, name: z.string(), category: z.string(), description: z.string(),
    features: z.array(z.string()), priceCents: CentsSchema,
    stock: z.number().int().nonnegative().max(1_000_000),
  })),
  orders: z.array(z.object({
    id: IdSchema, productId: IdSchema, quantity: z.number().int().positive(),
    paidCents: CentsSchema, status: z.enum(['paid', 'shipped', 'delivered', 'cancelled']),
  })),
  policies: z.array(z.object({ id: IdSchema, title: z.string(), content: z.string() })),
}).strict();
export type CommerceSeed = z.infer<typeof SeedSchema>;

export const GrantSchema = z.object({
  sessionId: IdSchema,
  role: z.enum(['support', 'operations', 'analyst']),
  orderIds: z.array(IdSchema),
  maxRefundCents: CentsSchema,
  expiresAt: z.number().int().positive(),
}).strict();
export type CommerceGrant = z.infer<typeof GrantSchema>;

const EventBase = z.object({
  sessionId: IdSchema, at: z.number(), requestId: IdSchema, reason: z.string().max(500),
});
export const LedgerEventSchema = z.discriminatedUnion('type', [
  EventBase.extend({ type: z.literal('refund'), orderId: IdSchema, amountCents: CentsSchema }),
  EventBase.extend({ type: z.literal('inventory'), productId: IdSchema, delta: z.number().int(), expectedVersion: z.number().int().nonnegative() }),
]);
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export function commerceDir(workspacePath: string): string { return join(workspacePath, 'commerce'); }
export function commerceEnabled(workspacePath: string): boolean { return existsSync(join(commerceDir(workspacePath), 'seed.json')); }

export function readSeed(workspacePath: string): CommerceSeed {
  if (!commerceEnabled(workspacePath)) throw new Error('COMMERCE_NOT_CONFIGURED: run commerce:init for this workspace.');
  return SeedSchema.parse(JSON.parse(readFileSync(join(commerceDir(workspacePath), 'seed.json'), 'utf8')));
}

/** Identity comes exclusively from the runtime context, never from model arguments. */
export function readGrant(workspacePath: string, sessionId: string): CommerceGrant {
  IdSchema.parse(sessionId);
  const path = join(commerceDir(workspacePath), 'grants', `${sessionId}.json`);
  if (!existsSync(path)) throw new Error('ACCESS_DENIED: this session has no commerce grant. Ask the workspace administrator.');
  const grant = GrantSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (grant.sessionId !== sessionId || grant.expiresAt <= Date.now()) throw new Error('ACCESS_DENIED: grant expired or identity mismatch.');
  return grant;
}

/** Only a non-newline-terminated tail may be ignored after a crash. Interior corruption fails closed. */
export function readJsonLines<T>(path: string, parse: (value: unknown) => T): { records: T[]; validBytes: number; partialTail: boolean } {
  if (!existsSync(path)) return { records: [], validBytes: 0, partialTail: false };
  const buffer = readFileSync(path);
  const end = buffer.lastIndexOf(10) + 1;
  const lines = buffer.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
  return { records: lines.map(line => parse(JSON.parse(line))), validBytes: end, partialTail: end !== buffer.length };
}

export function readLedger(workspacePath: string): LedgerEvent[] {
  return readJsonLines(join(commerceDir(workspacePath), 'ledger.jsonl'), value => LedgerEventSchema.parse(value)).records;
}

export function replayCommerce(seed: CommerceSeed, events: LedgerEvent[]) {
  const products = seed.products.map(p => ({ ...p, version: 0 }));
  const orders = seed.orders.map(o => ({ ...o, refundedCents: 0 }));
  for (const event of events) {
    if (event.type === 'refund') {
      const order = orders.find(o => o.id === event.orderId);
      if (!order || order.refundedCents + event.amountCents > order.paidCents) throw new Error('CORRUPT_LEDGER: invalid refund.');
      order.refundedCents += event.amountCents;
    } else {
      const product = products.find(p => p.id === event.productId);
      if (!product || product.version !== event.expectedVersion || product.stock + event.delta < 0 || product.stock + event.delta > 1_000_000) throw new Error('CORRUPT_LEDGER: invalid inventory update.');
      product.stock += event.delta;
      product.version++;
    }
  }
  return { products, orders, policies: seed.policies, mode: seed.mode, currency: seed.currency };
}

/** Cross-process exclusion also covers MCP subprocesses. Never steal an active/stale lock automatically. */
export async function withCommerceLock<T>(workspacePath: string, action: () => T): Promise<T> {
  const dir = commerceDir(workspacePath);
  if (!existsSync(dir)) throw new Error('COMMERCE_NOT_CONFIGURED');
  const lock = join(dir, 'ledger.lock');
  let fd: number | undefined;
  const deadline = Date.now() + 10_000;
  while (fd === undefined) {
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('COMMERCE_BUSY: retry with the SAME requestId; an administrator must inspect a stale ledger.lock.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Call only while holding ledger.lock. One durable append is both state and audit, eliminating dual writes. */
export function appendLedger(workspacePath: string, event: LedgerEvent): void {
  LedgerEventSchema.parse(event);
  const path = join(commerceDir(workspacePath), 'ledger.jsonl');
  const previous = readJsonLines(path, value => LedgerEventSchema.parse(value));
  if (previous.partialTail) truncateSync(path, previous.validBytes);
  const fd = openSync(path, 'a', 0o600);
  try {
    const data = Buffer.from(`${JSON.stringify(event)}\n`);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Administrative provisioning only. Not registered as an agent tool. */
export function initializeCommerce(workspacePath: string, seed: CommerceSeed): void {
  const parsed = SeedSchema.parse(seed);
  if (new Set(parsed.products.map(p => p.id)).size !== parsed.products.length || new Set(parsed.orders.map(o => o.id)).size !== parsed.orders.length || parsed.orders.some(o => !parsed.products.some(p => p.id === o.productId))) throw new Error('Invalid or duplicate seed identifiers.');
  mkdirSync(join(commerceDir(workspacePath), 'grants'), { recursive: true });
  writeFileSync(join(commerceDir(workspacePath), 'seed.json'), `${JSON.stringify(parsed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function provisionGrant(workspacePath: string, grant: CommerceGrant): void {
  const parsed = GrantSchema.parse(grant);
  const seed = readSeed(workspacePath);
  if (parsed.orderIds.some(id => !seed.orders.some(o => o.id === id))) throw new Error('Unknown order in grant.');
  writeFileSync(join(commerceDir(workspacePath), 'grants', `${parsed.sessionId}.json`), `${JSON.stringify(parsed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
