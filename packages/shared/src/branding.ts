/** MerchantDesk branding. Export names retained for upstream compatibility. */
export const CRAFT_LOGO = ['MerchantDesk / 商舟 AI'] as const;
export const CRAFT_LOGO_HTML = CRAFT_LOGO.join('\n');
/** Sharing is opt-in: never upload a fork session to the upstream public service. */
export const VIEWER_URL = process.env.MERCHANTDESK_VIEWER_URL || '';
