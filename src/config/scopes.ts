import type { TenantBrand } from './schema';

/**
 * The app-identity scopes this bridge needs (design §9). Single source of
 * truth — keep in sync with the design doc's scope list.
 *
 * Feishu has **no API to declare app scopes**: the scan-create flow
 * (`registerApp`) takes no permission argument, and so does the official
 * larksuite/cli. The only way to grant them is the developer-console
 * "apply scope" page. So instead of baking scopes into the QR (impossible),
 * we point the user at one console URL that pre-selects *all* of these at
 * once — scan once, click once. See {@link buildScopeGrantUrl}.
 *
 * Cloud-doc comment scopes live in {@link COMMENT_SCOPES}, NOT here: the
 * comment-reply feature is an opt-in enhancement, so it must never block the
 * daemon-install scope gate (which loops on REQUIRED_SCOPES until granted).
 */
export const REQUIRED_SCOPES = [
  // Feishu has split the old umbrella scopes (`im:chat`, `im:message`) into
  // fine-grained ones; new apps can only be granted the fine-grained names, so
  // we list those — not the umbrellas (which would be un-grantable + would make
  // the scope check false-positive).
  'im:message.group_at_msg:readonly', // @bot messages in project groups
  'im:message.group_msg', // ALL group messages (高敏感) — required for 免@ (respond without @)
  'im:message.p2p_msg:readonly', // DM console messages
  'im:message:send_as_bot', // reply_in_thread / send cards
  'im:message.pins:write_only', // Pin the welcome/command card to the group's Pins tab (im.v1.pin.create) — NOTE: plural `pins`
  'im:message.reactions:write_only', // ⏳/🫳 run-status emoji reactions (best-effort) — NOTE: plural `reactions`
  'im:resource', // upload/download images & resources
  'im:chat:create', // create the project group
  'im:chat:update', // transfer ownership on unbind
  'im:chat.managers:write_only', // promote the project creator to group admin (im.v1.chat.managers.add_managers)
  'im:chat.announcement:read', // read group announcement blocks (list)
  'im:chat.announcement:write_only', // write group announcement blocks (create/delete)
  'im:chat.top_notice:write_only', // pin the announcement to the top banner
  'im:chat.tabs:write_only', // add the "👈 查看可使用的命令" chat tab on group create
  'cardkit:card:write', // interactive button cards (CardKit entities)
] as const;

/**
 * Optional scopes for the cloud-doc comment-reply feature (@bot inside a Feishu
 * doc comment → reply in-thread). Pre-selected in the one-click grant URL so a
 * user who wants the feature gets them in the same click, but deliberately NOT
 * in {@link REQUIRED_SCOPES}: the daemon-install gate loops on REQUIRED_SCOPES
 * until granted, and we must not block the (messaging) bot on an opt-in extra.
 * Without these, the comment event simply isn't pushed / the API calls fail and
 * we log + skip — everything else still works.
 *
 * Names are exact Feishu fine-grained tokens (verified against the API docs +
 * the official lark CLI scope registry). `:read` covers reading the comment AND
 * receiving the `drive.notice.comment_add_v1` event; `:create` covers posting
 * the reply and the comment "Typing" reaction; `wiki:wiki:readonly` (umbrella
 * readonly — chosen over the fine-grained `wiki:node:read` to dodge the
 * singular/plural scope-name pitfall, cf. c6317e7) resolves knowledge-base
 * (wiki) nodes to their underlying doc token.
 */
export const COMMENT_SCOPES = [
  'docs:document.comment:read',
  'docs:document.comment:create',
  'wiki:wiki:readonly',
] as const;

/** Everything the one-click grant URL pre-selects: required + opt-in comment. */
export const GRANT_SCOPES = [...REQUIRED_SCOPES, ...COMMENT_SCOPES] as const;

const HOSTS: Record<TenantBrand, string> = {
  feishu: 'open.feishu.cn',
  lark: 'open.larksuite.com',
};

/**
 * Developer-console URL that pre-selects every scope in `scopes` for the app,
 * so the user enables them all on a single page. Mirrors larksuite/cli's
 * format (`/app/<id>/auth?q=<comma-joined>`); scopes are URL-encoded so a
 * stray `&`/`#` can't inject extra query params. Defaults to {@link GRANT_SCOPES}
 * (required + opt-in comment) so the comment feature is one click away; the
 * missing-scope gate still only enforces {@link REQUIRED_SCOPES}.
 */
export function buildScopeGrantUrl(
  appId: string,
  tenant: TenantBrand,
  scopes: readonly string[] = GRANT_SCOPES,
): string {
  const host = HOSTS[tenant];
  const q = encodeURIComponent(scopes.join(','));
  return `https://${host}/app/${encodeURIComponent(appId)}/auth?q=${q}`;
}

/**
 * Developer-console "事件与回调" page for the app. Unlike scopes there is **no**
 * `?q=` pre-select and **no** API to subscribe events/callbacks for a self-built
 * app — both the 事件配置 (im.message.receive_v1, application.bot.menu_v6) and
 * 回调配置 (card.action.trigger / 卡片回传交互) tabs must be filled in by hand.
 * The best we can do is deep-link to the page and auto-open it.
 */
export function buildEventConfigUrl(appId: string, tenant: TenantBrand): string {
  return `https://${HOSTS[tenant]}/app/${encodeURIComponent(appId)}/event`;
}
