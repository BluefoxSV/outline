/**
 * Bluefox: native TMP-002 review actions without ChatOps comments.
 * Proxies to in-cluster escribano POST /review.
 */
import Router from "koa-router";
import { InvalidRequestError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import { Document } from "@server/models";
import { authorize } from "@server/policies";
import { presentDocument, presentPolicies } from "@server/presenters";
import { APIContext } from "@server/types";
import fetch from "@server/utils/fetch";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { assertPresent, assertIn } from "@server/validation";

const router = new Router();

const COMMANDS = [
  "revision",
  "review",
  "aprobar",
  "approve",
  "rechazar",
  "reject",
] as const;

router.post(
  "bluefox.review",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  async (ctx: APIContext) => {
    const { user } = ctx.state.auth;
    const body = (ctx.request.body || {}) as Record<string, unknown>;
    const documentId = String(body.id || body.documentId || "");
    const command = String(body.command || "")
      .trim()
      .toLowerCase()
      .replace(/^\//, "");
    const reason = String(body.reason || "");

    assertPresent(documentId, "id is required");
    assertIn(command, [...COMMANDS]);

    const document = await Document.findByPk(documentId, {
      userId: user.id,
    });
    authorize(user, "read", document);
    if (command === "revision" || command === "review") {
      authorize(user, "update", document);
    }
    authorize(user, "comment", document);

    const escribanoUrl = (
      process.env.BLUEFOX_ESCRIBANO_URL || ""
    ).replace(/\/$/, "");
    const secret =
      process.env.BLUEFOX_REVIEW_SECRET || process.env.UTILS_SECRET || "";

    if (!escribanoUrl || !secret) {
      throw InvalidRequestError(
        "Bluefox review bridge is not configured (BLUEFOX_ESCRIBANO_URL / secret)"
      );
    }

    let remote: {
      ok?: boolean;
      status?: string;
      error?: string;
      message?: string;
    };
    try {
      const res = await fetch(`${escribanoUrl}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bluefox-Review-Secret": secret,
        },
        body: JSON.stringify({
          documentId,
          command,
          authorId: user.id,
          reason,
        }),
      });
      remote = (await res.json()) as typeof remote;
      if (!res.ok || !remote.ok) {
        throw InvalidRequestError(
          remote.error || `Escribano review failed (${res.status})`
        );
      }
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status?: number }).status === 400
      ) {
        throw err;
      }
      Logger.error("bluefox.review escribano call failed", err as Error);
      throw InvalidRequestError(
        err instanceof Error ? err.message : "Escribano unreachable"
      );
    }

    const fresh = await Document.findByPk(documentId, {
      userId: user.id,
      rejectOnEmpty: true,
    });

    ctx.body = {
      data: {
        document: presentDocument(ctx, fresh),
        status: remote.status,
        message: remote.message,
      },
      policies: presentPolicies(user, [fresh]),
    };
  }
);

export default router;
