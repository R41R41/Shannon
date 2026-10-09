# Configured Minecraft lifecycle operator

Candidate source only. No server/world/bot was started, stopped, logged in or logged out to implement this feature. Offline checks do not establish a real-game acceptance or authorize deployment.

The always-on legacy backend starts `startConfiguredMinecraftLifecycle()` after its existing registered services initialize. It remains alive when the bot and game server are absent. It polls the paired companion device channel `/v1/body/minecraft/lifecycle`; it does not use the platform service credential, start another planner, or create an autonomous runner. The API and the own-time worker share the original command IDs and fresh count-only operator snapshot through SQLite.

The operator is off unless `MINEBOT_LIFECYCLE=on`, `MINEBOT_COMMON_FCA=on`, and existing companion settings bind the dedicated `shannon-home` world. It additionally requires `MINEBOT_LIFECYCLE_BOT_UUID`, `MINEBOT_LIFECYCLE_RCON_PORT`, and a private `MINEBOT_LIFECYCLE_RCON_PASSWORD_FILE`. Optional `MINEBOT_LIFECYCLE_JOURNAL` selects an owner-managed private journal file; its default is `saves/minecraft/lifecycle-operations.json`. Token, password and journal files remain outside Git. The password/port/enable-rcon settings must match the actual fixed server's `server.properties`; its online-mode setting decides UUID exemptions. Do not change those properties while an old server process remains running. A rollout must verify actual server mode before enabling lifecycle authority.

The companion side requires `SHANNON_MINECRAFT_LIFECYCLE=on`, its existing Stage4 authority, the configured body device, and an explicit JSON array `SHANNON_MINECRAFT_LIFECYCLE_SERVERS` naming only server IDs already in `SHANNON_MINECRAFT_BODY_JSON`. The native adapter supports the single dedicated world, not shared or progressive lab servers. Enabling a procedure alone creates none of this authority.

## Operations and evidence

`minecraft.lifecycle_status` returns fresh `running`, `bot` and `otherPlayers` states. `minecraft.start` starts only a known stopped server, with an already-running result as an idempotent no-op. The existing fixed server registration owns the start script. `minecraft.login` joins only the configured running world through the existing common-FCA native bot; it does not start the server. `minecraft.logout` cancels any scheduled reconnect, awaits actual body release and network end, and leaves the management operator alive. A created mineflayer object is not proof of joining: both local native identity and RCON's UUID list must agree.

The configured process state and native RCON `list uuids` are queried again for every operation. Errors, an unparsed/incomplete count, a wrong UUID, or unknown connection state never become zero humans. Player identities are ephemeral in the operator; only counts and closed state enter the companion snapshot/receipts.

`minecraft.stop` first refuses a fresh nonzero/unknown human count. Its final guard is a single native RCON command:

```text
execute unless entity @a[nbt=!{UUID:[I;<four signed configured UUID words>]}] run stop
```

Minecraft evaluates the entity predicate and invokes `stop` on its own command thread in one tick; an intervening join cannot occur between two API calls. The server's stopped process/port is then verified. On an offline server the command is `execute unless entity @a run stop`, exempting nobody; log the bot out first. No unguarded `stop`, `stop.sh`, tmux kill, or forced process termination is a fallback. A successful changed-stop receipt contains the native guard time, zero other players and shutdown admission closure; the API also requires actual stopped state. Already-stopped is a no-op, not a fabricated shutdown proof.

Every delivered command retains its original authority (`owner_request` or `own_time`), action lease, issuedAt and provenance. Original command clocks must be valid before actuating; receipt observations and the atomic stop guard cannot predate that command. Delayed transport may replay the same historical receipt without an action replay. After awaited native reads the operator calls `/lifecycle/permit` again, immediately before the actuator, to recheck the original lease, source availability, deadline and the existing own-time stop/budget gates. Poll cancellation and lost contact abort the original action. They do not label a self-directed action as an owner request.

The API queues/delivers each operation once. The operator fsyncs a private begin record before actuating and fsyncs its immutable receipt afterwards. A process crash after begin, lost command transport, timeout, or unconfirmed outside effect holds the original operation unknown; a replacement ID is refused while unresolved work exists. Known receipts can be sent again until acknowledged, including after an operator restart. There is no automatic native retry or optimistic reconciliation from a coincidentally matching current world state.

## Validation boundary

Offline fixtures cover duplicate starts, independent login/logout, revoked final authority, malformed native players, a human joining between observation and final native stop, durable crash/receipt recovery, and a bounded fake RCON TCP session with split frames. Existing body-control/native tests cover real quiescence acknowledgement and late unknown holds. Type checking of the new isolated lifecycle contract/transport/operator modules is separate from the large legacy backend's historical no-check build.

Before a separately authorized rollout, preserve the existing dedicated world, configure private credentials, verify the actual server properties and bot UUID, and run a finite paired-device smoke test. Production flags, credentials, processes, labs and world saves were not changed by this implementation.
