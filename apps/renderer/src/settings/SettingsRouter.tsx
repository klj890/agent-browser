import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AdminView } from "./admin/AdminView";
import { BookmarksView } from "./bookmarks/BookmarksView";
import { DownloadsView } from "./downloads/DownloadsView";
import { HistoryView } from "./history/HistoryView";
import { PersonasView } from "./personas/PersonasView";
import { SettingsIndex } from "./SettingsIndex";
import { SettingsLayout } from "./SettingsLayout";
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
					<Route path="settings/history" element={<HistoryView />} />
					<Route path="settings/bookmarks" element={<BookmarksView />} />
					<Route path="settings/downloads" element={<DownloadsView />} />
					<Route path="settings/vault" element={<VaultView />} />
					<Route path="settings/trace" element={<TraceView />} />
					<Route path="*" element={<Navigate to="/settings" replace />} />
				</Route>
			</Routes>
		</HashRouter>
	);
}
