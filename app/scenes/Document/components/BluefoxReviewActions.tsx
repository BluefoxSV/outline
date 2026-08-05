/**
 * Bluefox: native review actions that emit ChatOps slash commands as comments.
 * The in-cluster escribano webhook (outline-export-webhook) transcribes TMP-002.
 *
 * Visibility = TMP-002 Status × role (mirrors escribano):
 *   Draft / rejected / missing + can.update     → Request review
 *   In review + Outline group "Revisores"       → Approve + Reject
 *   Accepted (and terminal) / Lector            → hide
 *
 * After a command: drop the slash comment from the local store (server delete
 * races with comments.create WS) and refresh document.data so buttons flip
 * without a full page reload.
 */
import { observer } from "mobx-react";
import { CheckmarkIcon, CloseIcon, PadlockIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ProsemirrorData } from "@shared/types";
import Document from "~/models/Document";
import Comment from "~/models/Comment";
import User from "~/models/User";
import { Action } from "~/components/Actions";
import Button from "~/components/Button";
import Tooltip from "~/components/Tooltip";
import useCurrentUser from "~/hooks/useCurrentUser";
import usePolicy from "~/hooks/usePolicy";
import useStores from "~/hooks/useStores";

/** Same default as REVISORES_GROUP in outline_export_webhook.py */
export const REVISORES_GROUP_NAME = "Revisores";

type Props = {
  document: Document;
};

type PmNode = {
  type?: string;
  text?: string;
  content?: PmNode[];
};

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
 * Read Status from the first TMP-002-style table in document.data.
 * Returns normalized lowercase status without parenthetical qualifiers, or null.
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

const DECIDE_STATUSES = new Set(["in review"]);
const HIDDEN_STATUSES = new Set([
  "accepted",
  "approved",
  "published",
  "implemented",
  "superseded",
  "deprecated",
  "archived",
]);

export function reviewActionsForStatus(status: string | null): {
  showRequest: boolean;
  showDecide: boolean;
} {
  const s = (status || "").trim().toLowerCase();
  if (HIDDEN_STATUSES.has(s)) {
    return { showRequest: false, showDecide: false };
  }
  if (DECIDE_STATUSES.has(s)) {
    return { showRequest: false, showDecide: true };
  }
  // Draft, rejected, missing, or unknown → start / restart review
  return { showRequest: true, showDecide: false };
}

/** Current user is in Outline group Revisores (auth.info groupUsers). */
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

/**
 * Final button visibility: status gates ∧ role gates (escribano parity).
 * - Request: editor with update (+ comment)
 * - Decide: Revisores group (+ comment); not gated on can.update
 */
export function reviewActionsVisible(opts: {
  status: string | null;
  canUpdate: boolean;
  canComment: boolean;
  isRevisor: boolean;
}): { showRequest: boolean; showDecide: boolean } {
  const byStatus = reviewActionsForStatus(opts.status);
  if (!opts.canComment) {
    return { showRequest: false, showDecide: false };
  }
  return {
    showRequest: byStatus.showRequest && opts.canUpdate,
    showDecide: byStatus.showDecide && opts.isRevisor,
  };
}

function expectedStatusForCommand(command: string): string | null {
  const c = command.trim().split(/\s+/)[0]?.toLowerCase() || "";
  if (c === "/revision" || c === "/review") {
    return "in review";
  }
  if (c === "/aprobar" || c === "/approve") {
    return "accepted";
  }
  if (c === "/rechazar" || c === "/reject") {
    return "draft";
  }
  return null;
}

function pmCommand(text: string): ProsemirrorData {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function BluefoxReviewActions({ document }: Props) {
  const { t } = useTranslation();
  const { comments, documents, groups, groupUsers } = useStores();
  const user = useCurrentUser({ rejectOnEmpty: false });
  const can = usePolicy(document);
  const [busy, setBusy] = React.useState(false);
  /** Optimistic Status until documents.fetch catches escribano TMP-002 write. */
  const [statusOverride, setStatusOverride] = React.useState<string | null>(
    null
  );

  const liveStatus = getTmp002Status(document.data);
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
  const { showRequest, showDecide } = reviewActionsVisible({
    status,
    canUpdate: !!can.update,
    canComment: !!can.comment,
    isRevisor,
  });

  const postCommand = React.useCallback(
    async (command: string) => {
      if (!user || busy) {
        return;
      }
      setBusy(true);
      const data = pmCommand(command);
      const comment = new Comment(
        {
          createdAt: new Date().toISOString(),
          documentId: document.id,
          data,
          reactions: [],
        },
        comments
      );
      try {
        await comment.save({ documentId: document.id, data });
        // Do not leave ChatOps slash in the sidebar. Escribano deletes
        // server-side, but comments.create WS often re-adds *after* that
        // delete — keep scrubbing the id for a few seconds.
        const slashId = comment.id;
        if (slashId) {
          comments.remove(slashId);
        }

        const expected = expectedStatusForCommand(command);
        if (expected) {
          setStatusOverride(expected);
        }

        // Pull TMP-002 after escribano updates (no full page reload).
        for (let i = 0; i < 12; i++) {
          await sleep(700);
          if (slashId && comments.get(slashId)) {
            comments.remove(slashId);
          }
          try {
            await documents.fetch(document.id, { force: true });
          } catch {
            // ignore transient fetch errors while polling
          }
          const st = getTmp002Status(document.data);
          if (expected && st === expected) {
            setStatusOverride(null);
            break;
          }
        }
        if (slashId && comments.get(slashId)) {
          comments.remove(slashId);
        }

        toast.success(t("Review command sent"));
      } catch (err) {
        comment.isNew = true;
        if (comment.id) {
          try {
            comments.remove(comment.id);
          } catch {
            /* ignore */
          }
        }
        setStatusOverride(null);
        toast.error(t("Error creating comment"));
        // eslint-disable-next-line no-console
        console.error(err);
      } finally {
        setBusy(false);
      }
    },
    [busy, comments, document, documents, t, user]
  );

  const handleRequestReview = React.useCallback(() => {
    void postCommand("/revision");
  }, [postCommand]);

  const handleApprove = React.useCallback(() => {
    void postCommand("/aprobar");
  }, [postCommand]);

  const handleReject = React.useCallback(() => {
    const reason = window.prompt(
      t("Reason for rejection (required)"),
      ""
    );
    if (reason === null) {
      return;
    }
    const trimmed = reason.trim();
    if (!trimmed) {
      toast.error(t("Reason for rejection (required)"));
      return;
    }
    void postCommand(`/rechazar ${trimmed}`);
  }, [postCommand, t]);

  if (document.isTemplate || document.isDeleted) {
    return null;
  }
  if (!showRequest && !showDecide) {
    return null;
  }

  return (
    <>
      {showRequest && (
        <Action>
          <Tooltip content={t("Request review")} placement="bottom">
            <Button
              onClick={handleRequestReview}
              disabled={busy}
              icon={<PadlockIcon />}
              neutral
            >
              {t("Request review")}
            </Button>
          </Tooltip>
        </Action>
      )}
      {showDecide && (
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

export default observer(BluefoxReviewActions);
