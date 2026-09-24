// Caller SQL is a PostgreSQL protocol message, never a psql script. The OS
// account and database login are both pp_mcp_reader; there is no postgres
// session whose authority could be recovered with RESET SESSION AUTHORIZATION.
export const READER_BOOTSTRAP_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='pp_mcp_reader') THEN
    CREATE ROLE pp_mcp_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    COMMENT ON ROLE pp_mcp_reader IS 'ProxyPilot managed SQL reader v1';
  ELSIF shobj_description((SELECT oid FROM pg_roles WHERE rolname='pp_mcp_reader'), 'pg_authid') IS DISTINCT FROM 'ProxyPilot managed SQL reader v1' THEN
    RAISE EXCEPTION 'Reserved reader role already exists without ProxyPilot provenance';
  END IF;
END $$;
ALTER ROLE pp_mcp_reader SET default_transaction_read_only=on;
ALTER ROLE pp_mcp_reader SET statement_timeout='30s';
GRANT CONNECT ON DATABASE app TO pp_mcp_reader;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname='api_read') THEN
    GRANT USAGE ON SCHEMA api_read TO pp_mcp_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA api_read TO pp_mcp_reader;
  END IF;
END $$;`;

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
// A fixed, admin-run provisioning operation. Existing guests must run this
// explicitly; the reader endpoint never creates roles or broadens grants.
export const READER_PROVISION_SCRIPT = `set -eu
command -v python3 >/dev/null
command -v runuser >/dev/null
if ! id pp_mcp_reader >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin pp_mcp_reader
fi
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d app -c ${quote(READER_BOOTSTRAP_SQL)}
`;

export const READER_PYTHON = String.raw`
import ctypes as c, ctypes.util, json, sys
p = c.CDLL(ctypes.util.find_library('pq') or 'libpq.so.5')
ptr, text, integer = c.c_void_p, c.c_char_p, c.c_int
def bind(name, result, *args):
    f = getattr(p, name); f.restype = result; f.argtypes = args; return f
connect = bind('PQconnectdb', ptr, text)
status = bind('PQstatus', integer, ptr)
error = bind('PQerrorMessage', text, ptr)
query = bind('PQexecParams', ptr, ptr, text, integer, ptr, ptr, ptr, ptr, integer)
result_status = bind('PQresultStatus', integer, ptr)
result_error = bind('PQresultErrorMessage', text, ptr)
clear = bind('PQclear', None, ptr)
finish = bind('PQfinish', None, ptr)
count = bind('PQntuples', integer, ptr)
fields = bind('PQnfields', integer, ptr)
name = bind('PQfname', text, ptr, integer)
value = bind('PQgetvalue', text, ptr, integer, integer)
isnull = bind('PQgetisnull', integer, ptr, integer, integer)
single = bind('PQsetSingleRowMode', integer, ptr)
send = bind('PQsendQueryParams', integer, ptr, text, integer, ptr, ptr, ptr, ptr, integer)
get = bind('PQgetResult', ptr, ptr)
db = connect(b"dbname=app user=pp_mcp_reader host=/var/run/postgresql connect_timeout=5 options='-c statement_timeout=30000 -c default_transaction_read_only=on'")
def checked(sql):
    r = query(db, sql, 0, None, None, None, None, 0)
    if not r: raise RuntimeError('Database query failed')
    if result_status(r) not in (1, 2):
        message = (result_error(r) or b'Query failed').decode(errors='replace'); clear(r); raise RuntimeError(message)
    return r
try:
    if status(db) != 0: raise RuntimeError('Read-only database login unavailable; provision the project SQL reader')
    r = checked(b"SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR EXISTS(SELECT FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname=current_user")
    unsafe = count(r) != 1 or value(r, 0, 0) != b'f'; clear(r)
    if unsafe: raise RuntimeError('Reader role has unsafe authority; refusing SQL')
    clear(checked(b'BEGIN READ ONLY'))
    request = json.load(sys.stdin)
    sql = request['sql'].encode(); limit = int(request['limit'])
    if len(sql) > 80000 or b'\0' in sql or not 1 <= limit <= 5000: raise RuntimeError('Invalid query')
    # Extended protocol rejects multiple statements; single-row mode bounds
    # libpq memory even when the user omits LIMIT.
    if send(db, sql, 0, None, None, None, None, 0) != 1 or single(db) != 1: raise RuntimeError('Query could not be started')
    columns, rows, truncated, size = [], [], False, 0
    while True:
        r = get(db)
        if not r: break
        try:
            state = result_status(r)
            if state not in (2, 9): raise RuntimeError((result_error(r) or b'Query failed').decode(errors='replace'))
            if not columns: columns = [name(r, i).decode(errors='replace') for i in range(fields(r))]
            if count(r):
                row = [None if isnull(r, 0, i) else value(r, 0, i).decode(errors='replace') for i in range(fields(r))]
                size += len(json.dumps(row))
                if len(rows) >= limit or size > 1500000:
                    truncated = True; break
                rows.append(row)
        finally: clear(r)
    print(json.dumps(dict(columns=columns, rows=rows, row_count=len(rows), truncated=truncated)))
except Exception as e:
    print(str(e)[:1200], file=sys.stderr); sys.exit(1)
finally:
    # Disconnect rolls back, including when output limits stop consumption.
    finish(db)
`;

export const READER_QUERY_SCRIPT = `set -eu
command -v python3 >/dev/null && command -v runuser >/dev/null && id pp_mcp_reader >/dev/null 2>&1 || { echo 'Read-only SQL is not provisioned for this guest' >&2; exit 66; }
exec runuser -u pp_mcp_reader -- python3 -c ${quote(READER_PYTHON)}
`;
