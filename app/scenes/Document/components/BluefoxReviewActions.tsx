/**
 * Bluefox: native review actions that emit ChatOps slash commands as comments.
 * The in-cluster escribano webhook (outline-export-webhook) transcribes TMP-002.
 */
import { observer } from "mobx-react";
import { CheckmarkIcon, CloseIcon, PadlockIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ProsemirrorData } from "@shared/types";
import Document from "~/models/Document";
import Comment from "~/models/Comment";
import { Action } from "~/components/Actions";
import Button from "~/components/Button";
import Tooltip from "~/components/Tooltip";
import useCurrentUser from "~/hooks/useCurrentUser";
import usePolicy from "~/hooks/usePolicy";
import useStores from "~/hooks/useStores";

type Props = {
  document: Document;
};

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

function BluefoxReviewActions({ document }: Props) {
  const { t } = useTranslation();
  const { comments } = useStores();
  const user = useCurrentUser({ rejectOnEmpty: false });
  const can = usePolicy(document);
  const [busy, setBusy] = React.useState(false);

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
        comment.isNew = false;
        comment.createdById = user.id;
        comment.createdBy = user;
        toast.success(t("Review command sent"));
      } catch (err) {
        comment.isNew = true;
        toast.error(t("Error creating comment"));
        // eslint-disable-next-line no-console
        console.error(err);
      } finally {
        setBusy(false);
      }
    },
    [busy, comments, document.id, t, user]
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

  if (!can.update || document.isTemplate || document.isDeleted) {
    return null;
  }

  return (
    <>
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
  );
}

export default observer(BluefoxReviewActions);
