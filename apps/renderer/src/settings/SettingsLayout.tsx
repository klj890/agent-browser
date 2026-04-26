import { NavLink, Outlet } from "react-router-dom";
import { useT } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/translate";

const NAV: ReadonlyArray<{ to: string; key: MessageKey }> = [
	{ to: "/settings/general", key: "settings.nav.general" },
	{ to: "/settings/admin", key: "settings.nav.admin" },
	{ to: "/settings/personas", key: "settings.nav.personas" },
	{ to: "/settings/profiles", key: "settings.nav.profiles" },
	{ to: "/settings/history", key: "settings.nav.history" },
	{ to: "/settings/bookmarks", key: "settings.nav.bookmarks" },
	{ to: "/settings/downloads", key: "settings.nav.downloads" },
	{ to: "/settings/extensions", key: "settings.nav.extensions" },
	{ to: "/settings/vault", key: "settings.nav.vault" },
	{ to: "/settings/sync", key: "settings.nav.sync" },
	{ to: "/settings/mcp", key: "settings.nav.mcp" },
	{ to: "/settings/trace", key: "settings.nav.trace" },
	{ to: "/settings/routines", key: "settings.nav.routines" },
];

interface Props {
	onClose: () => void;
}

export function SettingsLayout({ onClose }: Props) {
	const { t } = useT();
	return (
		<div className="settings-root">
			<aside className="settings-nav" aria-label={t("settings.title")}>
				<div className="settings-nav-header">
					<span>{t("settings.title")}</span>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("settings.close")}
					>
						×
					</button>
				</div>
				<nav>
					{NAV.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							className={({ isActive }: { isActive: boolean }) =>
								`settings-nav-link${isActive ? " active" : ""}`
							}
						>
							{t(item.key)}
						</NavLink>
					))}
				</nav>
			</aside>
			<main className="settings-main">
				<Outlet />
			</main>
		</div>
	);
}
