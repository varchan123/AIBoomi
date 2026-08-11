import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ProposedAction } from "./agentTypes";

export type ApprovalPayload = {
  run_id: string;
  action_hash: string;
  nonce: string;
  expires_at: number;
};

function approvalSecret(override?: string) {
  const secret = override || process.env.AGENT_APPROVAL_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AGENT_APPROVAL_SECRET must be at least 32 characters");
  }
  return secret;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function actionHash(actions: ProposedAction[], secretOverride?: string) {
  return createHmac("sha256", approvalSecret(secretOverride))
    .update(canonicalJson(actions))
    .digest("base64url");
}

function sign(encodedPayload: string, secretOverride?: string) {
  return createHmac("sha256", approvalSecret(secretOverride))
    .update(encodedPayload)
    .digest("base64url");
}

export function createApprovalToken(args: {
  runId: string;
  actions: ProposedAction[];
  ttlSeconds?: number;
  now?: number;
  secret?: string;
}) {
  const payload: ApprovalPayload = {
    run_id: args.runId,
    action_hash: actionHash(args.actions, args.secret),
    nonce: randomBytes(18).toString("base64url"),
    expires_at: (args.now || Date.now()) + (args.ttlSeconds || 600) * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, args.secret)}`;
}

export function verifyApprovalToken(args: {
  token: string;
  actions: ProposedAction[];
  now?: number;
  secret?: string;
}) {
  const [encoded, suppliedSignature, extra] = args.token.split(".");
  if (!encoded || !suppliedSignature || extra) throw new Error("Invalid approval token");
  const expected = Buffer.from(sign(encoded, args.secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("Invalid approval token signature");
  }
  let payload: ApprovalPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid approval token payload");
  }
  if (!payload.run_id || !payload.nonce || !payload.action_hash || !payload.expires_at) {
    throw new Error("Invalid approval token payload");
  }
  if (payload.expires_at <= (args.now || Date.now())) throw new Error("Approval token expired");
  const expectedHash = actionHash(args.actions, args.secret);
  const expectedHashBytes = Buffer.from(expectedHash);
  const suppliedHashBytes = Buffer.from(payload.action_hash);
  if (expectedHashBytes.length !== suppliedHashBytes.length ||
      !timingSafeEqual(expectedHashBytes, suppliedHashBytes)) {
    throw new Error("Approved actions were modified");
  }
  return payload;
}

