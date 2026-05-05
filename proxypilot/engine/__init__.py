"""ProxyPilot CVE execution engine.

Small by design. The engine reads YAML specs from the CVE inbox
(/var/lib/proxypilot/cve-inbox/<cve>.yaml), executes them on the
host according to each entry's action_class, and reports back by
appending to state.history. It does not pull feeds, score CVEs,
or author mitigations — Claude owns all of that and writes specs
into the inbox.

See proxypilot-core-phased-plan.md for the broader contract.
"""

INBOX_DIR = "/var/lib/proxypilot/cve-inbox"
INVENTORY_PATH = "/var/lib/proxypilot/inventory.json"
ENGINE_ACTOR = "proxypilot-engine"
