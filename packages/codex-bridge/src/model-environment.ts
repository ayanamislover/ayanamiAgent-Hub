/**
 * The model process receives only its narrow MODEL_MCP capability. CONTROL, capture, injector,
 * bootstrap and Dashboard credentials belong to the parent Adapter and never cross this Seam.
 * CrossAgent variables are default-denied instead of enumerated: a future credential name cannot
 * silently become child-visible. The MCP URL is already pinned in app-server argv.
 */
export function sanitizeModelEnvironment(
  source: NodeJS.ProcessEnv,
  modelMcpToken?: string,
): NodeJS.ProcessEnv {
  const sanitized = { ...source };
  for (const name of Object.keys(sanitized)) {
    if (name.toUpperCase().startsWith("CROSSAGENT_")) delete sanitized[name];
  }
  if (modelMcpToken) sanitized.CROSSAGENT_TOKEN = modelMcpToken;
  return sanitized;
}
