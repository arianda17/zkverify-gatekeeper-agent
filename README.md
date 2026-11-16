# Wowok — Proof Gatekeeper agent (zkVerify Agent Games)

Deterministic Gatekeeper agent for the [Agent Games](https://agentgames.zkverify.io)
Proof Gatekeeper track: it checks every field of each proof-backed payment task
against the 7 documented trap types, then proves its decision locally with the
official Groth16 circuit (snarkjs + `gatekeeper.wasm` / `gatekeeper_final.zkey`).

- Endpoint: `POST /agent` (preflight + tasks, HMAC-signed both ways).
  Health: `GET /` or `GET /agent`.
- Local tests: `cd agent && npm test` → 16/16 pass (preflight, HMAC, all trap
  types, PROOF_REUSED, idempotent retry, proof verifies against the circuit VK,
  circuit rejects a wrong APPROVE on a trap).
- Proof generation: ~0.3–1.0 s per task (60 s window is comfortable).

## Deploy

Any Node 22+ host with a public HTTPS URL works (Fly.io, Render, VPS...).
The Docker image downloads the official circuit artifacts at build time
(`scripts/fetch-circuits.sh`), so the repo carries no binaries.

```bash
docker build -t wowok-gatekeeper .
docker run -e PORT=8080 -e AGENT_GAMES_HMAC_SECRET=<from dashboard Rotate Secret> -p 8080:8080 wowok-gatekeeper
```

Fly.io: `fly launch` / `fly deploy` (see `fly.toml` in the deploy folder;
`fly secrets set AGENT_GAMES_HMAC_SECRET=...`).

Render: create a Web Service from this repo (Blueprint `render.yaml`),
set `AGENT_GAMES_HMAC_SECRET` in the dashboard. Free tier sleeps after
15 min idle — ping `/` every 5 min during scored rounds (17:30–03:30 WIB).

## Register (dashboard, after deploy)

Dashboard → My Agents → Register agent → name `Wowok`, event
**Proof Gatekeeper**, Repository URL: this repo, Endpoint:
`https://<host>/agent` → Save (runs a signed preflight) → Rotate Secret →
set it as `AGENT_GAMES_HMAC_SECRET` → restart → Dashboard → Practice →
dispatch 1 Proof Gatekeeper practice task and check the feedback.

## If practice says the proof does not verify

**Practice does NOT validate public-signal encodings** (proven 2026-11-16:
a practice task still returned proofStatus "verified" after the taskId
encoding was deliberately flipped to `hex`). Practice only checks the
Groth16 proof cryptographically. A round rejection (correct decision, -2
proof_failure) means a public-signal encoding differs — the SCORED ROUNDS
are the only true oracle. Flip one at a time, redeploy, and judge by the
next round's results (rounds run 17:30-03:30 WIB; check the dashboard the
next morning):
- `VK_HASH_MODE=keccak` = keccak256 of the RAW vk bytes (deployed 2026-11-16;
  the R03 fix: `modp` failed every round proof). `keccak-text` = keccak256 of
  the lowercase hex string as UTF-8. `modp` = BigInt(vk) mod p (default, failed R03).
- `TASK_ID_MODE=keccak` (default: keccak256 of the full task_id string),
  `hex` or `suffix`.

## Decision logic (deterministic, matches the circuit)

REJECT in this order: proof_tx seen before → `PROOF_REUSED` (no proof sent);
proof_vk ≠ registered_vk → `VK_SUBSTITUTION`; public_balance < minimum →
`THRESHOLD_MISMATCH`; recipient ≠ condition_recipient → `RECIPIENT_MISMATCH`;
current_block > expiry_block → `EXPIRED_CONDITION`; amount > max_transfer →
`AMOUNT_OVERFLOW`. Else APPROVE `VALID_CONDITION`. Fail closed on any error.

## Files

- `agent/server.mjs` — HTTP server, HMAC verify/sign, preflight, idempotency cache.
- `agent/gatekeeper.mjs` — decision logic + snarkjs proof (circuit inputs mapped
  by probing `gatekeeper.wasm`: 13 inputs, 13 public signals).
- `agent/test-local.mjs` — mock-platform end-to-end test.
- Circuit artifacts are downloaded at build from the official
  https://agentgames.zkverify.io/circuits/ (not committed).
