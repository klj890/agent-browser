import { useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import type { LocalePref } from "../../types/preload";

/**
 * Settings → General (Stage 21).
 *
 * Single concern for now: UI language. Locale source is shown so the user
 * understands when their personal choice is being overridden by an admin pin.
 */
export function GeneralView() {
	const { t, resolution, setUserPref } = useT();
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	// `saving` disables the radio group while the IPC + disk write is in flight.
	// Two consequences: (a) rapid re-clicks can't race the prior write, and
	// (b) the UI clearly signals that "your click was received but not yet
	// persisted" — without this the only feedback was the eventual `savedAt`
	// stamp, which lands ~100ms later.
	const [saving, setSaving] = useState(false);

	const adminPinned = resolution.source === "admin";
	const inputsDisabled = adminPinned || saving;

	const choose = async (pref: LocalePref) => {
		if (saving) return;
		setError(null);
		setSaving(true);
		try {
			await setUserPref(pref);
			setSavedAt(Date.now());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const localeLabel = (l: "zh" | "en") =>
		l === "zh"
			? t("settings.general.language.zh")
			: t("settings.general.language.en");

	return (
		<section className="settings-section" aria-labelledby="general-title">
			<h2 id="general-title">{t("settings.general.title")}</h2>
			<p className="settings-section-intro">{t("settings.general.intro")}</p>

			<fieldset className="settings-fieldset">
				<legend>{t("settings.general.language.label")}</legend>
				<div className="settings-radio-group" role="radiogroup">
					{(["auto", "zh", "en"] as const).map((pref) => (
						<label key={pref} className="settings-radio-label">
							<input
								type="radio"
								name="ui-locale"
								value={pref}
								checked={resolution.user === pref}
								onChange={() => void choose(pref)}
								disabled={inputsDisabled}
								aria-busy={saving || undefined}
							/>
							<span>
								{pref === "auto"
									? t("settings.general.language.auto")
									: localeLabel(pref)}
							</span>
						</label>
					))}
				</div>
			</fieldset>

			<div className="settings-effective" aria-live="polite">
				<div>
					{t("settings.general.effective.summary", {
						locale: localeLabel(resolution.effective),
						system: localeLabel(resolution.system),
					})}
				</div>
				{adminPinned && resolution.admin && resolution.admin !== "auto" ? (
					<div className="settings-effective-note settings-effective-admin">
						{t("settings.general.adminPinHint", {
							locale: localeLabel(resolution.admin),
						})}
					</div>
				) : resolution.source === "user" ? (
					<div className="settings-effective-note">
						{t("settings.general.effective.user")}
					</div>
				) : (
					<div className="settings-effective-note">
						{t("settings.general.effective.system")}
					</div>
				)}
				{savedAt ? (
					<div className="settings-effective-note">
						{t("settings.general.savedAt", {
							time: new Date(savedAt).toLocaleTimeString(
								resolution.effective === "zh" ? "zh-CN" : "en-US",
							),
						})}
					</div>
				) : null}
				{error ? (
					<div className="settings-effective-note settings-effective-error">
						{error}
					</div>
				) : null}
			</div>
		</section>
	);
}
