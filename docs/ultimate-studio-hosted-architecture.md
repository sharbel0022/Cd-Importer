# Hosted translation architecture and access boundary

Status: design plus a tested fail-closed boundary, **not a deployed authenticated platform**. The existing JSON filesystem queue remains a local single-user system. `npm run start` and `npm run dev` bind loopback. `src/proxy.ts` restricts Translation Studio/API requests to loopback URL and Host; any `STUDIO_DEPLOYMENT_MODE` other than `local` blocks the translation surface. This prevents accidentally enabling the current job routes as a hosted edition. It is not login, tenant isolation or protection against a proxy deliberately rewriting Host to loopback. Do not tunnel this local server or change its bind address as a substitute for authentication.

## Deployment contract before enabling hosted mode

1. Authenticate browser users using a maintained session/OIDC implementation; validate the session again in every API/data access layer. Secure, HttpOnly cookies, CSRF protection, session expiry/revocation and TLS are required. Select/provision the identity provider only with configured account access; none has been provisioned here.
2. Replace `readJob/listJobs/updateJob/jobDir` with an owner-aware repository. Persist `users`, `projects(owner_id)`, `memberships(project_id,user_id,role)`, `jobs`, `segment_revisions`, `artifacts`, `voice_consents`, and `usage_events` in a transactional database. Queries must include the authenticated owner/member predicate; a UUID alone never grants access. Test owner/editor/reviewer/viewer matrices before enabling invitations.
3. Store originals and immutable revision artifacts in private object storage under owner/project keys. Use short-lived authorized download/upload URLs. Validate upload type by decoding, enforce size/duration quotas and quarantine malformed inputs. Do not place user media in public static directories or application Git history.
4. Use a durable queue carrying only project/job/revision IDs. Claim work with leases and heartbeat; retain immutable model/checkpoint fingerprints. Workers fetch only scoped object references, checkpoint idempotently, reject obsolete revisions and publish a complete manifest transactionally. Cancellation revokes the lease and prevents success publication. Use retries with bounded backoff and a dead-letter state.
5. Run FFmpeg, ASR, TTS and optional video models in separate unprivileged CPU/GPU services. No shell-built command strings, public Python gateway or client-supplied model paths. Restrict worker egress, mount temporary job storage privately, bound CPU/RAM/GPU/time and concurrency. Health readiness must include actual model availability; process liveness alone is insufficient.
6. Enforce per-owner storage, duration and inference budgets before accepting work. Collect measured provider usage where supplied, job-stage latency, queue depth, failures, export checksums and cleanup outcomes without recording private transcripts in general logs. Local inference has infrastructure/electricity cost; no currency estimate is fabricated.
7. Add authenticated deletion covering originals, derived references, audio, video, checkpoints, search indexes, profiles and object versions under the defined retention policy. A revoked voice consent disables generation immediately and deletes associated reusable references. No reusable voice profile service currently exists.
8. Keep payments and collaboration disabled until identity, business requirements, metering, permissions and account configuration are real and tested. Remove the hosted fail-closed boundary only together with these authenticated data paths and unauthorized-access tests, not with an environment bypass.

## Sites integration

The existing Sites project `appgprj_6ac7b4be7e588191b146990bfc07c089` is a separate frontend/runtime. Sites `get_site` on 2026-10-15 reported active, latest version 6, live URL <https://ton-cd-importer.asdasdsa213.chatgpt.site>, updated 13:51:56 UTC. No new Sites version was deployed for this work. The web fetch tool could not render that URL; the native metadata confirms publication status, not AI inference health.

The static/browser build cannot run the local Python processes, disk queue or native FFmpeg worker. A future frontend must call an authenticated backend over HTTPS with explicit CORS, session/token and upload/download contracts. Keep frontend and backend deployment health checks distinct. Current local inference is not advertised as a public feature.

## Commercial model policy

`STUDIO_COMMERCIAL_MODE=true` fails closed unless `STUDIO_LICENSE_APPROVALS_JSON` contains a reviewed approval for each used local component. Each entry has exact model label/ID, license, HTTPS evidence URL, ISO `reviewedAt` date and `commercial:true`. For primary ASR, the selected gateway health label is authoritative; unknown health selection is blocked. Segment comparisons additionally require `asr:<allowlist-id>`. Translation approvals use `translation:en` / `translation:default`; local voices use `voice:<voice-id>`. This is an operator review registry, not automatic legal clearance. Pin and hash deployed model files and review their full dependency/dataset terms before rollout.

Known NC MMS, Ryan and XTTS IDs are blocked even if an approval incorrectly claims MIT. Unknown or missing approvals are blocked. Local evaluation remains available with an explicit licensing notice. No current environment approval or commercial license is inferred from installed files or a successful waveform.

Example shape (illustrative only; it is not an approval of any model):

```json
{
  "asr": {
    "model": "EXACT_SELECTED_HEALTH_LABEL",
    "license": "REVIEWED_LICENSE_IDENTIFIER",
    "evidence": "https://example.org/exact-model-license",
    "reviewedAt": "2026-10-15",
    "commercial": true
  }
}
```
