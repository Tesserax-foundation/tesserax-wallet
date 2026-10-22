//! Tesserax Wallet for the desktop: the pages of the wallet in a window of their own.
//!
//! Keys are encrypted, decrypted and used by the pages, as in the browser; the native side only
//! saves keystore files where the user chooses, opens links in the browser, and keeps the window
//! on the wallet itself.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs::OpenOptions, io::Write, path::Path};

use tauri::{webview::WebviewWindowBuilder, AppHandle, Manager, Url, WebviewUrl};
use tauri_plugin_dialog::DialogExt;

/// Keystore files are small JSON documents: anything larger is not one.
const MAX_KEYSTORE: usize = 64 * 1024;

/// Save a keystore file of the wallet where the user chooses. False when the user cancels.
#[tauri::command]
async fn save_keystore(
	app: AppHandle,
	file_name: String,
	contents: String,
) -> Result<bool, String> {
	let is_object =
		serde_json::from_str::<serde_json::Value>(&contents).is_ok_and(|v| v.is_object());
	if contents.len() > MAX_KEYSTORE || !is_object {
		return Err("not a keystore file".into());
	}
	// A name, never a path.
	let name = Path::new(&file_name)
		.file_name()
		.and_then(|name| name.to_str())
		.filter(|name| name.ends_with(".json"))
		.unwrap_or("account.json")
		.to_owned();
	let Some(path) = app
		.dialog()
		.file()
		.set_title("Save the keystore file")
		.set_file_name(name)
		.add_filter("Keystore file", &["json"])
		.blocking_save_file()
	else {
		return Ok(false);
	};
	let path = path.into_path().map_err(|error| error.to_string())?;
	write_private(&path, contents.as_bytes()).map_err(|error| error.to_string())?;
	Ok(true)
}

/// Write a file only its owner reads, as the command line wallet does.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
	let mut options = OpenOptions::new();
	options.write(true).create(true).truncate(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.mode(0o600);
	}
	options.open(path)?.write_all(bytes)
}

/// Pages of the wallet itself: the window never navigates anywhere else.
fn is_wallet_page(url: &Url) -> bool {
	match (url.scheme(), url.host_str()) {
		("tauri", Some("localhost")) => true,
		("http" | "https", Some("tauri.localhost")) => true,
		// The development server of `npm run desktop`.
		("http", Some("localhost")) => cfg!(debug_assertions) && url.port() == Some(5175),
		_ => false,
	}
}

fn main() {
	tauri::Builder::default()
		// A second launch shows the open window instead of a second wallet.
		.plugin(tauri_plugin_single_instance::init(|app, _, _| {
			if let Some(window) = app.get_webview_window("main") {
				let _ = window.unminimize();
				let _ = window.set_focus();
			}
		}))
		.plugin(tauri_plugin_window_state::Builder::default().build())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.invoke_handler(tauri::generate_handler![save_keystore])
		.setup(|app| {
			WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
				.title("Tesserax Wallet")
				.inner_size(1200.0, 820.0)
				.min_inner_size(380.0, 640.0)
				.center()
				.on_navigation(is_wallet_page)
				.build()?;
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("the wallet window could not start");
}
