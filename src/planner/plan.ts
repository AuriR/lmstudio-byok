/**
 * ReAct-style planner harness.
 * Implements the loop that sends messages to the model, parses tool calls,
 * executes them, and feeds results back until a final answer is produced.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  PlanningResult,
  PlannerConfig,
  PlannerContext,
  ToolDefinition,
  ToolResult,
  ToolRegistry,
  LmStudioMessage,
} from './types';
import { DefaultToolRegistry, BUILTIN_TOOLS } from './tools';
import { generateAgentSystemPrompt, loadFyiInstructions } from './systemPrompt';
import {
	TASK_LIKELY_REQUIRES_WORKSPACE_CHANGES_PATTERN,
	TASK_LIKELY_TARGETS_DOCUMENTATION_PATTERN,
	TASK_LIKELY_TARGETS_PROJECT_SETUP_PATTERN,
	RESPONSE_LOOKS_LIKE_INCOMPLETE_PROGRESS_NOTE_PATTERN,
} from '../constants';

// ─── JSON Parsing Utilities ────────────────────────────────────────────────────

interface ParsedToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

interface ParsedResponse {
  response?: string;
  tool?: ParsedToolCall;
}

function taskLikelyRequiresWorkspaceChanges(text: string): boolean {
  // This is heuristic planner routing, not a platform contract. It exists to decide when a
  // final natural-language answer is insufficient unless a real workspace action also happened.
  return TASK_LIKELY_REQUIRES_WORKSPACE_CHANGES_PATTERN.test(text);
}

function taskLikelyTargetsDocumentation(text: string): boolean {
  return TASK_LIKELY_TARGETS_DOCUMENTATION_PATTERN.test(text);
}

function taskLikelyTargetsProjectSetup(text: string): boolean {
  return TASK_LIKELY_TARGETS_PROJECT_SETUP_PATTERN.test(text);
}

function responseLooksLikeIncompleteProgressNote(text: string): boolean {
  // These phrase checks are intentionally heuristic. Local models often narrate intended work
  // instead of issuing the next tool call, and there is no external spec that normalizes that.
  // Treat future-tense scaffold/create narration as incomplete so project-setup tasks do
  // not terminate before any file-writing tool has actually succeeded.
  return RESPONSE_LOOKS_LIKE_INCOMPLETE_PROGRESS_NOTE_PATTERN.test(text);
}

function responseLooksLikeTaskRestatement(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (/<task>[\s\S]*<\/task>/i.test(text)) {
    return true;
  }

  return /^(create|build|make|implement|write|generate|scaffold)\b/.test(normalized);
}

function responseLooksLikeLegitimateNoChangeConclusion(text: string): boolean {
  // This is another extension-defined heuristic boundary: planner mode needs an explicit way to
  // distinguish a real "no changes needed" conclusion from a premature completion claim.
  return /\b(no changes (?:are )?needed|no update (?:is )?needed|already up to date|already correct|nothing to change|cannot complete|can't complete|unable to complete|blocked|missing dependency|missing information|need your input|no files were changed because)\b/i.test(text);
}

function normalizePlannerPathForComparison(filePath: string, workspaceRoot: string | undefined): string {
  let normalizedPath = filePath.trim();

  if (/^\/[A-Za-z]:[\\/]/.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(1);
  }

  normalizedPath = normalizedPath.replace(/\//g, path.sep);
  if (!path.isAbsolute(normalizedPath) && workspaceRoot) {
    normalizedPath = path.join(workspaceRoot, normalizedPath);
  }

  return path.normalize(normalizedPath).toLowerCase();
}

function extractToolTargetPaths(toolName: string, input: Record<string, unknown> | undefined, workspaceRoot: string | undefined): string[] {
  if (!input) {
    return [];
  }

  if ((toolName === 'read_file' || toolName === 'write_file') && typeof input.path === 'string') {
    return [normalizePlannerPathForComparison(input.path, workspaceRoot)];
  }

  if (toolName === 'write_project_files' && Array.isArray(input.files)) {
    return input.files
      .filter((file): file is Record<string, unknown> => !!file && typeof file === 'object' && !Array.isArray(file))
      .map(file => typeof file.path === 'string' ? normalizePlannerPathForComparison(file.path, workspaceRoot) : undefined)
      .filter((filePath): filePath is string => !!filePath);
  }

  if (toolName === 'apply_workspace_edit' && Array.isArray(input.edits)) {
    return input.edits
      .filter((edit): edit is Record<string, unknown> => !!edit && typeof edit === 'object' && !Array.isArray(edit))
      .map(edit => typeof edit.file === 'string' ? normalizePlannerPathForComparison(edit.file, workspaceRoot) : undefined)
      .filter((filePath): filePath is string => !!filePath);
  }

  return [];
}

function normalizeFailureSignatureText(content: string): string {
  return content
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function listKnownWorkspacePaths(executedTools: ToolResult[], limit = 5): string[] {
  const paths = new Set<string>();

  for (let index = executedTools.length - 1; index >= 0; index--) {
    const tool = executedTools[index];
    if (!tool.success) {
      continue;
    }

    const pathMatches = [
      ...tool.content.matchAll(/File:\s+([^\r\n]+)/g),
      ...tool.content.matchAll(/([A-Za-z]:\\[^\r\n:]+(?:\\[^\r\n:]+)*)(?::\d+)?/g),
    ];

    for (const match of pathMatches) {
      const path = (match[1] ?? '').trim();
      if (!path) {
        continue;
      }

      paths.add(path);
      if (paths.size >= limit) {
        return Array.from(paths);
      }
    }
  }

  return Array.from(paths);
}

function buildToolFailureRecoveryMessage(
  toolName: string,
  toolResult: ToolResult,
  executedTools: ToolResult[],
): string | undefined {
  const normalizedContent = toolResult.content.trim();

  if (toolName === 'read_file' && normalizedContent.includes('"path" argument is required')) {
    const knownPaths = listKnownWorkspacePaths(executedTools)
      .slice(0, 3)
      .map(path => `- ${path}`)
      .join('\n');
    const knownPathsSection = knownPaths
      ? `\nKnown file paths from earlier tool results:\n${knownPaths}\n`
      : '';

    return [
      'The read_file call failed because the required "path" argument was missing.',
      'Retry with a concrete file path, for example {"tool":"read_file","arguments":{"path":"c:\\Dev\\lmstudio-testing\\src\\extension.ts"}}.',
      'If you only need part of the file, include {"range":[startLine,endLine]} or startLine/endLine alongside the path.',
      knownPathsSection,
      'Do not call read_file with an empty arguments object.',
    ].join('\n');
  }

  if (toolName === 'read_file' && /is a directory, not a file/i.test(normalizedContent)) {
    return [
      'The read_file call targeted a directory instead of a file.',
      'Pick a specific file path from the listed directory entries, or call search_workspace with a concrete pattern to locate the right file first.',
      'Do not repeat read_file on the same directory path.',
    ].join('\n');
  }

  if (toolName === 'search_workspace' && normalizedContent.includes('"pattern" argument is required')) {
    const knownPaths = listKnownWorkspacePaths(executedTools)
      .slice(0, 3)
      .map(path => `- ${path}`)
      .join('\n');
    const knownPathsSection = knownPaths
      ? `\nIf you already found the relevant file, skip search_workspace and call read_file on one of these paths:\n${knownPaths}\n`
      : '';

    return [
      'The search_workspace call failed because the required "pattern" argument was missing.',
      'Retry with a concrete pattern, for example {"tool":"search_workspace","arguments":{"pattern":"Show Documentation"}}.',
      'You may also include filePattern to narrow the search, such as {"filePattern":"*.ts"}.',
      knownPathsSection,
      'Do not call search_workspace with an empty arguments object.',
    ].join('\n');
  }

  if (toolName === 'write_file' && normalizedContent.includes('"content" argument is required')) {
    return [
      'The write_file call failed because the required "content" argument was missing.',
      'Retry with both path and the full file contents, for example {"tool":"write_file","arguments":{"path":"c:\\Dev\\CoinFlip5\\package.json","content":"{...}"}}.',
      'Do not call write_file with only a path.',
    ].join('\n');
  }

  if (toolName === 'write_file' && normalizedContent.includes('Invalid arguments for')) {
    return [
      'The write_file call had invalid arguments.',
      'Retry with both a non-empty path string and the full file contents string.',
      'For new project files, write the whole file in one call instead of returning only the path or a placeholder.',
    ].join('\n');
  }

  if (toolName === 'write_file' && /placeholder or markdown wrapper text/i.test(normalizedContent)) {
    return [
      'The write_file call contained placeholder or markdown wrapper text instead of a real file body.',
      'Retry with the exact final file contents only. Do not include comments such as "...existing code...", "replaced", omitted sections, or ``` fences.',
      'If you are overwriting an existing file, send the complete updated file text exactly as it should appear on disk.',
    ].join('\n');
  }

  if (toolName === 'write_project_files' && normalizedContent.includes('"files"')) {
    return [
      'The write_project_files call failed because the files array was missing or invalid.',
      'Retry with {"tool":"write_project_files","arguments":{"files":[{"path":"package.json","content":"{...}"},{"path":"src/main.tsx","content":"..."}]}}.',
      'Each files item must be an object with non-empty path and string content.',
    ].join('\n');
  }

  if (toolName === 'write_project_files' && /File already exists:/i.test(normalizedContent)) {
    return [
      'The write_project_files call would overwrite an existing file.',
      'Retry with overwrite=true only if replacing those files is intentional.',
      'If you only need to update one existing file, use write_file or apply_workspace_edit instead.',
    ].join('\n');
  }

  if (toolName === 'write_project_files' && normalizedContent.includes('Invalid arguments for')) {
    return [
      'The write_project_files call had invalid arguments.',
      'Provide a non-empty files array. Each item must include a path string and a content string.',
      'Use this tool when creating several project files together, such as package.json plus src files for a new app.',
    ].join('\n');
  }

  if (toolName === 'write_project_files' && /placeholder or markdown wrapper text/i.test(normalizedContent)) {
    return [
      'The write_project_files call contained placeholder or markdown wrapper text in at least one file body.',
      'Retry with the exact final text for every file. Do not include elisions such as "...existing code...", omitted sections, or ``` fences.',
      'This tool should create complete files, not abbreviated templates.',
    ].join('\n');
  }

  if (toolName === 'run_vscode_command' && normalizedContent.includes('"command" argument is required')) {
    return [
      'The run_vscode_command call failed because the required "command" argument was missing.',
      'Retry only if you know an actual VS Code command ID to run, for example {"tool":"run_vscode_command","arguments":{"command":"workbench.action.files.newUntitledFile"}}.',
      'For project scaffolding, prefer write_file over run_vscode_command unless a real command ID is necessary.',
    ].join('\n');
  }

  if (toolName === 'run_vscode_command' && normalizedContent.includes('Invalid arguments for')) {
    return [
      'The run_vscode_command call had invalid arguments.',
      'Use a non-empty command string and optional string args only.',
      'If the task is to create files, prefer write_file instead of run_vscode_command.',
    ].join('\n');
  }

  if (toolName === 'run_vscode_command' && /command '.*' not found/i.test(normalizedContent)) {
    return [
      'The run_vscode_command call failed because that VS Code command ID is not available.',
      'Do not rely on terminal automation commands such as terminal.sendText unless you already know the command exists in this environment.',
      'Use run_vscode_command only for real VS Code command IDs. If you need to scaffold files, prefer write_file or apply_workspace_edit instead of trying to send shell commands through VS Code.',
    ].join('\n');
  }

  if (toolName === 'apply_workspace_edit' && normalizedContent.includes('Invalid arguments for')) {
    return [
      'The apply_workspace_edit call had invalid arguments.',
      'Each edit must include file and operation. Replace edits also need range.startLine, range.endLine, and content. Insert edits need range.startLine and content. Delete edits need range.startLine and range.endLine.',
      'If precise edit ranges are difficult, prefer write_file with the complete updated file content.',
    ].join('\n');
  }

  if (/refusing repeated whole-file overwrite/i.test(normalizedContent)) {
    return [
      'The planner attempted to overwrite the same file again without validating the previous full-file write.',
      'Read that file first to verify the last contents, then retry with one exact final file body if another rewrite is still necessary.',
      'For large docs or other multi-pass work, use write-read-write rather than blind consecutive overwrites.',
    ].join('\n');
  }

  if (toolName === 'search_workspace' && normalizedContent.includes('Invalid arguments for')) {
    return [
      'The search_workspace call had invalid arguments.',
      'Use a non-empty pattern string and optionally filePattern plus maxResults.',
      'If the workspace is empty and you need to create files, skip search_workspace and call write_file directly.',
    ].join('\n');
  }

  return undefined;
}

function extractSimpleArguments(text: string, tool?: ToolDefinition): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const schema = tool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  const allowedKeys = new Set(Object.keys(schema?.properties ?? {}));
  const fieldPattern = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?)/g;

  for (const match of text.matchAll(fieldPattern)) {
    const [, key, rawValue] = match;
    if (allowedKeys.size > 0 && !allowedKeys.has(key)) {
      continue;
    }

    if (rawValue === 'true') {
      result[key] = true;
      continue;
    }

    if (rawValue === 'false') {
      result[key] = false;
      continue;
    }

    if (rawValue === 'null') {
      result[key] = null;
      continue;
    }

    if (rawValue.startsWith('"')) {
      try {
        result[key] = JSON.parse(rawValue);
      } catch {
        result[key] = rawValue.slice(1, -1);
      }
      continue;
    }

    const numericValue = Number(rawValue);
    if (!Number.isNaN(numericValue)) {
      result[key] = numericValue;
    }
  }

  return result;
}

function recoverToolCallFromText(text: string, tools: ToolDefinition[]): ParsedToolCall | undefined {
  const toolDefinitions = tools.length > 0 ? tools : BUILTIN_TOOLS;
  const knownToolNames = new Set(toolDefinitions.map(tool => tool.name));
  const looksLikeToolCall = /"type"\s*:\s*"toolCall"|"toolCall"\s*:|"tool"\s*:|"tool_name"\s*:|"toolName"\s*:/.test(text);
  if (!looksLikeToolCall) {
    return undefined;
  }

  const nameMatch = text.match(/"(?:tool|tool_name|toolName|name)"\s*:\s*"([A-Za-z_][A-Za-z0-9_./-]*)"/);
  const toolName = nameMatch?.[1];
  if (!toolName || !knownToolNames.has(toolName)) {
    return undefined;
  }

  const toolDefinition = toolDefinitions.find(tool => tool.name === toolName);
  const argumentsBlockMatch = text.match(/"(?:input|arguments)"\s*:\s*(\{[\s\S]*\})/);
  if (argumentsBlockMatch) {
    const parsedArguments = tryParseJsonLikeObject(argumentsBlockMatch[1]);
    if (parsedArguments && typeof parsedArguments === 'object' && !Array.isArray(parsedArguments)) {
      return {
        tool: toolName,
        arguments: parsedArguments as Record<string, unknown>,
      };
    }

    return {
      tool: toolName,
      arguments: extractSimpleArguments(argumentsBlockMatch[1], toolDefinition),
    };
  }

  return {
    tool: toolName,
    arguments: extractSimpleArguments(text, toolDefinition),
  };
}

function inferToolCallFromArgumentsObject(json: unknown, tools: ToolDefinition[]): ParsedToolCall | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return undefined;
  }

  const input = json as Record<string, unknown>;
  const inputKeys = Object.keys(input);
  if (inputKeys.length === 0) {
    return undefined;
  }

  // Some local models emit only the argument object instead of the documented
  // { "tool": "name", "arguments": { ... } } wrapper. When the object cleanly
  // matches exactly one allowed tool schema, infer that tool call so the planner
  // can keep going instead of treating the object as a final answer.
  const candidates = tools.filter(tool => {
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const schemaKeys = Object.keys(schema.properties ?? {});
    if (schemaKeys.length === 0) {
      return false;
    }

    const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
    const hasRequiredKeys = requiredKeys.every(key => key in input);
    if (!hasRequiredKeys) {
      return false;
    }

    return inputKeys.every(key => schemaKeys.includes(key));
  });

  if (candidates.length !== 1) {
    return undefined;
  }

  return {
    tool: candidates[0].name,
    arguments: input,
  };
}

function tryParseJsonLikeObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some local models emit nearly-correct JSON but leave bare identifiers unquoted for
    // string-valued planner fields such as name or callId. Normalize those narrow cases and
    // retry instead of treating the whole object as a final answer.
    const normalized = text.replace(
      /("(?:type|tool|tool_name|toolName|name|callId)"\s*:\s*)([A-Za-z_][A-Za-z0-9_./-]*)(\s*[,}])/g,
      '$1"$2"$3',
    );

    if (normalized === text) {
      return undefined;
    }

    try {
      return JSON.parse(normalized);
    } catch {
      return undefined;
    }
  }
}

function normalizePlannerRole(role: LmStudioMessage['role']): 'system' | 'user' | 'assistant' {
  if (role === 'system' || role === 'assistant') {
    return role;
  }

  return 'user';
}

function truncateToolResult(text: string, maxToolResultTokens: number): string {
  if (!text || maxToolResultTokens <= 0) {
    return text;
  }

  const maxChars = Math.max(1200, maxToolResultTokens * 4);
  if (text.length <= maxChars) {
    return text;
  }

  const headChars = Math.max(600, Math.floor(maxChars * 0.7));
  const tailChars = Math.max(300, maxChars - headChars);
  return [
    text.slice(0, headChars),
    '',
    '[Planner note: tool result truncated to stay within the configured tool-result budget.]',
    '',
    text.slice(-tailChars),
  ].join('\n');
}

/**
 * Attempts to parse a tool call or response from model output.
 * Handles various formats the model might use.
 */
function parseModelOutput(text: string, tools: ToolDefinition[]): ParsedResponse {
  if (!text || !text.trim()) {
    return {};
  }

  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const json = tryParseJsonLikeObject(codeBlockMatch[1]);
    if (json !== undefined) {
      return normalizeParsedOutput(json, tools);
    }
  }

  // Try to find JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const json = tryParseJsonLikeObject(jsonMatch[0]);
    if (json !== undefined) {
      return normalizeParsedOutput(json, tools);
    }
  }

  const recoveredToolCall = recoverToolCallFromText(text, tools);
  if (recoveredToolCall) {
    return { tool: recoveredToolCall };
  }

  // If no JSON found, treat as final response
  return { response: text.trim() };
}

/**
 * Normalizes parsed JSON output into a standard format.
 */
function normalizeParsedOutput(json: any, tools: ToolDefinition[]): ParsedResponse {
  // Check if it's a tool call
  if (json.tool && json.arguments) {
    return { tool: { tool: json.tool, arguments: json.arguments as Record<string, unknown> } };
  }

  // Some models mirror the planner's internal transcript shape instead of the simpler
  // { "tool": "name", "arguments": { ... } } form. Accept that nested toolCall object
  // so the planner executes the intended next action instead of dumping raw JSON to chat.
  if (json.type === 'toolCall' && json.toolCall && typeof json.toolCall === 'object') {
    const toolCall = json.toolCall as {
      name?: unknown;
      input?: unknown;
      arguments?: unknown;
    };
    const toolArgumentsSource = (toolCall.input ?? toolCall.arguments) as unknown;

    if (typeof toolCall.name === 'string') {
      return {
        tool: {
          tool: toolCall.name,
          arguments: (toolArgumentsSource ?? {}) as Record<string, unknown>,
        },
      };
    }

    // Some local models preserve the nested transcript wrapper but corrupt the tool name field,
    // for example { type: "toolCall", toolCall: { name: {}, arguments: { path: "..." } } }.
    // When the nested arguments object still matches one allowed tool schema, infer the intended
    // tool call instead of surfacing the transcript JSON as a final answer.
    const inferredNestedToolCall = inferToolCallFromArgumentsObject(toolArgumentsSource, tools);
    if (inferredNestedToolCall) {
      return { tool: inferredNestedToolCall };
    }
  }

  // Some models flatten the planner transcript shape and emit the tool call fields directly
  // on the same object as { "type": "toolCall", "name": "...", "input": { ... } }.
  if (json.type === 'toolCall' && typeof json.name === 'string') {
    return {
      tool: {
        tool: json.name,
        arguments: (json.input ?? json.arguments ?? {}) as Record<string, unknown>,
      },
    };
  }

  // Some models flatten the transcript even further and put the tool identity inside the
  // arguments object itself, for example { "type": "toolCall", "arguments": { "name": "read_file", ... } }.
  // Strip transcript-only metadata so the real tool input is forwarded to the executor.
  if (json.type === 'toolCall' && json.arguments && typeof json.arguments === 'object') {
    const toolArguments = json.arguments as Record<string, unknown>;
    const toolName = typeof toolArguments.name === 'string'
      ? toolArguments.name
      : typeof toolArguments.tool === 'string'
        ? toolArguments.tool
        : undefined;

    if (toolName) {
      const { name: _name, tool: _tool, callId: _callId, ...input } = toolArguments;
      return {
        tool: {
          tool: toolName,
          arguments: input,
        },
      };
    }
  }

  // Check if it's a response
  if (json.response) {
    return { response: json.response };
  }

  // Check if it has a tool name but different structure
  if (json.tool_name || json.toolName) {
    return {
      tool: {
        tool: json.tool_name || json.toolName,
        arguments: json.input || json.arguments || {},
      },
    };
  }

  // If it has a response-like field, treat as response
  if (json.answer || json.final_answer || json.result) {
    return { response: json.answer || json.final_answer || json.result };
  }

  // If it looks like a tool call (has a known tool name)
  const knownTools = tools.length > 0 ? tools.map(t => t.name) : BUILTIN_TOOLS.map(t => t.name);
  for (const toolName of knownTools) {
    if (json[toolName] && typeof json[toolName] === 'object') {
      return { tool: { tool: toolName, arguments: json[toolName] } };
    }
  }

  const inferredToolCall = inferToolCallFromArgumentsObject(json, tools);
  if (inferredToolCall) {
    return { tool: inferredToolCall };
  }

  // Default: treat entire JSON as response
  return { response: JSON.stringify(json, null, 2) };
}

// ─── LM Studio Message Conversion ──────────────────────────────────────────────

/**
 * Converts planner messages to LM Studio format.
 */
function toLmStudioMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | unknown[] }>
): LmStudioMessage[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return {
        role: msg.role,
        content: [{ type: 'text', text: msg.content }],
      };
    }

    // Handle array content (tool calls, results, etc.)
    const content: any[] = [];
    for (const part of msg.content) {
      if (part && typeof part === 'object') {
        const partObj = part as any;
        if (partObj.type === 'text') {
          content.push({ type: 'text', text: partObj.text });
        } else if (partObj.type === 'toolCall') {
          content.push({
            type: 'toolCallRequest',
            toolCallRequest: {
              type: 'function',
              id: partObj.toolCall.callId,
              name: partObj.toolCall.name,
              arguments: partObj.toolCall.input,
            },
          });
        } else if (partObj.type === 'toolResult') {
          content.push({
            type: 'toolCallResult',
            toolCallId: partObj.toolResult.callId,
            result: partObj.toolResult.content,
          });
        }
      }
    }

    return {
      role: msg.role,
      content,
    };
  });
}

// ─── ReAct Planner Implementation ──────────────────────────────────────────────

export class ReActPlanner {
  private config: PlannerConfig;
  private context: PlannerContext;
  private registry: ToolRegistry;
  private messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | unknown[] }>;
  private executedTools: ToolResult[];
  private iteration: number;
  private outputChannel: vscode.OutputChannel;
  private explorationWarningIssued: boolean;

  private static readonly EXPLORATORY_TOOL_NAMES = new Set(['search_workspace', 'read_file']);
  // Treat multi-file scaffolding as a first-class action so empty-workspace project setup can
  // converge in one tool call instead of relying on several fragile write_file turns.
  private static readonly WORKSPACE_ACTION_TOOL_NAMES = new Set(['write_file', 'write_project_files', 'apply_workspace_edit', 'run_vscode_command']);
  private static readonly PERSISTENT_CHANGE_TOOL_NAMES = new Set(['write_file', 'write_project_files', 'apply_workspace_edit']);

  private createPlannerToolCallId(): string {
    return `planner-${this.iteration}-${this.executedTools.length + 1}`;
  }

  constructor(
    config: PlannerConfig,
    context: PlannerContext,
    outputChannel: vscode.OutputChannel,
    registry?: ToolRegistry,
  ) {
    this.config = config;
    this.context = context;
    this.outputChannel = outputChannel;
    this.registry = registry ?? new DefaultToolRegistry(config.allowedTools);
    this.messages = [];
    this.executedTools = [];
    this.iteration = 0;
    this.explorationWarningIssued = false;
  }

  private shouldWarnAboutExplorationLoop(): boolean {
    if (this.explorationWarningIssued) {
      return false;
    }

    if (this.executedTools.length < 4) {
      return false;
    }

    const hasActionTool = this.executedTools.some(tool =>
      tool.tool === 'write_file' ||
      tool.tool === 'write_project_files' ||
      tool.tool === 'apply_workspace_edit' ||
      tool.tool === 'run_vscode_command',
    );
    if (hasActionTool) {
      return false;
    }

    return this.executedTools.every(tool => ReActPlanner.EXPLORATORY_TOOL_NAMES.has(tool.tool));
  }

  private getLastSuccessfulPersistentChangeIndex(): number {
    for (let index = this.executedTools.length - 1; index >= 0; index--) {
      const tool = this.executedTools[index];
      if (tool.success && ReActPlanner.PERSISTENT_CHANGE_TOOL_NAMES.has(tool.tool)) {
        return index;
      }
    }

    return -1;
  }

  private hasValidationAfterLastPersistentChange(): boolean {
    const lastChangeIndex = this.getLastSuccessfulPersistentChangeIndex();
    if (lastChangeIndex < 0) {
      return false;
    }

    const changedPaths = extractToolTargetPaths(
      this.executedTools[lastChangeIndex].tool,
      this.executedTools[lastChangeIndex].input,
      this.context.workspaceRoot,
    );

    return this.executedTools.slice(lastChangeIndex + 1).some(tool => {
      if (!tool.success || !ReActPlanner.EXPLORATORY_TOOL_NAMES.has(tool.tool)) {
        return false;
      }

      if (tool.tool !== 'read_file') {
        return false;
      }

      if (changedPaths.length === 0) {
        return true;
      }

      const validationPaths = extractToolTargetPaths(tool.tool, tool.input, this.context.workspaceRoot);
      return validationPaths.some(validationPath => changedPaths.includes(validationPath));
    });
  }

  private shouldBlockRepeatedWholeFileOverwrite(toolName: string, toolInput: Record<string, unknown>): string | undefined {
    if (toolName !== 'write_file' && toolName !== 'write_project_files') {
      return undefined;
    }

    const targetPaths = extractToolTargetPaths(toolName, toolInput, this.context.workspaceRoot);
    if (targetPaths.length === 0) {
      return undefined;
    }

    for (const targetPath of targetPaths) {
      for (let index = this.executedTools.length - 1; index >= 0; index--) {
        const priorTool = this.executedTools[index];
        const priorPaths = extractToolTargetPaths(priorTool.tool, priorTool.input, this.context.workspaceRoot);
        if (!priorPaths.includes(targetPath)) {
          continue;
        }

        if (priorTool.success && priorTool.tool === 'read_file') {
          break;
        }

        if (priorTool.success && (priorTool.tool === 'write_file' || priorTool.tool === 'write_project_files')) {
          return targetPath;
        }
      }
    }

    return undefined;
  }

  private getRepeatedFailureLoopCount(): { count: number; toolName: string; targetDescription: string; } | undefined {
    const lastTool = this.executedTools.at(-1);
    if (!lastTool || lastTool.success) {
      return undefined;
    }

    const targetPaths = extractToolTargetPaths(lastTool.tool, lastTool.input, this.context.workspaceRoot);
    const targetDescription = targetPaths[0] ?? '(no target)';
    const failureSignature = `${lastTool.tool}|${targetDescription}|${normalizeFailureSignatureText(lastTool.content)}`;

    let count = 0;
    for (let index = this.executedTools.length - 1; index >= 0; index--) {
      const tool = this.executedTools[index];
      if (tool.success) {
        break;
      }

      const candidatePaths = extractToolTargetPaths(tool.tool, tool.input, this.context.workspaceRoot);
      const candidateDescription = candidatePaths[0] ?? '(no target)';
      const candidateSignature = `${tool.tool}|${candidateDescription}|${normalizeFailureSignatureText(tool.content)}`;
      if (candidateSignature !== failureSignature) {
        break;
      }

      count++;
    }

    if (count < 2) {
      return undefined;
    }

    return {
      count,
      toolName: lastTool.tool,
      targetDescription,
    };
  }

  private buildMaxIterationsResponse(): { response: string; error: string } {
    const lastTool = this.executedTools.at(-1);
    const successfulActionTools = this.executedTools.filter(tool =>
      tool.success && ReActPlanner.PERSISTENT_CHANGE_TOOL_NAMES.has(tool.tool),
    );

    // A local model may spend its final allowed round on the actual edit, leaving no extra
    // round to narrate the result. Call that out explicitly so the chat summary matches reality.
    if (lastTool && lastTool.success && ReActPlanner.PERSISTENT_CHANGE_TOOL_NAMES.has(lastTool.tool)) {
      return {
        response: [
          `Planner reached the configured round limit (${this.config.maxIterations}) immediately after a successful '${lastTool.tool}' call.`,
          'Workspace changes may already be applied even though the model did not get another round to write a final summary.',
          '',
          'Recent tool result:',
          `[${lastTool.tool}]: ${lastTool.content}`,
        ].join('\n'),
        error: `Max iterations (${this.config.maxIterations}) reached after a successful '${lastTool.tool}' call.`,
      };
    }

    if (successfulActionTools.length > 0) {
      return {
        response: [
          `Planner reached the configured round limit (${this.config.maxIterations}) after making workspace changes.`,
          'Review the tool results below because the model did not produce a final natural-language summary before the limit was reached.',
          '',
          ...this.executedTools.map(tool => `[${tool.tool}]: ${tool.content}`),
        ].join('\n\n'),
        error: `Max iterations (${this.config.maxIterations}) reached after workspace edits were attempted.`,
      };
    }

    return {
      response: `Planning reached maximum iterations (${this.config.maxIterations}). Here is the accumulated work:\n\n${this.executedTools.map(t => `[${t.tool}]: ${t.content}`).join('\n\n')}`,
      error: `Max iterations (${this.config.maxIterations}) reached.`,
    };
  }

  /**
   * Main entry point: runs the planning loop.
   */
  async plan(
    userMessage: string,
    chatHistory: LmStudioMessage[],
    modelProvider: (messages: LmStudioMessage[], tools: ToolDefinition[]) => Promise<string>,
    cancellationToken?: vscode.CancellationToken
  ): Promise<PlanningResult> {
    // Initialize messages with system prompt
    const fyiInstructions = this.config.fyiInstructionPath
      ? await loadFyiInstructions(this.config.fyiInstructionPath)
      : '';

    const systemPrompt = generateAgentSystemPrompt(
      this.registry.getAll(),
      this.context.workspaceRoot,
      fyiInstructions
    );

    this.messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory.map(msg => ({
        role: normalizePlannerRole(msg.role),
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })),
      { role: 'user', content: userMessage },
    ];

    this.executedTools = [];
    this.iteration = 0;
    this.explorationWarningIssued = false;
    const requiresWorkspaceChanges = taskLikelyRequiresWorkspaceChanges(userMessage);
    const documentationTask = taskLikelyTargetsDocumentation(userMessage);
    const projectSetupTask = taskLikelyTargetsProjectSetup(userMessage);

    try {
      while (this.iteration < this.config.maxIterations) {
        this.iteration++;

        this.outputChannel.appendLine(`[Planner] Planner running (round ${this.iteration}, max ${this.config.maxIterations})`);
        this.context.onProgress?.({ type: 'iteration', iteration: this.iteration });

        // Check cancellation
        if (cancellationToken?.isCancellationRequested) {
          return {
            response: 'Planning cancelled by user.',
            toolCalls: this.executedTools.map(t => ({
              callId: t.callId,
              tool: t.tool,
              input: t.input ?? {},
              result: t.content,
              success: t.success,
            })),
            iterations: this.iteration,
            success: false,
            error: 'Cancelled by user.',
          };
        }

        // Get model response
        const lmMessages = toLmStudioMessages(this.messages);
        const response = await modelProvider(lmMessages, this.registry.getAll());

        if (cancellationToken?.isCancellationRequested) {
          return {
            response: 'Planning cancelled by user.',
            toolCalls: this.executedTools.map(t => ({
              callId: t.callId,
              tool: t.tool,
              input: t.input ?? {},
              result: t.content,
              success: t.success,
            })),
            iterations: this.iteration,
            success: false,
            error: 'Cancelled by user.',
          };
        }

        // Parse response
        const parsed = parseModelOutput(response, this.registry.getAll());

        if (parsed.response) {
          const hasSuccessfulWorkspaceAction = this.executedTools.some(tool =>
            tool.success && ReActPlanner.PERSISTENT_CHANGE_TOOL_NAMES.has(tool.tool),
          );
          const hasOnlyFailedTools = this.executedTools.length > 0 && this.executedTools.every(tool => !tool.success);
          const hasOnlyExploratoryTools = this.executedTools.length > 0 && this.executedTools.every(tool =>
            tool.success && ReActPlanner.EXPLORATORY_TOOL_NAMES.has(tool.tool),
          );
          const unfinishedProjectSetupResponse = projectSetupTask &&
            !hasSuccessfulWorkspaceAction &&
            responseLooksLikeIncompleteProgressNote(parsed.response);
          const taskRestatementWithoutChanges = requiresWorkspaceChanges &&
            !hasSuccessfulWorkspaceAction &&
            responseLooksLikeTaskRestatement(parsed.response);
          const exploratoryCompletionClaim = requiresWorkspaceChanges &&
            !hasSuccessfulWorkspaceAction &&
            hasOnlyExploratoryTools &&
            !responseLooksLikeLegitimateNoChangeConclusion(parsed.response);
          const needsPostEditValidation = requiresWorkspaceChanges &&
            !documentationTask &&
            hasSuccessfulWorkspaceAction &&
            !this.hasValidationAfterLastPersistentChange() &&
            !responseLooksLikeLegitimateNoChangeConclusion(parsed.response);
          const unsupportedCompletionClaim = requiresWorkspaceChanges &&
            !hasSuccessfulWorkspaceAction &&
            hasOnlyFailedTools &&
            !responseLooksLikeLegitimateNoChangeConclusion(parsed.response);

          if (
            unfinishedProjectSetupResponse ||
            taskRestatementWithoutChanges ||
            exploratoryCompletionClaim ||
            needsPostEditValidation ||
            unsupportedCompletionClaim
          ) {
            // This branch is heuristic planner recovery, not a VS Code or LM Studio protocol
            // guarantee. It defends against common local-model failure modes such as progress
            // narration, task restatement, or completion claims after read-only exploration.
            this.outputChannel.appendLine('[Planner] Incomplete progress note detected; requesting a concrete tool call or completed final answer');
            this.messages.push({
              role: 'user',
              content: needsPostEditValidation
                ? 'Before you finish, validate the most recent code changes. Read back the file you just changed so you can confirm the final contents, then provide the final response. Do not stop immediately after a write on code tasks.'
                : exploratoryCompletionClaim
                ? 'Your last response cannot be accepted as completion because you have only used read/search tools so far and no file-writing action has succeeded. Do not describe updates as if they already happened. Either call write_project_files, write_file, or apply_workspace_edit next with concrete arguments, or explicitly explain that no changes are needed.'
                : unsupportedCompletionClaim
                ? 'Your last response cannot be accepted as completion because every tool call so far has failed and no file-writing action has succeeded. Do not claim completion yet. Either call the next tool with valid arguments, or explicitly explain the blocker and why no files were changed.'
                : taskRestatementWithoutChanges
                ? 'Your last response repeated the requested task instead of completing it. Do not restate the request. Call the next concrete tool with valid arguments, usually write_project_files for multiple new files or write_file with both path and full content for a single file, or return a final response only after the work is actually done.'
                : documentationTask
                ? 'Your last response described intended next steps, but the task still appears to require documentation changes and no write/edit action has succeeded yet. Do not stop here. After reading the target file, prefer write_file with the full updated file content for documentation-heavy updates. Use apply_workspace_edit only for small precise patches. Return a final response only after the work is complete or if no changes are needed.'
                : projectSetupTask
                  ? 'Your last response described intended next steps, but the task still appears to require creating or updating project files and no file-writing action has succeeded yet. Do not stop here. Prefer write_project_files when creating several new files together, or write_file for a single file, unless you know a specific VS Code command exists for the setup step. Return a final response only after the files are actually created or if no changes are needed.'
                : 'Your last response described intended next steps, but the task still appears to require workspace changes and no write/edit action has succeeded yet. Do not stop here. Call write_file, write_project_files, or apply_workspace_edit next with concrete arguments, or return a final response only if you have finished the task and no changes are needed.',
            });
            continue;
          }

          // Final response from model
          this.messages.push({ role: 'assistant', content: parsed.response });
          this.context.onProgress?.({ type: 'complete', message: parsed.response });

          return {
            response: parsed.response,
            toolCalls: this.executedTools.map(t => ({
              callId: t.callId,
              tool: t.tool,
              input: t.input ?? {},
              result: t.content,
              success: t.success,
            })),
            iterations: this.iteration,
            success: true,
          };
        }

        if (parsed.tool) {
          // Execute tool call
          const toolName = parsed.tool.tool;
          const toolInput = parsed.tool.arguments;
          const toolCallId = this.createPlannerToolCallId();

          this.outputChannel.appendLine(`[Planner] Executing tool: ${toolName}`);
          this.context.onProgress?.({
            type: 'toolCall',
            callId: toolCallId,
            toolName,
            toolInput,
          });

          // Find tool definition
          const toolDef = this.registry.get(toolName);
          if (!toolDef) {
            this.outputChannel.appendLine(`[Planner] Error: Tool '${toolName}' not found`);
            this.messages.push({
              role: 'user',
              content: `Error: Tool '${toolName}' is not available. Please use one of the available tools.`,
            });
            continue;
          }

          // Execute tool
          const blockedOverwritePath = this.shouldBlockRepeatedWholeFileOverwrite(toolName, toolInput);
          const toolResult = blockedOverwritePath
            ? {
                callId: '',
                tool: toolName,
                input: toolInput,
                content: `Error: Refusing repeated whole-file overwrite for '${blockedOverwritePath}' without an intervening read_file validation step. Read the file first if another full rewrite is still required.`,
                success: false,
                error: `Repeated whole-file overwrite blocked for ${blockedOverwritePath}`,
              }
            : await this.registry.execute(toolDef, toolInput, this.context);
          const boundedToolResult = {
            ...toolResult,
            callId: toolResult.callId || toolCallId,
            input: toolInput,
            content: truncateToolResult(toolResult.content, this.config.maxToolResultTokens),
          };
          this.executedTools.push(boundedToolResult);

          this.context.onProgress?.({
            type: 'toolResult',
            callId: boundedToolResult.callId,
            toolName,
            toolInput,
            toolSuccess: boundedToolResult.success,
            toolResult: boundedToolResult.content.slice(0, 500), // Truncate for progress
          });

          // Add tool result to messages
          this.messages.push({
            role: 'assistant',
            content: JSON.stringify({
              type: 'toolCall',
              toolCall: { callId: boundedToolResult.callId, name: toolName, input: toolInput },
            }),
          });

          this.messages.push({
            role: 'user',
            content: boundedToolResult.content,
          });

          if (this.shouldWarnAboutExplorationLoop()) {
            this.explorationWarningIssued = true;
            this.messages.push({
              role: 'user',
              content: documentationTask
                ? 'Planner reminder: you have already used several exploratory tools. Stop gathering broad context unless it is strictly necessary. For documentation-heavy updates, prefer write_file with the full updated file content after you have read the target file. Use apply_workspace_edit only for small precise fixes. If no change is needed, return a final response now.'
                : 'Planner reminder: you have already used several exploratory tools. Stop gathering broad context unless it is strictly necessary. If the task requires edits, use write_project_files for multiple new files, write_file for a single full-file change, or apply_workspace_edit for small precise patches. If no change is needed, return a final response now.',
            });
          }

          if (toolName === 'apply_workspace_edit' && !boundedToolResult.success) {
            this.messages.push({
              role: 'user',
              content: documentationTask
                ? 'The apply_workspace_edit call failed. For documentation-heavy updates, switch to write_file with the full updated file content after reading the target file. If you still use apply_workspace_edit, each replace edit must provide file, range.startLine, range.endLine, and content, and each insert edit must provide file, range.startLine, and content.'
                : 'The apply_workspace_edit call failed. For each replace edit you must provide file, range.startLine, range.endLine, and content. For each insert edit you must provide file, range.startLine, and content. If precise ranges are too hard, use write_file with the full updated file content instead of a partial workspace edit.',
            });
          }

          const toolFailureRecoveryMessage = !boundedToolResult.success
            ? buildToolFailureRecoveryMessage(toolName, boundedToolResult, this.executedTools)
            : undefined;
          if (toolFailureRecoveryMessage) {
            this.messages.push({
              role: 'user',
              content: toolFailureRecoveryMessage,
            });
          }

          const repeatedFailureLoop = this.getRepeatedFailureLoopCount();
          if (repeatedFailureLoop?.count === 2) {
            this.messages.push({
              role: 'user',
              content: `You just repeated the same failing '${repeatedFailureLoop.toolName}' action on ${repeatedFailureLoop.targetDescription}. Do not try the same failing action again. Change strategy, fix the arguments, or validate the file before another overwrite.`,
            });
          }

          if (repeatedFailureLoop && repeatedFailureLoop.count >= 3) {
            const repeatedFailureMessage = `Planner stopped after repeating the same failing '${repeatedFailureLoop.toolName}' action on ${repeatedFailureLoop.targetDescription} ${repeatedFailureLoop.count} times in a row.`;
            this.outputChannel.appendLine(`[Planner] ${repeatedFailureMessage}`);
            return {
              response: [
                repeatedFailureMessage,
                '',
                'Recent tool results:',
                ...this.executedTools.slice(-Math.min(3, this.executedTools.length)).map(tool => `[${tool.tool}]: ${tool.content}`),
              ].join('\n'),
              toolCalls: this.executedTools.map(t => ({
                callId: t.callId,
                tool: t.tool,
                input: t.input ?? {},
                result: t.content,
                success: t.success,
              })),
              iterations: this.iteration,
              success: false,
              error: repeatedFailureMessage,
            };
          }

          this.outputChannel.appendLine(
            boundedToolResult.success
              ? `[Planner] Tool '${toolName}' completed successfully`
              : `[Planner] Tool '${toolName}' completed with error`,
          );
        } else {
          // Could not parse response as tool call or final answer
          this.outputChannel.appendLine(`[Planner] Warning: Could not parse model output, retrying...`);
          this.messages.push({
            role: 'user',
            content: `I did not understand your response. Please either provide a final answer in the format {"response": "..."} or make a tool call in the format {"tool": "tool_name", "arguments": {...}}.`,
          });
        }
      }

      // Max iterations reached
      const maxIterationsResult = this.buildMaxIterationsResponse();
      return {
        response: maxIterationsResult.response,
        toolCalls: this.executedTools.map(t => ({
          callId: t.callId,
          tool: t.tool,
          input: t.input ?? {},
          result: t.content,
          success: t.success,
        })),
        iterations: this.iteration,
        success: false,
        error: maxIterationsResult.error,
      };
    } catch (error) {
      const err = error as Error;
      this.outputChannel.appendLine(`[Planner] Error: ${err.message}`);
      return {
        response: `Planning error: ${err.message}`,
        toolCalls: this.executedTools.map(t => ({
          callId: t.callId,
          tool: t.tool,
          input: t.input ?? {},
          result: t.content,
          success: t.success,
        })),
        iterations: this.iteration,
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Gets the current state of the planner.
   */
  getState(): {
    iteration: number;
    messageCount: number;
    executedToolCount: number;
  } {
    return {
      iteration: this.iteration,
      messageCount: this.messages.length,
      executedToolCount: this.executedTools.length,
    };
  }
}

// ─── Planner Factory ───────────────────────────────────────────────────────────

export function createPlanner(
  config: PlannerConfig,
  context: PlannerContext,
  outputChannel: vscode.OutputChannel,
  registry?: ToolRegistry,
): ReActPlanner {
  return new ReActPlanner(config, context, outputChannel, registry);
}
