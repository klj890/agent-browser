/**
 * English message catalog (Stage 21).
 *
 * English is the schema-of-truth: zh.ts must use the same keys. When a key is
 * missing in zh, the renderer falls back to the English string here so we can
 * ship partial translations without crashing.
 *
 * Keys are dot-namespaced by surface: `shell.*`, `sidebar.*`, `settings.*`.
 * Variables use `{name}` placeholders interpolated by `translate()`.
 */
export const en = {
	"shell.tab.new": "New tab",
	"shell.tab.title.fallback": "New tab",
	"shell.tab.close": "Close tab",
	"shell.tab.newOptions": "New tab options",
	"shell.tab.incognito": "🕶 New incognito tab",
	"shell.tab.openInProfile": "👤 Open in profile: {name}",
	"shell.tab.profileHint": "Create additional profiles in Settings → Profiles.",
	"shell.tab.incognitoLabel": "Incognito",
	"shell.tab.incognitoSuffix": " (incognito)",
	"shell.tab.profileLabel": "Profile",
	"shell.address.placeholder": "URL or search",
	"shell.address.back": "Back",
	"shell.address.forward": "Forward",
	"shell.address.reload": "Reload",
	"shell.address.reading": "Reading mode",
	"shell.address.settings": "Settings",
	"shell.content.activeTab": "Active tab: {label}",
	"shell.content.empty": "No tab — click + to open",
	"sidebar.title": "Agent",
	"sidebar.empty.noPersona": "No persona loaded.",
	"sidebar.empty.persona": "Persona: {name} — {description}",
	"sidebar.pageAttached": "Page attached:",
	"settings.close": "Close settings",
	"settings.title": "Settings",
	"settings.nav.general": "General",
	"settings.nav.admin": "Admin Policy",
	"settings.nav.personas": "Personas",
	"settings.nav.profiles": "Profiles",
	"settings.nav.history": "History",
	"settings.nav.bookmarks": "Bookmarks",
	"settings.nav.downloads": "Downloads",
	"settings.nav.extensions": "Extensions",
	"settings.nav.vault": "Auth Vault",
	"settings.nav.sync": "Cloud Sync",
	"settings.nav.mcp": "MCP Server",
	"settings.nav.trace": "Trace",
	"settings.nav.routines": "Routines",
	"settings.general.title": "General",
	"settings.general.intro":
		"Pick the interface language. The Agent's own replies stay driven by the active persona — this only affects buttons, menus, and labels.",
	"settings.general.language.label": "Interface language",
	"settings.general.language.auto": "Auto (follow system)",
	"settings.general.language.zh": "中文",
	"settings.general.language.en": "English",
	"settings.general.effective.admin": "Pinned by administrator policy.",
	"settings.general.effective.user": "Following your saved choice.",
	"settings.general.effective.system": "Following the system language.",
	"settings.general.effective.summary":
		"Effective: {locale} · System: {system}",
	"settings.general.savedAt": "Saved at {time}.",
	"settings.general.adminPinHint":
		"The administrator has pinned the language to {locale}. Your personal choice is kept but ignored until the policy is unpinned.",
} as const;

export type MessageKey = keyof typeof en;
