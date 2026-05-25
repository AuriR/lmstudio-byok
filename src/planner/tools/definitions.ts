/**
 * Tool definitions for the planning harness.
 */

import { ToolDefinition } from '../types';
import { TOOL_READ_FILE, TOOL_WRITE_FILE, TOOL_WRITE_PROJECT_FILES, TOOL_APPLY_WORKSPACE_EDIT, TOOL_RUN_VSCODE_COMMAND, TOOL_SEARCH_WORKSPACE } from '../../constants';

export const READ_FILE_TOOL: ToolDefinition = {
  name: TOOL_READ_FILE,
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
  name: TOOL_WRITE_FILE,
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
  name: TOOL_WRITE_PROJECT_FILES,
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
  name: TOOL_APPLY_WORKSPACE_EDIT,
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
  name: TOOL_RUN_VSCODE_COMMAND,
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
  name: TOOL_SEARCH_WORKSPACE,
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
