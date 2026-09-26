/** MerchantDesk addition: append-only execution audit; existing Craft messages remain the transcript. */
import { appendFileSync, existsSync, mkdirSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { commerceEnabled, IdSchema, readJsonLines } from './storage.ts';

const UsageSchema = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), costUsd: z.number().nonnegative().optional() });
const AuditRecordSchema = z.object({
  version: z.literal(1), at: z.number(), sessionId: IdSchema, runId: z.string(),
  model: z.string(), connection: z.string(),
  event: z.object({
    type: z.string(), text: z.string().optional(), toolName: z.string().optional(),
    toolUseId: z.string().optional(), requestId: z.string().optional(), isError: z.boolean().optional(),
    code: z.string().optional(), status: z.string().optional(), usage: UsageSchema.optional(),
  }),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
export interface AuditContext { workspacePath: string; sessionId: string; runId: string; model?: string; connection?: string }

function journalPath(workspacePath: string, sessionId: string) {
  IdSchema.parse(sessionId);
  return join(workspacePath, 'sessions', sessionId, 'commerce-events.jsonl');
}

export function readAgentAudit(workspacePath: string, sessionId: string) {
  return readJsonLines(journalPath(workspacePath, sessionId), value => {
    const record = AuditRecordSchema.parse(value);
    if (record.sessionId !== sessionId) throw new Error('AUDIT_IDENTITY_MISMATCH');
    return record;
  });
}

/** Deliberately excludes tool arguments, raw results, credentials and permission command strings. */
export function appendAgentAudit(ctx: AuditContext, event: { type: string; [key: string]: unknown }): void {
  const projected: AuditRecord['event'] = { type: event.type };
  for (const key of ['text', 'toolName', 'toolUseId', 'requestId', 'code', 'status'] as const) {
    if (typeof event[key] === 'string') projected[key] = event[key];
  }
  if (typeof event.isError === 'boolean') projected.isError = event.isError;
  if (event.type === 'error' && typeof event.message === 'string') projected.text = event.message;
  if (event.type === 'typed_error' && event.error && typeof event.error === 'object') {
    const error = event.error as { code?: string; message?: string };
    projected.code = error.code;
    projected.text = error.message;
  }
  if (event.type === 'complete' && event.usage) projected.usage = UsageSchema.parse(event.usage);
  const record = AuditRecordSchema.parse({ version: 1, at: Date.now(), sessionId: ctx.sessionId, runId: ctx.runId, model: ctx.model ?? 'unknown', connection: ctx.connection ?? 'default', event: projected });
  appendFileSync(journalPath(ctx.workspacePath, ctx.sessionId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function summarizeAgentAudit(records: AuditRecord[]) {
  const runs = new Map<string, { status: string; pendingTools: Set<string>; usageRecorded: boolean; hasError: boolean }>();
  const byModel: Record<string, { model: string; connection: string; inputTokens: number; outputTokens: number; reportedCostUsd: number; unpricedRuns: number; completedRuns: number }> = {};
  let toolCalls = 0;
  let toolFailures = 0;
  let permissionRequests = 0;
  let errors = 0;
  for (const record of records) {
    const e = record.event;
    const run = runs.get(record.runId) ?? { status: 'incomplete', pendingTools: new Set<string>(), usageRecorded: false, hasError: false };
    runs.set(record.runId, run);
    if (e.type === 'tool_start' && e.toolUseId) { run.pendingTools.add(e.toolUseId); toolCalls++; }
    if (e.type === 'tool_result' && e.toolUseId) { run.pendingTools.delete(e.toolUseId); if (e.isError) toolFailures++; }
    if (e.type === 'permission_request') permissionRequests++;
    if (e.type === 'error' || e.type === 'typed_error') { errors++; run.hasError = true; run.status = 'failed'; }
    if (e.type === 'complete' && !run.usageRecorded) {
      run.usageRecorded = true;
      run.status = run.hasError ? 'failed' : 'completed';
      const key = JSON.stringify([record.connection, record.model]);
      const row = byModel[key] ??= { model: record.model, connection: record.connection, inputTokens: 0, outputTokens: 0, reportedCostUsd: 0, unpricedRuns: 0, completedRuns: 0 };
      row.completedRuns++;
      row.inputTokens += e.usage?.inputTokens ?? 0;
      row.outputTokens += e.usage?.outputTokens ?? 0;
      row.reportedCostUsd += e.usage?.costUsd ?? 0;
      if (e.usage?.costUsd === undefined) row.unpricedRuns++;
    }
    if (e.type === 'run_finished' && e.status) run.status = e.status === 'completed' && run.hasError ? 'failed' : e.status;
  }
  const last = [...runs.entries()].at(-1);
  return {
    runCount: runs.size, toolCalls, toolFailures, permissionRequests, errors,
    lastRun: last ? { runId: last[0], status: last[1].status, pendingToolIds: [...last[1].pendingTools] } : null,
    costs: Object.values(byModel),
    costNote: 'Only provider-reported model cost in USD; missing prices are unknown. Tool counts are not monetary cost. Refund amounts are CNY cents.',
  };
}

/** Single writer: SessionManager owns each session. Repair only the torn tail before a new run. */
export function startCommerceRun(ctx: Omit<AuditContext, 'runId'>) {
  if (!commerceEnabled(ctx.workspacePath)) return null;
  const path = journalPath(ctx.workspacePath, ctx.sessionId);
  const previous = readAgentAudit(ctx.workspacePath, ctx.sessionId);
  if (previous.partialTail && existsSync(path)) truncateSync(path, previous.validBytes);
  mkdirSync(join(ctx.workspacePath, 'sessions', ctx.sessionId), { recursive: true });
  const audit = { ...ctx, runId: randomUUID() };
  const recovery = summarizeAgentAudit(previous.records).lastRun;
  appendAgentAudit(audit, { type: 'run_started' });
  return { audit, recovery };
}
