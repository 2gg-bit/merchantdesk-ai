/** Run upstream integration contracts without depending on a developer's local Craft configuration. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = mkdtempSync(join(tmpdir(), 'merchantdesk-integration-'));
try {
  copyFileSync(new URL('../apps/electron/resources/config-defaults.json', import.meta.url), join(config, 'config-defaults.json'));
  mkdirSync(join(config, 'permissions'));
  copyFileSync(new URL('../apps/electron/resources/permissions/default.json', import.meta.url), join(config, 'permissions/default.json'));
  const result = Bun.spawnSync([process.execPath, 'test',
    'packages/session-mcp-server/src/commerce.integration.test.ts',
    'packages/shared/src/agent/__tests__/session-tool-safe-mode-permissions.test.ts',
    'packages/shared/src/agent/__tests__/session-scoped-tools-merge.test.ts',
    'packages/shared/src/agent/backend/claude/session-tool-parity.test.ts',
    'packages/shared/src/agent/backend/pi/session-tool-parity.test.ts',
    'packages/shared/src/prompts/__tests__/system.test.ts',
  ], { cwd: join(import.meta.dir, '..'), env: { ...process.env, CRAFT_CONFIG_DIR: config }, stdout: 'inherit', stderr: 'inherit' });
  process.exitCode = result.exitCode;
} finally { rmSync(config, { recursive: true, force: true }); }
