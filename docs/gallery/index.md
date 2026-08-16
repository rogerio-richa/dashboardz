# Integration gallery

These are the integrations we run on our own walls — not demos, the actual
plumbing behind the screens this project is dogfooded on. Each one exists
because something kept demanding attention from the wrong place: a radio
network with no screen, an AI agent blocked on a question nobody saw, a
fleet of VMs whose problems lived in a terminal nobody had open.

They are worth reading together because each is a different answer to the
question "what counts as an integration?" There is no plugin API and no SDK
— an integration is any process holding a sender token and making three
HTTP calls — so the answers range from shell scripts to no process at all:

| | What lands on the wall | The pattern it demonstrates | Stack |
|---|---|---|---|
| [Meshtastic](meshtastic.md) | Radio messages routed by channel, DM, and sender; live radio telemetry | A long-running daemon that owns its own config page | Python, one container |
| [Claude and AI agents](claude.md) | Questions you answer by tapping; "session blocked" cards that retract themselves | The agent *is* the integration — no daemon at all | A skill file + two shell hooks |
| [Netdata](netdata.md) | A VM's health: alarm cards, gauges, a security journal | Bolting onto an alerting pipeline you already run | Shell + curl, no dependencies |

Every page ends the same way: with the parts you would swap to build your
own thing. The full contract they all share — mint a token, create a feed,
push, notify, read back the tap — is the
[integration walkthrough](../integrations.md); it takes about fifteen
minutes from a terminal, and everything in this gallery is that walkthrough
wearing a different costume.

The source for all three lives in the repository's
[`integrations/` folder](https://github.com/rogerio-richa/dashboardz/tree/main/integrations),
each self-contained with its own README, env-file config, and clean
uninstall. Copy the closest one and start swapping parts.
