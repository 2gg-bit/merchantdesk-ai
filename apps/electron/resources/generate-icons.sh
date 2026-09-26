#!/bin/bash
# MerchantDesk uses its original vector artwork; do not regenerate the upstream logo.
set -e
cd "$(dirname "$0")/../../.."
bun scripts/generate-merchantdesk-icons.ts
