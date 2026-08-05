/**
 * Bluefox: native review actions via server RPC → escribano (no ChatOps comment).
 * Visibility = TMP-002 Status × role (mirrors escribano).
 */
import { observer } from "mobx-react";
import { CheckmarkIcon, CloseIcon, PadlockIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ProsemirrorData } from "@shared/types";
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
  return { showRequest: true, showDecide: false };
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

function BluefoxReviewActions({ document }: Props) {
  const { t } = useTranslation();
  const { documents, groups, groupUsers } = useStores();
  const user = useCurrentUser({ rejectOnEmpty: false });
  const can = usePolicy(document);
  const [busy, setBusy] = React.useState(false);
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
    async (command: string, reason = "") => {
      if (!user || busy) {
        return;
      }
      setBusy(true);
      const cmd = command.trim().replace(/^\//, "");
      const expected = expectedStatusForCommand(cmd);
      if (expected) {
        setStatusOverride(expected);
      }
      try {
        await client.post("/bluefox.review", {
          id: document.id,
          command: cmd,
          reason,
        });
        for (let i = 0; i < 8; i++) {
          try {
            await documents.fetch(document.id, { force: true });
          } catch {
            /* ignore */
          }
          const st = getTmp002Status(document.data);
          if (expected && st === expected) {
            setStatusOverride(null);
            break;
          }
          await sleep(400);
        }
        toast.success(t("Review applied"));
      } catch (err) {
        setStatusOverride(null);
        toast.error(t("Error applying review"));
        // eslint-disable-next-line no-console
        console.error(err);
      } finally {
        setBusy(false);
      }
    },
    [busy, document, documents, t, user]
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
