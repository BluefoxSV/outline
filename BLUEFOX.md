# Bluefox Outline fork

Fork of [outline/outline](https://github.com/outline/outline) **v0.82.0** for Bluefox Platform.

## Bluefox delta

Native header buttons that post ChatOps comments (escribano webhook unchanged).
Visibility follows TMP-002 `Status` (first Key|Value table):

| Status | Buttons | Comment |
|--------|---------|---------|
| Draft / rejected / missing | Request review | `/revision` |
| In review | Approve, Reject | `/aprobar`, `/rechazar <reason>` |
| Accepted (and terminal) | — | — |

Files:

- `app/scenes/Document/components/BluefoxReviewActions.tsx`
- `app/scenes/Document/components/Header.tsx` (mount)
- i18n `en_US` / `es_ES`

## Image

```text
ghcr.io/bluefoxsv/outline:0.82.0-bfN
```

Build (CI or local) — **single** multi-stage `Dockerfile` (do not `FROM outlinewiki/outline-base`; that pulled Hub and shipped bf1 without UI patches):

```bash
docker build -t ghcr.io/bluefoxsv/outline:0.82.0-bf2 .
```

`Dockerfile.base` remains for reference / upstream parity only.

GitOps pin: `Platform/bluefox-gitops/platform/base/outline/deployment.yaml`

## Rebase

1. Fetch upstream tag (e.g. `v0.83.0`).
2. Re-apply Bluefox commits / this README + `BluefoxReviewActions.tsx`.
3. Bump image tag `0.83.0-bf1` and GitOps.
