// Schema fragments shared by the extended catalog. Every entry is a plain MCP
// tool definition: { name, description, inputSchema }. The helpers keep the
// cross-cutting parameters spelled identically on every tool.

export const P = {
  container: { type: 'string', description: 'Container name without the pp- prefix (list_lxc_containers).' },
  project_id: { type: 'number', description: 'Project id from list_projects.' },
  site_id: { type: ['number', 'string'], description: 'Static site id from list_static_sites.' },
  domain: { type: 'string', description: 'Fully qualified hostname, e.g. app.example.com.' },
  path_prefix: { type: 'string', description: 'Route path prefix; "/" (default) is the root route.' },
  confirm: { type: 'boolean', description: 'Set true only after the user approved the action in conversation.' },
  confirmation_token: { type: 'string', description: 'Omit on the first call: the tool validates everything and returns a one-time token bound to this exact target. Show the user the preview, then re-call with the token. Tokens expire after 10 minutes and are consumed on use.' },
  dry_run: { type: 'boolean', description: 'true = validate and return exactly what would change without touching anything.' },
  expected_sha256: { type: 'string', description: 'The sha256 returned by the matching read; the write is refused if the file changed since.' },
  limit: { type: 'number', description: 'Maximum rows to return.' },
};

/** Build one tool definition. `required` defaults to []; additionalProperties is always false. */
export function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

/** A mutating tool: dry_run + confirm on top of its own params. */
export function mutating(name, description, properties = {}, required = []) {
  return tool(name, description, { ...properties, dry_run: P.dry_run, confirm: P.confirm }, required);
}

/** A destructive tool: dry_run + confirmation_token. */
export function destructive(name, description, properties = {}, required = []) {
  return tool(name, description, { ...properties, dry_run: P.dry_run, confirmation_token: P.confirmation_token }, required);
}
