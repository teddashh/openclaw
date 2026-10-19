import { Type } from "typebox";
import { expect, it, onTestFinished, vi } from "vitest";
import { Agent } from "../../../packages/agent-core/src/agent.js";
import {
  createAssistantMessageEventStream,
  type Model,
} from "../../../packages/agent-core/src/llm.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import { resolveIncompleteTurnPayloadText } from "../embedded-agent-runner/run/incomplete-turn-resolution.js";
import { installToolLoopRecoveryCleanup } from "../embedded-agent-runner/run/tool-loop-recovery.js";
import { createSubscribedSessionHarness } from "../embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createHeartbeatResponseTool } from "./heartbeat-response-tool.js";

it.each([
  { scenario: "accepted", batchSize: 1, mixedBatch: false },
  { scenario: "accepted", batchSize: 1, mixedBatch: true },
  { scenario: "invalid response", batchSize: 1, mixedBatch: false },
  { scenario: "invalid schema", batchSize: 1, mixedBatch: false },
  { scenario: "invalid schema", batchSize: 3, mixedBatch: false },
])(
  "ends a repeating heartbeat model without timing out ($scenario, batch $batchSize, mixed $mixedBatch)",
  async ({ scenario, batchSize, mixedBatch }) => {
    const invalid = scenario !== "accepted";
    const tool = createHeartbeatResponseTool();
    let budgetExhausted = false;
    const outcomes: ReturnType<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "heartbeat-loop",
      sessionPersistence: "detached",
      onAgentEvent: (event) => {
        const phase = event.data.phase;
        if (event.stream === "lifecycle" && (phase === "end" || phase === "error")) {
          outcomes.push(
            buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: event.data }),
          );
        }
      },
    });
    onTestFinished(() => subscription.unsubscribe());
    let requests = 0;
    const stream = vi.fn(() => {
      requests += 1;
      // Bound a broken implementation without waiting for a real run-budget timeout.
      if (requests > 6) {
        budgetExhausted = true;
        agent.abort();
      }
      const message = makeAgentAssistantMessage({
        stopReason: "toolUse",
        content: Array.from({ length: batchSize }, (_, index) => ({
          type: "toolCall",
          id: `heartbeat-${requests}-${index}`,
          name: tool.name,
          arguments: {
            outcome: scenario === "invalid schema" ? `invalid-${requests}` : "no_change",
            notify: requests % 2 === 0,
            summary:
              scenario === "invalid response"
                ? " ".repeat(requests)
                : `Quiet heartbeat, wording ${requests}.`,
          },
        })),
      });
      if (mixedBatch) {
        message.content.push({
          type: "toolCall",
          id: `status-${requests}`,
          name: "read_status",
          arguments: {},
        });
      }
      const result = createAssistantMessageEventStream();
      result.push({ type: "done", reason: "toolUse", message });
      result.end();
      return result;
    });
    const model: Model = {
      id: "test-model",
      name: "Test",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    };
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          tool,
          {
            name: "read_status",
            label: "Status",
            description: "Read synthetic status.",
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: {} }),
          },
        ],
      },
      streamFn: stream,
    });
    installToolLoopRecoveryCleanup({ agent, runId: "heartbeat-loop" });
    const unsubscribe = agent.subscribe(emit);
    onTestFinished(unsubscribe);
    await agent.prompt("Report the heartbeat outcome.");
    const messages = agent.state.messages;
    const heartbeatResult = messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === tool.name,
    );
    await subscription.waitForPendingEvents();

    expect(stream).toHaveBeenCalledTimes(invalid ? Math.ceil(3 / batchSize) : 1);
    expect(budgetExhausted).toBe(false);
    if (!invalid) {
      expect(subscription.getHeartbeatToolResponse()).toMatchObject({
        outcome: "no_change",
        notify: false,
        summary: "Quiet heartbeat, wording 1.",
      });
      expect(outcomes).toEqual([expect.objectContaining({ status: "ok" })]);
    }
    if (invalid) {
      expect(heartbeatResult).toMatchObject({
        role: "toolResult",
        isError: true,
      });
      expect(subscription.getHeartbeatToolResponse()).toBeUndefined();
    } else {
      expect(heartbeatResult).toMatchObject({
        role: "toolResult",
        isError: false,
        details: { status: "accepted" },
      });
      expect(
        resolveIncompleteTurnPayloadText({
          payloadCount: 0,
          aborted: false,
          externalAbort: false,
          timedOut: false,
          attempt: makeEmbeddedRunnerAttempt({
            currentAttemptAssistant: messages.findLast((message) => message.role === "assistant"),
            heartbeatToolResponse: subscription.getHeartbeatToolResponse(),
          }),
        }),
      ).toBeNull();
    }
  },
);
