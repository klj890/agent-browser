import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AdminView } from "./admin/AdminView";
import { BookmarksView } from "./bookmarks/BookmarksView";
import { DownloadsView } from "./downloads/DownloadsView";
import { ExtensionsView } from "./extensions/ExtensionsView";
import { HistoryView } from "./history/HistoryView";
import { PersonasView } from "./personas/PersonasView";
import { ProfilesView } from "./profiles/ProfilesView";
import { RoutinesView } from "./routines/RoutinesView";
import { SettingsIndex } from "./SettingsIndex";
import { SettingsLayout } from "./SettingsLayout";
import { SyncView } from "./sync/SyncView";
import { TraceView } from "./trace/TraceView";
import { VaultView } from "./vault/VaultView";

interface Props {
	onClose: () => void;
}

export function SettingsRouter({ onClose }: Props) {
	return (
		<HashRouter>
			<Routes>
				<Route path="/" element={<SettingsLayout onClose={onClose} />}>
					<Route index element={<Navigate to="/settings" replace />} />
					<Route path="settings" element={<SettingsIndex />} />
					<Route path="settings/admin" element={<AdminView />} />
					<Route path="settings/personas" element={<PersonasView />} />
					<Route path="settings/profiles" element={<ProfilesView />} />
					<Route path="settings/history" element={<HistoryView />} />
					<Route path="settings/bookmarks" element={<BookmarksView />} />
					<Route path="settings/downloads" element={<DownloadsView />} />
					<Route path="settings/extensions" element={<ExtensionsView />} />
					<Route path="settings/vault" element={<VaultView />} />
					<Route path="settings/sync" element={<SyncView />} />
					<Route path="settings/trace" element={<TraceView />} />
					<Route path="settings/routines" element={<RoutinesView />} />
					<Route path="*" element={<Navigate to="/settings" replace />} />
				</Route>
			</Routes>
		</HashRouter>
	);
}
