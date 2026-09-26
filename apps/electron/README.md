# MerchantDesk Desktop

MerchantDesk (商舟 AI) is an ecommerce workbench based on Craft Agents 0.11.4. This package retains the upstream Electron/React architecture and shares session management, commerce tools and audit data with the Web UI and CLI.

From the repository root:

```bash
bun install --frozen-lockfile
bun run electron:start
```

For a development renderer, use `bun run electron:dev`. To verify the source build without launching Electron, use `bun run electron:build`.

Configure your own model connection in onboarding, then follow [the commerce guide](../../docs/commerce.md) to initialize a demo store and grant access to specific sessions. The built-in store and refunds are simulated; no real payments are processed.

The product name, icon and bundle ID are independent from Craft. Internal package names and CRAFT_* environment variables remain compatible with upstream. Default upstream updates and public sharing are disabled; see [the root README](../../README.md).

See [architecture](../../docs/architecture.md), [validation](../../docs/validation.md), [security boundaries](../../SECURITY.md), and [upstream notices](../../NOTICE).
