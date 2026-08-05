# Bluefox Outline fork

Fork of [outline/outline](https://github.com/outline/outline) **v0.82.0** for Bluefox Platform.

## Bluefox delta

Native header review buttons call **`POST /api/bluefox.review`**, which proxies
in-cluster to escribano `POST /review` (shared secret). **No ChatOps comment** is
created by the UI. Slash commands (`/revision`, `/aprobar`, `/rechazar`) still
work via webhook for power users.

Visibility = TMP-002 `Status` × role (parity with `outline_export_webhook.py`):

| Status | Role | Buttons | Server command |
|--------|------|---------|----------------|
| Draft / rejected / missing | Editor (`can.update`) | Request review | `revision` |
| Accepted / published / … | Editor (`can.update`) | Request **re-review** | `revision` |
| In review | Outline group **Revisores** | Approve, Reject | `aprobar`, `rechazar` + reason |
| Superseded / deprecated / archived | any | — | — |
| any | Lector (no comment/update) | — | — |

Non-revisors never see Approve/Reject (escribano would reject anyway).

**Runtime env (GitOps):**

- `BLUEFOX_ESCRIBANO_URL=http://outline-export-webhook.outline.svc:8080`
- `BLUEFOX_REVIEW_SECRET` = same value as webhook `REVIEW_SECRET` (reuses `UTILS_SECRET` from `outline-app`)

Files:

- `app/scenes/Document/components/BluefoxReviewActions.tsx`
- `server/routes/api/bluefox/bluefox.ts`
- `app/scenes/Document/components/Header.tsx` (mount)
- i18n `en_US` / `es_ES`

## Image

```text
ghcr.io/bluefoxsv/outline:0.82.0-bfN
```

Build (CI or local) — **single** multi-stage `Dockerfile` (do not `FROM outlinewiki/outline-base`; that pulled Hub and shipped bf1 without UI patches):

```bash
docker build -t ghcr.io/bluefoxsv/outline:0.82.0-bf6 .
```

`Dockerfile.base` remains for reference / upstream parity only.

GitOps pin: `Platform/bluefox-gitops/platform/base/outline/deployment.yaml`

## Rebase

1. Fetch upstream tag (e.g. `v0.83.0`).
2. Re-apply Bluefox commits / this README + review bridge.
3. Bump image tag `0.83.0-bf1` and GitOps.
