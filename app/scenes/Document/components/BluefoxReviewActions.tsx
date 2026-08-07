/**
 * Bluefox: review actions + Status chip from documents.bluefoxMeta.
 * TMP-002 body table is hidden in the editor (BluefoxHideTmp002).
 */
import { observer } from "mobx-react";
import { CheckmarkIcon, CloseIcon, PadlockIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled, { createGlobalStyle } from "styled-components";
import type { BluefoxMeta, ProsemirrorData } from "@shared/types";
import { bluefoxContentFingerprint } from "@shared/utils/bluefoxContentFingerprint";
import Document from "~/models/Document";
import User from "~/models/User";
import { Action } from "~/components/Actions";
import Button from "~/components/Button";
import Tooltip from "~/components/Tooltip";
import useCurrentUser from "~/hooks/useCurrentUser";
import usePolicy from "~/hooks/usePolicy";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";

/** Same default as REVISORES_GROUP in outline_export_webhook.py */
export const REVISORES_GROUP_NAME = "Revisores";

type Props = {
  document: Document;
  /** True when separate-edit mode has the editor open (not read view). */
  isEditing?: boolean;
  /** Unsaved editor body vs last persisted document.data */
  isEditorDirty?: boolean;
};

type PmNode = {
  type?: string;
  text?: string;
  content?: PmNode[];
};

const Tmp002HideStyles = createGlobalStyle`
  .ProseMirror .bluefox-tmp002-hidden {
    display: none !important;
  }
`;

/** Flatten ProseMirror JSON text (no schema required). */
export function pmNodeText(node: PmNode | undefined | null): string {
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.text || "";
  }
  return (node.content || []).map(pmNodeText).join("");
}

function findFirstTable(node: PmNode | undefined | null): PmNode | null {
  if (!node) {
    return null;
  }
  if (node.type === "table") {
    return node;
  }
  for (const child of node.content || []) {
    const hit = findFirstTable(child);
    if (hit) {
      return hit;
    }
  }
  return null;
}

/**
 * Read Status from the first TMP-002-style table in document.data (legacy).
 */
export function getTmp002Status(
  data: ProsemirrorData | undefined | null
): string | null {
  const table = findFirstTable(data as PmNode);
  if (!table?.content) {
    return null;
  }
  for (const row of table.content) {
    if (row.type !== "table_row" && row.type !== "tr") {
      continue;
    }
    const cells = (row.content || []).map((cell) =>
      pmNodeText(cell).replace(/`/g, "").trim()
    );
    if (cells.length < 2) {
      continue;
    }
    if (cells[0].toLowerCase() === "status") {
      const raw = cells[1].split("(", 1)[0].trim().toLowerCase();
      return raw || null;
    }
  }
  return null;
}

export function getBluefoxStatus(document: Document): string | null {
  const fromMeta = (document.bluefoxMeta?.status || "")
    .split("(", 1)[0]
    .trim()
    .toLowerCase();
  if (fromMeta) {
    return fromMeta;
  }
  const fromTable = getTmp002Status(document.data);
  if (fromTable) {
    return fromTable;
  }
  // New docs / missing meta: treat as Draft for chip + review actions.
  return "draft";
}

const DECIDE_STATUSES = new Set(["in review"]);
const RETIRED_STATUSES = new Set([
  "superseded",
  "deprecated",
  "archived",
]);
const REREVIEW_STATUSES = new Set([
  "accepted",
  "approved",
  "published",
  "implemented",
]);

export function reviewActionsForStatus(status: string | null): {
  showRequest: boolean;
  showDecide: boolean;
  isRereview: boolean;
} {
  const s = (status || "").trim().toLowerCase();
  if (RETIRED_STATUSES.has(s)) {
    return { showRequest: false, showDecide: false, isRereview: false };
  }
  if (DECIDE_STATUSES.has(s)) {
    return { showRequest: false, showDecide: true, isRereview: false };
  }
  if (REREVIEW_STATUSES.has(s)) {
    // Caller must gate showRequest on content changed since approve.
    return { showRequest: true, showDecide: false, isRereview: true };
  }
  return { showRequest: true, showDecide: false, isRereview: false };
}

/** True when Accepted content diverged (local edits or hash mismatch). */
export function contentChangedSinceApprove(
  document: Document,
  isEditorDirty = false
): boolean {
  if (isEditorDirty || document.isDirty()) {
    return true;
  }
  const approved = document.bluefoxMeta?.approvedContentHash;
  if (!approved) {
    // No snapshot yet — do not invent "changed" (that hid/broke approve UX).
    return false;
  }
  const current = bluefoxContentFingerprint({
    title: document.title,
    data: document.data,
  });
  return current !== approved;
}

/**
 * Demote Accepted → Draft only when the author is actively editing and the
 * editor is dirty.
 *
 * Never demote on hash mismatch alone (server vs client JSON differ after
 * approve). Never demote in read view: after /aprobar the escribano may
 * rewrite the legacy TMP-002 table (documents.update); collaborative sync
 * then marks isEditorDirty=true even though the user did not type — that
 * falsely flipped Status back to Draft on bf12.
 */
export function shouldDemoteAccepted(
  _document: Document,
  isEditorDirty = false,
  isEditing = false
): boolean {
  return isEditing && isEditorDirty;
}

export function userIsRevisor(
  user: User | undefined | null,
  groups: { get: (id: string) => { name?: string } | undefined },
  groupUsers: { orderedData: { userId: string; groupId: string }[] }
): boolean {
  if (!user) {
    return false;
  }
  const needle = REVISORES_GROUP_NAME.toLowerCase();
  return groupUsers.orderedData.some((gu) => {
    if (gu.userId !== user.id) {
      return false;
    }
    const name = (groups.get(gu.groupId)?.name || "").toLowerCase();
    return name === needle;
  });
}

export function reviewActionsVisible(opts: {
  status: string | null;
  canUpdate: boolean;
  canComment: boolean;
  isRevisor: boolean;
  /** When status is Accepted-like, require content change for re-review. */
  contentChanged?: boolean;
}): { showRequest: boolean; showDecide: boolean; isRereview: boolean } {
  const byStatus = reviewActionsForStatus(opts.status);
  if (!opts.canComment) {
    return { showRequest: false, showDecide: false, isRereview: false };
  }
  let showRequest = byStatus.showRequest && opts.canUpdate;
  if (showRequest && byStatus.isRereview && opts.contentChanged === false) {
    showRequest = false;
  }
  return {
    showRequest,
    showDecide: byStatus.showDecide && opts.isRevisor,
    isRereview: byStatus.isRereview,
  };
}

function expectedStatusForCommand(command: string): string | null {
  const c =
    command.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() || "";
  if (c === "revision" || c === "review") {
    return "in review";
  }
  if (c === "aprobar" || c === "approve") {
    return "accepted";
  }
  if (c === "rechazar" || c === "reject") {
    return "draft";
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayStatusLabel(status: string | null): string {
  if (!status) {
    return "—";
  }
  const s = status.trim().toLowerCase();
  if (s === "in review") {
    return "In review";
  }
  if (s === "accepted") {
    return "Accepted";
  }
  if (s === "draft") {
    return "Draft";
  }
  return status
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function BluefoxReviewActions({
  document,
  isEditing = false,
  isEditorDirty = false,
}: Props) {
  const { t } = useTranslation();
  const { documents, groups, groupUsers } = useStores();
  const user = useCurrentUser({ rejectOnEmpty: false });
  const can = usePolicy(document);
  const [busy, setBusy] = React.useState(false);
  const [statusOverride, setStatusOverride] = React.useState<string | null>(
    null
  );
  /** Skip demote after approve while escribano/table sync settles. */
  const demoteGraceUntil = React.useRef(0);

  const liveStatus = getBluefoxStatus(document);
  React.useEffect(() => {
    if (
      statusOverride &&
      liveStatus &&
      liveStatus === statusOverride.toLowerCase()
    ) {
      setStatusOverride(null);
    }
  }, [liveStatus, statusOverride]);

  const status = statusOverride || liveStatus;
  const isRevisor = userIsRevisor(user, groups, groupUsers);
  const contentChanged = contentChangedSinceApprove(document, isEditorDirty);
  const { showRequest, showDecide, isRereview } = reviewActionsVisible({
    status,
    canUpdate: !!can.update,
    canComment: !!can.comment,
    isRevisor,
    contentChanged,
  });

  // Separate-edit mode: review buttons only in read view (after "Done editing").
  // Always-edit teams (!separateEditMode) keep buttons available while typing.
  const separateEdit = !!user?.separateEditMode;
  const reviewBlockedByEdit = separateEdit && isEditing;
  const showRequestBtn = showRequest && !reviewBlockedByEdit;
  const showDecideBtn = showDecide && !reviewBlockedByEdit;

  // Accepted + typing in editor → demote to Draft (export gate + Request review).
  const demoteLock = React.useRef(false);
  React.useEffect(() => {
    const s = (status || "").trim().toLowerCase();
    if (!REREVIEW_STATUSES.has(s)) {
      demoteLock.current = false;
      return;
    }
    if (Date.now() < demoteGraceUntil.current) {
      return;
    }
    // Always-edit mode: treat as editing so dirty still demotes.
    const editingForDemote = isEditing || !separateEdit;
    if (
      !can.update ||
      !shouldDemoteAccepted(document, isEditorDirty, editingForDemote)
    ) {
      return;
    }
    if (demoteLock.current || busy) {
      return;
    }
    demoteLock.current = true;
    setStatusOverride("draft");
    void (async () => {
      try {
        const res = await client.post("/bluefox.meta.update", {
          id: document.id,
          meta: {
            status: "Draft",
            approvedBy: "",
            approvedAt: "",
            approvedContentHash: "",
          },
        });
        const meta = res?.data?.bluefoxMeta as BluefoxMeta | undefined;
        if (meta) {
          document.bluefoxMeta = {
            ...meta,
            status: "Draft",
            approvedBy: "",
            approvedAt: "",
            approvedContentHash: "",
          };
        } else {
          document.bluefoxMeta = {
            ...(document.bluefoxMeta || {}),
            status: "Draft",
            approvedBy: "",
            approvedAt: "",
            approvedContentHash: "",
          };
        }
      } catch {
        demoteLock.current = false;
        setStatusOverride(null);
      }
    })();
  }, [busy, can.update, document, isEditing, isEditorDirty, separateEdit, status]);

  const postCommand = React.useCallback(
    async (command: string, reason = "") => {
      if (!user || busy) {
        return;
      }
      setBusy(true);
      const cmd = command.trim().replace(/^\//, "");
      const expected = expectedStatusForCommand(cmd);
      try {
        // Persist title/body before review so a later refresh cannot clobber
        // unsaved editor state (editors lose trust when titles snap back).
        if (isEditorDirty || isEditing) {
          try {
            await document.save(undefined, {
              done: !isEditing,
              autosave: false,
            });
          } catch (err) {
            toast.error(
              err instanceof Error && err.message
                ? err.message
                : t("Error applying review")
            );
            // eslint-disable-next-line no-console
            console.error(err);
            return;
          }
        }

        const res = await client.post("/bluefox.review", {
          id: document.id,
          command: cmd,
          reason,
        });
        const meta = res?.data?.bluefoxMeta as BluefoxMeta | undefined;
        if (meta) {
          document.bluefoxMeta = {
            ...meta,
            // Keep visible Outline title as meta SoT (never restore stale Title).
            title: document.title || meta.title,
          };
        }
        if (
          (cmd === "aprobar" || cmd === "approve") &&
          document.bluefoxMeta
        ) {
          demoteGraceUntil.current = Date.now() + 20_000;
          const hash = bluefoxContentFingerprint({
            title: document.title,
            data: document.data,
          });
          document.bluefoxMeta = {
            ...document.bluefoxMeta,
            approvedContentHash: hash,
            title: document.title,
          };
          try {
            await client.post("/bluefox.meta.update", {
              id: document.id,
              meta: {
                approvedContentHash: hash,
                title: document.title,
              },
            });
          } catch {
            /* non-fatal */
          }
        } else if (document.title) {
          try {
            await client.post("/bluefox.meta.update", {
              id: document.id,
              meta: { title: document.title },
            });
          } catch {
            /* non-fatal */
          }
        }
        const remoteStatus =
          (res?.data?.status as string | undefined)?.toLowerCase() || expected;
        if (remoteStatus) {
          setStatusOverride(remoteStatus);
        }
        // Never force-refetch over an open/dirty editor — that reverts title/body.
        if (!isEditing && !isEditorDirty) {
          for (let i = 0; i < 10; i++) {
            try {
              await documents.fetch(document.id, { force: true });
            } catch {
              /* ignore */
            }
            const st = getBluefoxStatus(document);
            if (remoteStatus && st === remoteStatus) {
              setStatusOverride(null);
              break;
            }
            await sleep(500);
          }
        }
        toast.success(t("Review applied"));
      } catch (err) {
        setStatusOverride(null);
        const detail =
          err &&
          typeof err === "object" &&
          "message" in err &&
          typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : "";
        toast.error(
          detail && detail.length < 200
            ? detail
            : t("Error applying review")
        );
        // eslint-disable-next-line no-console
        console.error(err);
      } finally {
        setBusy(false);
      }
    },
    [busy, document, documents, isEditing, isEditorDirty, t, user]
  );

  const handleRequestReview = React.useCallback(() => {
    void postCommand("revision");
  }, [postCommand]);

  const handleApprove = React.useCallback(() => {
    void postCommand("aprobar");
  }, [postCommand]);

  const handleReject = React.useCallback(() => {
    const reason = window.prompt(t("Reason for rejection (required)"), "");
    if (reason === null) {
      return;
    }
    const trimmed = reason.trim();
    if (!trimmed) {
      toast.error(t("Reason for rejection (required)"));
      return;
    }
    void postCommand("rechazar", trimmed);
  }, [postCommand, t]);

  if (document.isTemplate || document.isDeleted) {
    return null;
  }

  const requestLabel = isRereview
    ? t("Request re-review")
    : t("Request review");
  // Always show Status chip (defaults to Draft via getBluefoxStatus).
  const showChip = true;

  if (!showRequestBtn && !showDecideBtn && !showChip) {
    return null;
  }

  return (
    <>
      <Tmp002HideStyles />
      {showChip && (
        <Action>
          <StatusChip title={document.bluefoxMeta?.mkdocsPath || undefined}>
            {t("Status")}: {displayStatusLabel(status)}
          </StatusChip>
        </Action>
      )}
      {showRequestBtn && (
        <Action>
          <Tooltip content={requestLabel} placement="bottom">
            <Button
              onClick={handleRequestReview}
              disabled={busy}
              icon={<PadlockIcon />}
              neutral
            >
              {requestLabel}
            </Button>
          </Tooltip>
        </Action>
      )}
      {showDecideBtn && (
        <>
          <Action>
            <Tooltip content={t("Approve document")} placement="bottom">
              <Button
                onClick={handleApprove}
                disabled={busy}
                icon={<CheckmarkIcon />}
                neutral
              >
                {t("Approve")}
              </Button>
            </Tooltip>
          </Action>
          <Action>
            <Tooltip content={t("Reject document")} placement="bottom">
              <Button
                onClick={handleReject}
                disabled={busy}
                icon={<CloseIcon />}
                neutral
              >
                {t("Reject")}
              </Button>
            </Tooltip>
          </Action>
        </>
      )}
    </>
  );
}

const StatusChip = styled.span`
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 4px;
  color: ${(props) => props.theme.textSecondary};
  background: ${(props) => props.theme.backgroundSecondary};
  white-space: nowrap;
`;

export default observer(BluefoxReviewActions);
