# Z-04 long-session acceptance

Generated: 2026-11-24T11:48:59.810Z

- ok: **true**
- rounds: **24/24** (real `daily` processes, one persistent state/dataDomain; unique intents **24**, unique runs **24**)
- context watermark rows: **24** (assembled max **20**, trimmed **0**, over budget **0**)
- memory decision events: **24**; writeback skipped: **0**; consolidation failed: **0**
- active facts: **25**; settled decision facts: **1** (provenance **24**); disputed facts: **0**
- active facts missing expected subjects: **0**
- old fact traceable: **true**; old fact recallable: **true**
- writeback did not pollute decisions: **true** (conclusions: healthy)

Caveat: 20+ round branch of the OR criterion; not one week of natural use. The peer is local and deterministic, so this proves the memory/context path, not answer quality.
