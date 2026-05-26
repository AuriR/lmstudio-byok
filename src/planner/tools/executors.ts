/**
 * Tool executors for the planning harness.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  PlannerContext,
  ToolDefinition,
} from '../types';
import {
  contentLooksLikePlaceholderOrWrappedSnippet,
  isRecord,
  normalizeEditRange,
  normalizeToolInput,
  normalizeWorkspacePath,
} from './utils';

export async function executeReadFile(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
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

export async function executeWriteFile(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
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

export async function executeWriteProjectFiles(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
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

export async function executeApplyWorkspaceEdit(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
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
      const document = await vscode.workspace.openTextDocument(uri);
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

export async function executeRunVsCodeCommand(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
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

export async function executeSearchWorkspace(tool: ToolDefinition, input: Record<string, unknown>, context: PlannerContext): Promise<string> {
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