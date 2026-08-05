/**
 * Bluefox: native TMP-002 review + bluefoxMeta (internal document metadata).
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
import type { BluefoxMeta } from "@shared/types";

const router = new Router();

const COMMANDS = [
  "revision",
  "review",
  "aprobar",
  "approve",
  "rechazar",
  "reject",
] as const;

function normalizeStatus(status: string | undefined | null): string {
  return (status || "").trim().toLowerCase().split("(", 1)[0].trim();
}

function statusForCommand(command: string): Partial<BluefoxMeta> {
  const c = command.trim().toLowerCase().replace(/^\//, "");
  const today = new Date().toISOString().slice(0, 10);
  if (c === "revision" || c === "review") {
    return { status: "In review" };
  }
  if (c === "aprobar" || c === "approve") {
    return { status: "Accepted", approvedAt: today };
  }
  if (c === "rechazar" || c === "reject") {
    return { status: "Draft" };
  }
  return {};
}

function mergeBluefoxMeta(
  current: BluefoxMeta | null | undefined,
  patch: Partial<BluefoxMeta>
): BluefoxMeta {
  const next: BluefoxMeta = { ...(current || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      continue;
    }
    (next as Record<string, string>)[k] = String(v);
  }
  return next;
}

router.post(
  "bluefox.meta.update",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  async (ctx: APIContext) => {
    const { user } = ctx.state.auth;
    const body = (ctx.request.body || {}) as Record<string, unknown>;
    const documentId = String(body.id || body.documentId || "");
    assertPresent(documentId, "id is required");

    const document = await Document.findByPk(documentId, {
      userId: user.id,
      rejectOnEmpty: true,
    });
    authorize(user, "update", document);

    const patch = (body.meta ||
      body.bluefoxMeta ||
      {}) as Record<string, unknown>;
    const allowed: (keyof BluefoxMeta)[] = [
      "id",
      "title",
      "status",
      "version",
      "layer",
      "mkdocsPath",
      "audience",
      "owner",
      "approvedBy",
      "approvedAt",
      "discussionUntil",
      "implementBy",
    ];
    const clean: Partial<BluefoxMeta> = {};
    for (const key of allowed) {
      if (patch[key] !== undefined && patch[key] !== null) {
        clean[key] = String(patch[key]);
      }
    }
    // Map snake / TMP-002 export keys
    const aliases: Record<string, keyof BluefoxMeta> = {
      ID: "id",
      Status: "status",
      "MkDocs Path": "mkdocsPath",
      MKDOCS_PATH: "mkdocsPath",
      ESTADO: "status",
      Layer: "layer",
      Audience: "audience",
      Owner: "owner",
      "Approved By": "approvedBy",
      "Approved At": "approvedAt",
      Version: "version",
      Title: "title",
    };
    for (const [from, to] of Object.entries(aliases)) {
      if (patch[from] !== undefined && patch[from] !== null && !clean[to]) {
        clean[to] = String(patch[from]);
      }
    }

    document.bluefoxMeta = mergeBluefoxMeta(document.bluefoxMeta, clean);
    await document.save({ hooks: false });

    ctx.body = {
      data: {
        document: await presentDocument(ctx, document),
        bluefoxMeta: document.bluefoxMeta,
      },
      policies: presentPolicies(user, [document]),
    };
  }
);

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
          authorName: user.name,
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

    // Persist Status in bluefoxMeta (SoT for UI / export); escribano may still
    // sync the legacy TMP-002 table when present.
    const patch = statusForCommand(command);
    if (command === "aprobar" || command === "approve") {
      patch.approvedBy = user.name;
    }
    if (remote.status) {
      const rs = normalizeStatus(remote.status);
      if (rs === "in review") {
        patch.status = "In review";
      } else if (rs === "accepted") {
        patch.status = "Accepted";
      } else if (rs === "draft") {
        patch.status = "Draft";
      }
    }
    document.bluefoxMeta = mergeBluefoxMeta(document.bluefoxMeta, patch);
    await document.save({ hooks: false });

    const fresh = await Document.findByPk(documentId, {
      userId: user.id,
      rejectOnEmpty: true,
    });

    ctx.body = {
      data: {
        document: await presentDocument(ctx, fresh),
        status: normalizeStatus(
          fresh.bluefoxMeta?.status || remote.status || patch.status
        ),
        message: remote.message,
        bluefoxMeta: fresh.bluefoxMeta,
      },
      policies: presentPolicies(user, [fresh]),
    };
  }
);

export default router;
