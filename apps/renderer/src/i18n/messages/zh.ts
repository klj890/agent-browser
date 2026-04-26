/**
 * Chinese (zh-CN) translations.
 *
 * Keys not present here will fall back to the English baseline (`en.ts`).
 * Keep the surface names in English (e.g. "Persona", "Vault") when the
 * project's CLAUDE.md / docs treat them as proper nouns — translating
 * "Persona" to "角色" is fine and matches the codebase comments, but words
 * like "MCP" / "OAuth2" stay verbatim.
 */
import type { MessageKey } from "./en";

export const zh: Partial<Record<MessageKey, string>> = {
	"shell.tab.new": "新标签页",
	"shell.tab.title.fallback": "新标签页",
	"shell.tab.close": "关闭标签页",
	"shell.tab.newOptions": "新标签页选项",
	"shell.tab.incognito": "🕶 新建隐私标签页",
	"shell.tab.openInProfile": "👤 在身份中打开：{name}",
	"shell.tab.profileHint": "在 设置 → 身份 中创建更多身份。",
	"shell.tab.incognitoLabel": "隐私模式",
	"shell.tab.profileLabel": "身份",
	"shell.address.placeholder": "网址或搜索",
	"shell.address.back": "后退",
	"shell.address.forward": "前进",
	"shell.address.reload": "刷新",
	"shell.address.reading": "阅读模式",
	"shell.address.settings": "设置",
	"shell.content.activeTab": "当前标签页：{label}",
	"shell.content.empty": "暂无标签页 — 点击 + 新建",
	"sidebar.title": "Agent",
	"sidebar.empty.noPersona": "未加载任何角色。",
	"sidebar.empty.persona": "角色：{name} — {description}",
	"sidebar.pageAttached": "已附带页面：",
	"settings.close": "关闭设置",
	"settings.title": "设置",
	"settings.nav.general": "通用",
	"settings.nav.admin": "管理员策略",
	"settings.nav.personas": "角色",
	"settings.nav.profiles": "身份",
	"settings.nav.history": "历史",
	"settings.nav.bookmarks": "书签",
	"settings.nav.downloads": "下载",
	"settings.nav.extensions": "扩展",
	"settings.nav.vault": "凭据保管箱",
	"settings.nav.sync": "云同步",
	"settings.nav.mcp": "MCP 服务器",
	"settings.nav.trace": "追踪",
	"settings.nav.routines": "定时任务",
	"settings.general.title": "通用",
	"settings.general.intro":
		"选择界面语言。Agent 的回答语言由当前角色控制 — 此处仅影响按钮、菜单与标签。",
	"settings.general.language.label": "界面语言",
	"settings.general.language.auto": "自动（跟随系统）",
	"settings.general.language.zh": "中文",
	"settings.general.language.en": "English",
	"settings.general.effective.admin": "已被管理员策略锁定。",
	"settings.general.effective.user": "使用你保存的选择。",
	"settings.general.effective.system": "跟随系统语言。",
	"settings.general.effective.summary": "当前生效：{locale} · 系统：{system}",
	"settings.general.savedAt": "已于 {time} 保存。",
	"settings.general.adminPinHint":
		"管理员已将界面语言锁定为 {locale}。你的个人选择会被保存，但解锁前不生效。",
};
