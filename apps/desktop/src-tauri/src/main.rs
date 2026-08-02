//! Grox native shell.
//!
//! The webview speaks JSON-RPC while this process owns the long-lived
//! `grok agent stdio` child. Keeping process management here prevents the
//! privileged webview from spawning arbitrary commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufRead, BufReader as StdBufReader, Write as _},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(target_os = "macos")]
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GROX_BUILD_COMMIT: &str = env!("GROX_BUILD_COMMIT");
const GROK_INSTALL_PS1_URL: &str = "https://x.ai/cli/install.ps1";
const GROK_INSTALL_SH_URL: &str = "https://x.ai/cli/install.sh";
/// Public GitHub repo used for desktop release checks / download links.
const GROX_GITHUB_REPO: &str = "congqianv/Grox";
const GROX_RELEASES_LATEST_API: &str =
    "https://api.github.com/repos/congqianv/Grox/releases/latest";
const GROX_RELEASES_PAGE: &str = "https://github.com/congqianv/Grox/releases";
const GROX_PRIVACY_ENV: [(&str, &str); 12] = [
    ("GROX_PRIVACY_MODE", "1"),
    // Legacy fallbacks also protect users who point GROK_DESKTOP_CLI at an
    // older Grok binary that does not yet understand GROX_PRIVACY_MODE.
    ("DISABLE_TELEMETRY", "1"),
    ("DISABLE_ERROR_REPORTING", "1"),
    ("GROK_TELEMETRY_ENABLED", "0"),
    ("GROK_TELEMETRY_TRACE_UPLOAD", "0"),
    ("GROK_TELEMETRY_MIXPANEL_ENABLED", "0"),
    ("GROK_FEEDBACK_ENABLED", "0"),
    ("GROK_ERROR_REPORTING", "0"),
    ("GROK_EXTERNAL_OTEL", "0"),
    ("OTEL_TRACES_EXPORTER", "none"),
    ("OTEL_METRICS_EXPORTER", "none"),
    ("OTEL_LOGS_EXPORTER", "none"),
];

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    generation: u64,
}

#[derive(Default)]
struct AcpState {
    process: Mutex<Option<AgentProcess>>,
    next_generation: AtomicU64,
    /// When true, drop ACP stream notifications that only rebuild UI history
    /// (session/update with sessionUpdate). Used during silent session/load so
    /// first-send agent-bind does not flood the webview with 100MB+ of events.
    /// JSON-RPC responses / requests still pass through.
    silent_stream: AtomicBool,
}

struct PreviewProcess {
    child: Child,
    root: PathBuf,
}

#[derive(Default)]
struct PreviewState {
    process: Mutex<Option<PreviewProcess>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpExitPayload {
    code: Option<i32>,
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEnvironment {
    default_workspace: String,
    grok_command: String,
    app_version: String,
    github_repo: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: String,
    download_url: Option<String>,
    asset_name: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    checked_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigDocument {
    id: &'static str,
    label: &'static str,
    path: String,
    content: String,
    exists: bool,
    language: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewFile {
    path: String,
    name: String,
    kind: &'static str,
    mime: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntry {
    path: String,
    name: String,
    is_dir: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrokRuntimeInfo {
    path: String,
    source: &'static str,
    preference: String,
    system_path: Option<String>,
    bundled_path: Option<String>,
    selection_required: bool,
    version: Option<String>,
    grox_commit: &'static str,
    upstream_commit: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPreview {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    framework: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone)]
struct FrontendTarget {
    root: PathBuf,
    framework: String,
    manager: &'static str,
    port: u16,
    script: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteConfigDocument {
    id: String,
    cwd: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    kind: String,
    api_key: Option<String>,
    base_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    kind: &'static str,
    has_api_key: bool,
    base_url: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderApiBackend {
    #[default]
    Auto,
    Responses,
    ChatCompletions,
}

impl ProviderApiBackend {
    fn resolved(self, name: &str, base_url: &str) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::ChatCompletions => "chat_completions",
            Self::Auto => {
                let identity = format!("{name} {base_url}").to_ascii_lowercase();
                if [
                    "grok2api",
                    "chenyme",
                    "cliproxyapi",
                    "cli-proxy-api",
                    "cli proxy",
                    "router-for-me",
                    "newapi",
                    "new api",
                ]
                    .iter()
                    .any(|marker| identity.contains(marker))
                {
                    "responses"
                } else {
                    "chat_completions"
                }
            }
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProviderProfile {
    id: String,
    name: String,
    api_key: String,
    base_url: String,
    #[serde(default)]
    api_backend: ProviderApiBackend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    models_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default)]
    available_models: Vec<String>,
    #[serde(default)]
    resident_models: Vec<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfilesFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_id: Option<String>,
    #[serde(default)]
    profiles: Vec<StoredProviderProfile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileSummary {
    id: String,
    name: String,
    has_api_key: bool,
    base_url: String,
    api_backend: ProviderApiBackend,
    available_models: Vec<String>,
    resident_models: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfilesResponse {
    active_id: Option<String>,
    profiles: Vec<ProviderProfileSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProviderProfile {
    id: Option<String>,
    name: String,
    api_key: Option<String>,
    base_url: String,
    #[serde(default)]
    api_backend: ProviderApiBackend,
    #[serde(default)]
    resident_models: Vec<String>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES: usize = 2_000;
static CONFIG_WRITE_NONCE: AtomicU64 = AtomicU64::new(0);

fn path_for_webview(path: &Path) -> String {
    let raw = path.to_string_lossy();
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

fn default_workspace() -> PathBuf {
    if let Some(path) = std::env::var_os("GROK_DESKTOP_CWD").filter(|v| !v.is_empty()) {
        return PathBuf::from(path);
    }

    #[cfg(debug_assertions)]
    {
        // `src-tauri` lives at `<repo>/apps/desktop/src-tauri` in development.
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        if let Some(repo) = manifest.ancestors().nth(3) {
            return repo.to_path_buf();
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn grok_home() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("GROK_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "无法定位用户目录，请设置 GROK_HOME".to_string())?;
    Ok(PathBuf::from(home).join(".grok"))
}

fn read_bounded_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("不是文件：{}", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!("文件过大：{}", path.display()));
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, content, MAX_CONFIG_BYTES)
}

/// Atomic write with an explicit size cap (session UI transcripts can exceed 4MB).
fn atomic_write_bytes(path: &Path, content: &str, max_bytes: u64) -> Result<(), String> {
    if content.len() as u64 > max_bytes {
        return Err(format!(
            "写入过大（{} bytes > {}）：{}",
            content.len(),
            max_bytes,
            path.display()
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "配置路径缺少父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 {}：{error}", parent.display()))?;
    let temp = parent.join(format!(
        ".{}.grox-{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config"),
        std::process::id(),
        CONFIG_WRITE_NONCE.fetch_add(1, Ordering::Relaxed),
    ));
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("无法创建临时文件 {}：{error}", temp.display()))?;
        if let Err(error) = file
            .write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err(format!("无法写入 {}：{error}", temp.display()));
        }
    }
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("无法替换 {}：{error}", path.display()))?;
    }
    fs::rename(&temp, path).map_err(|error| format!("无法保存 {}：{error}", path.display()))
}

fn file_size_mtime_ms(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((meta.len(), mtime))
}

#[cfg(unix)]
fn restrict_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法限制凭据文件权限 {}：{error}", path.display()))
}

#[cfg(not(unix))]
fn restrict_private_file(_path: &Path) -> Result<(), String> {
    // Windows user profiles inherit a per-user ACL from their parent folder.
    Ok(())
}

fn replace_managed_block(content: &str, start: &str, end: &str, replacement: &str) -> String {
    let preserved = if let Some(start_idx) = content.find(start) {
        let suffix = &content[start_idx..];
        if let Some(relative_end) = suffix.find(end) {
            let after = start_idx + relative_end + end.len();
            format!(
                "{}{}",
                content[..start_idx].trim_end(),
                content[after..].trim_start()
            )
        } else {
            content[..start_idx].trim_end().to_string()
        }
    } else {
        content.trim_end().to_string()
    };
    if replacement.is_empty() {
        return if preserved.is_empty() {
            preserved
        } else {
            format!("{preserved}\n")
        };
    }
    let prefix = if preserved.is_empty() {
        String::new()
    } else {
        format!("{preserved}\n\n")
    };
    format!("{prefix}{start}\n{replacement}\n{end}\n")
}

fn replace_managed_env_block(content: &str, replacement: &str) -> String {
    replace_managed_block(
        content,
        "# >>> Grox managed provider",
        "# <<< Grox managed provider",
        replacement,
    )
}

fn replace_managed_model_block(content: &str, replacement: &str) -> String {
    replace_managed_block(
        content,
        "# >>> Grox managed models",
        "# <<< Grox managed models",
        replacement,
    )
}

fn env_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// TOML table header for a model id (`[model.foo]` or `[model."grok-4.5"]`).
fn model_table_header(model_id: &str) -> String {
    let bare = model_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-');
    if bare {
        format!("[model.{model_id}]")
    } else {
        format!("[model.{}]", toml_string(model_id))
    }
}

fn model_table_header_aliases(model_id: &str) -> Vec<String> {
    let mut headers = vec![model_table_header(model_id), format!("[model.{}]", toml_string(model_id))];
    headers.sort();
    headers.dedup();
    headers
}

fn provider_resident_model_ids(profile: &StoredProviderProfile) -> Vec<String> {
    let mut ids = profile.resident_models.clone();
    if ids.is_empty() {
        if let Some(model) = profile.model.as_ref().filter(|model| !model.is_empty()) {
            ids.push(model.clone());
        }
    }
    if ids.is_empty() {
        ids.push("grok-4.5".into());
    }
    // Keep order, drop empties / dupes.
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty() && seen.insert(id.to_ascii_lowercase()))
        .collect()
}

/// Remove whole `[model.<id>]` tables so a later managed block is the sole
/// definition Grok sees for those ids (avoids local base_url winning).
fn strip_model_tables(content: &str, model_ids: &[String]) -> String {
    if model_ids.is_empty() || content.is_empty() {
        return content.to_owned();
    }
    let mut drop_headers = std::collections::HashSet::new();
    for id in model_ids {
        for header in model_table_header_aliases(id) {
            drop_headers.insert(header);
        }
    }

    let mut out = Vec::new();
    let mut skipping = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping = drop_headers.contains(trimmed);
            if skipping {
                continue;
            }
        } else if skipping {
            continue;
        }
        out.push(line);
    }

    // Collapse runs of 3+ blank lines left by removals.
    let mut cleaned = Vec::new();
    let mut blank_run = 0usize;
    for line in out {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 2 {
                cleaned.push(line);
            }
        } else {
            blank_run = 0;
            cleaned.push(line);
        }
    }
    let mut text = cleaned.join("\n");
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// Ensure `[models].default` points at a resident model of the active provider.
/// Creates a minimal `[models]` table when the file has none.
fn ensure_models_default(content: &str, default_id: &str) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_owned).collect();
    let mut in_models = false;
    let mut saw_models = false;
    let mut patched = false;
    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_models = trimmed == "[models]";
            if in_models {
                saw_models = true;
            }
            continue;
        }
        if !in_models || patched {
            continue;
        }
        if trimmed.starts_with("default") && trimmed.contains('=') {
            *line = format!("default = {}", toml_string(default_id));
            patched = true;
        }
    }
    if !saw_models {
        let mut block = vec![
            "[models]".to_string(),
            format!("default = {}", toml_string(default_id)),
            String::new(),
        ];
        block.append(&mut lines);
        lines = block;
    } else if !patched {
        // `[models]` exists but has no default key — insert one right after the header.
        if let Some(index) = lines.iter().position(|line| line.trim() == "[models]") {
            lines.insert(index + 1, format!("default = {}", toml_string(default_id)));
        }
    }
    let mut text = lines.join("\n");
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// Build the managed `config.toml` fragment so selected model ids route to the
/// active compatible provider. Per-model `base_url` wins over env alone, which
/// is why saving only `GROK_MODELS_BASE_URL` was not enough when the user already
/// had local `[model.*]` overrides.
fn compatible_provider_model_config(profile: &StoredProviderProfile) -> Result<String, String> {
    let base = checked_service_url(&profile.base_url, "服务地址")?;
    let key = checked_api_key(&profile.api_key)?;
    let backend = profile.api_backend.resolved(&profile.name, &base);
    let model_ids = provider_resident_model_ids(profile);
    if model_ids.is_empty() {
        return Err("供应商没有可用模型".into());
    }

    let mut lines = Vec::new();
    lines.push("# Written by Grox when a compatible provider is activated.".to_string());
    lines.push(
        "# Per-model base_url is required so requests do not stick to older local overrides."
            .to_string(),
    );

    for model_id in &model_ids {
        lines.push(model_table_header(model_id));
        lines.push(format!("model = {}", toml_string(model_id)));
        lines.push(format!("base_url = {}", toml_string(&base)));
        lines.push(format!(
            "name = {}",
            toml_string(&format!("{} · {model_id}", profile.name))
        ));
        lines.push(format!("api_key = {}", toml_string(key)));
        lines.push(format!("api_backend = {}", toml_string(backend)));
        lines.push("context_window = 500000".to_string());
        lines.push("supports_backend_search = true".to_string());
        lines.push("supports_reasoning_effort = true".to_string());
        lines.push(String::new());
    }

    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    Ok(lines.join("\n"))
}

fn apply_compatible_provider_to_config(profile: &StoredProviderProfile) -> Result<(), String> {
    let path = grok_home()?.join("config.toml");
    let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    // Drop previous managed block first so strip only sees user tables.
    let without_managed = replace_managed_model_block(&current, "");
    let model_ids = provider_resident_model_ids(profile);
    let default_id = model_ids
        .first()
        .cloned()
        .unwrap_or_else(|| "grok-4.5".into());
    let stripped = strip_model_tables(&without_managed, &model_ids);
    let patched = ensure_models_default(&stripped, &default_id);
    let fragment = compatible_provider_model_config(profile)?;
    atomic_write(&path, &replace_managed_model_block(&patched, &fragment))?;
    restrict_private_file(&path)?;
    Ok(())
}

fn clear_compatible_provider_from_config() -> Result<(), String> {
    let path = grok_home()?.join("config.toml");
    if !path.exists() {
        return Ok(());
    }
    let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    let next = replace_managed_model_block(&current, "");
    if next != current {
        atomic_write(&path, &next)?;
        restrict_private_file(&path)?;
    }
    Ok(())
}

fn config_path(id: &str, cwd: &Path) -> Result<(PathBuf, &'static str, &'static str), String> {
    let home = grok_home()?;
    match id {
        "config" => Ok((home.join("config.toml"), "Grok config.toml", "toml")),
        "system-prompt" => Ok((home.join("system-prompt.md"), "系统提示词", "markdown")),
        "agents" => Ok((cwd.join("AGENTS.md"), "项目 AGENTS.md", "markdown")),
        _ => Err("未知配置文档".into()),
    }
}

fn parse_env_file(path: &Path) -> BTreeMap<String, String> {
    let Ok(content) = read_bounded_text(path, MAX_CONFIG_BYTES) else {
        return BTreeMap::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, raw_value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty()
                || !key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_')
            {
                return None;
            }
            let value = raw_value.trim();
            let value = if value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\'')))
            {
                &value[1..value.len() - 1]
            } else {
                value
            };
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

fn checked_workspace_file(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(requested);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(candidate)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析文件 {}：{error}", candidate.display()))?;
    if !canonical.starts_with(workspace) {
        return Err("只能访问当前项目内的文件".into());
    }
    Ok(canonical)
}

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn checked_service_url(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(value).map_err(|error| format!("无效{label}：{error}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{label}不能在 URL 中包含用户名或密码"));
    }
    let secure = parsed.scheme() == "https";
    let local_http = parsed.scheme() == "http" && is_loopback_host(parsed.host_str());
    if !secure && !local_http {
        return Err(format!("{label}必须使用 HTTPS；仅本机回环地址允许 HTTP"));
    }
    // Use url's serialized representation instead of the original input.
    // URL parsers may tolerate ASCII whitespace that would otherwise become a
    // second line in the managed dotenv block.
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn checked_api_key(value: &str) -> Result<&str, String> {
    if value.chars().any(char::is_control) {
        return Err("API Key 不能包含换行符或控制字符".into());
    }
    if value.len() > 16 * 1024 {
        return Err("API Key 过长".into());
    }
    Ok(value)
}

fn preview_type(path: &Path) -> (&'static str, &'static str) {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" | "mdx" => ("markdown", "text/markdown"),
        "html" | "htm" => ("html", "text/html"),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        "bmp" => ("image", "image/bmp"),
        "txt" | "log" | "json" | "jsonl" | "toml" | "yaml" | "yml" | "xml" | "css" | "js"
        | "jsx" | "ts" | "tsx" | "rs" | "py" | "go" | "java" | "c" | "h" | "cpp" | "hpp" | "sh"
        | "ps1" => ("text", "text/plain"),
        _ => ("unsupported", "application/octet-stream"),
    }
}

fn collect_workspace_entries(root: &Path, dir: &Path, output: &mut Vec<WorkspaceEntry>) {
    if output.len() >= MAX_WORKSPACE_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.path().is_dir(), entry.file_name()));
    for entry in entries {
        if output.len() >= MAX_WORKSPACE_ENTRIES {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = file_type.is_dir();
        if is_dir
            && matches!(
                name.as_str(),
                ".git" | "node_modules" | "target" | "dist" | ".pnpm-store"
            )
        {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path);
        output.push(WorkspaceEntry {
            path: relative.to_string_lossy().replace('\\', "/"),
            name,
            is_dir,
        });
        if is_dir {
            collect_workspace_entries(root, &path, output);
        }
    }
}

fn executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        return fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

fn system_grok_candidates(executable: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|directory| directory.join(executable)),
    );
    if let Some(home) = std::env::var_os("GROK_HOME").filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(home).join("bin").join(executable));
    }
    if let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
    {
        let home = PathBuf::from(home);
        candidates.push(home.join(".grok").join("bin").join(executable));
        candidates.push(home.join(".cargo").join("bin").join(executable));
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Grok")
                .join(executable),
        );
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(executable));
        candidates.push(PathBuf::from("/usr/local/bin").join(executable));
    }
    candidates
}

fn bundled_grok_candidates(
    app: &tauri::AppHandle,
    executable: &str,
    source_executable: &str,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(directory) = current_executable.parent() {
            candidates.push(directory.join(executable));
            candidates.push(directory.join(source_executable));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(executable));
        candidates.push(resources.join("binaries").join(executable));
        candidates.push(resources.join(source_executable));
    }

    #[cfg(debug_assertions)]
    if let Some(repo) = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3) {
        candidates.push(repo.join("target").join("debug").join(source_executable));
        candidates.push(
            repo.join("target")
                .join("release-dist")
                .join(source_executable),
        );
    }
    candidates
}

fn normalized_existing_path(path: &Path) -> Option<PathBuf> {
    if !executable_file(path) {
        return None;
    }
    path.canonicalize()
        .ok()
        .or_else(|| Some(path.to_path_buf()))
}

fn runtime_preference_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("runtime.json"))
        .map_err(|error| format!("无法定位 Grox 配置目录：{error}"))
}

fn read_runtime_preference(app: &tauri::AppHandle) -> String {
    let Ok(path) = runtime_preference_path(app) else {
        return "auto".into();
    };
    let Ok(content) = read_bounded_text(&path, 16 * 1024) else {
        return "auto".into();
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|value| value.get("preference")?.as_str().map(str::to_owned))
        .filter(|value| matches!(value.as_str(), "auto" | "system" | "bundled"))
        .unwrap_or_else(|| "auto".into())
}

fn write_runtime_preference(app: &tauri::AppHandle, preference: &str) -> Result<(), String> {
    if !matches!(preference, "auto" | "system" | "bundled") {
        return Err("未知 Grok CLI 运行时选项".into());
    }
    let content = serde_json::json!({ "preference": preference }).to_string();
    atomic_write(&runtime_preference_path(app)?, &content)
}

fn grok_binary_version(path: &str) -> Option<String> {
    let mut command = std::process::Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok().filter(|output| output.status.success())?;
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
}

fn runtime_info(
    path: String,
    source: &'static str,
    preference: String,
    system_path: Option<String>,
    bundled_path: Option<String>,
    selection_required: bool,
) -> GrokRuntimeInfo {
    GrokRuntimeInfo {
        version: grok_binary_version(&path),
        path,
        source,
        preference,
        system_path,
        bundled_path,
        selection_required,
        grox_commit: GROX_BUILD_COMMIT,
        // Lite fork: no vendored agent tree / .grox provenance. CLI version
        // comes from the system binary via `grok_binary_version`.
        upstream_commit: None,
    }
}

fn configured_grok_command(app: &tauri::AppHandle) -> GrokRuntimeInfo {
    let executable = if cfg!(windows) { "grok.exe" } else { "grok" };
    let source_executable = if cfg!(windows) {
        "xai-grok-pager.exe"
    } else {
        "xai-grok-pager"
    };
    let bundled = bundled_grok_candidates(app, executable, source_executable)
        .into_iter()
        .find_map(|candidate| normalized_existing_path(&candidate));
    let bundled_paths = bundled.iter().cloned().collect::<Vec<_>>();
    let system = system_grok_candidates(executable)
        .into_iter()
        .filter_map(|candidate| normalized_existing_path(&candidate))
        .find(|candidate| !bundled_paths.iter().any(|bundled| bundled == candidate));
    let preference = read_runtime_preference(app);

    if let Some(path) = std::env::var_os("GROK_DESKTOP_CLI").filter(|value| !value.is_empty()) {
        return runtime_info(
            PathBuf::from(path).to_string_lossy().into_owned(),
            "override",
            preference,
            system.as_deref().map(path_for_webview),
            bundled.as_deref().map(path_for_webview),
            false,
        );
    }

    if let Some(path) = system.as_deref() {
        return runtime_info(
            path.to_string_lossy().into_owned(),
            "system",
            preference,
            Some(path_for_webview(path)),
            bundled.as_deref().map(path_for_webview),
            false,
        );
    }

    if let Some(path) = bundled.as_deref() {
        let selection_required = preference != "bundled";
        return runtime_info(
            path.to_string_lossy().into_owned(),
            "bundled",
            preference,
            None,
            Some(path_for_webview(path)),
            selection_required,
        );
    }

    runtime_info(executable.to_string(), "missing", preference, None, None, true)
}

#[tauri::command]
fn grok_runtime_info(app: tauri::AppHandle) -> GrokRuntimeInfo {
    configured_grok_command(&app)
}

#[tauri::command]
fn set_grok_runtime_preference(
    app: tauri::AppHandle,
    preference: String,
) -> Result<GrokRuntimeInfo, String> {
    let status = configured_grok_command(&app);
    if preference == "system" && status.system_path.is_none() {
        return Err("尚未检测到本机官方 Grok Build CLI".into());
    }
    if preference == "bundled" && status.bundled_path.is_none() {
        return Err("当前安装包没有内置 Grok Build CLI".into());
    }
    write_runtime_preference(&app, &preference)?;
    Ok(configured_grok_command(&app))
}

#[tauri::command]
async fn install_official_grok_cli(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<GrokRuntimeInfo, String> {
    // Windows cannot replace a running executable. Stop the official CLI
    // child before invoking its official updater; the webview reload below
    // starts the freshly installed binary again.
    if let Some(process) = state.process.lock().await.take() {
        terminate_process(process).await;
    }
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("irm '{}' | iex", GROK_INSTALL_PS1_URL),
        ]);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("/bin/bash");
        command.args([
            "-c",
            &format!("curl -fsSL '{}' | bash", GROK_INSTALL_SH_URL),
        ]);
        command
    } else {
        return Err("Grox 当前仅支持在 Windows 和 macOS 上自动安装 CLI".into());
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(Duration::from_secs(300), command.output())
        .await
        .map_err(|_| "官方 Grok CLI 安装超过 5 分钟，已停止等待".to_string())?
        .map_err(|error| format!("无法启动官方 Grok CLI 安装程序：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "官方 Grok CLI 安装失败（退出码 {}）：\n{}",
            output.status.code().map_or_else(|| "unknown".into(), |code| code.to_string()),
            stderr
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("already installed") || stdout.contains("up to date") {
        // Treat as success even if no-op
    } else if !stdout.trim().is_empty() {
        // Optionally log, but since UI, perhaps emit later
    }
    write_runtime_preference(&app, "system")?;
    let runtime = configured_grok_command(&app);
    if runtime.system_path.is_none() {
        return Err("安装程序已完成，但 Grox 尚未在标准位置检测到 grok；请重启后重试".into());
    }
    Ok(runtime)
}

fn checked_workspace(cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".into());
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("工作区不存在：{}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("工作区不是目录：{}", path.display()));
    }
    path.canonicalize()
        .map_err(|error| format!("无法解析工作区 {}：{error}", path.display()))
}

fn detect_frontend(workspace: &Path) -> Option<FrontendTarget> {
    let candidates = [
        workspace.to_path_buf(),
        workspace.join("frontend"),
        workspace.join("web"),
        workspace.join("client"),
        workspace.join("apps").join("web"),
    ];
    for root in candidates {
        let package_path = root.join("package.json");
        let Ok(raw_package) = fs::read_to_string(package_path) else {
            continue;
        };
        let Ok(package) = serde_json::from_str::<serde_json::Value>(&raw_package) else {
            continue;
        };
        let Some(script) = package
            .get("scripts")
            .and_then(|scripts| scripts.get("dev"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|script| !script.is_empty())
        else {
            continue;
        };
        let script = script.to_string();
        let dependencies = package
            .get("dependencies")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flatten()
            .chain(
                package
                    .get("devDependencies")
                    .and_then(serde_json::Value::as_object)
                    .into_iter()
                    .flatten(),
            )
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();
        let lower = script.to_ascii_lowercase();
        if ["tauri", "electron", "react-native", "capacitor"]
            .iter()
            .any(|runtime| lower.contains(runtime))
        {
            continue;
        }
        let has = |name: &str| dependencies.iter().any(|dependency| *dependency == name);
        let (framework, port) = if lower.contains("next") || has("next") {
            ("Next.js", 3000)
        } else if lower.contains("nuxt") || has("nuxt") {
            ("Nuxt", 3000)
        } else if lower.contains("astro") || has("astro") {
            ("Astro", 4321)
        } else if lower.contains("ng serve") || has("@angular/core") {
            ("Angular", 4200)
        } else if lower.contains("react-scripts") || has("react-scripts") {
            ("Create React App", 3000)
        } else if lower.contains("vue-cli-service") || has("@vue/cli-service") {
            ("Vue CLI", 8080)
        } else if lower.contains("vite") || has("vite") {
            ("Vite", 5173)
        } else {
            continue;
        };
        let manager = if root.join("pnpm-lock.yaml").is_file()
            || workspace.join("pnpm-lock.yaml").is_file()
        {
            "pnpm"
        } else if root.join("yarn.lock").is_file() || workspace.join("yarn.lock").is_file() {
            "yarn"
        } else if root.join("bun.lock").is_file()
            || root.join("bun.lockb").is_file()
            || workspace.join("bun.lock").is_file()
            || workspace.join("bun.lockb").is_file()
        {
            "bun"
        } else {
            "npm"
        };
        return Some(FrontendTarget {
            root,
            framework: framework.to_string(),
            manager,
            port,
            script,
        });
    }
    None
}

fn preview_online(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(120)).is_ok()
}

fn preview_response(
    target: &FrontendTarget,
    status: &'static str,
    error: Option<String>,
) -> ProjectPreview {
    let url = format!("http://127.0.0.1:{}", target.port);
    ProjectPreview {
        status,
        url: Some(url),
        framework: Some(target.framework.clone()),
        command: Some(format!("{} run dev", target.manager)),
        root: Some(path_for_webview(&target.root)),
        error,
    }
}

#[tauri::command]
async fn start_project_preview(
    state: tauri::State<'_, Arc<PreviewState>>,
    cwd: String,
    start: bool,
) -> Result<ProjectPreview, String> {
    let workspace = checked_workspace(&cwd)?;
    let Some(target) = detect_frontend(&workspace) else {
        let mut guard = state.process.lock().await;
        if let Some(mut previous) = guard.take() {
            let _ = previous.child.kill().await;
            let _ = previous.child.wait().await;
        }
        return Ok(ProjectPreview {
            status: "none",
            url: None,
            framework: None,
            command: None,
            root: None,
            error: None,
        });
    };

    let mut guard = state.process.lock().await;
    if guard
        .as_ref()
        .is_some_and(|process| process.root == target.root)
    {
        let exited = guard
            .as_mut()
            .and_then(|process| process.child.try_wait().ok())
            .flatten();
        if let Some(status) = exited {
            guard.take();
            return Ok(preview_response(
                &target,
                "error",
                Some(format!(
                    "开发服务器已退出（{}）",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                )),
            ));
        }
        return Ok(preview_response(
            &target,
            if preview_online(target.port) {
                "ready"
            } else {
                "starting"
            },
            None,
        ));
    }

    if let Some(mut previous) = guard.take() {
        let _ = previous.child.kill().await;
        let _ = previous.child.wait().await;
    }

    if preview_online(target.port) {
        return Ok(preview_response(&target, "ready", None));
    }
    if !start {
        return Ok(preview_response(&target, "detected", None));
    }
    if !target.root.join("node_modules").is_dir() && !workspace.join("node_modules").is_dir() {
        return Ok(preview_response(
            &target,
            "error",
            Some("检测到前端项目，但依赖尚未安装".into()),
        ));
    }

    let executable = if cfg!(windows) {
        match target.manager {
            "pnpm" => "pnpm.cmd",
            "yarn" => "yarn.cmd",
            "bun" => "bun.exe",
            _ => "npm.cmd",
        }
    } else {
        target.manager
    };
    let mut command = Command::new(executable);
    match target.manager {
        "yarn" => {
            command.arg("dev");
        }
        _ => {
            command.args(["run", "dev"]);
        }
    }
    let script = target.script.to_ascii_lowercase();
    if script.contains("vite")
        || script.contains("astro")
        || script.contains("ng serve")
        || script.contains("vue-cli-service")
    {
        if target.manager == "npm" {
            command.arg("--");
        }
        command.args(["--host", "127.0.0.1", "--port", &target.port.to_string()]);
    }
    command
        .current_dir(&target.root)
        .env("BROWSER", "none")
        .env("NO_OPEN", "1")
        .env("HOST", "127.0.0.1")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", target.port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(preview_response(
                &target,
                "error",
                Some(format!("无法启动 {}：{error}", target.manager)),
            ));
        }
    };
    let response = preview_response(&target, "starting", None);
    *guard = Some(PreviewProcess {
        child,
        root: target.root,
    });
    Ok(response)
}

async fn terminate_process(mut process: AgentProcess) {
    drop(process.stdin);
    let _ = process.child.kill().await;
    let _ = process.child.wait().await;
}

#[tauri::command]
fn desktop_environment(app: tauri::AppHandle) -> DesktopEnvironment {
    let runtime = configured_grok_command(&app);
    DesktopEnvironment {
        default_workspace: path_for_webview(&default_workspace()),
        grok_command: path_for_webview(Path::new(&runtime.path)),
        app_version: CLIENT_VERSION.to_string(),
        github_repo: GROX_GITHUB_REPO.to_string(),
    }
}

#[derive(Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    draft: Option<bool>,
    prerelease: Option<bool>,
    assets: Vec<GithubReleaseAsset>,
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Strip optional leading `v` and normalize for comparison.
fn normalize_version(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_string()
}

/// Compare dotted semver-ish strings. Returns `Ordering` for left vs right.
fn cmp_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |s: &str| -> Vec<u64> {
        let core = s.split(['-', '+']).next().unwrap_or(s);
        core.split('.')
            .map(|part| {
                part.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect()
    };
    let a = parse(left);
    let b = parse(right);
    let len = a.len().max(b.len());
    for i in 0..len {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        match av.cmp(&bv) {
            std::cmp::Ordering::Equal => {},
            other => return other,
        }
    }
    // Prefer a release without pre-release suffix when numeric parts match.
    let a_pre = left.contains('-');
    let b_pre = right.contains('-');
    match (a_pre, b_pre) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    }
}

/// Pick the best download asset for the running desktop target.
/// On macOS prefer `.app.tar.gz` so the app can self-replace without opening a DMG.
fn pick_release_asset(assets: &[GithubReleaseAsset]) -> Option<&GithubReleaseAsset> {
    let prefer = |candidates: &[&str]| -> Option<&GithubReleaseAsset> {
        for needle in candidates {
            if let Some(asset) = assets.iter().find(|a| {
                let n = a.name.to_ascii_lowercase();
                n.contains(&needle.to_ascii_lowercase())
            }) {
                return Some(asset);
            }
        }
        None
    };

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return prefer(&["aarch64.app.tar.gz", "aarch64.dmg", "aarch64"]);
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        // Prefer Intel-specific x64 assets; avoid matching aarch64 by accident.
        if let Some(asset) = assets.iter().find(|a| {
            let n = a.name.to_ascii_lowercase();
            n.contains("x64.app.tar.gz")
        }) {
            return Some(asset);
        }
        if let Some(asset) = assets.iter().find(|a| {
            let n = a.name.to_ascii_lowercase();
            n.contains("x64.dmg") || n.contains("_x64.")
        }) {
            return Some(asset);
        }
        return prefer(&["x64.app.tar.gz", "x64.dmg"]);
    }
    #[cfg(target_os = "windows")]
    {
        return prefer(&["x64-setup.exe", "x64_en-us.msi", "setup.exe", ".msi", ".exe"]);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        prefer(&[".AppImage", ".deb", ".rpm", ".tar.gz"])
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress {
    stage: String,
    percent: u8,
    downloaded: u64,
    total: Option<u64>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInstallResult {
    installed: bool,
    restarted: bool,
    message: String,
    open_url: Option<String>,
}

static APP_UPDATE_BUSY: AtomicBool = AtomicBool::new(false);

fn emit_update_progress(app: &tauri::AppHandle, progress: AppUpdateProgress) {
    let _ = app.emit("app-update-progress", progress);
}

#[cfg(target_os = "macos")]
fn resolve_current_app_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位当前程序：{error}"))?;
    let mut cursor = exe.as_path();
    while let Some(parent) = cursor.parent() {
        if parent
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
        {
            return Ok(parent.to_path_buf());
        }
        cursor = parent;
    }
    Err("当前不在 .app 包内运行，无法应用内升级（请使用发布版安装包）".into())
}

#[cfg(target_os = "macos")]
fn find_app_bundle(root: &Path) -> Result<PathBuf, String> {
    if root
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    {
        return Ok(root.to_path_buf());
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|error| format!("读取解压目录失败：{error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("读取解压目录失败：{error}"))?;
            let path = entry.path();
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
            {
                return Ok(path);
            }
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    Err("安装包中未找到 .app 应用包".into())
}

#[cfg(target_os = "macos")]
async fn download_to_file(
    app: &tauri::AppHandle,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent(format!("Grox-Desktop/{CLIENT_VERSION}"))
        .build()
        .map_err(|error| format!("无法创建下载客户端：{error}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("下载更新失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载更新失败：{error}"))?;

    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(dest).map_err(|error| format!("无法写入临时文件：{error}"))?;
    let mut downloaded: u64 = 0;
    let mut last_emit = 0u8;

    emit_update_progress(
        app,
        AppUpdateProgress {
            stage: "downloading".into(),
            percent: 0,
            downloaded: 0,
            total,
            message: "正在下载更新…".into(),
        },
    );

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("下载中断：{error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("写入临时文件失败：{error}"))?;
        downloaded += chunk.len() as u64;
        let percent = match total {
            Some(t) if t > 0 => ((downloaded * 100) / t).min(100) as u8,
            _ => 0,
        };
        if percent >= last_emit.saturating_add(2) || percent == 100 {
            last_emit = percent;
            emit_update_progress(
                app,
                AppUpdateProgress {
                    stage: "downloading".into(),
                    percent,
                    downloaded,
                    total,
                    message: format!("正在下载更新… {percent}%"),
                },
            );
        }
    }

    file.sync_all()
        .map_err(|error| format!("同步临时文件失败：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn extract_app_tar_gz(archive: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dest_dir).map_err(|error| format!("无法创建解压目录：{error}"))?;
    let status = std::process::Command::new("tar")
        .args(["-xzf"])
        .arg(archive)
        .arg("-C")
        .arg(dest_dir)
        .status()
        .map_err(|error| format!("解压失败：{error}"))?;
    if !status.success() {
        return Err(format!("tar 解压失败，退出码 {status}"));
    }
    find_app_bundle(dest_dir)
}

#[cfg(target_os = "macos")]
fn extract_app_from_dmg(dmg: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dest_dir).map_err(|error| format!("无法创建解压目录：{error}"))?;
    let mount_root = dest_dir.join("mount");
    fs::create_dir_all(&mount_root).map_err(|error| format!("无法创建挂载目录：{error}"))?;

    let attach = std::process::Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mount_root)
        .arg(dmg)
        .output()
        .map_err(|error| format!("挂载 DMG 失败：{error}"))?;
    if !attach.status.success() {
        let stderr = String::from_utf8_lossy(&attach.stderr);
        return Err(format!("挂载 DMG 失败：{stderr}"));
    }

    let result = (|| -> Result<PathBuf, String> {
        let source = find_app_bundle(&mount_root)?;
        let target = dest_dir.join(
            source
                .file_name()
                .ok_or("DMG 中的应用包名称无效")?,
        );
        let status = std::process::Command::new("cp")
            .args(["-R"])
            .arg(&source)
            .arg(&target)
            .status()
            .map_err(|error| format!("复制应用包失败：{error}"))?;
        if !status.success() {
            return Err("复制 DMG 中的应用包失败".into());
        }
        Ok(target)
    })();

    let _ = std::process::Command::new("hdiutil")
        .args(["detach"])
        .arg(&mount_root)
        .arg("-force")
        .status();

    result
}

#[cfg(target_os = "macos")]
fn replace_app_bundle(current_app: &Path, new_app: &Path) -> Result<(), String> {
    if !new_app.exists() {
        return Err("新版本应用包不存在".into());
    }
    let parent = current_app
        .parent()
        .ok_or("无法确定当前应用安装目录")?;
    let stamp = now_unix_secs();
    let backup = parent.join(format!(".Grox.app.bak-{stamp}"));
    let staging = parent.join(format!(".Grox.app.new-{stamp}"));

    // Copy into the same directory first so the final rename stays atomic on the volume.
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    let copy = std::process::Command::new("cp")
        .args(["-R"])
        .arg(new_app)
        .arg(&staging)
        .status()
        .map_err(|error| format!("准备新版本失败：{error}"))?;
    if !copy.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err("准备新版本失败（可能没有写入 /Applications 的权限）".into());
    }

    // Clear quarantine on the staged bundle before swap.
    let _ = std::process::Command::new("xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(&staging)
        .status();

    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    fs::rename(current_app, &backup).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        format!("无法备份当前版本：{error}")
    })?;

    if let Err(error) = fs::rename(&staging, current_app) {
        // Best-effort rollback.
        let _ = fs::rename(&backup, current_app);
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("替换应用失败：{error}"));
    }

    // Cleanup backup in the background; ignore failures (file may still be busy briefly).
    let _ = fs::remove_dir_all(&backup);
    let _ = std::process::Command::new("xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(current_app)
        .status();
    Ok(())
}

#[cfg(target_os = "macos")]
fn relaunch_app(app_bundle: &Path) -> Result<(), String> {
    // Delay relaunch so the current process can exit cleanly first.
    let script = format!(
        "sleep 1; open -n {}",
        shell_quote(&app_bundle.display().to_string())
    );
    std::process::Command::new("/bin/sh")
        .args(["-c", &script])
        .spawn()
        .map_err(|error| format!("无法重新启动应用：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[tauri::command]
async fn install_app_update(
    app: tauri::AppHandle,
    download_url: String,
    asset_name: Option<String>,
) -> Result<AppUpdateInstallResult, String> {
    if !APP_UPDATE_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err("已有更新正在进行".into());
    }

    let result = install_app_update_inner(&app, download_url, asset_name).await;
    APP_UPDATE_BUSY.store(false, Ordering::SeqCst);

    match result {
        Ok(value) => {
            if value.restarted {
                // Give the frontend a moment to show the final state, then exit.
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    handle.exit(0);
                });
            }
            Ok(value)
        }
        Err(error) => {
            emit_update_progress(
                &app,
                AppUpdateProgress {
                    stage: "error".into(),
                    percent: 0,
                    downloaded: 0,
                    total: None,
                    message: error.clone(),
                },
            );
            Err(error)
        }
    }
}

async fn install_app_update_inner(
    app: &tauri::AppHandle,
    download_url: String,
    asset_name: Option<String>,
) -> Result<AppUpdateInstallResult, String> {
    let parsed = url::Url::parse(&download_url).map_err(|error| format!("无效下载链接：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许从 HTTP(S) 下载更新".into());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, asset_name);
        return Ok(AppUpdateInstallResult {
            installed: false,
            restarted: false,
            message: "当前平台暂不支持应用内升级，将打开下载页".into(),
            open_url: Some(download_url),
        });
    }

    #[cfg(target_os = "macos")]
    {
        let current_app = match resolve_current_app_bundle() {
            Ok(path) => path,
            Err(message) => {
                return Ok(AppUpdateInstallResult {
                    installed: false,
                    restarted: false,
                    message: format!("{message}，将打开下载页"),
                    open_url: Some(download_url),
                });
            }
        };
        let name = asset_name
            .as_deref()
            .or_else(|| Path::new(parsed.path()).file_name().and_then(|s| s.to_str()))
            .unwrap_or("Grox.update")
            .to_string();
        let lower = name.to_ascii_lowercase();
        let can_self_install = lower.ends_with(".app.tar.gz")
            || lower.ends_with(".tar.gz")
            || lower.ends_with(".dmg");
        if !can_self_install {
            return Ok(AppUpdateInstallResult {
                installed: false,
                restarted: false,
                message: "该安装包格式不支持应用内升级，将打开下载页".into(),
                open_url: Some(download_url),
            });
        }

        let work_dir = std::env::temp_dir().join(format!("grox-update-{}", now_unix_secs()));
        fs::create_dir_all(&work_dir).map_err(|error| format!("无法创建临时目录：{error}"))?;
        let archive_path = work_dir.join(&name);

        download_to_file(app, &download_url, &archive_path).await?;

        emit_update_progress(
            app,
            AppUpdateProgress {
                stage: "extracting".into(),
                percent: 100,
                downloaded: 0,
                total: None,
                message: "正在解压安装包…".into(),
            },
        );

        let extract_dir = work_dir.join("extract");
        let new_app = if lower.ends_with(".dmg") {
            extract_app_from_dmg(&archive_path, &extract_dir)?
        } else {
            extract_app_tar_gz(&archive_path, &extract_dir)?
        };

        emit_update_progress(
            app,
            AppUpdateProgress {
                stage: "installing".into(),
                percent: 100,
                downloaded: 0,
                total: None,
                message: "正在替换应用…".into(),
            },
        );

        replace_app_bundle(&current_app, &new_app)?;

        emit_update_progress(
            app,
            AppUpdateProgress {
                stage: "restarting".into(),
                percent: 100,
                downloaded: 0,
                total: None,
                message: "更新完成，正在重启…".into(),
            },
        );

        relaunch_app(&current_app)?;
        let _ = fs::remove_dir_all(&work_dir);

        Ok(AppUpdateInstallResult {
            installed: true,
            restarted: true,
            message: "更新已安装，应用即将重启".into(),
            open_url: None,
        })
    }
}

#[tauri::command]
async fn check_app_update() -> Result<AppUpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(format!("Grox-Desktop/{CLIENT_VERSION}"))
        .build()
        .map_err(|error| format!("无法创建 HTTP 客户端：{error}"))?;

    let response = client
        .get(GROX_RELEASES_LATEST_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(AppUpdateInfo {
            current_version: CLIENT_VERSION.to_string(),
            latest_version: CLIENT_VERSION.to_string(),
            update_available: false,
            release_url: GROX_RELEASES_PAGE.to_string(),
            download_url: None,
            asset_name: None,
            published_at: None,
            body: None,
            checked_at: now_unix_secs(),
        });
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub 返回 {status}{}",
            if body.is_empty() {
                String::new()
            } else {
                format!("：{}", body.chars().take(200).collect::<String>())
            }
        ));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|error| format!("解析发布信息失败：{error}"))?;

    if release.draft.unwrap_or(false) {
        return Err("最新发布仍是草稿，暂不可用".into());
    }

    let latest = normalize_version(&release.tag_name);
    let current = normalize_version(CLIENT_VERSION);
    let update_available = cmp_versions(&latest, &current) == std::cmp::Ordering::Greater
        && !release.prerelease.unwrap_or(false);

    let asset = pick_release_asset(&release.assets);

    Ok(AppUpdateInfo {
        current_version: current,
        latest_version: latest,
        update_available,
        release_url: if release.html_url.is_empty() {
            GROX_RELEASES_PAGE.to_string()
        } else {
            release.html_url
        },
        download_url: asset.map(|a| a.browser_download_url.clone()),
        asset_name: asset.map(|a| a.name.clone()),
        published_at: release.published_at,
        body: release.body,
        checked_at: now_unix_secs(),
    })
}

#[tauri::command]
fn validate_workspace(cwd: String) -> Result<String, String> {
    checked_workspace(&cwd).map(|path| path_for_webview(&path))
}

#[tauri::command]
fn pick_workspace() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择 Grox 项目")
        .pick_folder()
        .map(|path| path_for_webview(&path))
}

#[tauri::command]
fn list_workspace_files(cwd: String) -> Result<Vec<WorkspaceEntry>, String> {
    let root = checked_workspace(&cwd)?;
    let mut output = Vec::new();
    collect_workspace_entries(&root, &root, &mut output);
    Ok(output)
}

#[tauri::command]
fn read_preview_file(cwd: String, path: String) -> Result<PreviewFile, String> {
    let root = checked_workspace(&cwd)?;
    let file = checked_workspace_file(&root, &path)?;
    let metadata =
        fs::metadata(&file).map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    if !metadata.is_file() {
        return Err("只能预览文件".into());
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("预览文件不能超过 16 MB".into());
    }
    let (kind, mime) = preview_type(&file);
    if kind == "unsupported" {
        return Err("暂不支持预览该文件类型".into());
    }
    let bytes = fs::read(&file).map_err(|error| format!("无法读取 {}：{error}", file.display()))?;
    let content = if kind == "image" {
        BASE64.encode(bytes)
    } else {
        String::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?
    };
    Ok(PreviewFile {
        path: path_for_webview(&file),
        name: file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("preview")
            .to_string(),
        kind,
        mime: mime.to_string(),
        content,
    })
}

#[tauri::command]
fn open_in_explorer(cwd: String, path: Option<String>) -> Result<(), String> {
    let root = checked_workspace(&cwd)?;
    let target = match path {
        Some(path) if !path.trim().is_empty() => checked_workspace_file(&root, &path)?,
        _ => root,
    };
    let target = if target.is_file() {
        target.parent().unwrap_or(&target).to_path_buf()
    } else {
        target
    };

    #[cfg(windows)]
    std::process::Command::new("explorer.exe")
        .arg(&target)
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&target)
        .spawn()
        .map_err(|error| format!("无法打开 Finder：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map_err(|error| format!("无法打开文件管理器：{error}"))?;
    Ok(())
}

/// Paths the user removed from the desktop sidebar.
/// Stored under ~/.grok so it survives app reinstall (WebView localStorage does not).
fn hidden_projects_path() -> Result<PathBuf, String> {
    Ok(grok_home()?.join("desktop-hidden-projects.json"))
}

#[tauri::command]
fn read_hidden_projects() -> Result<Vec<String>, String> {
    let path = hidden_projects_path()?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw).map_err(|error| format!("无法解析隐藏项目列表：{error}"))
}

#[tauri::command]
fn write_hidden_projects(ids: Vec<String>) -> Result<(), String> {
    let path = hidden_projects_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let mut unique = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    unique.sort();
    unique.dedup();
    let body = serde_json::to_string_pretty(&unique)
        .map_err(|error| format!("无法序列化隐藏项目列表：{error}"))?;
    atomic_write(&path, &body)
}

/// Local UI transcript cache — avoids waiting on full ACP `session/load` when
/// switching missions. Stored under the app config dir (not the agent session tree).
const SESSION_CACHE_MAX_BYTES: u64 = 12 * 1024 * 1024;

fn session_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("session-cache"))
        .map_err(|error| format!("无法定位会话缓存目录：{error}"))
}

fn session_cache_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    if safe.is_empty() {
        return Err("无效的会话 ID".into());
    }
    Ok(session_cache_dir(app)?.join(format!("{safe}.json")))
}

#[tauri::command]
fn read_session_cache(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let path = session_cache_path(&app, &id)?;
    if !path.is_file() {
        return Ok(None);
    }
    match read_bounded_text(&path, SESSION_CACHE_MAX_BYTES) {
        Ok(content) if !content.trim().is_empty() => Ok(Some(content)),
        Ok(_) => Ok(None),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn write_session_cache(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    if content.len() as u64 > SESSION_CACHE_MAX_BYTES {
        return Err(format!(
            "会话缓存过大（{} bytes），已跳过写入",
            content.len()
        ));
    }
    let path = session_cache_path(&app, &id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建会话缓存目录：{error}"))?;
    }
    // Dedicated writer: session cache may exceed the 4MB config document cap.
    atomic_write_bytes(&path, &content, SESSION_CACHE_MAX_BYTES)
}

/// Co-located durable offline transcript (survives app restart; fingerprint-gated).
const UI_TRANSCRIPT_NAME: &str = "grox-ui-transcript.v1.json";
const UI_TRANSCRIPT_MAX_BYTES: u64 = 32 * 1024 * 1024;

fn ui_transcript_path(session_dir: &Path) -> PathBuf {
    session_dir.join(UI_TRANSCRIPT_NAME)
}

fn write_ui_transcript(
    session_dir: &Path,
    session_id: &str,
    session: &serde_json::Value,
    updates_path: &Path,
) -> Result<(), String> {
    let (size, mtime_ms) = file_size_mtime_ms(updates_path).unwrap_or((0, 0));
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let envelope = serde_json::json!({
        "schema": 1,
        "sessionId": session_id,
        "writtenAtMs": now,
        "source": {
            "updatesSize": size,
            "updatesMtimeMs": mtime_ms,
        },
        "scan": {
            "complete": true,
            "maxFinalBlocks": 1500,
            "thoughtsSkipped": true,
        },
        "session": session,
    });
    let body = envelope
        .to_string();
    atomic_write_bytes(
        &ui_transcript_path(session_dir),
        &body,
        UI_TRANSCRIPT_MAX_BYTES,
    )
}

/// Return cached offline session JSON if fingerprint still matches updates.jsonl.
fn read_ui_transcript_if_fresh(session_dir: &Path, session_id: &str) -> Option<serde_json::Value> {
    let path = ui_transcript_path(session_dir);
    let raw = match read_bounded_text(&path, UI_TRANSCRIPT_MAX_BYTES) {
        Ok(text) if !text.trim().is_empty() => text,
        _ => return None,
    };
    let env: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if env.get("schema").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    if env.get("sessionId").and_then(|v| v.as_str()) != Some(session_id) {
        return None;
    }
    if env.pointer("/scan/complete").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let updates = session_dir.join("updates.jsonl");
    let (size, mtime_ms) = file_size_mtime_ms(&updates)?;
    let src = env.get("source")?;
    if src.get("updatesSize").and_then(|v| v.as_u64()) != Some(size) {
        return None;
    }
    if src.get("updatesMtimeMs").and_then(|v| v.as_u64()) != Some(mtime_ms) {
        return None;
    }
    env.get("session").cloned()
}

/// Fast open path: return durable offline transcript when source fingerprint matches.
#[tauri::command]
fn get_ui_transcript(id: String) -> Result<Option<String>, String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    if safe.is_empty() {
        return Ok(None);
    }
    let Some(dir) = find_grok_session_dir(&safe) else {
        return Ok(None);
    };
    Ok(read_ui_transcript_if_fresh(&dir, &safe).map(|session| session.to_string()))
}

/// Locate `~/.grok/sessions/**/<id>/` without relying on cwd encoding details.
fn find_grok_session_dir(id: &str) -> Option<PathBuf> {
    let root = grok_home().ok()?.join("sessions");
    if !root.is_dir() {
        return None;
    }
    let Ok(level1) = fs::read_dir(&root) else {
        return None;
    };
    for entry in level1.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if entry.file_name() == id {
            return Some(path);
        }
        if let Ok(level2) = fs::read_dir(&path) {
            for child in level2.flatten() {
                if child.file_name() == id && child.path().is_dir() {
                    return Some(child.path());
                }
            }
        }
    }
    None
}

fn json_text_content(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                } else if let Some(t) = item.as_str() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            out
        }
        serde_json::Value::Object(map) => map
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn extract_user_visible_text(raw: &str) -> String {
    if let Some(start) = raw.find("<user_query>") {
        if let Some(end) = raw.find("</user_query>") {
            if end > start {
                return raw[start + "<user_query>".len()..end].trim().to_string();
            }
        }
    }
    if raw.contains("<system-reminder>") && !raw.contains("<user_query>") {
        return String::new();
    }
    if raw.len() > 4000 {
        let mut end = 4000;
        while !raw.is_char_boundary(end) {
            end -= 1;
        }
        return format!("{}…", &raw[..end]);
    }
    raw.trim().to_string()
}

/// Fast UI transcript from the small `chat_history.jsonl` (typically <1MB),
/// avoiding full ACP `session/load` of multi-hundred-MB `updates.jsonl`.
#[tauri::command]
fn preview_session_from_disk(
    id: String,
    title: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<Option<String>, String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    if safe.is_empty() {
        return Ok(None);
    }
    let Some(dir) = find_grok_session_dir(&safe) else {
        return Ok(None);
    };
    let chat_path = dir.join("chat_history.jsonl");
    if !chat_path.is_file() {
        return Ok(None);
    }
    let raw = match read_bounded_text(&chat_path, 6 * 1024 * 1024) {
        Ok(text) if !text.trim().is_empty() => text,
        _ => return Ok(None),
    };

    let mut title = title.unwrap_or_else(|| "Untitled mission".into());
    let mut cwd = cwd.unwrap_or_default();
    let mut model = model.unwrap_or_else(|| "grok-4.5".into());
    let mut created_at = 0u64;
    let mut updated_at = 0u64;
    if let Ok(summary_raw) = read_bounded_text(&dir.join("summary.json"), 256 * 1024) {
        if let Ok(summary) = serde_json::from_str::<serde_json::Value>(&summary_raw) {
            if let Some(t) = summary
                .pointer("/generated_title")
                .or_else(|| summary.pointer("/session_summary"))
                .and_then(|v| v.as_str())
            {
                if !t.trim().is_empty() {
                    title = t.trim().to_string();
                }
            }
            if let Some(c) = summary
                .pointer("/info/cwd")
                .or_else(|| summary.pointer("/cwd"))
                .and_then(|v| v.as_str())
            {
                cwd = c.to_string();
            }
            if let Some(m) = summary
                .pointer("/current_model_id")
                .and_then(|v| v.as_str())
            {
                model = m.to_string();
            }
            created_at = summary
                .pointer("/created_at")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            updated_at = summary
                .pointer("/updated_at")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
        }
    }

    let mut blocks: Vec<serde_json::Value> = Vec::new();
    let mut block_i = 0usize;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "system" => {}
            "user" => {
                let text = extract_user_visible_text(&json_text_content(
                    entry.get("content").unwrap_or(&serde_json::Value::Null),
                ));
                if text.is_empty() {
                    continue;
                }
                block_i += 1;
                blocks.push(serde_json::json!({
                    "type": "user",
                    "id": format!("disk-user-{block_i}"),
                    "text": text,
                    "ts": updated_at,
                }));
            }
            "assistant" => {
                let text =
                    json_text_content(entry.get("content").unwrap_or(&serde_json::Value::Null));
                let text = text.trim();
                if !text.is_empty() {
                    block_i += 1;
                    blocks.push(serde_json::json!({
                        "type": "assistant",
                        "id": format!("disk-assistant-{block_i}"),
                        "text": text,
                        "streaming": false,
                        "ts": updated_at,
                    }));
                }
                if let Some(calls) = entry.get("tool_calls").and_then(|v| v.as_array()) {
                    for (ti, call) in calls.iter().enumerate() {
                        let name = call
                            .pointer("/function/name")
                            .or_else(|| call.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool");
                        block_i += 1;
                        blocks.push(serde_json::json!({
                            "type": "tool",
                            "id": format!("disk-tool-{block_i}-{ti}"),
                            "ts": updated_at,
                            "call": {
                                "id": format!("disk-tool-{block_i}-{ti}"),
                                "kind": "other",
                                "rawKind": name,
                                "title": name,
                                "status": "done",
                            }
                        }));
                    }
                }
            }
            _ => {}
        }
    }

    if blocks.is_empty() {
        return Ok(None);
    }

    // chat_history is already small (typically <2MB); keep all turns for the
    // instant paint. Offline updates scan upgrades tools/fidelity later.
    const MAX_BLOCKS: usize = 800;
    if blocks.len() > MAX_BLOCKS {
        blocks = blocks.split_off(blocks.len() - MAX_BLOCKS);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if created_at == 0 {
        created_at = now;
    }
    if updated_at == 0 {
        updated_at = now;
    }

    let session = serde_json::json!({
        "id": safe,
        "title": title,
        "cwd": cwd,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "model": model,
        "blocks": blocks,
        "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "costUSD": 0,
            "contextUsed": 0,
            "contextMax": 0,
            "turns": 0
        },
        "status": "idle",
        "demo": false
    });
    Ok(Some(session.to_string()))
}

/// Generation token: switching missions abandons the previous offline scan.
static OFFLINE_HISTORY_GEN: AtomicU64 = AtomicU64::new(0);
/// Session id currently being scanned (empty = idle).
static OFFLINE_HISTORY_ACTIVE_ID: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// Pollable scan progress (event-driven progress freezes the webview under load).
static SCAN_BYTES: AtomicU64 = AtomicU64::new(0);
static SCAN_TOTAL: AtomicU64 = AtomicU64::new(0);
static SCAN_LINES: AtomicU64 = AtomicU64::new(0);
static SCAN_BLOCKS: AtomicU64 = AtomicU64::new(0);
static SCAN_DONE: AtomicU64 = AtomicU64::new(1); // 1=idle/done, 0=running
// 0=idle 1=scanning 2=complete 3=error 4=missing 5=no-updates 6=cancelled
static SCAN_PHASE_CODE: AtomicU64 = AtomicU64::new(0);

fn phase_code(phase: &str) -> u64 {
    match phase {
        "scanning" => 1,
        "complete" => 2,
        "error" => 3,
        "missing" => 4,
        "no-updates" => 5,
        "cancelled" => 6,
        _ => 0,
    }
}

fn phase_name(code: u64) -> &'static str {
    match code {
        1 => "scanning",
        2 => "complete",
        3 => "error",
        4 => "missing",
        5 => "no-updates",
        6 => "cancelled",
        _ => "idle",
    }
}

fn scan_progress_reset(total: u64) {
    SCAN_BYTES.store(0, Ordering::Relaxed);
    SCAN_TOTAL.store(total, Ordering::Relaxed);
    SCAN_LINES.store(0, Ordering::Relaxed);
    SCAN_BLOCKS.store(0, Ordering::Relaxed);
    SCAN_DONE.store(0, Ordering::Relaxed);
    SCAN_PHASE_CODE.store(1, Ordering::Relaxed);
}

fn scan_progress_set(bytes: u64, lines: u64, blocks: u64) {
    SCAN_BYTES.store(bytes, Ordering::Relaxed);
    SCAN_LINES.store(lines, Ordering::Relaxed);
    SCAN_BLOCKS.store(blocks, Ordering::Relaxed);
}

fn scan_progress_finish(phase: &str) {
    SCAN_DONE.store(1, Ordering::Relaxed);
    SCAN_PHASE_CODE.store(phase_code(phase), Ordering::Relaxed);
}

/// Bump generation so any in-flight offline history worker exits without emitting.
#[tauri::command]
fn cancel_offline_session_history() {
    OFFLINE_HISTORY_GEN.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = OFFLINE_HISTORY_ACTIVE_ID.lock() {
        guard.clear();
    }
    scan_progress_finish("cancelled");
}

/// Frontend polls this every ~250ms — never depends on high-frequency emit.
#[tauri::command]
fn get_offline_scan_progress() -> serde_json::Value {
    let bytes = SCAN_BYTES.load(Ordering::Relaxed);
    let total = SCAN_TOTAL.load(Ordering::Relaxed);
    let lines = SCAN_LINES.load(Ordering::Relaxed);
    let blocks = SCAN_BLOCKS.load(Ordering::Relaxed);
    let done = SCAN_DONE.load(Ordering::Relaxed) != 0;
    let phase = phase_name(SCAN_PHASE_CODE.load(Ordering::Relaxed));
    let active = OFFLINE_HISTORY_ACTIVE_ID
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let percent = if done && phase == "complete" {
        100
    } else if total > 0 {
        ((bytes.saturating_mul(100)) / total).min(99)
    } else {
        0
    };
    serde_json::json!({
        "id": active,
        "done": done,
        "phase": phase,
        "percent": percent,
        "bytesRead": bytes,
        "totalBytes": total,
        "lines": lines,
        "blocks": blocks,
    })
}

fn offline_history_meta(dir: &Path) -> (String, String, String, u64, u64) {
    let mut title = "Untitled mission".to_string();
    let mut cwd = String::new();
    let mut model = "grok-4.5".to_string();
    let mut created_at = 0u64;
    let mut updated_at = 0u64;
    if let Ok(summary_raw) = read_bounded_text(&dir.join("summary.json"), 256 * 1024) {
        if let Ok(summary) = serde_json::from_str::<serde_json::Value>(&summary_raw) {
            if let Some(t) = summary
                .pointer("/generated_title")
                .or_else(|| summary.pointer("/session_summary"))
                .and_then(|v| v.as_str())
            {
                if !t.trim().is_empty() {
                    title = t.trim().to_string();
                }
            }
            if let Some(c) = summary
                .pointer("/info/cwd")
                .or_else(|| summary.pointer("/cwd"))
                .and_then(|v| v.as_str())
            {
                cwd = c.to_string();
            }
            if let Some(m) = summary
                .pointer("/current_model_id")
                .and_then(|v| v.as_str())
            {
                model = m.to_string();
            }
            created_at = summary
                .pointer("/created_at")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            updated_at = summary
                .pointer("/updated_at")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
        }
    }
    (title, cwd, model, created_at, updated_at)
}

fn pack_offline_session(
    id: &str,
    title: &str,
    cwd: &str,
    model: &str,
    created_at: u64,
    updated_at: u64,
    blocks: &[serde_json::Value],
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "title": title,
        "cwd": cwd,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "model": model,
        "blocks": blocks,
        "usage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "costUSD": 0,
            "contextUsed": 0,
            "contextMax": 0,
            "turns": 0
        },
        "status": "idle",
        "demo": false
    })
}

/// Stream-parse `updates.jsonl` on a worker thread (no Agent, no UI freeze).
/// Switching sessions bumps the generation and abandons the previous scan.
#[tauri::command]
fn start_offline_session_history(
    app: tauri::AppHandle,
    id: String,
    title: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    if safe.is_empty() {
        return Err("无效的会话 ID".into());
    }
    // Same-id re-entry while truly running: join. If ACTIVE_ID is stale (worker
    // died without clear), allow restart so the bar cannot stick forever.
    if let Ok(mut guard) = OFFLINE_HISTORY_ACTIVE_ID.lock() {
        if guard.as_str() == safe {
            if SCAN_DONE.load(Ordering::Relaxed) == 0 {
                return Ok(());
            }
            guard.clear();
        }
    }
    let gen = OFFLINE_HISTORY_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = OFFLINE_HISTORY_ACTIVE_ID.lock() {
        *guard = safe.clone();
    }
    // Mark running immediately so poll never treats a stale "done" as finished.
    SCAN_DONE.store(0, Ordering::Relaxed);
    SCAN_PHASE_CODE.store(1, Ordering::Relaxed);
    SCAN_BYTES.store(0, Ordering::Relaxed);
    SCAN_LINES.store(0, Ordering::Relaxed);
    SCAN_BLOCKS.store(0, Ordering::Relaxed);
    std::thread::Builder::new()
        .name(format!("offline-hist-{safe}"))
        .spawn(move || {
            let abandoned = || OFFLINE_HISTORY_GEN.load(Ordering::SeqCst) != gen;
            let clear_active = || {
                if let Ok(mut guard) = OFFLINE_HISTORY_ACTIVE_ID.lock() {
                    if guard.as_str() == safe {
                        guard.clear();
                    }
                }
            };
            // Only emit session on terminal events — mid-scan progress is polled via
            // get_offline_scan_progress (atomics). Emitting every tick freezes WebView.
            let emit_done = |session: Option<serde_json::Value>, phase: &str| {
                if abandoned() {
                    return;
                }
                let bytes = SCAN_BYTES.load(Ordering::Relaxed);
                let total = SCAN_TOTAL.load(Ordering::Relaxed);
                let lines = SCAN_LINES.load(Ordering::Relaxed);
                let blocks = SCAN_BLOCKS.load(Ordering::Relaxed);
                let percent = if phase == "complete" {
                    100
                } else if total > 0 {
                    ((bytes.saturating_mul(100)) / total).min(99)
                } else {
                    0
                };
                let mut payload = serde_json::json!({
                    "id": safe,
                    "gen": gen,
                    "done": true,
                    "phase": phase,
                    "bytesRead": bytes,
                    "totalBytes": total,
                    "percent": percent,
                    "lines": lines,
                    "blocks": blocks,
                });
                if let Some(session) = session {
                    if let Some(obj) = payload.as_object_mut() {
                        obj.insert("session".into(), session);
                    }
                }
                let _ = app.emit("disk-history-progress", payload);
            };
            let emit = |session: serde_json::Value, _done: bool, phase: &str| {
                emit_done(Some(session), phase);
            };

            let Some(dir) = find_grok_session_dir(&safe) else {
                scan_progress_finish("missing");
                emit_done(None, "missing");
                clear_active();
                return;
            };

            // Wave 1: durable fingerprint cache — skip multi-hundred-MB rescan.
            if let Some(cached) = read_ui_transcript_if_fresh(&dir, &safe) {
                if !abandoned() {
                    let blocks_n = cached
                        .get("blocks")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    scan_progress_set(0, 0, blocks_n as u64);
                    scan_progress_finish("complete");
                    let payload = serde_json::json!({
                        "id": safe,
                        "gen": gen,
                        "done": true,
                        "phase": "complete",
                        "session": cached,
                        "fromCache": true,
                        "percent": 100,
                        "bytesRead": 0,
                        "totalBytes": 0,
                        "lines": 0,
                        "blocks": blocks_n,
                    });
                    let _ = app.emit("disk-history-progress", payload);
                }
                clear_active();
                return;
            }

            let (mut title_s, mut cwd_s, mut model_s, mut created_at, mut updated_at) =
                offline_history_meta(&dir);
            if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
                title_s = t;
            }
            if let Some(c) = cwd.filter(|s| !s.trim().is_empty()) {
                cwd_s = c;
            }
            if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
                model_s = m;
            }
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if created_at == 0 {
                created_at = now;
            }
            if updated_at == 0 {
                updated_at = now;
            }

            // Phase 1: chat_history already shown by frontend; optional skip.

            // Phase 2: stream updates.jsonl for full tool + message fidelity.
            let updates_path = dir.join("updates.jsonl");
            if !updates_path.is_file() {
                scan_progress_finish("no-updates");
                emit(
                    pack_offline_session(
                        &safe, &title_s, &cwd_s, &model_s, created_at, updated_at, &[],
                    ),
                    true,
                    "no-updates",
                );
                clear_active();
                return;
            }

            let file = match File::open(&updates_path) {
                Ok(f) => f,
                Err(e) => {
                    scan_progress_finish("error");
                    let _ = app.emit(
                        "disk-history-progress",
                        serde_json::json!({
                            "id": safe,
                            "gen": gen,
                            "done": true,
                            "phase": "error",
                            "error": format!("open updates: {e}"),
                            "session": null,
                        }),
                    );
                    clear_active();
                    return;
                }
            };

            let total_bytes = file_size_mtime_ms(&updates_path)
                .map(|(size, _)| size)
                .unwrap_or(0);
            // Blocking worker: use std BufReader (tokio::io::BufReader is async).
            // Cap per-line read so multi-MB thought lines cannot freeze progress for minutes.
            const MAX_LINE_BYTES: usize = 192 * 1024;
            let mut reader = StdBufReader::with_capacity(1024 * 256, file);
            let mut line_buf: Vec<u8> = Vec::with_capacity(8 * 1024);
            let mut blocks: Vec<serde_json::Value> = Vec::new();
            let mut user_open: Option<(String, String)> = None; // id, text
            let mut asst_open: Option<(String, String)> = None;
            let mut block_i = 0usize;
            let mut line_i = 0usize;
            let mut last_progress_lines = 0usize;
            let mut last_progress_bytes = 0u64;
            let mut last_progress_at = Instant::now();
            let mut bytes_read = 0u64;
            // NOTE: Do NOT emit full session snapshots mid-scan. Serializing hundreds of
            // blocks + React re-render freezes the webview for many seconds, so progress
            // events pile up and the bar looks "stuck" even though the worker advances.

            // Pollable progress (frontend setInterval) — no mid-scan IPC flood.
            scan_progress_reset(total_bytes);

            let flush_user = |blocks: &mut Vec<serde_json::Value>,
                             user_open: &mut Option<(String, String)>,
                             updated_at: u64| {
                if let Some((id, text)) = user_open.take() {
                    let text = extract_user_visible_text(&text);
                    if !text.is_empty() {
                        blocks.push(serde_json::json!({
                            "type": "user",
                            "id": id,
                            "text": text,
                            "ts": updated_at,
                        }));
                    }
                }
            };
            let flush_asst = |blocks: &mut Vec<serde_json::Value>,
                              asst_open: &mut Option<(String, String)>,
                              updated_at: u64| {
                if let Some((id, text)) = asst_open.take() {
                    if !text.trim().is_empty() {
                        blocks.push(serde_json::json!({
                            "type": "assistant",
                            "id": id,
                            "text": text,
                            "streaming": false,
                            "ts": updated_at,
                        }));
                    }
                }
            };

            loop {
                if abandoned() {
                    return;
                }
                line_buf.clear();
                // Read one logical line, but never buffer more than MAX_LINE_BYTES of body.
                // Oversized tails (huge thoughts) are drained without holding them in RAM.
                let (read_n, capped) =
                    match read_jsonl_line_capped(&mut reader, &mut line_buf, MAX_LINE_BYTES) {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                if read_n == 0 {
                    break; // EOF
                }
                line_i += 1;
                bytes_read = bytes_read.saturating_add(read_n as u64);

                // Update atomics often; UI polls them — no emit, no main-thread block.
                let need_tick = bytes_read.saturating_sub(last_progress_bytes) >= 128 * 1024
                    || last_progress_at.elapsed() >= Duration::from_millis(100)
                    || line_i.saturating_sub(last_progress_lines) >= 200;
                if need_tick {
                    last_progress_lines = line_i;
                    last_progress_bytes = bytes_read;
                    last_progress_at = Instant::now();
                    let shown = if total_bytes > 0 {
                        bytes_read.min(total_bytes)
                    } else {
                        bytes_read
                    };
                    scan_progress_set(shown, line_i as u64, blocks.len() as u64);
                }
                if line_i & 0xFFF == 0 && abandoned() {
                    scan_progress_finish("cancelled");
                    clear_active();
                    return;
                }

                // Oversized / truncated lines: skip parse (almost always thoughts / blobs).
                if capped {
                    continue;
                }

                let Ok(line) = std::str::from_utf8(&line_buf) else {
                    continue;
                };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // Fast-path: thoughts dominate huge updates.jsonl files (100MB+).
                if line.contains("\"agent_thought_chunk\"") {
                    continue;
                }
                // Other heavy payloads (inline images, huge tool_update) — skip parse.
                if line.len() > 96 * 1024 {
                    continue;
                }
                let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                let update = entry
                    .pointer("/params/update")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let kind = update
                    .get("sessionUpdate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                match kind {
                    "agent_thought_chunk" => {}
                    "user_message_chunk" => {
                        flush_asst(&mut blocks, &mut asst_open, updated_at);
                        let delta = json_text_content(
                            update.get("content").unwrap_or(&serde_json::Value::Null),
                        );
                        if let Some((_, ref mut text)) = user_open {
                            text.push_str(&delta);
                        } else {
                            block_i += 1;
                            user_open = Some((format!("off-user-{block_i}"), delta));
                        }
                    }
                    "agent_message_chunk" => {
                        flush_user(&mut blocks, &mut user_open, updated_at);
                        let delta = json_text_content(
                            update.get("content").unwrap_or(&serde_json::Value::Null),
                        );
                        // Cap offline assistant body — unbounded append freezes pack/emit.
                        const ASST_CAP: usize = 48 * 1024;
                        if let Some((_, ref mut text)) = asst_open {
                            if text.len() < ASST_CAP {
                                let room = ASST_CAP - text.len();
                                if delta.len() <= room {
                                    text.push_str(&delta);
                                } else {
                                    text.push_str(&delta[..room]);
                                    text.push('…');
                                }
                            }
                        } else {
                            block_i += 1;
                            let clipped = if delta.len() > ASST_CAP {
                                format!("{}…", &delta[..ASST_CAP])
                            } else {
                                delta
                            };
                            asst_open = Some((format!("off-asst-{block_i}"), clipped));
                        }
                    }
                    "tool_call" => {
                        flush_user(&mut blocks, &mut user_open, updated_at);
                        flush_asst(&mut blocks, &mut asst_open, updated_at);
                        let tool_id = update
                            .get("toolCallId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool");
                        let title = update
                            .get("title")
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                update
                                    .pointer("/_meta/x.ai/tool/name")
                                    .and_then(|v| v.as_str())
                            })
                            .unwrap_or("tool");
                        let kind_s = update
                            .pointer("/_meta/x.ai/tool/kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("other");
                        let kind_norm = match kind_s {
                            "execute" | "terminal" | "edit" | "write" | "delete" | "move"
                            | "read" | "search" | "fetch" | "list" | "other" => kind_s,
                            _ => "other",
                        };
                        let block_id = if tool_id.is_empty() {
                            block_i += 1;
                            format!("off-tool-{block_i}")
                        } else {
                            format!("off-tool-{tool_id}")
                        };
                        let input = update
                            .get("rawInput")
                            .or_else(|| update.pointer("/_meta/x.ai/tool/rawInput"))
                            .map(|v| {
                                let s = if let Some(t) = v.as_str() {
                                    t.to_string()
                                } else {
                                    v.to_string()
                                };
                                if s.len() > 4000 {
                                    format!("{}…", &s[..4000])
                                } else {
                                    s
                                }
                            });
                        let mut call = serde_json::json!({
                            "id": tool_id,
                            "kind": kind_norm,
                            "rawKind": title,
                            "title": title,
                            "status": "done",
                            "startedAt": updated_at,
                        });
                        if let (Some(inp), Some(obj)) = (input, call.as_object_mut()) {
                            obj.insert("input".into(), serde_json::Value::String(inp));
                        }
                        blocks.push(serde_json::json!({
                            "type": "tool",
                            "id": block_id,
                            "ts": updated_at,
                            "call": call,
                        }));
                    }
                    "tool_call_update" => {
                        let tool_id = update
                            .get("toolCallId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let status = update
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("done");
                        let title = update.get("title").and_then(|v| v.as_str());
                        let status_norm = match status {
                            "in_progress" | "running" | "pending" => "running",
                            "failed" | "error" => "error",
                            "cancelled" | "canceled" => "cancelled",
                            "awaiting_permission" => "awaiting_permission",
                            _ => "done",
                        };
                        if let Some(block) = blocks.iter_mut().rev().find(|b| {
                            b.get("type").and_then(|t| t.as_str()) == Some("tool")
                                && b.pointer("/call/id").and_then(|t| t.as_str()) == Some(tool_id)
                        }) {
                            if let Some(call) = block.get_mut("call") {
                                if let Some(obj) = call.as_object_mut() {
                                    obj.insert(
                                        "status".into(),
                                        serde_json::Value::String(status_norm.into()),
                                    );
                                    if let Some(t) = title {
                                        obj.insert(
                                            "title".into(),
                                            serde_json::Value::String(t.to_string()),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    "plan" => {
                        flush_user(&mut blocks, &mut user_open, updated_at);
                        flush_asst(&mut blocks, &mut asst_open, updated_at);
                        let entries = update
                            .get("entries")
                            .or_else(|| update.get("steps"))
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        let mut steps = Vec::new();
                        for (i, entry) in entries.iter().enumerate() {
                            let content = entry
                                .get("content")
                                .or_else(|| entry.get("title"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if content.is_empty() {
                                continue;
                            }
                            let st = entry
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("pending");
                            let st_norm = match st {
                                "in_progress" | "running" => "in_progress",
                                "completed" | "done" => "completed",
                                _ => "pending",
                            };
                            let sid = entry
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| format!("step-{i}"));
                            steps.push(serde_json::json!({
                                "id": sid,
                                "content": content,
                                "status": st_norm,
                            }));
                        }
                        if !steps.is_empty() {
                            if let Some(existing) = blocks.iter_mut().rev().find(|b| {
                                b.get("type").and_then(|t| t.as_str()) == Some("plan")
                            }) {
                                if let Some(obj) = existing.as_object_mut() {
                                    obj.insert("steps".into(), serde_json::Value::Array(steps));
                                }
                            } else {
                                block_i += 1;
                                blocks.push(serde_json::json!({
                                    "type": "plan",
                                    "id": format!("off-plan-{block_i}"),
                                    "ts": updated_at,
                                    "steps": steps,
                                }));
                            }
                        }
                    }
                    "turn_completed" => {
                        flush_user(&mut blocks, &mut user_open, updated_at);
                        flush_asst(&mut blocks, &mut asst_open, updated_at);
                    }
                    _ => {}
                }

                // Progress-only during scan (no mid-scan session payloads).
            }

            if abandoned() {
                scan_progress_finish("cancelled");
                clear_active();
                return;
            }
            flush_user(&mut blocks, &mut user_open, updated_at);
            flush_asst(&mut blocks, &mut asst_open, updated_at);
            for block in blocks.iter_mut() {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool") {
                    continue;
                }
                if let Some(call) = block.get_mut("call").and_then(|c| c.as_object_mut()) {
                    let running = call
                        .get("status")
                        .and_then(|s| s.as_str())
                        .map(|s| s == "running" || s == "pending" || s == "in_progress")
                        .unwrap_or(false);
                    if running {
                        call.insert("status".into(), serde_json::Value::String("done".into()));
                    }
                }
            }
            // Attach tool outputs from small chat_history.jsonl (safe; not from huge updates).
            enrich_tools_from_chat_history(&dir, &mut blocks);

            // Timeline windows initial paint; 1500 blocks covers long missions.
            const MAX_FINAL_BLOCKS: usize = 1500;
            if blocks.len() > MAX_FINAL_BLOCKS {
                blocks = blocks.split_off(blocks.len() - MAX_FINAL_BLOCKS);
            }
            let packed = pack_offline_session(
                &safe, &title_s, &cwd_s, &model_s, created_at, updated_at, &blocks,
            );
            // Durable fingerprint cache for next cold open.
            let _ = write_ui_transcript(&dir, &safe, &packed, &updates_path);
            let final_bytes = total_bytes.max(bytes_read);
            scan_progress_set(final_bytes, line_i as u64, blocks.len() as u64);
            scan_progress_finish("complete");
            emit_done(Some(packed), "complete");
            clear_active();
        })
        .map_err(|e| {
            scan_progress_finish("error");
            if let Ok(mut guard) = OFFLINE_HISTORY_ACTIVE_ID.lock() {
                guard.clear();
            }
            format!("无法启动离线历史线程：{e}")
        })?;
    Ok(())
}

/// Read one JSONL record, capping buffered body size.
/// Returns `(bytes_consumed_including_skipped_tail, was_capped)`.
/// `Ok((0, _))` means EOF at start of read.
fn read_jsonl_line_capped<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_body: usize,
) -> std::io::Result<(usize, bool)> {
    buf.clear();
    let mut consumed = 0usize;
    let mut capped = false;
    loop {
        let data = reader.fill_buf()?;
        if data.is_empty() {
            // EOF mid-line or empty file.
            if consumed == 0 {
                return Ok((0, false));
            }
            if !capped {
                while buf.last().copied() == Some(b'\n') || buf.last().copied() == Some(b'\r') {
                    buf.pop();
                }
            }
            return Ok((consumed, capped));
        }
        if let Some(pos) = data.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if !capped {
                let room = max_body.saturating_sub(buf.len());
                if take <= room {
                    buf.extend_from_slice(&data[..take]);
                } else if room > 0 {
                    buf.extend_from_slice(&data[..room]);
                    capped = true;
                } else {
                    capped = true;
                }
            }
            reader.consume(take);
            consumed = consumed.saturating_add(take);
            if !capped {
                while buf.last().copied() == Some(b'\n') || buf.last().copied() == Some(b'\r') {
                    buf.pop();
                }
            }
            return Ok((consumed, capped));
        }
        // No newline in this chunk — copy or skip.
        let chunk_len = data.len();
        if !capped {
            let room = max_body.saturating_sub(buf.len());
            if chunk_len <= room {
                buf.extend_from_slice(data);
            } else {
                if room > 0 {
                    buf.extend_from_slice(&data[..room]);
                }
                capped = true;
            }
        }
        reader.consume(chunk_len);
        consumed = consumed.saturating_add(chunk_len);
    }
}

/// Pull tool_result bodies from chat_history (small) onto offline tool blocks.
fn enrich_tools_from_chat_history(dir: &Path, blocks: &mut [serde_json::Value]) {
    let chat_path = dir.join("chat_history.jsonl");
    let Ok(raw) = read_bounded_text(&chat_path, 8 * 1024 * 1024) else {
        return;
    };
    if raw.trim().is_empty() {
        return;
    }
    // toolCallId -> truncated output
    let mut outputs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "tool_result" && kind != "tool" {
            continue;
        }
        let id = entry
            .get("tool_call_id")
            .or_else(|| entry.get("toolCallId"))
            .or_else(|| entry.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let text = json_text_content(entry.get("content").unwrap_or(&serde_json::Value::Null));
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        const CAP: usize = 16 * 1024;
        let clipped = if text.len() > CAP {
            format!("{}…", &text[..CAP])
        } else {
            text.to_string()
        };
        outputs.insert(id.to_string(), clipped);
    }
    if outputs.is_empty() {
        return;
    }
    for block in blocks.iter_mut() {
        if block.get("type").and_then(|t| t.as_str()) != Some("tool") {
            continue;
        }
        let Some(call_id) = block
            .pointer("/call/id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        else {
            continue;
        };
        let Some(out) = outputs.get(&call_id) else {
            continue;
        };
        if let Some(call) = block.get_mut("call").and_then(|c| c.as_object_mut()) {
            call.insert("output".into(), serde_json::Value::String(out.clone()));
            if !call.contains_key("detail") {
                let detail: String = out.chars().take(200).collect();
                call.insert("detail".into(), serde_json::Value::String(detail));
            }
        }
    }
}

#[tauri::command]
fn read_config_documents(cwd: String) -> Result<Vec<ConfigDocument>, String> {
    let cwd = checked_workspace(&cwd)?;
    ["config", "system-prompt", "agents"]
        .into_iter()
        .map(|id| {
            let (path, label, language) = config_path(id, &cwd)?;
            let exists = path.is_file();
            Ok(ConfigDocument {
                id,
                label,
                path: path_for_webview(&path),
                content: read_bounded_text(&path, MAX_CONFIG_BYTES)?,
                exists,
                language,
            })
        })
        .collect()
}

#[tauri::command]
fn write_config_document(request: WriteConfigDocument) -> Result<ConfigDocument, String> {
    let cwd = checked_workspace(&request.cwd)?;
    let (path, label, language) = config_path(&request.id, &cwd)?;
    atomic_write(&path, &request.content)?;
    let id: &'static str = match request.id.as_str() {
        "config" => "config",
        "system-prompt" => "system-prompt",
        "agents" => "agents",
        _ => return Err("未知配置文档".into()),
    };
    Ok(ConfigDocument {
        id,
        label,
        path: path_for_webview(&path),
        content: request.content,
        exists: true,
        language,
    })
}

fn provider_profiles_path() -> Result<PathBuf, String> {
    Ok(grok_home()?.join("grox-providers.json"))
}

fn read_provider_profiles_file() -> Result<ProviderProfilesFile, String> {
    let path = provider_profiles_path()?;
    if !path.exists() {
        return Ok(ProviderProfilesFile::default());
    }
    let content = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    serde_json::from_str(&content)
        .map_err(|error| format!("无法解析供应商档案 {}：{error}", path.display()))
}

fn write_provider_profiles_file(value: &ProviderProfilesFile) -> Result<(), String> {
    let path = provider_profiles_path()?;
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化供应商档案：{error}"))?;
    atomic_write(&path, &content)?;
    restrict_private_file(&path)
}

fn provider_profile_summary(profile: &StoredProviderProfile) -> ProviderProfileSummary {
    let mut resident_models = profile.resident_models.clone();
    if resident_models.is_empty() {
        if let Some(model) = profile.model.as_ref().filter(|model| !model.is_empty()) {
            resident_models.push(model.clone());
        }
    }
    ProviderProfileSummary {
        id: profile.id.clone(),
        name: profile.name.clone(),
        has_api_key: !profile.api_key.is_empty(),
        base_url: profile.base_url.clone(),
        api_backend: profile.api_backend,
        available_models: profile.available_models.clone(),
        resident_models,
    }
}

fn compatible_models_url(base_url: &str) -> Result<String, String> {
    let base = checked_service_url(base_url, "服务地址")?;
    let mut parsed = url::Url::parse(&base).map_err(|error| format!("无效服务地址：{error}"))?;
    let path = parsed.path().trim_end_matches('/');
    if !path.ends_with("/models") {
        parsed.set_path(&format!("{path}/models"));
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string().trim_end_matches('/').to_owned())
}

fn checked_model_ids(models: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for model in models {
        let model = model.trim();
        if model.is_empty() {
            continue;
        }
        if model.chars().count() > 200 || model.chars().any(char::is_control) {
            return Err("模型 ID 不能超过 200 个字符或包含控制字符".into());
        }
        if !result.iter().any(|existing| existing == model) {
            result.push(model.to_owned());
        }
        if result.len() > 200 {
            return Err("常驻模型不能超过 200 个".into());
        }
    }
    Ok(result)
}

fn compatible_provider_env(
    api_key: &str,
    base_url: &str,
    provider_name: &str,
    api_backend: ProviderApiBackend,
) -> Result<String, String> {
    let key = checked_api_key(api_key.trim())?;
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    let base = checked_service_url(base_url.trim(), "服务地址")?;
    let lines = vec![
        format!("XAI_API_KEY={}", env_value(key)),
        format!("GROK_MODELS_BASE_URL={}", env_value(&base)),
        format!(
            "GROK_MODELS_LIST_URL={}",
            env_value(&compatible_models_url(&base)?)
        ),
        format!(
            "GROK_MODELS_API_BACKEND={}",
            env_value(api_backend.resolved(provider_name, &base))
        ),
    ];
    Ok(lines.join("\n"))
}

#[tauri::command]
fn list_provider_profiles() -> Result<ProviderProfilesResponse, String> {
    let value = read_provider_profiles_file()?;
    Ok(ProviderProfilesResponse {
        active_id: value.active_id,
        profiles: value
            .profiles
            .iter()
            .map(provider_profile_summary)
            .collect(),
    })
}

#[tauri::command]
fn save_provider_profile(request: SaveProviderProfile) -> Result<ProviderProfileSummary, String> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("供应商名称必须为 1–80 个可见字符".into());
    }
    let mut value = read_provider_profiles_file()?;
    let existing = request
        .id
        .as_deref()
        .and_then(|id| value.profiles.iter().find(|profile| profile.id == id));
    let current_values = parse_env_file(&grok_home()?.join(".env"));
    let key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .or_else(|| existing.map(|profile| profile.api_key.as_str()))
        .or_else(|| current_values.get("XAI_API_KEY").map(String::as_str))
        .ok_or("API Key 不能为空")?;
    compatible_provider_env(key, &request.base_url, name, request.api_backend)?;
    let resident_models = checked_model_ids(request.resident_models)?;
    let id = request.id.unwrap_or_else(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("provider-{}-{nanos}", std::process::id())
    });
    if id.len() > 96
        || id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("无效的供应商档案 ID".into());
    }
    let profile = StoredProviderProfile {
        id: id.clone(),
        name: name.to_owned(),
        api_key: checked_api_key(key)?.to_owned(),
        base_url: checked_service_url(&request.base_url, "服务地址")?,
        api_backend: request.api_backend,
        models_url: None,
        model: resident_models.first().cloned(),
        available_models: existing
            .map(|profile| profile.available_models.clone())
            .unwrap_or_default(),
        resident_models,
    };
    if let Some(index) = value.profiles.iter().position(|entry| entry.id == id) {
        value.profiles[index] = profile.clone();
    } else {
        value.profiles.push(profile.clone());
    }
    write_provider_profiles_file(&value)?;
    Ok(provider_profile_summary(&profile))
}

#[tauri::command]
async fn refresh_provider_models(id: String) -> Result<ProviderProfileSummary, String> {
    let profile = read_provider_profiles_file()?
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or("供应商档案不存在")?;
    let endpoint = compatible_models_url(&profile.base_url)?;
    let response = reqwest::Client::builder()
        .user_agent(format!("Grox/{CLIENT_VERSION}"))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法创建模型目录客户端：{error}"))?
        .get(endpoint)
        .bearer_auth(&profile.api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("无法获取模型列表：{error}"))?
        .error_for_status()
        .map_err(|error| format!("模型服务返回错误：{error}"))?
        .json::<OpenAiModelsResponse>()
        .await
        .map_err(|error| format!("模型列表不是 OpenAI 兼容格式：{error}"))?;
    let mut models = response
        .data
        .into_iter()
        .map(|model| model.id)
        .collect::<Vec<_>>();
    models.sort_by_key(|model| model.to_ascii_lowercase());
    models.dedup();
    models.truncate(1_000);

    let mut value = read_provider_profiles_file()?;
    let stored = value
        .profiles
        .iter_mut()
        .find(|stored| stored.id == profile.id)
        .ok_or("供应商档案已被删除")?;
    stored.available_models = models;
    let summary = provider_profile_summary(stored);
    write_provider_profiles_file(&value)?;
    Ok(summary)
}

#[tauri::command]
fn activate_provider_profile(id: String) -> Result<(), String> {
    let mut value = read_provider_profiles_file()?;
    let profile = value
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .cloned()
        .ok_or("供应商档案不存在")?;
    let replacement = compatible_provider_env(
        &profile.api_key,
        &profile.base_url,
        &profile.name,
        profile.api_backend,
    )?;
    let path = grok_home()?.join(".env");
    let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    atomic_write(&path, &replace_managed_env_block(&current, &replacement))?;
    restrict_private_file(&path)?;
    // Also pin each resident model id to this provider in config.toml so
    // existing local [model.*] overrides cannot keep routing to 127.0.0.1.
    apply_compatible_provider_to_config(&profile)?;
    value.active_id = Some(profile.id);
    write_provider_profiles_file(&value)
}

#[tauri::command]
fn delete_provider_profile(id: String) -> Result<(), String> {
    let mut value = read_provider_profiles_file()?;
    let before = value.profiles.len();
    value.profiles.retain(|profile| profile.id != id);
    if before == value.profiles.len() {
        return Err("供应商档案不存在".into());
    }
    if value.active_id.as_deref() == Some(id.as_str()) {
        let path = grok_home()?.join(".env");
        let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
        atomic_write(&path, &replace_managed_env_block(&current, ""))?;
        restrict_private_file(&path)?;
        clear_compatible_provider_from_config()?;
        value.active_id = None;
    }
    write_provider_profiles_file(&value)
}

#[tauri::command]
fn read_provider_status() -> Result<ProviderStatus, String> {
    let values = parse_env_file(&grok_home()?.join(".env"));
    let api_key = values
        .get("XAI_API_KEY")
        .filter(|value| !value.trim().is_empty());
    let base_url = values
        .get("GROK_MODELS_BASE_URL")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let kind = if base_url.is_some() {
        "compatible"
    } else if api_key.is_some() {
        "official"
    } else {
        "oauth"
    };
    Ok(ProviderStatus {
        kind,
        has_api_key: api_key.is_some(),
        base_url,
    })
}

#[tauri::command]
fn configure_provider(request: ProviderConfig) -> Result<(), String> {
    let home = grok_home()?;
    let path = home.join(".env");
    let current = read_bounded_text(&path, MAX_CONFIG_BYTES)?;
    let current_values = parse_env_file(&path);
    let requested_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let saved_key = current_values
        .get("XAI_API_KEY")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let replacement = match request.kind.as_str() {
        "oauth" => String::new(),
        "official" => {
            let key = requested_key.or(saved_key).ok_or("API Key 不能为空")?;
            let key = checked_api_key(key)?;
            format!("XAI_API_KEY={}", env_value(key))
        }
        "compatible" => {
            let key = requested_key.or(saved_key).ok_or("API Key 不能为空")?;
            compatible_provider_env(
                key,
                request.base_url.as_deref().unwrap_or_default(),
                "compatible",
                ProviderApiBackend::ChatCompletions,
            )?
        }
        _ => return Err("未知账户接入类型".into()),
    };
    atomic_write(&path, &replace_managed_env_block(&current, &replacement))?;
    restrict_private_file(&path)?;
    // Leaving OAuth / official xAI: drop managed model routes so built-ins
    // and any remaining user [model.*] sections take over again.
    if request.kind != "compatible" {
        clear_compatible_provider_from_config()?;
    } else if let Some(base_url) = request.base_url.as_deref() {
        // One-shot compatible configure (no named profile): still pin a
        // default model so the session does not stick to a local override.
        let key = requested_key.or(saved_key).ok_or("API Key 不能为空")?;
        let synthetic = StoredProviderProfile {
            id: "compatible".into(),
            name: "compatible".into(),
            api_key: checked_api_key(key)?.to_owned(),
            base_url: checked_service_url(base_url, "服务地址")?,
            api_backend: ProviderApiBackend::ChatCompletions,
            models_url: None,
            model: Some("grok-4.5".into()),
            available_models: Vec::new(),
            resident_models: vec!["grok-4.5".into()],
        };
        apply_compatible_provider_to_config(&synthetic)?;
    }
    let mut profiles = read_provider_profiles_file()?;
    if profiles.active_id.take().is_some() {
        write_provider_profiles_file(&profiles)?;
    }
    Ok(())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|error| format!("无效链接：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许打开 HTTP(S) 链接".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("链接不能包含用户名或密码".into());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", parsed.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法打开浏览器：{error}"))?;
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("无法打开浏览器：{error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("无法打开浏览器：{error}"))?;

    Ok(())
}

/// Start a fresh ACP child and stream each stdout JSON-RPC line to the webview.
/// A repeated call intentionally replaces the old child so a webview reload
/// cannot initialize the same agent process twice.
#[tauri::command]
async fn acp_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
    cwd: String,
) -> Result<(), String> {
    // New child never inherits a previous silent-load filter.
    state.silent_stream.store(false, Ordering::Relaxed);
    let cwd = checked_workspace(&cwd)?;

    // Invalidate the previous readers before terminating their process. On a
    // fast development reload Windows can still deliver a few buffered stdout
    // or stderr lines after `kill`; those lines must not reach the new ACP
    // connection.
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;

    if let Some(old) = state.process.lock().await.take() {
        terminate_process(old).await;
    }

    let runtime = configured_grok_command(&app);
    let command_path = PathBuf::from(&runtime.path);
    let mut command = Command::new(&command_path);
    command
        .args(["agent", "--leader", "--reasoning-effort", "high", "stdio"])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Ok(home) = grok_home() {
        for (key, value) in parse_env_file(&home.join(".env")) {
            command.env(key, value);
        }
    }
    // Provider profiles are authoritative at process start. This also migrates
    // profiles saved by older Grox versions whose managed .env block predates
    // GROK_MODELS_API_BACKEND, without exposing or rewriting the stored key.
    if let Ok(profiles) = read_provider_profiles_file() {
        if let Some(profile) = profiles.active_id.as_deref().and_then(|active_id| {
            profiles
                .profiles
                .iter()
                .find(|profile| profile.id == active_id)
        }) {
            let base = checked_service_url(&profile.base_url, "服务地址")?;
            command
                .env("XAI_API_KEY", &profile.api_key)
                .env("GROK_MODELS_BASE_URL", &base)
                .env("GROK_MODELS_LIST_URL", compatible_models_url(&base)?)
                .env(
                    "GROK_MODELS_API_BACKEND",
                    profile.api_backend.resolved(&profile.name, &base),
                );
            // Keep config.toml in lockstep with the active profile so a restart
            // after editing resident models still routes away from stale local
            // [model.*] base_url overrides without requiring a manual re-activate.
            let _ = apply_compatible_provider_to_config(profile);
        }
    }
    // This is deliberately applied after the user environment so neither a
    // stale config nor a server-controlled flag can re-enable background data
    // collection in the Grox-bundled agent.
    for (key, value) in GROX_PRIVACY_ENV {
        command.env(key, value);
    }

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动 Grok CLI（{}）：{error}。可通过 GROK_DESKTOP_CLI 指定可执行文件。",
            command_path.display()
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Grok CLI 未提供标准错误".to_string())?;
    *state.process.lock().await = Some(AgentProcess {
        child,
        stdin,
        generation,
    });

    let stdout_app = app.clone();
    let stdout_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if stdout_state.next_generation.load(Ordering::Relaxed) != generation {
                        break;
                    }
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    // Silent agent-bind: agent still loads history in-process, but
                    // we must not ship every sessionUpdate to the webview (that
                    // freezes UI on multi-hundred-MB updates.jsonl). Keep responses
                    // (have "result"/"error" + id, no sessionUpdate) and server
                    // requests (requestPermission, etc.).
                    if stdout_state.silent_stream.load(Ordering::Relaxed)
                        && (line.contains("\"sessionUpdate\"")
                            || line.contains("agent_thought_chunk")
                            || line.contains("\"session/update\"")
                            || line.contains("\"x.ai/session/update\""))
                    {
                        continue;
                    }
                    let _ = stdout_app.emit("acp-event", line);
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = stdout_app.emit("acp-stderr", format!("读取 ACP 输出失败：{error}"));
                    break;
                }
            }
        }

        let process = {
            let mut guard = stdout_state.process.lock().await;
            if guard
                .as_ref()
                .is_some_and(|process| process.generation == generation)
            {
                guard.take()
            } else {
                None
            }
        };
        if let Some(mut process) = process {
            drop(process.stdin);
            let code = process
                .child
                .wait()
                .await
                .ok()
                .and_then(|status| status.code());
            let _ = stdout_app.emit(
                "acp-exit",
                AcpExitPayload {
                    code,
                    reason: "exited",
                },
            );
        }
    });

    let stderr_app = app.clone();
    let stderr_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stderr_state.next_generation.load(Ordering::Relaxed) != generation {
                break;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                // Bound diagnostics before they cross into the webview.
                let safe = trimmed.chars().take(16_384).collect::<String>();
                let _ = stderr_app.emit("acp-stderr", safe);
            }
        }
    });

    Ok(())
}

/// Enable/disable silent ACP stream filtering (see AcpState::silent_stream).
#[tauri::command]
fn acp_set_silent_stream(state: tauri::State<'_, Arc<AcpState>>, silent: bool) {
    state.silent_stream.store(silent, Ordering::Relaxed);
}

#[tauri::command]
async fn acp_send(state: tauri::State<'_, Arc<AcpState>>, line: String) -> Result<(), String> {
    if line.contains('\n') || line.contains('\r') {
        return Err("ACP 消息必须是单行 JSON".into());
    }
    let mut guard = state.process.lock().await;
    let process = guard
        .as_mut()
        .ok_or_else(|| "Grok Agent 尚未启动".to_string())?;
    process
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| format!("写入 Grok Agent 失败：{error}"))?;
    process
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|error| format!("写入 Grok Agent 失败：{error}"))?;
    process
        .stdin
        .flush()
        .await
        .map_err(|error| format!("刷新 Grok Agent 输入失败：{error}"))
}

#[tauri::command]
async fn acp_kill(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AcpState>>,
) -> Result<(), String> {
    state.next_generation.fetch_add(1, Ordering::Relaxed);
    if let Some(process) = state.process.lock().await.take() {
        terminate_process(process).await;
        let _ = app.emit(
            "acp-exit",
            AcpExitPayload {
                code: None,
                reason: "killed",
            },
        );
    }
    Ok(())
}

/// Build the native menu. On macOS, remap ⌘W from "Close Window" to minimize —
/// users expect the shell to stay in the Dock rather than quit the agent session.
fn install_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // Custom File item: ⌘W / Ctrl+W minimizes instead of closing the window.
    let minimize_on_w = MenuItem::with_id(
        app,
        "cmd-w-minimize",
        "Minimize",
        true,
        Some("CmdOrCtrl+W"),
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            // Keep a way to fully close the window (no ⌘W accelerator).
            &PredefinedMenuItem::close_window(app, Some("Close"))?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about))?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &minimize_on_w,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )?;

    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(AcpState::default()))
        .manage(Arc::new(PreviewState::default()))
        .setup(|app| {
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            if let Err(error) = install_app_menu(app.handle()) {
                eprintln!("failed to install app menu: {error}");
            }
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "cmd-w-minimize" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.minimize();
                    }
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(icon)?;
                // Size against the monitor *work area* (excludes menu bar + Dock).
                // Default: width = 80% work area, height = 90% work area, centered both axes.
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let work = monitor.work_area();
                    let work_w = work.size.width.max(1);
                    let work_h = work.size.height.max(1);
                    let width = (((work_w as f64) * 0.8).round() as u32)
                        .max(960)
                        .min(work_w);
                    let height = (((work_h as f64) * 0.9).round() as u32)
                        .max(640)
                        .min(work_h);
                    let x = work.position.x
                        + ((work_w.saturating_sub(width) as i32) / 2);
                    let y = work.position.y
                        + ((work_h.saturating_sub(height) as i32) / 2);
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width,
                        height,
                    }));
                    let _ = window.set_position(tauri::Position::Physical(
                        tauri::PhysicalPosition { x, y },
                    ));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_environment,
            validate_workspace,
            pick_workspace,
            list_workspace_files,
            read_preview_file,
            open_in_explorer,
            read_config_documents,
            write_config_document,
            read_hidden_projects,
            write_hidden_projects,
            read_session_cache,
            write_session_cache,
            preview_session_from_disk,
            start_offline_session_history,
            cancel_offline_session_history,
            get_ui_transcript,
            get_offline_scan_progress,
            read_provider_status,
            configure_provider,
            list_provider_profiles,
            save_provider_profile,
            refresh_provider_models,
            activate_provider_profile,
            delete_provider_profile,
            grok_runtime_info,
            set_grok_runtime_preference,
            install_official_grok_cli,
            open_external,
            check_app_update,
            install_app_update,
            start_project_preview,
            acp_spawn,
            acp_send,
            acp_kill,
            acp_set_silent_stream,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<Arc<AcpState>>().inner().clone();
                let preview_state = window.state::<Arc<PreviewState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(process) = state.process.lock().await.take() {
                        terminate_process(process).await;
                    }
                    if let Some(mut process) = preview_state.process.lock().await.take() {
                        let _ = process.child.kill().await;
                        let _ = process.child.wait().await;
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Grox Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_workspace() {
        let missing = std::env::temp_dir().join("grox-workspace-that-does-not-exist");
        assert!(checked_workspace(&path_for_webview(&missing)).is_err());
    }

    #[test]
    fn accepts_existing_workspace() {
        let workspace = checked_workspace(env!("CARGO_MANIFEST_DIR")).unwrap();
        assert!(workspace.is_dir());
    }

    #[test]
    fn service_urls_require_encryption_except_for_loopback() {
        assert!(checked_service_url("https://api.example.com/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://localhost:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://127.0.0.1:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://[::1]:11434/v1", "服务地址").is_ok());
        assert!(checked_service_url("http://api.example.com/v1", "服务地址").is_err());
        assert!(checked_service_url("https://user:secret@example.com/v1", "服务地址").is_err());
        let normalized =
            checked_service_url("https://api.example.com/v1\n?model=grok", "服务地址").unwrap();
        assert!(!normalized.contains('\r') && !normalized.contains('\n'));
        assert!(checked_api_key("secret\nINJECTED=1").is_err());
    }

    #[test]
    fn compatible_provider_environment_is_validated_and_complete() {
        let env = compatible_provider_env(
            "sk-test",
            "https://gateway.example.com/v1",
            "grok2api",
            ProviderApiBackend::Auto,
        )
        .unwrap();
        assert!(env.contains("XAI_API_KEY=\"sk-test\""));
        assert!(env.contains("GROK_MODELS_BASE_URL=\"https://gateway.example.com/v1\""));
        assert!(env.contains("GROK_MODELS_LIST_URL=\"https://gateway.example.com/v1/models\""));
        assert!(env.contains("GROK_MODELS_API_BACKEND=\"responses\""));
        assert!(compatible_provider_env(
            "",
            "https://gateway.example.com/v1",
            "generic",
            ProviderApiBackend::Auto,
        )
        .is_err());
        assert!(compatible_provider_env(
            "sk-test",
            "http://gateway.example.com/v1",
            "generic",
            ProviderApiBackend::Auto,
        )
        .is_err());
    }

    #[test]
    fn managed_model_block_overrides_local_base_url() {
        let profile = StoredProviderProfile {
            id: "p1".into(),
            name: "picpi".into(),
            api_key: "sk-test".into(),
            base_url: "https://api.picpi.top/v1".into(),
            api_backend: ProviderApiBackend::Responses,
            models_url: None,
            model: Some("grok-4.5".into()),
            available_models: Vec::new(),
            resident_models: vec!["grok-4.5".into(), "grok-build".into()],
        };
        let existing = r#"
[models]
default = "local"

[model.local]
model = "grok-4.5"
base_url = "http://127.0.0.1:8000/v1"
api_key = "local-key"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "http://127.0.0.1:8000/v1"
api_key = "local-key"
"#;
        let without = replace_managed_model_block(existing, "");
        let ids = provider_resident_model_ids(&profile);
        let stripped = strip_model_tables(&without, &ids);
        assert!(
            !stripped.contains("[model.\"grok-4.5\"]"),
            "resident model tables should be stripped: {stripped}"
        );
        assert!(
            stripped.contains("[model.local]"),
            "unrelated local alias should remain"
        );
        let patched = ensure_models_default(&stripped, "grok-4.5");
        assert!(patched.contains("default = \"grok-4.5\""));
        let fragment = compatible_provider_model_config(&profile).unwrap();
        assert!(fragment.contains("base_url = \"https://api.picpi.top/v1\""));
        assert!(fragment.contains("api_key = \"sk-test\""));
        let final_cfg = replace_managed_model_block(&patched, &fragment);
        assert!(final_cfg.contains("# >>> Grox managed models"));
        assert!(final_cfg.contains("https://api.picpi.top/v1"));
        assert!(final_cfg.contains("[model.\"grok-4.5\"]") || final_cfg.contains("[model.grok-4.5]"));
    }

    #[test]
    fn bundled_agent_privacy_environment_is_fail_closed() {
        let values = GROX_PRIVACY_ENV.into_iter().collect::<BTreeMap<_, _>>();
        assert_eq!(values.get("GROX_PRIVACY_MODE"), Some(&"1"));
        assert_eq!(values.get("DISABLE_TELEMETRY"), Some(&"1"));
        assert_eq!(values.get("DISABLE_ERROR_REPORTING"), Some(&"1"));
        assert_eq!(values.get("GROK_TELEMETRY_ENABLED"), Some(&"0"));
        assert_eq!(values.get("GROK_TELEMETRY_TRACE_UPLOAD"), Some(&"0"));
        assert_eq!(values.get("GROK_EXTERNAL_OTEL"), Some(&"0"));
        assert_eq!(values.get("OTEL_LOGS_EXPORTER"), Some(&"none"));
    }

}
