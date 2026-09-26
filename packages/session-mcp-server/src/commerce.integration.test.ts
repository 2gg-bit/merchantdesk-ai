import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeCommerce, provisionGrant, SeedSchema, readLedger } from '@craft-agent/session-tools-core';
import seed from '../../../examples/commerce/seed.json';

test('commerce tools work across the actual MCP stdio boundary with session authorization and idempotency', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'merchantdesk-mcp-'));
  const client = new Client({ name: 'merchantdesk-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./index.ts', import.meta.url)), '--session-id', 'mcp-support', '--workspace-root', workspacePath, '--plans-folder', join(workspacePath, 'plans')],
    env: { ...process.env, MERCHANTDESK_DOCS_MCP_URL: '' } as Record<string, string>,
    stderr: 'pipe',
  });
  try {
    initializeCommerce(workspacePath, SeedSchema.parse(seed));
    provisionGrant(workspacePath, { sessionId: 'mcp-support', role: 'support', orderIds: ['DEMO-1001'], maxRefundCents: 8900, expiresAt: Date.now() + 60_000 });
    await client.connect(transport);
    const listing = await client.listTools();
    expect(listing.tools.filter(t => t.name.startsWith('commerce_'))).toHaveLength(6);
    const allowed = await client.callTool({ name: 'commerce_get_order', arguments: { orderId: 'DEMO-1001' } });
    expect(allowed.isError).toBe(false);
    const denied = await client.callTool({ name: 'commerce_get_order', arguments: { orderId: 'DEMO-1002' } });
    expect(denied.isError).toBe(true);
    const spoofed = await client.callTool({ name: 'commerce_get_order', arguments: { orderId: 'DEMO-1001', sessionId: 'someone-else' } });
    expect(spoofed.isError).toBe(true);
    const request = { name: 'commerce_refund_order', arguments: { orderId: 'DEMO-1001', amountCents: 100, reason: 'MCP integration test', requestId: 'mcp-refund-1' } };
    expect((await client.callTool(request)).isError).toBe(false);
    expect((await client.callTool(request)).isError).toBe(false);
    expect(readLedger(workspacePath)).toHaveLength(1);
  } finally {
    await client.close();
    await transport.close();
    rmSync(workspacePath, { recursive: true, force: true });
  }
}, 20_000);
