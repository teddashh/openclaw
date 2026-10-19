import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../../../auto-reply/heartbeat-tool-response.js";
import { clearBatchAdmittedToolCallsForRun } from "../../agent-tools.before-tool-call.state.js";
import type { HookContext } from "../../agent-tools.before-tool-call.types.js";
import { normalizeCodeModeExecBeforeHookParams } from "../../code-mode-control-tools.js";
import type { Agent } from "../../runtime/index.js";
import {
  attachInternalToolBatchLifecycle,
  type InternalBeforeToolBatchHook,
} from "../../runtime/internal-hooks.js";
import { admitToolCallBatch } from "../../tool-loop-admission.js";
import { hashToolCall } from "../../tool-loop-detection.js";
import { readToolResultDetails } from "../../tool-result-error.js";
import { log } from "../logger.js";

/** Build the embedded-runner's private bridge into agent-core loop recovery. */
export function createToolLoopBatchAdmission(
  ctx: HookContext,
): InternalBeforeToolBatchHook | undefined {
  if (ctx.loopDetection?.enabled !== true) {
    return undefined;
  }
  return async ({ calls }) => {
    const canonicalCalls = calls.map((call) => ({
      ...call,
      args: call.tool
        ? normalizeCodeModeExecBeforeHookParams({ tool: call.tool, params: call.args })
        : call.args,
    }));
    try {
      const admission = await admitToolCallBatch(canonicalCalls, ctx);
      const { commitReadyCalls, releaseSkippedCalls, ...result } = admission;
      return commitReadyCalls && releaseSkippedCalls
        ? attachInternalToolBatchLifecycle(result, {
            commitReadyCalls,
            releaseSkippedCalls,
          })
        : result;
    } catch (error) {
      const first = canonicalCalls[0];
      log.error(`tool-loop batch admission failed: ${String(error)}`);
      return first
        ? {
            intervention: {
              kind: "critical-tool-loop",
              toolCallId: first.toolCall.id,
              toolName: first.toolCall.name,
              actionKey: hashToolCall(first.toolCall.name, first.args),
              detector: "loop_admission_failure",
              count: 1,
              reason: "Tool execution was blocked because loop safety checks failed.",
            },
          }
        : undefined;
    }
  };
}

/** Bound heartbeat retries and clean up run-scoped batch admission markers. */
export function installToolLoopRecoveryCleanup(params: { agent: Agent; runId: string }): void {
  let consecutiveHeartbeatCalls = 0;
  const prepareNextTurnWithContext = params.agent.prepareNextTurnWithContext;
  params.agent.prepareNextTurnWithContext = async (context, signal) => {
    // Count finalized results, including schema failures, at the batch boundary.
    // Already-admitted calls settle before we stop the next model request.
    for (const result of context.toolResults) {
      if (result.toolName === HEARTBEAT_RESPONSE_TOOL_NAME && !result.isError) {
        const status = readToolResultDetails(result)?.status;
        if (status === "accepted" || status === "already_accepted") {
          return { stop: true };
        }
      }
      consecutiveHeartbeatCalls =
        result.toolName === HEARTBEAT_RESPONSE_TOOL_NAME ? consecutiveHeartbeatCalls + 1 : 0;
      if (consecutiveHeartbeatCalls >= 3) {
        return { stop: true };
      }
    }
    return prepareNextTurnWithContext
      ? prepareNextTurnWithContext.call(params.agent, context, signal)
      : params.agent.prepareNextTurn?.(signal);
  };
  params.agent.subscribe((event) => {
    if (event.type === "agent_start") {
      consecutiveHeartbeatCalls = 0;
    }
    if (event.type === "agent_end") {
      clearBatchAdmittedToolCallsForRun(params.runId);
    }
  });
}
