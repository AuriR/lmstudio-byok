/**
 * Tool registry for the planning harness.
 */

import {
  PlannerContext,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '../types';
import {
  APPLY_WORKSPACE_EDIT_TOOL,
  READ_FILE_TOOL,
  RUN_VSCODE_COMMAND_TOOL,
  SEARCH_WORKSPACE_TOOL,
  WRITE_FILE_TOOL,
  WRITE_PROJECT_FILES_TOOL,
} from './definitions';
import {
  executeApplyWorkspaceEdit,
  executeReadFile,
  executeRunVsCodeCommand,
  executeSearchWorkspace,
  executeWriteFile,
  executeWriteProjectFiles,
} from './executors';
import {
  isToolExecutionFailureResult,
  normalizeToolInput,
  SimpleObjectSchema,
  validateToolInput,
} from './utils';

export class DefaultToolRegistry {
  private tools = new Map<string, { definition: ToolDefinition; executor: ToolExecutor }>();

  constructor(allowedToolNames?: readonly string[]) {
    // Some callers, such as the debug-only planner smoke test, need to exercise the real planner
    // loop without exposing write-capable tools. This constructor-level allow-list keeps the safety
    // rule close to the registry rather than depending on model compliance.
    const allowedTools = allowedToolNames ? new Set(allowedToolNames) : undefined;
    const registerIfAllowed = (tool: ToolDefinition, executor: ToolExecutor) => {
      if (!allowedTools || allowedTools.has(tool.name)) {
        this.register(tool, executor);
      }
    };

    registerIfAllowed(READ_FILE_TOOL, executeReadFile);
    registerIfAllowed(WRITE_FILE_TOOL, executeWriteFile);
    registerIfAllowed(WRITE_PROJECT_FILES_TOOL, executeWriteProjectFiles);
    registerIfAllowed(APPLY_WORKSPACE_EDIT_TOOL, executeApplyWorkspaceEdit);
    registerIfAllowed(RUN_VSCODE_COMMAND_TOOL, executeRunVsCodeCommand);
    registerIfAllowed(SEARCH_WORKSPACE_TOOL, executeSearchWorkspace);
  }

  register(tool: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(tool.name, { definition: tool, executor });
  }

  unregister(toolName: string): void {
    this.tools.delete(toolName);
  }

  get(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName)?.definition;
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter(({ definition }) => definition.enabled)
      .map(({ definition }) => definition);
  }

  async execute(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<ToolResult> {
    const registered = this.tools.get(tool.name);
    if (!registered) {
      return {
        callId: '',
        tool: tool.name,
        input,
        content: `Error: Tool '${tool.name}' is not registered.`,
        success: false,
        error: `Tool '${tool.name}' not found in registry.`,
      };
    }

    try {
      const normalizedInput = normalizeToolInput(input);
      const validationErrors = validateToolInput(tool, normalizedInput);
      if (validationErrors.length > 0) {
        const allowedProperties = Object.keys((tool.inputSchema as SimpleObjectSchema).properties ?? {});
        return {
          callId: '',
          tool: tool.name,
          input: normalizedInput,
          content: `Error: Invalid arguments for '${tool.name}': ${validationErrors.join('; ')}.${allowedProperties.length > 0 ? ` Allowed arguments: ${allowedProperties.join(', ')}.` : ''}`,
          success: false,
          error: validationErrors.join('; '),
        };
      }

      const result = await registered.executor(tool, normalizedInput, context);
      const success = !isToolExecutionFailureResult(result);
      return {
        callId: '',
        tool: tool.name,
        input: normalizedInput,
        content: result,
        success,
        error: success ? undefined : result,
      };
    } catch (error) {
      const err = error as Error;
      return {
        callId: '',
        tool: tool.name,
        input,
        content: `Error executing tool '${tool.name}': ${err.message}`,
        success: false,
        error: err.message,
      };
    }
  }
}

export const BUILTIN_TOOLS: ToolDefinition[] = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  WRITE_PROJECT_FILES_TOOL,
  APPLY_WORKSPACE_EDIT_TOOL,
  RUN_VSCODE_COMMAND_TOOL,
  SEARCH_WORKSPACE_TOOL,
];