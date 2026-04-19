import { NavLink, Outlet } from "react-router-dom";

const NAV = [
	{ to: "/settings/admin", label: "Admin Policy" },
	{ to: "/settings/personas", label: "Personas" },
	{ to: "/settings/history", label: "History" },
	{ to: "/settings/bookmarks", label: "Bookmarks" },
	{ to: "/settings/downloads", label: "Downloads" },
	{ to: "/settings/vault", label: "Auth Vault" },
] as const;

interface Props {
	onClose: () => void;
}

export function SettingsLayout({ onClose }: Props) {
	return (
		<div className="settings-root">
			<aside className="settings-nav">
				<div className="settings-nav-header">
					<span>Settings</span>
					<button type="button" onClick={onClose} aria-label="Close settings">
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
							{item.label}
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
