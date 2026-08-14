import { createHash } from "node:crypto";
import { incidentAgentSystemPrompt } from "./agentPrompts";
import { canonicalJson, createApprovalToken } from "./approvalTokens";
import {
  createAgentId,
  executeReadOnlyTool,
  investigationSubmissionJsonSchema,
  investigationSubmissionSchema,
  readOnlyToolDefinitions,
  type ToolExecution,
} from "./agentTools";
import type { InvestigationProposal, PlantCitation, ProposedAction, PublicTraceEvent } from "./agentTypes";
import { runSarvamChat, type SarvamChatArgs } from "./sarvam";

export const MAX_AGENT_ROUNDS = 4;
const TOOL_ENABLED_ROUNDS = MAX_AGENT_ROUNDS - 1;

type AgentInput = {
  report: string;
  selected_machine_id?: string;
  language_code?: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type RunnerDependencies = {
  chat?: (args: SarvamChatArgs) => Promise<unknown>;
  executeTool?: (name: string, args: unknown) => Promise<ToolExecution>;
  signProposal?: typeof createApprovalToken;
  log?: (event: { run_id: string; round: number; phase: "tools" | "synthesis" | "repair"; requested_tools: Array<{ name: string; argument_fingerprint: string }> }) => void;
};

export class SynthesisInvalidJsonError extends Error {
  readonly code = "SYNTHESIS_INVALID_JSON";
  readonly statusCode = 502;

  constructor() {
    super("Agent synthesis returned invalid structured output. Please retry the investigation.");
    this.name = "SynthesisInvalidJsonError";
  }
}

function responseMessage(response: any) {
  const message = response?.choices?.[0]?.message;
  if (!message) throw new Error("Sarvam returned no assistant message");
  return message;
}

function parseToolArguments(call: ToolCall) {
  try {
    return JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error(`Invalid JSON arguments for ${call.function.name}`);
  }
}

function argumentFingerprint(name: string, normalizedArguments: unknown) {
  return createHash("sha256")
    .update(`${name}:${canonicalJson(normalizedArguments)}`)
    .digest("hex")
    .slice(0, 12);
}

function shortText(value: unknown, maxLength = 300) {
  return typeof value === "string" ? value.slice(0, maxLength) : value;
}

function compactRows(rows: unknown, limit: number, fields: string[]) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limit).map((row) => {
    if (!row || typeof row !== "object") return shortText(row);
    return Object.fromEntries(fields
      .filter((field) => (row as Record<string, unknown>)[field] !== undefined)
      .map((field) => [field, shortText((row as Record<string, unknown>)[field])]));
  });
}

export function compactToolResult(name: string, result: unknown): unknown {
  if (!result || typeof result !== "object") return shortText(result);
  const value = result as Record<string, any>;
  if (value.error) return { error: shortText(value.error, 300) };
  if (name === "resolve_machine") return {
    machine_id: value.machine_id || null,
    machine_name: shortText(value.machine_name, 120) || null,
    resolution_source: value.resolution_source,
    ambiguous: Boolean(value.ambiguous),
    candidates: compactRows(value.candidates, 5, ["machine_id", "machine_name"]),
  };
  if (name === "get_machine_state") return {
    machine: value.machine ? Object.fromEntries([
      "machine_id", "machine_name", "equipment_type", "area", "criticality", "normal_operating_note",
    ].filter((field) => value.machine[field] !== undefined).map((field) => [field, shortText(value.machine[field])])) : null,
    open_incidents: compactRows(value.open_incidents, 4,
      ["incident_id", "start_time", "operator_description", "severity", "status", "rca_category"]),
    recent_incidents: compactRows(value.recent_incidents, 4,
      ["incident_id", "start_time", "operator_description", "severity", "status", "rca_category"]),
    maintenance_actions: compactRows(value.maintenance_actions, 4,
      ["work_order_id", "incident_id", "maintenance_type", "action_taken", "status", "completion_time"]),
    latest_available_alarms: compactRows(value.latest_available_alarms, 6,
      ["alarm_id", "incident_id", "timestamp", "tep_tag", "alarm_type", "severity", "alarm_message"]),
    latest_available_sensor_snapshots: compactRows(value.latest_available_sensor_snapshots, 6,
      ["incident_id", "timestamp", "tep_tag", "phase", "synthetic_value", "z_score_vs_normal", "status"]),
    data_freshness_note: shortText(value.data_freshness_note, 160),
  };
  if (name === "search_plant_memory") return {
    weak: Boolean(value.weak),
    strongest_similarity: value.strongest_similarity,
    documents: (Array.isArray(value.documents) ? value.documents : []).slice(0, 4).map((document: any) => ({
      source_id: shortText(document.source_id, 100),
      source_type: shortText(document.source_type, 80),
      title: shortText(document.title, 200),
      machine_id: shortText(document.machine_id, 40),
      similarity: document.similarity,
      excerpt: shortText(document.excerpt, 800),
    })),
    citations: compactRows(value.citations, 4,
      ["source_id", "source_type", "title", "machine_id", "incident_id", "relevance"]),
  };
  if (name === "get_machine_sop") return {
    machine_id: value.machine_id,
    found: Boolean(value.found),
    title: shortText(value.title, 200),
    content: shortText(value.content, 800),
    steps: (Array.isArray(value.steps) ? value.steps : []).slice(0, 6).map((item: unknown) => shortText(item, 300)),
    safety_notes: (Array.isArray(value.safety_notes) ? value.safety_notes : []).slice(0, 4).map((item: unknown) => shortText(item, 300)),
  };
  if (name === "get_escalation_contact") return {
    contact_id: value.contact_id,
    role: shortText(value.role, 80),
    display: shortText(value.display, 100),
    authorization_scope: shortText(value.authorization_scope, 160),
  };
  return { error: "Unsupported tool result" };
}

type SynthesisEvidence = {
  tool_name: string;
  relevant_arguments: unknown;
  compact_result: unknown;
  evidence_identifiers: string[];
};

function compactToolArguments(toolName: string, value: unknown): unknown {
  const args = (value ?? {}) as Record<string, unknown>;
  if (toolName === "resolve_machine") return {
    selected_machine_id: args.selected_machine_id ?? null,
    operator_report_supplied: typeof args.operator_report === "string",
  };
  if (toolName === "get_machine_state" || toolName === "get_machine_sop") {
    return { machine_id: args.machine_id ?? null };
  }
  if (toolName === "search_plant_memory") return {
    machine_id: args.machine_id ?? null,
    query: shortText(args.query, 300),
  };
  if (toolName === "get_escalation_contact") return {
    machine_id: args.machine_id ?? null,
    severity: args.severity ?? null,
    required_role: args.required_role ?? null,
  };
  return {};
}

function collectEvidenceIdentifiers(toolName: string, result: unknown): string[] {
  const value = (result ?? {}) as Record<string, any>;
  const identifiers: unknown[] = [];
  if (toolName === "resolve_machine") {
    identifiers.push(value.machine_id);
  } else if (toolName === "get_machine_state") {
    identifiers.push(value.machine?.machine_id);
    for (const item of [...(value.open_incidents || []), ...(value.recent_incidents || [])]) {
      identifiers.push(item.incident_id);
    }
    for (const item of value.maintenance_actions || []) identifiers.push(item.work_order_id);
    for (const item of value.latest_available_alarms || []) identifiers.push(item.alarm_id);
  } else if (toolName === "search_plant_memory") {
    for (const item of value.documents || []) identifiers.push(item.source_id);
    for (const item of value.citations || []) identifiers.push(item.source_id);
  } else if (toolName === "get_machine_sop") {
    identifiers.push(value.sop_id, value.title);
  } else if (toolName === "get_escalation_contact") {
    identifiers.push(value.contact_id);
  }
  return [...new Set(identifiers.filter((item): item is string => typeof item === "string" && item.length > 0))].slice(0, 4);
}

function synthesisResult(toolName: string, value: unknown) {
  const result = (value ?? {}) as Record<string, any>;
  if (toolName === "get_machine_state") return {
    machine: result.machine,
    open_incidents: (result.open_incidents || []).slice(0, 3),
    recent_incidents: (result.recent_incidents || []).slice(0, 3),
    maintenance_actions: (result.maintenance_actions || []).slice(0, 3),
    latest_available_alarms: (result.latest_available_alarms || []).slice(0, 3),
    latest_available_sensor_snapshots: (result.latest_available_sensor_snapshots || []).slice(0, 3),
    data_freshness_note: result.data_freshness_note,
  };
  if (toolName === "search_plant_memory") return {
    weak: result.weak,
    strongest_similarity: result.strongest_similarity,
    documents: (result.documents || []).slice(0, 3),
  };
  if (toolName === "get_machine_sop") return {
    machine_id: result.machine_id,
    found: result.found,
    title: result.title,
    content: shortText(result.content, 500),
    steps: (result.steps || []).slice(0, 3),
    safety_notes: (result.safety_notes || []).slice(0, 3),
  };
  return value;
}

function serializeSynthesisEvidence(evidence: SynthesisEvidence[]) {
  if (!evidence.length) return "No tool evidence was retrieved.";
  return evidence.map((item, index) => [
    `EVIDENCE ${index + 1}`,
    `Tool name: ${item.tool_name}`,
    `Relevant arguments: ${JSON.stringify(item.relevant_arguments)}`,
    `Compact result: ${JSON.stringify(synthesisResult(item.tool_name, item.compact_result))}`,
    `Evidence/citation identifiers: ${item.evidence_identifiers.join(", ") || "none"}`,
  ].join("\n")).join("\n\n");
}

function synthesisWasTruncated(response: any, maxTokens: number) {
  const finishReason = String(response?.choices?.[0]?.finish_reason || "").toLowerCase();
  if (["length", "max_tokens", "token_limit"].includes(finishReason)) return true;
  const completionTokens = Number(response?.usage?.completion_tokens);
  return Number.isFinite(completionTokens) && completionTokens >= maxTokens;
}

function validatedSubmission(response: unknown, maxTokens: number) {
  if (synthesisWasTruncated(response, maxTokens)) return null;
  const content = (response as any)?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  try {
    return investigationSubmissionSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

const investigationResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "chemiegenie_investigation_result",
    strict: true,
    schema: investigationSubmissionJsonSchema,
  },
} as const;

function clarificationResult(args: {
  runId: string;
  input: AgentInput;
  trace: PublicTraceEvent[];
  candidates?: Array<{ machine_id?: string; machine_name?: string }>;
}): InvestigationProposal {
  const candidateText = args.candidates?.length
    ? ` Possible matches: ${args.candidates.map((item) => `${item.machine_id} - ${item.machine_name}`).join(", ")}.`
    : "";
  return {
    run_id: args.runId,
    summary: "A single machine could not be resolved safely.",
    confidence: "low",
    language_code: args.input.language_code,
    citations: [], trace: args.trace, requires_approval: false, proposed_actions: [],
    clarification_question: `Which machine is affected? Please select or state its machine ID.${candidateText}`,
  };
}

function buildWhatsAppMessage(args: {
  severity: string;
  machineId: string;
  machineName: string;
  report: string;
  sourceIds: string[];
  incidentId: string;
  workOrderId: string;
  requestedAction: string;
}) {
  const evidence = args.sourceIds.length ? args.sourceIds.slice(0, 3).join(", ") : "No strong historical match";
  return [
    `🚨 ${args.severity.toUpperCase()} PRIORITY - ${args.machineId} ${args.machineName}`,
    "",
    `Report: ${args.report}`,
    `Evidence: ${evidence}`,
    `Incident: ${args.incidentId}`,
    `Work order: ${args.workOrderId}`,
    `Requested check: ${args.requestedAction}`,
    "",
    "Reply: ACCEPTED, IN PROGRESS, NEED HELP, or RESOLVED followed by a short update.",
  ].join("\n").slice(0, 1400);
}

export function assertSafeRequestedAction(action: string) {
  const normalized = action.toLowerCase();
  const blocked = [
    /\b(?:bypass|disable|override|defeat|suppress)\b/,
    /\bswitch\s+to\s+manual\b/,
    /\b(?:change|adjust|raise|lower|increase|decrease|repair|replace|reset)\b/,
    /\b(?:open|close|start|stop|operate|energize|de-energize)\b/,
  ];
  if (blocked.some((pattern) => pattern.test(normalized))) {
    throw new Error("Proposed action crosses the advisory-only safety boundary");
  }
  if (!/\b(inspect|verify|check|review|compare|observe|confirm)\b/.test(normalized)) {
    throw new Error("Proposed action must be limited to inspection or verification");
  }
}

export function constrainRequestedAction(action: string, machineId: string) {
  try {
    assertSafeRequestedAction(action);
    return { action, was_constrained: false };
  } catch {
    const fallback = `Inspect ${machineId} and verify the reported condition using the approved SOP and normal safety procedures`;
    assertSafeRequestedAction(fallback);
    return { action: fallback, was_constrained: true };
  }
}

function buildProposal(args: {
  runId: string;
  input: AgentInput;
  submission: ReturnType<typeof investigationSubmissionSchema.parse>;
  executions: Map<string, ToolExecution>;
  trace: PublicTraceEvent[];
  signProposal: typeof createApprovalToken;
}): InvestigationProposal {
  const resolved = args.executions.get("resolve_machine")?.result as any;
  if (!resolved || resolved.ambiguous || !resolved.machine_id) {
    return clarificationResult({ runId: args.runId, input: args.input, trace: args.trace, candidates: resolved?.candidates });
  }
  const memory = args.executions.get("search_plant_memory")?.result as any;
  const availableCitations: PlantCitation[] = (memory?.citations || []).map((citation: any) => ({
    source_id: String(citation.source_id), source_type: String(citation.source_type),
    title: String(citation.title), machine_id: citation.machine_id ? String(citation.machine_id) : null,
    relevance: String(citation.relevance || "Supporting plant evidence"),
  }));
  const availableIds = new Set(availableCitations.map((citation) => citation.source_id));
  const citedIds = [...new Set(args.submission.citation_source_ids)].filter((id) => availableIds.has(id));
  const citations = availableCitations.filter((citation) => citedIds.includes(citation.source_id));

  if (!args.submission.should_escalate) {
    return {
      run_id: args.runId, summary: args.submission.summary, confidence: args.submission.confidence,
      spoken_response: args.submission.operator_response,
      language_code: args.input.language_code, citations, trace: args.trace,
      requires_approval: false, proposed_actions: [],
      clarification_question: args.submission.clarification_question || undefined,
    };
  }

  const requiredTools = ["resolve_machine", "get_machine_state", "search_plant_memory", "get_escalation_contact"];
  const missing = requiredTools.filter((name) => !args.executions.has(name));
  if (missing.length) throw new Error(`Agent submitted escalation before required investigation tools: ${missing.join(", ")}`);
  const contact = args.executions.get("get_escalation_contact")?.result as any;
  if (!contact?.contact_id) throw new Error("No approved escalation contact was resolved");

  const incidentId = createAgentId("INC-AGENT");
  const workOrderId = createAgentId("WO-AGENT");
  const constrainedAction = constrainRequestedAction(args.submission.requested_action, resolved.machine_id);
  const messageBody = buildWhatsAppMessage({
    severity: args.submission.severity, machineId: resolved.machine_id, machineName: resolved.machine_name,
    report: args.input.report, sourceIds: citedIds, incidentId, workOrderId,
    requestedAction: constrainedAction.action,
  });
  const proposedActions: ProposedAction[] = [
    { type: "create_open_incident", arguments: {
      incident_id: incidentId, machine_id: resolved.machine_id,
      operator_description: args.input.report, severity: args.submission.severity, status: "Open",
    } },
    { type: "create_maintenance_work_order", arguments: {
      work_order_id: workOrderId, incident_id: incidentId, machine_id: resolved.machine_id,
      maintenance_type: "Inspection", requested_action: constrainedAction.action, status: "Assigned",
    } },
    { type: "send_whatsapp_escalation", arguments: {
      incident_id: incidentId, work_order_id: workOrderId,
      contact_id: contact.contact_id, message_body: messageBody,
    } },
  ];
  return {
    run_id: args.runId, summary: `${args.submission.summary} ${args.submission.concise_rationale}`.trim(),
    spoken_response: args.submission.operator_response,
    confidence: args.submission.confidence, language_code: args.input.language_code,
    citations, trace: [
      ...args.trace,
      ...(constrainedAction.was_constrained ? [{
        tool: "safety_guard",
        label: "Advisory-only action",
        status: "completed" as const,
        summary: "Replaced operational model wording with an inspection-and-verification-only action",
      }] : []),
      { tool: "synthesize_investigation", label: "Approval",
        status: "completed", summary: "Prepared an exact escalation proposal; no writes or messages executed" },
    ],
    requires_approval: true, proposed_actions: proposedActions,
    recipient: { contact_id: contact.contact_id, role: contact.role, display: contact.display },
    approval_token: args.signProposal({ runId: args.runId, actions: proposedActions }),
  };
}

export async function investigateIncident(input: AgentInput, dependencies: RunnerDependencies = {}): Promise<InvestigationProposal> {
  const chat = dependencies.chat || runSarvamChat;
  const executeTool = dependencies.executeTool || executeReadOnlyTool;
  const signProposal = dependencies.signProposal || createApprovalToken;
  const log = dependencies.log || ((event) => console.info("ChemieGenie agent round", event));
  const runId = createAgentId("RUN");
  const responseLanguageCode = input.language_code || "en-IN";
  const languageInstruction = responseLanguageCode === "en-IN"
    ? "Write every output field, including operator_response, strictly in natural English. Do not use Tamil, transliterated Tamil, code-mixing, or Indic-script text. Keep operator_response under 500 characters for speech playback."
    : "Keep investigation fields and the WhatsApp action in English. Write operator_response only in the requested response language, using native script rather than English-letter transliteration for Indic languages, and keep it under 500 characters for speech playback.";
  const messages: any[] = [
    { role: "system", content: incidentAgentSystemPrompt },
    { role: "user", content: JSON.stringify({
      task: "Investigate using only the supplied read-only tools during the first three rounds. Use at least resolve_machine, get_machine_state, search_plant_memory, and get_escalation_contact before proposing escalation. Load the SOP when it can ground the requested check. A separate final synthesis round will follow with no tools available.",
      operator_report: input.report,
      selected_machine_id: input.selected_machine_id || null,
      response_language_code: responseLanguageCode,
      language_instruction: languageInstruction,
    }) },
  ];
  const trace: PublicTraceEvent[] = [];
  const executions = new Map<string, ToolExecution>();
  const priorCalls = new Map<string, { result: unknown; execution?: ToolExecution }>();
  const accumulatedEvidence: SynthesisEvidence[] = [];

  for (let round = 1; round <= TOOL_ENABLED_ROUNDS; round += 1) {
    const response = await chat({ messages, tools: [...readOnlyToolDefinitions], toolChoice: "required", maxTokens: 1000, reasoningEffort: "low" });
    const assistant = responseMessage(response);
    const calls = (assistant.tool_calls || []) as ToolCall[];
    if (!calls.length) throw new Error("Agent returned without a tool call");
    if (calls.length > 8) throw new Error("Agent requested too many tools in one round");
    log({
      run_id: runId,
      round,
      phase: "tools",
      requested_tools: calls.map((call) => {
        let normalized: unknown;
        try { normalized = JSON.parse(call.function.arguments || "{}"); }
        catch { normalized = { invalid_json: true }; }
        return { name: call.function.name, argument_fingerprint: argumentFingerprint(call.function.name, normalized) };
      }),
    });
    messages.push({ role: "assistant", content: assistant.content || undefined, tool_calls: calls });

    for (const call of calls) {
      let toolResult: unknown;
      let callKey: string | undefined;
      try {
        const raw = parseToolArguments(call);
        if (call.function.name === "resolve_machine" && input.selected_machine_id && !raw.selected_machine_id) {
          raw.selected_machine_id = input.selected_machine_id;
        }
        const resolved = executions.get("resolve_machine")?.result as any;
        if (resolved?.machine_id && raw.machine_id && raw.machine_id !== resolved.machine_id) {
          throw new Error(`Tool machine_id must match resolved machine ${resolved.machine_id}`);
        }
        callKey = `${call.function.name}:${canonicalJson(raw)}`;
        const prior = priorCalls.get(callKey);
        if (prior) {
          toolResult = prior.result;
          trace.push({
            tool: call.function.name,
            label: "Repeated tool call",
            status: "completed",
            summary: `Reused the prior ${call.function.name} result without executing it again`,
          });
        } else {
          const execution = await executeTool(call.function.name, raw);
          const compactResult = compactToolResult(call.function.name, execution.result);
          const compactExecution = { ...execution, result: compactResult };
          executions.set(call.function.name, compactExecution);
          trace.push(execution.trace);
          toolResult = compactResult;
          priorCalls.set(callKey, { result: compactResult, execution: compactExecution });
          accumulatedEvidence.push({
            tool_name: call.function.name,
            relevant_arguments: compactToolArguments(call.function.name, raw),
            compact_result: compactResult,
            evidence_identifiers: collectEvidenceIdentifiers(call.function.name, compactResult),
          });
          if (call.function.name === "resolve_machine" && (compactResult as any)?.ambiguous) {
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(compactResult) });
            return clarificationResult({ runId, input, trace, candidates: (compactResult as any).candidates });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool failed";
        trace.push({ tool: call.function.name, label: call.function.name, status: "failed", summary: message });
        toolResult = { error: message };
        if (callKey) priorCalls.set(callKey, { result: toolResult });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult) });
    }
  }

  const compactEvidenceText = serializeSynthesisEvidence(accumulatedEvidence);
  const synthesisMessages = [
    {
      role: "system",
      content: `${incidentAgentSystemPrompt}\n\nFINAL SYNTHESIS ONLY: Return one compact validated InvestigationResult matching the required JSON schema. Do not request, name, or simulate any tool call. Tools are unavailable. Use at most 3 concise evidence-backed findings in summary, at most 4 citation_source_ids, and one concise inspection-only requested_action. Do not repeat evidence descriptions across summary and rationale. The application creates at most 3 approval actions; do not invent an action list. Preserve evidence identifiers, distinguish evidence from inference, and do not claim any database write or WhatsApp action occurred.`,
    },
    {
      role: "user",
      content: [
        "ORIGINAL OPERATOR REPORT",
        input.report,
        "SELECTED MACHINE",
        input.selected_machine_id ?? "not provided",
        "REQUESTED LANGUAGE",
        responseLanguageCode,
        "LANGUAGE REQUIREMENT",
        languageInstruction,
        "ACCUMULATED COMPACT EVIDENCE",
        compactEvidenceText,
        "INVESTIGATION TRACE",
        JSON.stringify(trace.map(({ tool, status, summary }) => ({ tool, status, summary }))),
        "FINAL INSTRUCTION",
        "Return compact JSON only. Use no more than 3 findings and 4 evidence IDs, with concise non-duplicative summaries. Do not request further evidence or tools. If evidence is insufficient or the machine is unresolved, set should_escalate to false and provide clarification_question; otherwise set clarification_question to null.",
      ].join("\n\n"),
    },
  ];
  log({ run_id: runId, round: MAX_AGENT_ROUNDS, phase: "synthesis", requested_tools: [] });
  const finalResponse = await chat({
    messages: synthesisMessages,
    maxTokens: 1200,
    reasoningEffort: null,
    responseFormat: investigationResponseFormat,
  });
  let submission = validatedSubmission(finalResponse, 1200);
  if (!submission) {
    const malformedResponse = String((finalResponse as any)?.choices?.[0]?.message?.content || "[no response content]");
    const repairMessages = [
      {
        role: "system",
        content: "JSON REPAIR ONLY. Return compact valid JSON matching the supplied schema. Do not use or request tools. Do not add facts. Use at most 3 concise findings and 4 evidence IDs, avoid duplicated evidence descriptions, and output JSON only.",
      },
      {
        role: "user",
        content: [
          "COMPACT EVIDENCE",
          compactEvidenceText,
          "REQUIRED JSON SCHEMA",
          JSON.stringify(investigationSubmissionJsonSchema),
          "MALFORMED RESPONSE",
          malformedResponse,
          "LANGUAGE REQUIREMENT",
          languageInstruction,
          "Return one compact, complete JSON object only.",
        ].join("\n\n"),
      },
    ];
    log({ run_id: runId, round: MAX_AGENT_ROUNDS, phase: "repair", requested_tools: [] });
    const repairResponse = await chat({
      messages: repairMessages,
      maxTokens: 800,
      reasoningEffort: null,
      responseFormat: investigationResponseFormat,
    });
    submission = validatedSubmission(repairResponse, 800);
    if (!submission) throw new SynthesisInvalidJsonError();
  }
  if (submission.should_escalate && !executions.has("get_escalation_contact")) {
    const resolved = executions.get("resolve_machine")?.result as any;
    if (!resolved?.machine_id) throw new Error("Cannot resolve an escalation recipient without a resolved machine");
    const execution = await executeTool("get_escalation_contact", {
      machine_id: resolved.machine_id,
      severity: submission.severity,
      required_role: "Maintenance Lead",
    });
    const compactExecution = {
      ...execution,
      result: compactToolResult("get_escalation_contact", execution.result),
    };
    executions.set("get_escalation_contact", compactExecution);
    trace.push({
      ...execution.trace,
      label: "Approved recipient resolution",
      summary: "Resolved the configured escalation contact after the agent selected escalation; no message was sent",
    });
  }
  return buildProposal({ runId, input, submission, executions, trace, signProposal });
}
