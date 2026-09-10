const command = (description, properties = {}, required = []) => ({ description, type: "object", properties, required, additionalProperties: false });
const framework = { type: "string", enum: ["claude", "codex", "cursor", "windsurf", "zed"] };
export const INTEGRATION_APP_COMMANDS = {
  get_integrations: command("Read MCP integration settings, generated configuration and per-device startup health. Credentials are never included."),
  check_integrations: command("Start startup repair checks on configured devices; poll get_integrations for completion and per-device outcomes.", { deviceIds: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } }, fresh: { type: "boolean" } }),
  configure_integration_connection: command("Select the app SSH target and absolute MCP script path in integration settings, then regenerate credential-free client configuration.", { agentHost: { type: "string", maxLength: 255, pattern: "^(?:[a-zA-Z0-9_][a-zA-Z0-9_.@-]*)?$" }, mcpPath: { type: "string", maxLength: 4096, pattern: "^(?:/[^\\u0000-\\u001f\\u007f]*)?$" } }),
  install_integration: command("Start installing the local app MCP entry into a supported client configuration. Poll get_integrations for the result.", { framework: { type: "string", enum: ["claude", "codex"] } }, ["framework"]),
  copy_integration_config: command("Copy the selected generated MCP client configuration to the app device clipboard.", { framework }, ["framework"]),
};
