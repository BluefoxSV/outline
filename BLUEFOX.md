# Bluefox Outline fork

Fork of [outline/outline](https://github.com/outline/outline) **v0.82.0** for Bluefox Platform.

## Bluefox delta

### Internal metadata (`bluefoxMeta`)

TMP-002 Status / MkDocs Path / ID live in `documents.bluefoxMeta` (JSONB), not as a
visible editor table. The leading TMP-002 heading+table is **hidden** in the
editor (`BluefoxHideTmp002`). Header shows a Status chip + review buttons.

- `POST /api/bluefox.meta.update` — `{ id, meta: { status, mkdocsPath, … } }`
- `POST /api/bluefox.review` — proxies escribano and updates `bluefoxMeta.status`

### Unpublish («Despublicar documento»)

Native Outline Unpublish also:

1. Sets `bluefoxMeta.status=Draft` (clears approve fields)
2. POSTs escribano `/export` so the page is pruned from the MkDocs 1:1 mirror

Escribano webhook event `documents.unpublish` does the same as a backup.

### Review buttons

Native header review buttons call **`POST /api/bluefox.review`**. Slash ChatOps
still works via webhook.

With **separate editing** (default): Request review / Approve / Reject are
hidden while the editor is open — click **Done editing** first. Status chip
stays visible.

Review actions never `documents.fetch(force)` over a dirty/open editor (that
reverted titles/body). Unsaved changes are saved first when a review command
runs. Escribano does not rewrite document text when `bluefoxMeta` exists
(avoids Yjs clobber via `documents.update`).

| Status | Role | Buttons |
|--------|------|---------|
| Draft / missing | Editor | Request review |
| Accepted / published | Editor | Request re-review |
| In review | Revisores | Approve, Reject |
| Superseded / archived | — | — |

**Runtime env (GitOps):**

- `BLUEFOX_ESCRIBANO_URL=http://outline-export-webhook.outline.svc:8080`
- `BLUEFOX_REVIEW_SECRET` = webhook `REVIEW_SECRET` (reuses `UTILS_SECRET`)

## Image

```text
ghcr.io/bluefoxsv/outline:0.82.0-bfN
```

```bash
docker build -t ghcr.io/bluefoxsv/outline:0.82.0-bf17 .
```

GitOps pin: `Platform/bluefox-gitops/platform/base/outline/deployment.yaml`

## Migrate existing TMP-002 tables

```bash
OUTLINE_URL=… OUTLINE_API_TOKEN=… DRY_RUN=1 \
  python3 Platform/bluefox-infra/scripts/outline-migrate-tmp002-to-meta.py
# then drop DRY_RUN; optional STRIP_TABLE=1 to remove tables from bodies
```
