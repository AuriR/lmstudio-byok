/**
 * Built-in tools for the planning harness.
 * Provides file operations, workspace search, and VS Code command execution.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  ToolDefinition,
  ToolExecutor,
  PlannerContext,
  ToolResult,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type SimpleSchemaProperty = {
  type?: string;
  enum?: unknown[];
  items?: { type?: string };
  minItems?: number;
  maxItems?: number;
};

type SimpleObjectSchema = {
  type?: string;
  properties?: Record<string, SimpleSchemaProperty>;
  required?: string[];
};

function normalizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const nestedInput = isRecord(input.input)
    ? input.input
    : isRecord(input.arguments)
      ? input.arguments
      : undefined;

  if (!nestedInput) {
    return input;
  }

  const { input: _input, arguments: _arguments, ...rest } = input;
  return {
    ...nestedInput,
    ...rest,
  };
}

function normalizeWorkspacePath(filePath: string, workspaceRoot: string | undefined): string {
  let normalizedPath = filePath.trim();

  // Local models sometimes emit POSIX-looking Windows paths such as /c:/foo/bar.
  // Normalize those before checking absoluteness so they do not get joined onto the workspace root.
  if (/^\/[A-Za-z]:[\\/]/.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(1);
  }

  if (/^file:\/\//i.test(normalizedPath)) {
    try {
      normalizedPath = vscode.Uri.parse(normalizedPath).fsPath;
    } catch {
      normalizedPath = normalizedPath.replace(/^file:\/\//i, '');
    }
  }

  normalizedPath = normalizedPath.replace(/\//g, path.sep);

  if (!path.isAbsolute(normalizedPath) && workspaceRoot) {
    return path.join(workspaceRoot, normalizedPath);
  }

  return normalizedPath;
}

function normalizeEditRange(range: unknown): { startLine: number; endLine: number } | undefined {
  if (Array.isArray(range)) {
    const startLine = typeof range[0] === 'number' ? Math.floor(range[0]) : undefined;
    const endLine = typeof range[1] === 'number' ? Math.floor(range[1]) : undefined;
    if (startLine !== undefined && endLine !== undefined) {
      return { startLine, endLine };
    }
    return undefined;
  }

  if (isRecord(range)) {
    const startLine = typeof range.startLine === 'number' ? Math.floor(range.startLine) : undefined;
    const endLine = typeof range.endLine === 'number' ? Math.floor(range.endLine) : undefined;
    if (startLine !== undefined && endLine !== undefined) {
      return { startLine, endLine };
    }
  }

  return undefined;
}

function valueMatchesSchemaType(value: unknown, expectedType: string | undefined): boolean {
  if (!expectedType) {
    return true;
  }

  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

function validateToolInput(tool: ToolDefinition, input: Record<string, unknown>): string[] {
  // This validation is extension-defined guardrail logic, not a VS Code requirement. The
  // planner protocol is our own surface, so we validate obvious schema issues before invoking
  // file system or command APIs and returning harder-to-recover runtime failures.
  const schema = tool.inputSchema as SimpleObjectSchema;
  const errors: string[] = [];

  if (schema.type === 'object' && !isRecord(input)) {
    return ['arguments must be a JSON object'];
  }

  const properties = schema.properties ?? {};
  const requiredFields = Array.isArray(schema.required) ? schema.required : [];

  for (const fieldName of requiredFields) {
    const value = input[fieldName];
    const property = properties[fieldName];
    const missingStringValue = property?.type === 'string' && typeof value === 'string' && value.trim() === '';

    if (value === undefined || value === null || missingStringValue) {
      errors.push(`missing required argument "${fieldName}"`);
    }
  }

  for (const [fieldName, property] of Object.entries(properties)) {
    if (!(fieldName in input)) {
      continue;
    }

    const value = input[fieldName];
    if (!valueMatchesSchemaType(value, property.type)) {
      errors.push(`argument "${fieldName}" must be of type ${property.type}`);
      continue;
    }

    if (property.enum && !property.enum.includes(value)) {
      errors.push(`argument "${fieldName}" must be one of: ${property.enum.join(', ')}`);
    }

    if (property.type === 'array' && Array.isArray(value)) {
      if (typeof property.minItems === 'number' && value.length < property.minItems) {
        errors.push(`argument "${fieldName}" must contain at least ${property.minItems} item(s)`);
      }

      if (typeof property.maxItems === 'number' && value.length > property.maxItems) {
        errors.push(`argument "${fieldName}" must contain at most ${property.maxItems} item(s)`);
      }

      if (property.items?.type) {
        const invalidItem = value.find(item => !valueMatchesSchemaType(item, property.items?.type));
        if (invalidItem !== undefined) {
          errors.push(`all items in "${fieldName}" must be of type ${property.items.type}`);
        }
      }
    }
  }

  return errors;
}

function contentLooksLikePlaceholderOrWrappedSnippet(content: string): boolean {
  const normalizedContent = content.trim();

  if (normalizedContent.startsWith('```') || normalizedContent.endsWith('```')) {
    return true;
  }

  return /\.\.\.\s*existing code\s*\.\.\.|\brest of (?:the )?code\b|\bunchanged code\b|\bexisting implementation\b|^\s*(?:\/\/|#|\/\*)\s*replaced\b|\bomitted\b|\bplaceholder\b/i.test(normalizedContent);
}

function isToolExecutionFailureResult(result: string): boolean {
  const normalized = result.trimStart();
  if (normalized.startsWith('Error:')) {
    return true;
  }

  const appliedEditsMatch = normalized.match(/^Applied\s+(\d+)\/(\d+)\s+edits:/);
  if (appliedEditsMatch) {
    const appliedCount = Number(appliedEditsMatch[1]);
    const requestedCount = Number(appliedEditsMatch[2]);
    return !Number.isFinite(appliedCount) || !Number.isFinite(requestedCount) || appliedCount < requestedCount;
  }

  return false;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

export const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file at the specified path. Use this to examine file contents before making changes. This tool reads files only, not directories.',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The absolute or relative path to the file to read.',
      },
      startLine: {
        type: 'number',
        description: 'Optional 1-based start line for partial reads.',
      },
      endLine: {
        type: 'number',
        description: 'Optional 1-based end line for partial reads.',
      },
      range: {
        type: 'array',
        description: 'Optional [startLine, endLine] pair for partial reads. Local models sometimes emit this shorter form.',
        items: {
          type: 'number',
        },
        minItems: 2,
        maxItems: 2,
      },
    },
    required: ['path'],
  } as object,
};

export const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file at the specified path. Creates the file if it does not exist, or overwrites if it does. Prefer this for whole-file rewrites such as markdown or documentation updates after reading the current file.',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The absolute or relative path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file.',
      },
    },
    required: ['path', 'content'],
  } as object,
};

export const WRITE_PROJECT_FILES_TOOL: ToolDefinition = {
  name: 'write_project_files',
  description: 'Create or update multiple files in one tool call. Prefer this for project scaffolding or whenever you need to create several files together, such as package.json plus src files for a new app.',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Array of files to write. Each item must include path and content.',
        items: {
          type: 'object',
        },
        minItems: 1,
      },
      overwrite: {
        type: 'boolean',
        description: 'Whether existing files may be overwritten. Defaults to false.',
      },
    },
    required: ['files'],
  } as object,
};

export const APPLY_WORKSPACE_EDIT_TOOL: ToolDefinition = {
  name: 'apply_workspace_edit',
  description: 'Apply a workspace edit to modify one or more files. Use this for precise code modifications like adding, removing, or replacing text.',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: 'Array of edit operations to apply.',
        items: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'The file path to edit.',
            },
            operation: {
              type: 'string',
              enum: ['insert', 'replace', 'delete'],
              description: 'The type of edit operation.',
            },
            range: {
              type: 'object',
              properties: {
                startLine: { type: 'number' },
                endLine: { type: 'number' },
              },
            },
            content: {
              type: 'string',
              description: 'The content to insert or replace with.',
            },
          },
          required: ['file', 'operation'],
        },
      },
    },
    required: ['edits'],
  } as object,
};

export const RUN_VSCODE_COMMAND_TOOL: ToolDefinition = {
  name: 'run_vscode_command',
  description: 'Execute a VS Code command by its ID. Use this only for real built-in or extension command IDs that already exist in the current VS Code environment. Do not use it as a generic shell or terminal runner.',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The ID of the VS Code command to execute.',
      },
      args: {
        type: 'array',
        description: 'Optional arguments to pass to the command.',
        items: { type: 'string' },
      },
    },
    required: ['command'],
  } as object,
};

export const SEARCH_WORKSPACE_TOOL: ToolDefinition = {
  name: 'search_workspace',
  description: 'Search for text patterns across all files in the workspace using grep-style matching.',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The text pattern to search for (supports regex).',
      },
      filePattern: {
        type: 'string',
        description: 'Optional glob pattern to filter files (e.g., "*.ts").',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 50).',
      },
    },
    required: ['pattern'],
  } as object,
};

// ─── Tool Executors ────────────────────────────────────────────────────────────

async function executeReadFile(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
  const normalizedInput = normalizeToolInput(input);
  const filePath = normalizedInput.path as string;
  if (!filePath) {
    return 'Error: "path" argument is required.';
  }

  // Resolve relative paths against workspace root
  const resolvedPath = normalizeWorkspacePath(filePath, context.workspaceRoot);

  try {
    const stats = fs.statSync(resolvedPath);

    if (stats.isDirectory()) {
      // Local models sometimes probe the workspace root with read_file first. Return a
      // structured failure plus a small directory listing so the next tool call can recover.
      const directoryEntries = fs.readdirSync(resolvedPath, { withFileTypes: true })
        .slice(0, 20)
        .map(entry => `${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}`);
      const entriesSection = directoryEntries.length > 0
        ? `\nEntries:\n${directoryEntries.join('\n')}`
        : '\nEntries:\n(empty directory)';

      return [
        `Error: '${filePath}' is a directory, not a file.`,
        'Use read_file with a concrete file path, or use search_workspace to find a relevant file first.',
        entriesSection,
      ].join('\n');
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const sizeKB = (stats.size / 1024).toFixed(2);
    const lines = content.split(/\r?\n/);
    const explicitStartLine = typeof normalizedInput.startLine === 'number' ? normalizedInput.startLine : undefined;
    const explicitEndLine = typeof normalizedInput.endLine === 'number' ? normalizedInput.endLine : undefined;
    const range = Array.isArray(normalizedInput.range) ? normalizedInput.range : undefined;
    const rangeStartLine = typeof range?.[0] === 'number' ? range[0] : undefined;
    const rangeEndLine = typeof range?.[1] === 'number' ? range[1] : undefined;
    const startLine = Math.max(1, Math.floor(explicitStartLine ?? rangeStartLine ?? 1));
    const endLine = Math.min(lines.length, Math.floor(explicitEndLine ?? rangeEndLine ?? lines.length));

    // Some planner-capable local models naturally ask for a focused line range instead of the
    // entire file. Support that directly so the planner can keep moving without inventing a
    // different tool-call wrapper first.
    const selectedLines = startLine <= endLine
      ? lines.slice(startLine - 1, endLine)
      : lines;
    const contentPrefix = startLine <= endLine && (startLine !== 1 || endLine !== lines.length)
      ? `Content (${startLine}-${endLine}):`
      : 'Content:';

    return `File: ${resolvedPath}\nSize: ${sizeKB} KB\nLines: ${lines.length}\n\n${contentPrefix}\n${selectedLines.join('\n')}`;
  } catch (error) {
    const err = error as Error;
    return `Error: Error reading file '${filePath}': ${err.message}`;
  }
}

async function executeWriteFile(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
  const normalizedInput = normalizeToolInput(input);
  const filePath = normalizedInput.path as string;
  const content = normalizedInput.content as string;

  if (!filePath) {
    return 'Error: "path" argument is required.';
  }
  if (content === undefined || content === null) {
    return 'Error: "content" argument is required.';
  }

  // Resolve relative paths against workspace root
  const resolvedPath = normalizeWorkspacePath(filePath, context.workspaceRoot);

  if (contentLooksLikePlaceholderOrWrappedSnippet(content)) {
    return 'Error: write_file content appears to contain placeholder or markdown wrapper text. Provide the exact final file contents only, with no elisions such as "...existing code..." and no fenced code blocks.';
  }

  try {
    // Ensure parent directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, content, 'utf-8');
    const lines = content.split('\n').length;
    return `Successfully wrote ${content.length} characters (${lines} lines) to ${resolvedPath}`;
  } catch (error) {
    const err = error as Error;
    return `Error: Error writing file '${filePath}': ${err.message}`;
  }
}

async function executeWriteProjectFiles(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
  const normalizedInput = normalizeToolInput(input);
  const files = normalizedInput.files;
  const overwrite = normalizedInput.overwrite === true;

  if (!Array.isArray(files) || files.length === 0) {
    return 'Error: "files" array is required and must be non-empty.';
  }

  const normalizedFiles: Array<{ path: string; resolvedPath: string; content: string }> = [];
  const seenResolvedPaths = new Set<string>();

  for (const [index, file] of files.entries()) {
    if (!isRecord(file)) {
      return `Error: files[${index}] must be an object with "path" and "content".`;
    }

    const filePath = typeof file.path === 'string' ? file.path.trim() : '';
    const content = typeof file.content === 'string' ? file.content : undefined;

    if (!filePath) {
      return `Error: files[${index}].path is required and must be a non-empty string.`;
    }

    if (content === undefined) {
      return `Error: files[${index}].content is required and must be a string.`;
    }

    if (contentLooksLikePlaceholderOrWrappedSnippet(content)) {
      return `Error: files[${index}].content appears to contain placeholder or markdown wrapper text. Provide the exact final file contents only, with no elisions such as "...existing code..." and no fenced code blocks.`;
    }

    const resolvedPath = normalizeWorkspacePath(filePath, context.workspaceRoot);
    if (seenResolvedPaths.has(resolvedPath)) {
      return `Error: Duplicate file path detected in write_project_files: ${filePath}`;
    }

    seenResolvedPaths.add(resolvedPath);
    normalizedFiles.push({ path: filePath, resolvedPath, content });
  }

  if (!overwrite) {
    // Validate the full batch before writing anything so scaffold calls fail fast instead of
    // partially creating a project and leaving the planner to infer which files were skipped.
    const existingFile = normalizedFiles.find(file => fs.existsSync(file.resolvedPath));
    if (existingFile) {
      return `Error: File already exists: ${existingFile.path}. Retry with overwrite=true only if replacing existing files is intentional.`;
    }
  }

  const results: string[] = [];
  let successCount = 0;

  for (const file of normalizedFiles) {
    try {
      const dir = path.dirname(file.resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(file.resolvedPath, file.content, 'utf-8');
      const lines = file.content.split(/\r?\n/).length;
      results.push(`✓ Wrote ${file.path} (${lines} lines)`);
      successCount++;
    } catch (error) {
      const err = error as Error;
      results.push(`✗ Error writing ${file.path}: ${err.message}`);
    }
  }

  const summary = `Wrote ${successCount}/${normalizedFiles.length} files:\n${results.join('\n')}`;
  if (successCount < normalizedFiles.length) {
    return `Error: ${summary}`;
  }

  return summary;
}

async function executeApplyWorkspaceEdit(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
  const normalizedInput = normalizeToolInput(input);
  const edits = normalizedInput.edits as Array<{
    file: string;
    operation: 'insert' | 'replace' | 'delete';
    range?: { startLine: number; endLine: number } | [number, number];
    content?: string;
  }>;

  if (!edits || !Array.isArray(edits) || edits.length === 0) {
    return 'Error: "edits" array is required and must be non-empty.';
  }

  const results: string[] = [];
  let successCount = 0;

  for (const edit of edits) {
    try {
      const normalizedRange = normalizeEditRange(edit.range);

      if (!edit.file) {
        results.push('✗ Each edit requires a "file" path.');
        continue;
      }

      if (edit.operation === 'insert' && (!normalizedRange || edit.content === undefined)) {
        results.push(`✗ Insert edit for ${edit.file} requires both "range.startLine" and "content".`);
        continue;
      }

      if (edit.operation === 'replace' && (!normalizedRange || edit.content === undefined)) {
        results.push(`✗ Replace edit for ${edit.file} requires "range.startLine", "range.endLine", and "content".`);
        continue;
      }

      if (edit.operation === 'delete' && !normalizedRange) {
        results.push(`✗ Delete edit for ${edit.file} requires "range.startLine" and "range.endLine".`);
        continue;
      }

      // Resolve file path
      const resolvedPath = normalizeWorkspacePath(edit.file, context.workspaceRoot);

      // Get document
      const uri = vscode.Uri.file(resolvedPath);
      let document = await vscode.workspace.openTextDocument(uri);
      const editBuilder = new vscode.WorkspaceEdit();

      switch (edit.operation) {
        case 'insert':
          if (normalizedRange && edit.content !== undefined) {
            const insertPos = document.positionAt(
              document.getText(new vscode.Range(0, 0, normalizedRange.startLine, 0)).length
            );
            editBuilder.insert(uri, insertPos, edit.content);
          }
          break;

        case 'replace':
          if (normalizedRange && edit.content !== undefined) {
            const start = document.positionAt(
              document.getText(new vscode.Range(0, 0, normalizedRange.startLine, 0)).length
            );
            const end = document.positionAt(
              document.getText(new vscode.Range(0, 0, normalizedRange.endLine + 1, 0)).length
            );
            editBuilder.replace(uri, new vscode.Range(start, end), edit.content);
          }
          break;

        case 'delete':
          if (normalizedRange) {
            const start = document.positionAt(
              document.getText(new vscode.Range(0, 0, normalizedRange.startLine, 0)).length
            );
            const end = document.positionAt(
              document.getText(new vscode.Range(0, 0, normalizedRange.endLine + 1, 0)).length
            );
            editBuilder.delete(uri, new vscode.Range(start, end));
          }
          break;
      }

      const applied = await vscode.workspace.applyEdit(editBuilder);
      if (applied) {
        // Save the document
        await document.save();
        results.push(`✓ Applied ${edit.operation} to ${edit.file}`);
        successCount++;
      } else {
        results.push(`✗ Failed to apply ${edit.operation} to ${edit.file}`);
      }
    } catch (error) {
      const err = error as Error;
      results.push(`✗ Error applying edit to ${edit.file}: ${err.message}`);
    }
  }

  const summary = `Applied ${successCount}/${edits.length} edits:\n${results.join('\n')}`;
  if (successCount < edits.length) {
    return `Error: ${summary}`;
  }

  return summary;
}

async function executeRunVsCodeCommand(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
  const normalizedInput = normalizeToolInput(input);
  const command = normalizedInput.command as string;
  const args = normalizedInput.args as string[];

  if (!command) {
    return 'Error: "command" argument is required.';
  }

  try {
    // This part is spec-backed extension behavior: the VS Code commands API exposes the set
    // of currently available command IDs, so we can verify the command exists before executing it.
    const availableCommands = await vscode.commands.getCommands(true);
    if (!availableCommands.includes(command)) {
      return `Error: VS Code command '${command}' is not available in this environment.`;
    }

    const result = await vscode.commands.executeCommand(command, ...(args || []));
    return `Command '${command}' executed successfully. Result: ${JSON.stringify(result, null, 2)}`;
  } catch (error) {
    const err = error as Error;
    return `Error executing command '${command}': ${err.message}`;
  }
}

async function executeSearchWorkspace(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
  const normalizedInput = normalizeToolInput(input);
  const pattern = normalizedInput.pattern as string;
  const filePattern = normalizedInput.filePattern as string | undefined;
  const maxResults = (normalizedInput.maxResults as number) || 50;

  if (!pattern) {
    return 'Error: "pattern" argument is required.';
  }

  try {
    const searchPattern = filePattern ? `**/${filePattern}` : '**/*';
    const excludePattern = filePattern ? undefined : '**/{node_modules,out,dist,.git}/**';
    const fileUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(context.workspaceRoot || '.', searchPattern),
      excludePattern,
      maxResults * 4,
    );

    const regex = (() => {
      try {
        return new RegExp(pattern, 'gi');
      } catch {
        const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escapedPattern, 'gi');
      }
    })();

    const results: Array<{ file: string; line: number; text: string; }> = [];

    for (const fileUri of fileUris) {
      let content: string;

      try {
        content = fs.readFileSync(fileUri.fsPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) {
          continue;
        }

        results.push({
          file: fileUri.fsPath,
          line: index + 1,
          text: lines[index],
        });

        if (results.length >= maxResults) {
          break;
        }
      }

      regex.lastIndex = 0;

      if (results.length >= maxResults) {
        break;
      }
    }

    if (results.length === 0) {
      return `No matches found for '${pattern}'.`;
    }

    const output = results.map(result => {
      const text = result.text;
      const line = result.line;
      const matchIndex = text.toLowerCase().indexOf(pattern.toLowerCase());
      const contextStart = Math.max(0, matchIndex - 50);
      const contextEnd = Math.min(text.length, matchIndex + pattern.length + 50);
      const preview = text.substring(contextStart, contextEnd);
      return `${result.file}:${line}\n  ...${preview}...\n`;
    }).join('\n');

    return `Found ${results.length} matches:\n${output}`;
  } catch (error) {
    const err = error as Error;
    return `Error searching workspace: ${err.message}`;
  }
}

// ─── Tool Registry Implementation ──────────────────────────────────────────────

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

// ─── Export All Built-in Tools ─────────────────────────────────────────────────

export const BUILTIN_TOOLS: ToolDefinition[] = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  WRITE_PROJECT_FILES_TOOL,
  APPLY_WORKSPACE_EDIT_TOOL,
  RUN_VSCODE_COMMAND_TOOL,
  SEARCH_WORKSPACE_TOOL,
];
