use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

// Separate from the agent bearer: never returned by an invoke command or saved.
pub(crate) fn proof_key() -> Option<&'static str> {
    static KEY: OnceLock<Option<String>> = OnceLock::new();
    KEY.get_or_init(|| crate::agent::random_hex(32)).as_deref()
}

#[tauri::command]
pub async fn bridge_local_decide(
    app: AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let object = request.as_object().ok_or("Invalid local consent request")?;
    let kind = object
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !["config", "job", "approval"].contains(&kind) {
        return Err("Unsupported local consent decision".into());
    }
    let body = serde_json::to_vec(&request).map_err(|_| "Invalid consent payload")?;
    if body.len() > 2 * 1024 * 1024 {
        return Err("Consent payload is too large".into());
    }
    let token = app
        .state::<crate::agent::AgentState>()
        .token
        .lock()
        .map_err(|_| "Device agent is unavailable")?
        .clone();
    if token.is_empty() {
        return Err("Start the receiving desktop app before approving".into());
    }
    let proof = proof_key()
        .ok_or("Native consent is unavailable")?
        .to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| "Cannot initialize local consent connection")?;
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/bridge/local-decision",
                crate::agent::AGENT_PORT
            ))
            .bearer_auth(token)
            .header("x-pzza-native-consent", proof)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .map_err(|_| "Receiving device agent could not be reached")?;
        let status = response.status();
        use std::io::Read;
        let mut bytes = Vec::new();
        response
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read local consent outcome")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("Consent response is too large".to_string());
        }
        let result: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid local consent outcome")?;
        if !status.is_success() {
            return Err(result
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("Local consent was refused")
                .chars()
                .take(500)
                .collect());
        }
        Ok(result)
    })
    .await
    .map_err(|_| "Local consent task interrupted")?
}
