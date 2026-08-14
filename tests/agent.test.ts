import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import twilio from "twilio";
import IncidentAgent, { canSubmitClosure, conversationLabel, deliveryLabel, latestInboundEvent, workflowLabel } from "../components/IncidentAgent";
import TriageResult from "../components/TriageResult";
import PlantQA, { appendChatMessage } from "../components/PlantQA";
import WorkerPage from "../app/worker/page";
import { getAgentActivity, setAgentActivityDatabaseForTests } from "../lib/agentActivity";
import { fetchAgentActivity, mergeActivityEvents } from "../lib/agentActivityTypes";
import { actionHash, createApprovalToken, verifyApprovalToken } from "../lib/approvalTokens";
import { executeReadOnlyTool } from "../lib/agentTools";
import { assertSafeRequestedAction, constrainRequestedAction, investigateIncident, MAX_AGENT_ROUNDS, SynthesisInvalidJsonError } from "../lib/agentRunner";
import { ActiveConversationConflictError, assertConversationAvailable, executeApprovedProposal, setAgentStoreDatabaseForTests } from "../lib/agentStore";
import type { ProposedAction } from "../lib/agentTypes";
import { interpretTechnicianReply } from "../lib/replyInterpreter";
import { proposedActionsSchema, speechSynthesizeInput } from "../lib/validation";
import { validateTwilioWebhook } from "../lib/whatsapp";
import { frontendErrorMessage } from "../lib/frontendErrors";
import { closeWorkOrder, setWorkOrderClosureDatabaseForTests, WorkOrderClosureError } from "../lib/workOrderClosure";
import { buildBulbulV3Request, buildSaarasUpload, buildSaarasV3Request, callSaarasV3, sarvamErrorDiagnostic, setSarvamProviderForTests } from "../lib/sarvam";
import { buildIncidentSpeechText, mapUiLanguageToBulbul, MAX_BULBUL_TEXT_LENGTH, speechLanguageOptions } from "../lib/speech";
import { POST as synthesizeSpeech } from "../app/api/speech/synthesize/route";
import { normalizeAudioMimeType, prepareRecordingFile, selectRecorderMimeType } from "../lib/audioRecording";
import { POST as transcribeSpeech } from "../app/api/speech/transcribe/route";

const secret = "test-secret-that-is-deliberately-longer-than-thirty-two-characters";
const actions: ProposedAction[] = [
  { type: "create_open_incident", arguments: {
    incident_id: "INC-AGENT-ABCDEFGH", machine_id: "R-101", operator_description: "Temperature is rising rapidly",
    severity: "High", status: "Open",
  } },
  { type: "create_maintenance_work_order", arguments: {
    work_order_id: "WO-AGENT-ABCDEFGH", incident_id: "INC-AGENT-ABCDEFGH", machine_id: "R-101",
    maintenance_type: "Inspection", requested_action: "Inspect cooling-water valve response", status: "Assigned",
  } },
  { type: "send_whatsapp_escalation", arguments: {
    incident_id: "INC-AGENT-ABCDEFGH", work_order_id: "WO-AGENT-ABCDEFGH",
    contact_id: "maintenance_primary", message_body: "Approved exact maintenance escalation message",
  } },
];

test("approval token accepts exact actions and rejects mutation, expiry, and run substitution", () => {
  const now = 1_800_000_000_000;
  const token = createApprovalToken({ runId: "RUN-ABCDEFGH", actions, now, ttlSeconds: 60, secret });
  assert.equal(verifyApprovalToken({ token, actions, now: now + 1, secret }).run_id, "RUN-ABCDEFGH");
  const mutated = structuredClone(actions) as any;
  mutated[0].arguments.machine_id = "E-201";
  assert.throws(() => verifyApprovalToken({ token, actions: mutated, now: now + 1, secret }), /modified/);
  assert.throws(() => verifyApprovalToken({ token, actions, now: now + 61_000, secret }), /expired/);
  assert.notEqual(actionHash(actions, secret), actionHash(mutated, secret));
});

test("approved action schema rejects model-supplied phone numbers and cross-work-order mutation", () => {
  assert.equal(proposedActionsSchema.safeParse(actions).success, true);
  const withPhone = structuredClone(actions) as any;
  withPhone[2].arguments.phone = "whatsapp:+919999999999";
  assert.equal(proposedActionsSchema.safeParse(withPhone).success, false);
  const wrongWorkOrder = structuredClone(actions) as any;
  wrongWorkOrder[2].arguments.work_order_id = "WO-AGENT-ZZZZZZZZ";
  assert.equal(proposedActionsSchema.safeParse(wrongWorkOrder).success, false);
});

test("active conversation conflict is detected before any database mutation or WhatsApp send", async () => {
  let mutationCount = 0;
  let sendCount = 0;
  const query: any = {
    select: () => query,
    eq: () => query,
    in: () => query,
    maybeSingle: async () => ({
      data: { conversation_id: 7, work_order_id: "WO-AGENT-OLDERDEMO", status: "active" },
      error: null,
    }),
    insert: () => { mutationCount += 1; return query; },
    update: () => { mutationCount += 1; return query; },
    upsert: () => { mutationCount += 1; return query; },
    delete: () => { mutationCount += 1; return query; },
  };
  const database: any = { from: () => query };
  const previous = {
    account: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_WHATSAPP_FROM,
    contact: process.env.MAINTENANCE_WHATSAPP_TO,
    approvalSecret: process.env.AGENT_APPROVAL_SECRET,
  };
  process.env.TWILIO_ACCOUNT_SID = "AC-test";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+910000000001";
  process.env.MAINTENANCE_WHATSAPP_TO = "whatsapp:+910000000002";
  process.env.AGENT_APPROVAL_SECRET = secret;
  setAgentStoreDatabaseForTests(database);
  try {
    await assert.rejects(
      () => executeApprovedProposal({
        runId: "RUN-CONFLICT",
        payload: { run_id: "RUN-CONFLICT", action_hash: "hash", nonce: "nonce", expires_at: Date.now() + 60_000 },
        actions,
        send: async () => {
          sendCount += 1;
          return { message_sid: "SM-UNEXPECTED", delivery_status: "queued", channel: "whatsapp" as const };
        },
      }),
      (error: unknown) => error instanceof ActiveConversationConflictError
        && error.statusCode === 409
        && error.existingWorkOrderId === "WO-AGENT-OLDERDEMO",
    );
    assert.equal(mutationCount, 0);
    assert.equal(sendCount, 0);

    const runId = "RUN-CONFLICTHTTP";
    const approvalToken = createApprovalToken({ runId, actions, secret });
    const { POST } = await import("../app/api/agent/execute/route");
    const response = await POST(new Request("http://localhost/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, approval_token: approvalToken, proposed_actions: actions }),
    }));
    const responseBody = await response.json();
    assert.equal(response.status, 409);
    assert.equal(responseBody.code, "ACTIVE_CONVERSATION_CONFLICT");
    assert.equal(responseBody.existing_work_order_id, "WO-AGENT-OLDERDEMO");
    assert.match(responseBody.error, /WO-AGENT-OLDERDEMO/);
    assert.equal(mutationCount, 0);
    assert.equal(sendCount, 0);
  } finally {
    setAgentStoreDatabaseForTests();
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    };
    restore("TWILIO_ACCOUNT_SID", previous.account);
    restore("TWILIO_AUTH_TOKEN", previous.token);
    restore("TWILIO_WHATSAPP_FROM", previous.from);
    restore("MAINTENANCE_WHATSAPP_TO", previous.contact);
    restore("AGENT_APPROVAL_SECRET", previous.approvalSecret);
  }
});

test("activity API returns a redacted, deduplicated chronological timeline", async () => {
  const fullPhone = "whatsapp:+919876543210";
  const results: Record<string, any> = {
    external_conversations: { data: {
      conversation_id: 42, work_order_id: "WO-AGENT-ACTIVITY", status: "active",
      external_user: fullPhone, created_at: "2026-08-12T10:00:00.000Z", updated_at: "2026-08-12T10:04:00.000Z",
    }, error: null },
    maintenance_actions: { data: { work_order_id: "WO-AGENT-ACTIVITY", status: "In Progress" }, error: null },
    work_order_closure_audit: { data: null, error: null },
    agent_actions: { data: [
      { action_id: 1, input_json: { message_body: "Please inspect the cooling loop", phone: fullPhone },
        output_json: { delivery_status: "delivered", provider_payload: "must-not-leak" }, status: "completed",
        external_message_sid: "SMOUTBOUND", created_at: "2026-08-12T10:01:00.000Z" },
      { action_id: 2, input_json: { message_body: "duplicate" }, output_json: { delivery_status: "read" },
        status: "completed", external_message_sid: "SMOUTBOUND", created_at: "2026-08-12T10:02:00.000Z" },
    ], error: null },
    inbound_messages: { data: [{ message_sid: "SMINBOUND", sender: fullPhone, body: "Started inspection",
      voice_transcript: null, classification_json: { status_update: "In Progress", root_cause_claim: "private draft" },
      processing_status: "applied", received_at: "2026-08-12T10:03:00.000Z", processed_at: "2026-08-12T10:03:01.000Z" }], error: null },
  };
  const database: any = {
    from(table: string) {
      const query: any = {
        select: () => query, eq: () => query, in: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => results[table],
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(results[table]).then(resolve, reject),
      };
      return query;
    },
  };
  const previousContact = process.env.MAINTENANCE_WHATSAPP_TO;
  process.env.MAINTENANCE_WHATSAPP_TO = fullPhone;
  setAgentActivityDatabaseForTests(database);
  try {
    const { GET } = await import("../app/api/agent/activity/route");
    const response = await GET(new Request("http://localhost/api/agent/activity?work_order_id=WO-AGENT-ACTIVITY"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.equal(body.work_order_id, "WO-AGENT-ACTIVITY");
    assert.equal(body.workflow_status, "In Progress");
    assert.equal(body.conversation_status, "active");
    assert.equal(body.events.length, 2);
    assert.deepEqual(body.events.map((event: any) => event.message_id), ["SMOUTBOUND", "SMINBOUND"]);
    assert.equal(body.events[0].direction, "outbound");
    assert.equal(body.events[0].delivery_status, "delivered");
    assert.equal(body.events[1].interpreted_status, "In Progress");
    assert.equal(body.events[1].masked_party, "WhatsApp ending 3210");
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(fullPhone), false);
    assert.equal(serialized.includes("must-not-leak"), false);
    assert.equal(serialized.includes("private draft"), true);

    const restored = await GET(new Request("http://localhost/api/agent/activity"));
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).work_order_id, "WO-AGENT-ACTIVITY");
  } finally {
    setAgentActivityDatabaseForTests();
    if (previousContact === undefined) delete process.env.MAINTENANCE_WHATSAPP_TO;
    else process.env.MAINTENANCE_WHATSAPP_TO = previousContact;
  }
});

test("activity client uses no-store and component renders separate activity states", async () => {
  let requestedUrl = "";
  let requestedCache: RequestCache | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedCache = init?.cache;
    return new Response(JSON.stringify({
      work_order_id: "WO-AGENT-ACTIVITY", workflow_status: "Accepted",
      conversation_status: "active", delivery_status: "sent", closure_note: null, closed_at: null, events: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await fetchAgentActivity("WO-AGENT-ACTIVITY", fetcher);
  assert.equal(requestedUrl, "/api/agent/activity?work_order_id=WO-AGENT-ACTIVITY");
  assert.equal(requestedCache, "no-store");
  const merged = mergeActivityEvents(
    [{ message_id: "two", direction: "inbound", message: "later", interpreted_status: null,
      delivery_status: null, timestamp: "2026-08-12T10:02:00.000Z", masked_party: "masked",
      is_voice_note: false, root_cause_claim: null, fix_claim: null }],
    [{ message_id: "one", direction: "outbound", message: "earlier", interpreted_status: null,
      delivery_status: "sent", timestamp: "2026-08-12T10:01:00.000Z", masked_party: "masked",
      is_voice_note: false, root_cause_claim: null, fix_claim: null },
    { message_id: "two", direction: "inbound", message: "updated", interpreted_status: "Accepted",
      delivery_status: null, timestamp: "2026-08-12T10:02:00.000Z", masked_party: "masked",
      is_voice_note: true, root_cause_claim: "Unverified cause", fix_claim: "Reported fix" }],
  );
  assert.deepEqual(merged.map((event) => event.message_id), ["one", "two"]);
  assert.equal(merged[1].message, "updated");

  assert.equal(deliveryLabel("queued"), "Submitted to WhatsApp");
  assert.equal(workflowLabel("Resolved - Awaiting Verification"), "Resolved — awaiting human verification");
  assert.equal(conversationLabel("active"), "Open");
  assert.equal(latestInboundEvent({ work_order_id: "WO-AGENT-ACTIVITY", workflow_status: "Accepted",
    conversation_status: "active", delivery_status: "sent", closure_note: null, closed_at: null, events: merged })?.message, "updated");

  const markup = renderToStaticMarkup(React.createElement(IncidentAgent, {
    proposal: null, report: "One shared report", machine: { machine_id: "R-101" }, languageCode: "en-IN", onCancel: () => undefined,
  }));
  assert.match(markup, /Investigate the incident first/);
  assert.match(markup, /Approve and escalate/);
  assert.equal((markup.match(/<textarea/g) || []).length, 0);
});

test("worker has one report input and investigation result preserves all evidence sections", () => {
  const workerMarkup = renderToStaticMarkup(React.createElement(WorkerPage));
  assert.equal((workerMarkup.match(/<textarea/g) || []).length, 1);
  assert.equal((workerMarkup.match(/Operator report/g) || []).length, 1);
  assert.match(workerMarkup, /R-101 temperature is increasing/);
  assert.match(workerMarkup, /<option value="en-IN" selected="">English<\/option>/);

  const result = {
    likely_fault: "Cooling response fault", likely_category: "Cooling", issue_summary: "Temperature rose while flow fell.",
    confidence: "medium", confidence_reason: "Matched historical records.", warning: "Live telemetry is unavailable.",
    first_checks: [{ check: "Inspect the flow indication", why: "Confirms the reported condition." }],
    what_was_done_last_time: [{ incident_id: "INC-001", summary: "The technician inspected the positioner." }],
    affected_equipment: [{ machine_id: "R-101", machine_name: "Reactor", related_incident_ids: ["INC-001"], sop: null }],
    similar_incidents: [{ incident_id: "INC-001", title: "Reactor — Cooling", status: "Resolved" }],
    incident_details: [{ incident_id: "INC-001", machine_id: "R-101", alarm_data: [{ alarm_id: "AL-1", alarm_type: "Flow", severity: "High" }], process_variables: [{ tep_tag: "FIC-1", phase: "fault", synthetic_value: 2 }] }],
    citations: [{ source_id: "RCA-1", source_type: "rca_document", title: "Cooling RCA", machine_id: "R-101", relevance: "Similar" }],
    matched_documents: [{ doc_id: "DOC-1", source_id: "RCA-1", title: "Cooling RCA", text: "Historical evidence" }],
  };
  const proposal = { summary: "Inspect cooling response", confidence: "medium", requires_approval: true,
    citations: result.citations, trace: [{ tool: "search_plant_memory", label: "Plant memory", status: "completed", summary: "Retrieved RCA-1" }],
    proposed_actions: [actions[0], actions[1], actions[2]], recipient: { role: "Maintenance Lead", display: "WhatsApp ending 1234" } };
  const markup = renderToStaticMarkup(React.createElement(TriageResult, {
    result, proposal, machine: { machine_id: "R-101", machine_name: "Reactor" }, report: "One shared report",
  }));
  for (const heading of ["Immediate assessment", "Machine and operating context", "Findings", "Grounding evidence", "Recommended safe checks", "How the agent investigated"]) {
    assert.match(markup, new RegExp(heading));
  }
  assert.match(markup, /historical\/sample data/);
  assert.match(markup, /What was done in related incidents/);
  assert.match(markup, /Source records and fault signatures/);
});

test("known frontend errors are safe and chatbot session messages are preserved", () => {
  assert.equal(frontendErrorMessage(409, { code: "ACTIVE_CONVERSATION_CONFLICT", existing_work_order_id: "WO-AGENT-OLDER" }),
    "This maintenance contact is already handling work order WO-AGENT-OLDER. Close or verify it before starting another escalation.");
  assert.equal(frontendErrorMessage(502, { code: "SYNTHESIS_INVALID_JSON" }),
    "The investigation response could not be completed. Please retry once.");
  const unknown = frontendErrorMessage(500, { run_id: "RUN-SAFE" } as any);
  assert.match(unknown, /Reference: RUN-SAFE/);
  assert.doesNotMatch(frontendErrorMessage(500, { run_id: "SQL password=secret" } as any), /password|secret|SQL/i);

  const session = appendChatMessage(
    appendChatMessage([], { id: 1, role: "user", text: "First question" }),
    { id: 2, role: "assistant", text: "First answer" },
  );
  assert.deepEqual(session.map((message) => message.text), ["First question", "First answer"]);
  const drawerMarkup = renderToStaticMarkup(React.createElement(PlantQA));
  assert.match(drawerMarkup, /Ask ChemieGenie/);
  assert.match(drawerMarkup, /aria-expanded="false"/);
});

test("human closure is atomic, audited once, idempotent, and releases the active contact", async () => {
  const fullPhone = "whatsapp:+919876543210";
  const state = {
    workOrders: [{ work_order_id: "WO-AGENT-CLOSEME", incident_id: "INC-AGENT-CLOSEME", status: "Resolved - Awaiting Verification", completion_time: null as string | null }],
    incidents: [{ incident_id: "INC-AGENT-CLOSEME", status: "Open" }],
    conversations: [{ conversation_id: 1, run_id: "RUN-CLOSEME", work_order_id: "WO-AGENT-CLOSEME", incident_id: "INC-AGENT-CLOSEME",
      contact_id: "maintenance_primary", external_user: fullPhone, channel: "whatsapp", status: "active" }],
    audits: [] as any[],
    actions: [] as any[],
  };
  let rpcCalls = 0;
  let forceFailure = false;
  let providerCalls = 0;
  const database: any = {
    async rpc(name: string, args: any) {
      rpcCalls += 1;
      assert.equal(name, "close_agent_work_order");
      const current = state.workOrders.find((row) => row.work_order_id === args.p_work_order_id);
      if (!current) return { data: null, error: { code: "P0002", message: "WORK_ORDER_NOT_FOUND" } };
      const conversation = state.conversations.find((row) => row.work_order_id === current.work_order_id
        && row.incident_id === current.incident_id && row.contact_id === args.p_contact_id
        && row.external_user === args.p_external_user);
      if (!conversation) return { data: null, error: { code: "P0001", message: "WORK_ORDER_CONVERSATION_CONFLICT" } };
      const priorAudit = state.audits.find((row) => row.work_order_id === current.work_order_id);
      if (current.status === "Closed - Human Verified" && priorAudit) return { data: {
        work_order_id: current.work_order_id, work_order_status: current.status, incident_id: current.incident_id,
        incident_status: "Resolved", conversation_status: "closed", closure_note: priorAudit.closure_note,
        closed_at: priorAudit.closed_at, already_closed: true,
      }, error: null };
      const next = structuredClone(state);
      const nextWorkOrder = next.workOrders.find((row) => row.work_order_id === current.work_order_id)!;
      nextWorkOrder.status = "Closed - Human Verified"; nextWorkOrder.completion_time = "2026-08-12T12:00:00.000Z";
      next.conversations.filter((row) => row.work_order_id === current.work_order_id && ["active", "pending_send"].includes(row.status))
        .forEach((row) => { row.status = "closed"; });
      next.incidents.find((row) => row.incident_id === current.incident_id)!.status = "Resolved";
      next.audits.push({ id: 1, work_order_id: current.work_order_id, incident_id: current.incident_id,
        closure_note: args.p_closure_note, previous_work_order_status: current.status, closed_by: args.p_closed_by,
        closed_at: "2026-08-12T12:00:00.000Z" });
      next.actions.push({ action_type: "human_verify_and_close", work_order_id: current.work_order_id });
      if (forceFailure) return { data: null, error: { code: "XX000", message: "internal sql detail" } };
      Object.assign(state, next);
      return { data: { work_order_id: current.work_order_id, work_order_status: "Closed - Human Verified",
        incident_id: current.incident_id, incident_status: "Resolved", conversation_status: "closed",
        closure_note: args.p_closure_note, closed_at: "2026-08-12T12:00:00.000Z", already_closed: false }, error: null };
    },
  };
  const previousContact = process.env.MAINTENANCE_WHATSAPP_TO;
  process.env.MAINTENANCE_WHATSAPP_TO = fullPhone;
  setWorkOrderClosureDatabaseForTests(database);
  try {
    const closed = await closeWorkOrder({ workOrderId: "WO-AGENT-CLOSEME", closureNote: "Maintenance outcome reviewed and verified." });
    assert.equal(closed.work_order_status, "Closed - Human Verified");
    assert.equal(state.workOrders[0].status, "Closed - Human Verified");
    assert.equal(state.incidents[0].status, "Resolved");
    assert.ok(state.conversations.every((row) => row.status === "closed"));
    assert.equal(state.audits.length, 1);
    assert.equal(state.actions.length, 1);

    const repeated = await closeWorkOrder({ workOrderId: "WO-AGENT-CLOSEME", closureNote: "A different repeated note" });
    assert.equal(repeated.already_closed, true);
    assert.equal(repeated.closure_note, "Maintenance outcome reviewed and verified.");
    assert.equal(state.audits.length, 1);
    assert.equal(state.actions.length, 1);

    const guardQuery: any = {
      select: () => guardQuery, eq: () => guardQuery, in: () => guardQuery,
      maybeSingle: async () => ({ data: state.conversations.find((row) => ["active", "pending_send"].includes(row.status)) || null, error: null }),
    };
    setAgentStoreDatabaseForTests({ from: () => guardQuery } as any);
    assert.equal(await assertConversationAvailable({ sender: fullPhone, workOrderId: "WO-AGENT-NEWONE" }), null);
    assert.equal(providerCalls, 0);
    assert.equal(rpcCalls, 2);
  } finally {
    setAgentStoreDatabaseForTests(); setWorkOrderClosureDatabaseForTests();
    if (previousContact === undefined) delete process.env.MAINTENANCE_WHATSAPP_TO; else process.env.MAINTENANCE_WHATSAPP_TO = previousContact;
  }

  forceFailure = true;
  process.env.MAINTENANCE_WHATSAPP_TO = fullPhone;
  setWorkOrderClosureDatabaseForTests(database);
  try {
    state.workOrders.push({ work_order_id: "WO-AGENT-FAILCLOSE", incident_id: "INC-AGENT-FAILCLOSE", status: "In Progress", completion_time: null });
    state.incidents.push({ incident_id: "INC-AGENT-FAILCLOSE", status: "Open" });
    state.conversations.push({ conversation_id: 2, run_id: "RUN-FAILCLOSE", work_order_id: "WO-AGENT-FAILCLOSE", incident_id: "INC-AGENT-FAILCLOSE",
      contact_id: "maintenance_primary", external_user: fullPhone, channel: "whatsapp", status: "active" });
    const failureSnapshot = structuredClone(state);
    await assert.rejects(() => closeWorkOrder({ workOrderId: "WO-AGENT-FAILCLOSE", closureNote: "Reviewed but transaction fails" }),
      (error: unknown) => error instanceof WorkOrderClosureError && error.code === "WORK_ORDER_CLOSE_FAILED");
    assert.deepEqual(state, failureSnapshot);
    assert.equal(providerCalls, 0);
  } finally {
    setWorkOrderClosureDatabaseForTests();
    if (previousContact === undefined) delete process.env.MAINTENANCE_WHATSAPP_TO; else process.env.MAINTENANCE_WHATSAPP_TO = previousContact;
  }
});

test("close API validates input, returns 404 safely, and closure controls require note plus confirmation", async () => {
  let rpcCalls = 0;
  const database: any = { rpc: async () => { rpcCalls += 1; return { data: null, error: { code: "P0002", message: "raw database detail" } }; } };
  const previousContact = process.env.MAINTENANCE_WHATSAPP_TO;
  process.env.MAINTENANCE_WHATSAPP_TO = "whatsapp:+919876543210";
  setWorkOrderClosureDatabaseForTests(database);
  try {
    const { POST } = await import("../app/api/agent/close/route");
    const invalid = await POST(new Request("http://localhost/api/agent/close", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ work_order_id: "bad", closure_note: "" }) }));
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, "INVALID_CLOSE_REQUEST");
    assert.equal(rpcCalls, 0);

    const missing = await POST(new Request("http://localhost/api/agent/close", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ work_order_id: "WO-AGENT-MISSING", closure_note: "Reviewed outcome" }) }));
    const body = await missing.json();
    assert.equal(missing.status, 404); assert.equal(body.error, "This work order could not be found.");
    assert.equal(JSON.stringify(body).includes("database"), false);
    assert.equal(canSubmitClosure("", true), false);
    assert.equal(canSubmitClosure("Reviewed", false), false);
    assert.equal(canSubmitClosure("Reviewed", true), true);
    assert.equal(frontendErrorMessage(500, { code: "WORK_ORDER_CLOSE_FAILED" }), "The request could not be closed. Please refresh and try again.");
  } finally {
    setWorkOrderClosureDatabaseForTests();
    if (previousContact === undefined) delete process.env.MAINTENANCE_WHATSAPP_TO; else process.env.MAINTENANCE_WHATSAPP_TO = previousContact;
  }
});

test("invalid Zod tool arguments fail before database execution", async () => {
  await assert.rejects(() => executeReadOnlyTool("get_machine_state", {}), /machine_id/);
});

test("ambiguous machine resolution stops without approval or writes", async () => {
  let calls = 0;
  const result = await investigateIncident({ report: "Something is noisy near cooling" }, {
    chat: async () => ({ choices: [{ message: { tool_calls: [{ id: "one", type: "function",
      function: { name: "resolve_machine", arguments: JSON.stringify({ operator_report: "Something is noisy near cooling" }) } }] } }] }),
    executeTool: async () => {
      calls += 1;
      return { name: "resolve_machine", result: { ambiguous: true, candidates: [] },
        trace: { tool: "resolve_machine", label: "Machine resolution", status: "needs_clarification", summary: "Machine needs clarification" } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.requires_approval, false);
  assert.equal(result.proposed_actions.length, 0);
});

test("three tool-enabled rounds always end in a successful no-tools synthesis round", async () => {
  const chatRequests: any[] = [];
  const executionCounts = new Map<string, number>();
  const loggedRounds: any[] = [];
  const result = await investigateIncident({ report: "R-101 temperature is rising and cooling flow is low", selected_machine_id: "R-101", language_code: "en-IN" }, {
    chat: async (request) => {
      chatRequests.push(request);
      const round = chatRequests.length;
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: "resolve", type: "function", function: { name: "resolve_machine",
          arguments: JSON.stringify({ operator_report: "R-101 temperature is rising", selected_machine_id: "R-101" }) },
      }] } }] };
      if (round === 2) return { choices: [{ message: { tool_calls: [
        ["get_machine_state", { machine_id: "R-101" }],
        ["search_plant_memory", { query: "R-101 cooling flow low", machine_id: "R-101" }],
      ].map(([name, args], index) => ({ id: `evidence-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }] };
      if (round === 3) return { choices: [{ message: { tool_calls: [{
        id: "repeat-memory", type: "function", function: { name: "search_plant_memory",
          arguments: JSON.stringify({ query: "R-101 cooling flow low", machine_id: "R-101" }) },
      }] } }] };
      assert.equal("tools" in request, false);
      assert.equal(request.toolChoice, undefined);
      assert.equal(request.reasoningEffort, null);
      assert.equal(request.maxTokens, 1200);
      assert.equal(request.messages.some((message: any) => message.role === "tool"), false);
      assert.equal(request.messages.some((message: any) => "tool_calls" in message), false);
      assert.ok(request.messages.every((message: any) => ["system", "user", "assistant"].includes(message.role)));
      const synthesisContext = request.messages.map((message: any) => message.content || "").join("\n");
      assert.match(synthesisContext, /ORIGINAL OPERATOR REPORT/);
      assert.match(synthesisContext, /strictly in natural English/);
      assert.match(synthesisContext, /Do not use Tamil, transliterated Tamil, code-mixing/);
      assert.match(synthesisContext, /Tool name: resolve_machine/);
      assert.match(synthesisContext, /Evidence\/citation identifiers:/);
      assert.match(synthesisContext, /RCA0001/);
      return { choices: [{ message: { content: JSON.stringify({
        summary: "Cooling performance needs inspection",
        operator_response: "The incident is ready for your approval.",
        confidence: "medium", severity: "High", should_escalate: true,
        requested_action: "Inspect the cooling-water valve response and adjust the valve if needed",
        citation_source_ids: ["RCA0001"], concise_rationale: "A similar record supports inspection.",
        clarification_question: null,
      }) } }] };
    },
    executeTool: async (name) => {
      executionCounts.set(name, (executionCounts.get(name) || 0) + 1);
      assert.ok(["resolve_machine", "get_machine_state", "search_plant_memory", "get_escalation_contact", "get_machine_sop"].includes(name));
      const results: Record<string, any> = {
        resolve_machine: { ambiguous: false, machine_id: "R-101", machine_name: "Reactor", resolution_source: "explicit_id" },
        get_machine_state: { machine: { machine_id: "R-101", machine_name: "Reactor" }, open_incidents: [], recent_incidents: [], maintenance_actions: [], latest_available_alarms: [], latest_available_sensor_snapshots: [] },
        search_plant_memory: { weak: false, documents: [{ source_id: "RCA0001", source_type: "rca_document", title: "Prior cooling incident", machine_id: "R-101", similarity: 0.8, excerpt: "Cooling valve response was inspected." }], citations: [{ source_id: "RCA0001", source_type: "rca_document", title: "Prior cooling incident", machine_id: "R-101", relevance: "Similar symptoms" }] },
        get_escalation_contact: { contact_id: "maintenance_primary", role: "Maintenance Lead", display: "WhatsApp ending 1234" },
      };
      return { name, result: results[name], trace: { tool: name, label: name, status: "completed", summary: `${name} complete` } };
    },
    signProposal: () => "signed-test-token",
    log: (event) => loggedRounds.push(event),
  });
  assert.equal(chatRequests.length, MAX_AGENT_ROUNDS);
  assert.ok(chatRequests.slice(0, 3).every((request) => request.tools?.length === 5));
  assert.equal("tools" in chatRequests[3], false);
  assert.equal(chatRequests[3].messages.some((message: any) => message.role === "tool"), false);
  assert.equal(chatRequests[3].messages.some((message: any) => "tool_calls" in message), false);
  assert.ok(chatRequests[3].responseFormat);
  assert.equal(executionCounts.get("search_plant_memory"), 1);
  assert.deepEqual(loggedRounds.map((event) => event.phase), ["tools", "tools", "tools", "synthesis"]);
  assert.deepEqual(loggedRounds[1].requested_tools.map((tool: any) => tool.name),
    ["get_machine_state", "search_plant_memory"]);
  assert.equal(executionCounts.get("get_escalation_contact"), 1);
  assert.equal(result.requires_approval, true);
  assert.equal(result.proposed_actions.length, 3);
  assert.match((result.proposed_actions[0] as any).arguments.incident_id, /^INC-AGENT-[A-Z]+$/);
  assert.equal(
    (result.proposed_actions[1] as any).arguments.requested_action,
    "Inspect R-101 and verify the reported condition using the approved SOP and normal safety procedures",
  );
  assert.ok(result.trace.some((event) => event.tool === "safety_guard"));
  assert.ok(result.trace.some((event) => event.label === "Approved recipient resolution"));
  assert.equal(result.approval_token, "signed-test-token");
  assert.equal(JSON.stringify(result).includes("whatsapp:+"), false);
});

const compactValidSubmission = {
  summary: "Cooling condition needs inspection",
  operator_response: "The escalation is ready for approval.",
  confidence: "medium", severity: "High", should_escalate: true,
  requested_action: "Inspect the cooling loop and verify the reported condition",
  citation_source_ids: ["RCA0001"], concise_rationale: "Plant evidence supports inspection.",
  clarification_question: null,
};

async function runSynthesisRepairScenario(args: {
  first: unknown;
  repair: unknown;
}) {
  const requests: any[] = [];
  let readExecutions = 0;
  let mutationAttempts = 0;
  const resultPromise = investigateIncident({
    report: "R-101 temperature is rising and cooling flow is low",
    selected_machine_id: "R-101",
    language_code: "en-IN",
  }, {
    chat: async (request) => {
      requests.push(request);
      if (requests.length === 1) return { choices: [{ message: { tool_calls: [{
        id: "resolve", type: "function", function: { name: "resolve_machine",
          arguments: JSON.stringify({ operator_report: "R-101 temperature rising", selected_machine_id: "R-101" }) },
      }] } }] };
      if (requests.length === 2) return { choices: [{ message: { tool_calls: [{
        id: "state", type: "function", function: { name: "get_machine_state", arguments: JSON.stringify({ machine_id: "R-101" }) },
      }] } }] };
      if (requests.length === 3) return { choices: [{ message: { tool_calls: [
        { id: "memory", type: "function", function: { name: "search_plant_memory", arguments: JSON.stringify({ machine_id: "R-101", query: "cooling flow low" }) } },
        { id: "contact", type: "function", function: { name: "get_escalation_contact", arguments: JSON.stringify({ machine_id: "R-101", severity: "High", required_role: "Maintenance Lead" }) } },
      ] } }] };
      if (requests.length === 4) return args.first;
      if (requests.length === 5) return args.repair;
      throw new Error("Unexpected extra provider call");
    },
    executeTool: async (name) => {
      if (!["resolve_machine", "get_machine_state", "search_plant_memory", "get_escalation_contact", "get_machine_sop"].includes(name)) {
        mutationAttempts += 1;
        throw new Error("Unexpected mutation tool");
      }
      readExecutions += 1;
      const results: Record<string, any> = {
        resolve_machine: { ambiguous: false, machine_id: "R-101", machine_name: "Reactor", resolution_source: "explicit_id" },
        get_machine_state: { machine: { machine_id: "R-101", machine_name: "Reactor" }, open_incidents: [], recent_incidents: [], maintenance_actions: [], latest_available_alarms: [], latest_available_sensor_snapshots: [] },
        search_plant_memory: { weak: false, documents: [{ source_id: "RCA0001", source_type: "rca_document", title: "Prior cooling incident", machine_id: "R-101", similarity: 0.8, excerpt: "Inspect cooling response." }], citations: [{ source_id: "RCA0001", source_type: "rca_document", title: "Prior cooling incident", machine_id: "R-101", relevance: "Similar condition" }] },
        get_escalation_contact: { contact_id: "maintenance_primary", role: "Maintenance Lead", display: "WhatsApp ending 1234" },
      };
      return { name, result: results[name], trace: { tool: name, label: name, status: "completed", summary: `${name} read-only` } };
    },
    signProposal: () => "repair-test-token",
    log: () => undefined,
  });
  return { requests, getReadExecutions: () => readExecutions, getMutationAttempts: () => mutationAttempts, resultPromise };
}

test("truncated synthesis is detected before parsing and repaired once without tools", async () => {
  const scenario = await runSynthesisRepairScenario({
    first: { choices: [{ finish_reason: "length", message: { content: '{"summary":"truncated","citation_source_ids":[' } }], usage: { completion_tokens: 1200 } },
    repair: { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(compactValidSubmission) } }], usage: { completion_tokens: 210 } },
  });
  const result = await scenario.resultPromise;
  assert.equal(result.requires_approval, true);
  assert.equal(scenario.requests.length, 5);
  assert.equal(scenario.requests[3].maxTokens, 1200);
  assert.equal(scenario.requests[4].maxTokens, 800);
  assert.equal(scenario.requests[4].reasoningEffort, null);
  assert.equal("tools" in scenario.requests[3], false);
  assert.equal("tools" in scenario.requests[4], false);
  assert.equal(scenario.requests[4].messages.some((message: any) => message.role === "tool" || "tool_calls" in message), false);
  const repairContext = scenario.requests[4].messages.map((message: any) => message.content).join("\n");
  assert.match(repairContext, /COMPACT EVIDENCE/);
  assert.match(repairContext, /REQUIRED JSON SCHEMA/);
  assert.match(repairContext, /MALFORMED RESPONSE/);
  assert.doesNotMatch(repairContext, /ORIGINAL OPERATOR REPORT/);
  assert.equal(scenario.getReadExecutions(), 4);
  assert.equal(scenario.getMutationAttempts(), 0);
});

test("non-truncated invalid JSON gets one successful compact repair", async () => {
  const scenario = await runSynthesisRepairScenario({
    first: { choices: [{ finish_reason: "stop", message: { content: '{"summary": invalid}' } }], usage: { completion_tokens: 30 } },
    repair: { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(compactValidSubmission) } }], usage: { completion_tokens: 190 } },
  });
  const result = await scenario.resultPromise;
  assert.equal(result.approval_token, "repair-test-token");
  assert.equal(scenario.requests.length, 5);
  assert.equal(scenario.getMutationAttempts(), 0);
});

test("failed synthesis repair returns controlled SYNTHESIS_INVALID_JSON without further calls", async () => {
  const scenario = await runSynthesisRepairScenario({
    first: { choices: [{ finish_reason: "length", message: { content: '{"summary":' } }], usage: { completion_tokens: 1200 } },
    repair: { choices: [{ finish_reason: "stop", message: { content: '{"still":"incomplete"' } }], usage: { completion_tokens: 90 } },
  });
  await assert.rejects(scenario.resultPromise, (error: unknown) => {
    assert.ok(error instanceof SynthesisInvalidJsonError);
    assert.equal(error.code, "SYNTHESIS_INVALID_JSON");
    assert.equal(error.statusCode, 502);
    assert.doesNotMatch(error.message, /SyntaxError|Expected|JSON\.parse/);
    return true;
  });
  assert.equal(scenario.requests.length, 5);
  assert.equal(scenario.getReadExecutions(), 4);
  assert.equal(scenario.getMutationAttempts(), 0);
});

test("Sarvam reply intents map only to bounded statuses", async () => {
  const cases = [
    ["accepted", "Accepted"], ["progress_update", "In Progress"],
    ["needs_help", "Needs Help"], ["resolution_claim", "Resolved - Awaiting Verification"],
    ["unrelated", null],
  ] as const;
  for (const [intent, expected] of cases) {
    const result = await interpretTechnicianReply({ message: String(intent), workOrder: { work_order_id: "WO-AGENT-ABCDEFGH" },
      chat: async () => ({ choices: [{ message: { content: JSON.stringify({ intent,
        status_update: intent === "unrelated" ? null : "Accepted", technician_update: "Update from technician",
        root_cause_claim: null, fix_claim: null, needs_human_review: intent === "unrelated" }) } }] }),
    });
    assert.equal(result.status_update, expected);
  }
});

test("root-cause and fix claims are always marked for human review", async () => {
  const result = await interpretTechnicianReply({ message: "RESOLVED. I think the positioner failed and I replaced it.", workOrder: {},
    chat: async () => ({ choices: [{ message: { content: JSON.stringify({ intent: "resolution_claim",
      status_update: "Resolved - Awaiting Verification", technician_update: "Technician reports replacement",
      root_cause_claim: "Positioner failed", fix_claim: "Replaced positioner", needs_human_review: false }) } }] }),
  });
  assert.equal(result.status_update, "Resolved - Awaiting Verification");
  assert.equal(result.needs_human_review, true);
});

test("Bulbul v3 request contains only the supported production fields", () => {
  assert.deepEqual(buildBulbulV3Request({ text: "  Check cooling flow.  ", languageCode: "ta-IN" }), {
    text: "Check cooling flow.",
    language_code: "ta-IN",
    model: "bulbul:v3",
    speaker: "shubh",
    output_audio_codec: "mp3",
    speech_sample_rate: 24000,
    pace: 1,
  });
});

test("incident speech is bounded and contains only the concise response sections", () => {
  const text = buildIncidentSpeechText({
    summary: "S".repeat(2_000),
    likelyCause: "C".repeat(1_000),
    recommendedAction: "A".repeat(1_000),
    evidence: "must not be spoken",
    trace: "must not be spoken",
    whatsappMessage: "must not be spoken",
  } as any);
  assert.ok(text.length <= MAX_BULBUL_TEXT_LENGTH);
  assert.doesNotMatch(text, /must not be spoken/);
  assert.equal(speechSynthesizeInput.safeParse({ text: "a".repeat(MAX_BULBUL_TEXT_LENGTH), language_code: "en-IN" }).success, true);
  assert.equal(speechSynthesizeInput.safeParse({ text: "a".repeat(MAX_BULBUL_TEXT_LENGTH + 1), language_code: "en-IN" }).success, false);
});

test("blank Bulbul text is rejected locally before a provider request", () => {
  assert.throws(() => buildBulbulV3Request({ text: "   ", languageCode: "en-IN" }), /required/);
  assert.equal(speechSynthesizeInput.safeParse({ text: "   ", language_code: "en-IN" }).success, false);
});

test("every worker UI language maps to the matching Bulbul BCP-47 code", () => {
  for (const [code] of speechLanguageOptions) assert.equal(mapUiLanguageToBulbul(code), code);
  assert.equal(mapUiLanguageToBulbul("unsupported"), "en-IN");
});

test("TTS route hides provider details from the browser and logs only safe diagnostics", async () => {
  const previousEnabled = process.env.ENABLE_SARVAM_TTS;
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  process.env.ENABLE_SARVAM_TTS = "true";
  console.error = (...args: unknown[]) => { logged.push(args); };
  setSarvamProviderForTests({
    chat: async () => ({}),
    transcribe: async () => ({ transcript: "" }),
    synthesize: async () => {
      throw Object.assign(new Error("SDK wrapper message"), {
        statusCode: 400,
        body: { error: { code: "invalid_request", message: "Unsupported TTS parameter", request_id: "req_safe_123" },
          provider_payload: "sensitive payload", authorization: "secret header" },
      });
    },
  });
  try {
    const response = await synthesizeSpeech(new Request("http://localhost/api/speech/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Inspect cooling flow.", language_code: "en-IN" }),
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Speech synthesis failed", code: "SPEECH_SYNTHESIS_FAILED" });
    assert.equal(logged.length, 1);
    const serializedLog = JSON.stringify(logged[0]);
    assert.match(serializedLog, /invalid_request/);
    assert.match(serializedLog, /Unsupported TTS parameter/);
    assert.match(serializedLog, /req_safe_123/);
    assert.match(serializedLog, /400/);
    assert.doesNotMatch(serializedLog, /sensitive payload|secret header|authorization|provider_payload/);
    assert.deepEqual(sarvamErrorDiagnostic({ statusCode: 400, body: {
      error: { code: "invalid_request", message: "Unsupported TTS parameter", request_id: "req_safe_123" },
    } }), {
      code: "invalid_request", message: "Unsupported TTS parameter", request_id: "req_safe_123", http_status: 400,
    });
  } finally {
    setSarvamProviderForTests(undefined);
    console.error = originalConsoleError;
    if (previousEnabled === undefined) delete process.env.ENABLE_SARVAM_TTS;
    else process.env.ENABLE_SARVAM_TTS = previousEnabled;
  }
});

test("recorder selects WebM Opus first and normalizes its upload MIME type", () => {
  const supported = new Set(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
  assert.equal(selectRecorderMimeType((mimeType) => supported.has(mimeType)), "audio/webm;codecs=opus");
  assert.equal(normalizeAudioMimeType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normalizeAudioMimeType("audio/ogg;codecs=opus"), "audio/ogg");
});

test("Saaras upload has explicit bytes and extension-compatible metadata", async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4])], "captured-name.bin", { type: "audio/webm;codecs=opus" });
  const upload = await buildSaarasUpload(file);
  assert.deepEqual([...upload.data], [1, 2, 3, 4]);
  assert.equal(upload.filename, "operator-report.webm");
  assert.equal(upload.contentType, "audio/webm");
  assert.equal(upload.contentLength, 4);
});

test("empty and too-short browser recordings are rejected before upload", () => {
  assert.throws(() => prepareRecordingFile(new Blob([], { type: "audio/webm;codecs=opus" }), 2_000), /empty/i);
  assert.throws(() => prepareRecordingFile(new Blob([new Uint8Array([1])], { type: "audio/webm;codecs=opus" }), 999), /at least 1 second/i);
  const valid = prepareRecordingFile(new Blob([new Uint8Array([1])], { type: "audio/ogg;codecs=opus" }), 1_000);
  assert.equal(valid.name, "operator-report.ogg");
  assert.equal(valid.type, "audio/ogg;codecs=opus");
});

test("Saaras v3 request uses the exact snake_case transcription contract", async () => {
  const file = new File([new Uint8Array([7, 8])], "operator-report.webm", { type: "audio/webm" });
  const upload = await buildSaarasUpload(file);
  const expected = {
    file: upload,
    model: "saaras:v3",
    mode: "translate",
    language_code: "unknown",
  } as const;
  let captured: unknown;
  await callSaarasV3(file, async (request) => { captured = request; return { transcript: "mocked" }; });
  assert.deepEqual(captured, expected);
  assert.equal("withTimestamps" in buildSaarasV3Request(upload), false);
  assert.equal("inputAudioCodec" in buildSaarasV3Request(upload), false);
});

test("STT route keeps provider errors sanitized and logs only safe audio diagnostics", async () => {
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  setSarvamProviderForTests({
    chat: async () => ({}),
    transcribe: async () => {
      throw Object.assign(new Error("SDK wrapper"), { statusCode: 400, body: {
        error: { code: "invalid_audio", message: "Unsupported audio", request_id: "req_stt_safe" },
        audio: "secret-audio-bytes", authorization: "secret-header",
      } });
    },
    synthesize: async () => ({ mimeType: "audio/mpeg", base64Audio: "" }),
  });
  try {
    const form = new FormData();
    form.append("audio", new File([new Uint8Array([1, 2, 3])], "operator-report.webm", { type: "audio/webm;codecs=opus" }));
    const response = await transcribeSpeech(new Request("http://localhost/api/speech/transcribe", { method: "POST", body: form }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Transcription failed", code: "TRANSCRIPTION_FAILED" });
    assert.equal(logged.length, 1);
    const diagnostic = JSON.parse(String(logged[0][0]));
    assert.deepEqual(diagnostic, {
      code: "invalid_audio", message: "Unsupported audio", request_id: "req_stt_safe", http_status: 400,
      audio_mime_type: "audio/webm", audio_byte_size: 3,
    });
    assert.doesNotMatch(JSON.stringify(logged), /secret-audio-bytes|secret-header|authorization/);
  } finally {
    setSarvamProviderForTests(undefined);
    console.error = originalConsoleError;
  }
});

test("application guardrail rejects equipment control and safety bypass instructions", () => {
  assert.doesNotThrow(() => assertSafeRequestedAction("Inspect the valve positioner and verify flow indication"));
  assert.throws(() => assertSafeRequestedAction("Bypass the interlock and start the pump"), /safety boundary/);
  assert.throws(() => assertSafeRequestedAction("Increase cooling-water flow"), /safety boundary/);
  assert.throws(() => assertSafeRequestedAction("Repair the system"), /safety boundary/);
  const constrained = constrainRequestedAction("Inspect the valve and adjust it if needed", "R-101");
  assert.equal(constrained.was_constrained, true);
  assert.doesNotThrow(() => assertSafeRequestedAction(constrained.action));
});

test("Twilio webhook validation accepts only the exact signed public URL and form fields", () => {
  const previousToken = process.env.TWILIO_AUTH_TOKEN;
  const previousBaseUrl = process.env.APP_BASE_URL;
  process.env.TWILIO_AUTH_TOKEN = "test-twilio-auth-token";
  process.env.APP_BASE_URL = "https://example.test";
  const params = { From: "whatsapp:+911234567890", Body: "ACCEPTED", MessageSid: "SMTEST" };
  const signature = twilio.getExpectedTwilioSignature(
    process.env.TWILIO_AUTH_TOKEN,
    "https://example.test/api/whatsapp/inbound",
    params,
  );
  assert.equal(validateTwilioWebhook({ signature, params, path: "/api/whatsapp/inbound" }), true);
  assert.equal(validateTwilioWebhook({ signature, params: { ...params, Body: "RESOLVED" }, path: "/api/whatsapp/inbound" }), false);
  if (previousToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = previousToken;
  if (previousBaseUrl === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = previousBaseUrl;
});
