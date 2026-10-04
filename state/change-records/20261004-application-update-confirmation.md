# Application-only update confirmation

The deployed update handler and root runner already keep Incus package/image
settings unchanged for ordinary application updates. The MCP tool definition
already describes this correctly, but its refusal confirmation and the dashboard
dialog retained obsolete Incus-upgrade wording. This patch aligns those surfaces
with the existing flags and adds a regression that rejects the Incus option.

No update flag, host operation, permission or deployment mechanism changes.
The current ChatGPT connector advertises older metadata: automatic approval
review rejected two normal deployment requests on that basis. No request started;
the coordinator has not routed the rejected action through a different operation.
Refreshing the connector contract or obtaining an explicitly application-only
fixed deployment operation remains necessary. Source tests are not deployment.
