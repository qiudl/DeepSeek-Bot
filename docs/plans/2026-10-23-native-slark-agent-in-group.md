# Slark Agent in an existing DS Bot group

REQ-20261023-0013 extends the native group design in `2026-10-07-group-chat.md`.
The DS Bot room stays the chat the user sees. Its Session keeps accepting ordinary
messages, and its round scheduler decides when Bots and the Slark Agent speak.

Slark's existing group activation installs an input fence on the Session attached
to its group Source. Fencing the room Session would break ordinary group chat.
The plugin therefore creates a separate Session in the team workspace for each
room that gains a Slark Agent. The plugin persists the room ID and bridge Session
ID together. Only the bridge Session is bound to Slark's group ledger.

The first bridge Source is a control event with a stable message ID. It is never
relayed into the room. The Host captures it through the DSH Profile's
`captureCollaborationSource` API. On a retry, the plugin reuses the recorded
bridge and Source identity. Slark must attest that Source through the current
Account, Profile, and Host before it prepares the group.

Later work must bind each native room message and Slark result to this mapping,
preserve room sequence and member cycle, and project public Agent replies back
into the same room. Explicit @ wins the next slot; otherwise the Agent joins the
room's ordinary rotation. Unknown acceptance is resolved by receipt lookup.
Removing the Agent stops future delivery without rewriting room history.

The bridge Source endpoint is internal preparation only. It does not make the
Agent a room member or turn on message dispatch until the rest of the binding,
roster, and result path is present and tested.
