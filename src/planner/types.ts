/**
 * Core types for the planning harness.
 * Defines the data structures used by the ReAct-style planner.
 */

import { LanguageModelChatMessage, LanguageModelChatTool } from 'vscode';

// ─── Planning Result ───────────────────────────────────────────────────────────

export interface PlanningResult {
  /** Final text response from the model */
  response: string;
  /** List of tool calls that were executed during planning */
  toolCalls: Array<{
    callId: string;
    tool: string;
    input: Record<string, unknown>;
    result: string;
    success: boolean;
  }>;
  /** Number of planning iterations performed */
  iterations: number;
  /** Whether the planning completed successfully */
  success: boolean;
  /** Error message if planning failed */
  error?: string;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

export interface ToolDefinition {
  /** Unique tool name */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  inputSchema: object;
  /** Whether the tool is enabled */
  enabled: boolean;
}

export interface ToolCall {
  /** Tool name */
  name: string;
  /** Tool call ID (for matching request/response) */
  callId: string;
  /** Input parameters */
  input: Record<string, unknown>;
}

export interface ToolResult {
  /** Tool call ID */
  callId: string;
  /** Tool name */
  tool: string;
  /** Tool input */
  input?: Record<string, unknown>;
  /** Result content */
  content: string;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

// ─── Planning Configuration ────────────────────────────────────────────────────

export interface PlannerConfig {
  /** Maximum number of planning iterations */
  maxIterations: number;
  /** Maximum tokens for tool results in context */
  maxToolResultTokens: number;
  /** Whether to enable planning (vs direct chat) */
  enabled: boolean;
  /** Whether to use structured tool calling */
  useToolCalling: boolean;
  /** Path to FYI instruction file to inject */
  fyiInstructionPath?: string;
  /** Model family for LM Studio compatibility */
  modelFamily: string;
  /** Optional allow-list of tool names for restricted planner runs such as smoke tests */
  allowedTools?: string[];
}

// ─── ReAct Loop State ──────────────────────────────────────────────────────────

export interface ReActState {
  /** Current conversation history */
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{ type: 'text' | 'toolCall' | 'toolResult'; text?: string; toolCall?: ToolCall; toolResult?: ToolResult }>;
  }>;
  /** Executed tool calls */
  executedTools: ToolResult[];
  /** Iteration count */
  iteration: number;
  /** Current planning state */
  status: 'planning' | 'executing' | 'complete' | 'error';
  /** Accumulated context for the model */
  context: string;
}

// ─── Planner Events ────────────────────────────────────────────────────────────

export interface PlannerProgress {
  type: 'iteration' | 'toolCall' | 'toolResult' | 'error' | 'complete';
  iteration?: number;
  percent?: number;
  callId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolSuccess?: boolean;
  toolResult?: string;
  message?: string;
}

// ─── LM Studio Message Format ──────────────────────────────────────────────────

export interface LmStudioToolCall {
  type: 'function';
  id: string;
  name: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface LmStudioMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{
    type: 'text' | 'toolCallRequest' | 'toolCallResult';
    text?: string;
    toolCallRequest?: { type: 'function'; id?: string; name: string; arguments?: Record<string, any> };
    toolCallResult?: { type: 'function'; toolCallId: string; result: string };
  }>;
}

// ─── Tool Registry ─────────────────────────────────────────────────────────────

export type ToolExecutor = (
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: PlannerContext
) => Promise<string>;

export interface ToolRegistry {
  register(tool: ToolDefinition, executor: ToolExecutor): void;
  unregister(toolName: string): void;
  get(toolName: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  execute(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<ToolResult>;
}

// ─── Planner Context ───────────────────────────────────────────────────────────

export interface PlannerContext {
  /** VS Code workspace root path */
  workspaceRoot: string | undefined;
  /** Logger output channel */
  outputChannel: {
    appendLine(msg: string): void;
    append(msg: string): void;
    show(preserveFocus?: boolean): void;
    hide(): void;
    dispose(): void;
  };
  /** Progress callback */
  onProgress?: (progress: PlannerProgress) => void;
  /** CancellationToken */
  token?: { isCancellationRequested: boolean };
}

// ─── Tool Schema Registry ──────────────────────────────────────────────────────

export interface ToolSchema {
  /** VS Code LanguageModelChatTool definition */
  chatTool: LanguageModelChatTool;
  /** Internal tool definition */
  definition: ToolDefinition;
}
