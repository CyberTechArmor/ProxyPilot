// Shared by dispatch and ledger serialization; no database dependency.
export function redactMcpSecrets(value) {
  return String(value ?? '').replace(/ppmcp_[a-f0-9]{64}/gi,'[redacted MCP token]')
    .replace(/(\/api\/mcp(?:-editor)?\/(?:t|upload)\/)[^\s?"']+/g,'$1[redacted]');
}
