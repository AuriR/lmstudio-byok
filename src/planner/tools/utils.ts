/**
 * Utility functions for the planning tools.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition } from '../types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export type SimpleSchemaProperty = {
  type?: string;
  enum?: unknown[];
  items?: { type?: string };
  minItems?: number;
  maxItems?: number;
};

export type SimpleObjectSchema = {
  type?: string;
  properties?: Record<string, SimpleSchemaProperty>;
  required?: string[];
};

export function normalizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
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

export function normalizeWorkspacePath(filePath: string, workspaceRoot: string | undefined): string {
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

export function normalizeEditRange(range: unknown): { startLine: number; endLine: number } | undefined {
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

export function valueMatchesSchemaType(value: unknown, expectedType: string | undefined): boolean {
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

export function validateToolInput(tool: ToolDefinition, input: Record<string, unknown>): string[] {
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

export function contentLooksLikePlaceholderOrWrappedSnippet(content: string): boolean {
  const normalizedContent = content.trim();

  if (normalizedContent.startsWith('```') || normalizedContent.endsWith('```')) {
    return true;
  }

  return /\.\.\.\s*existing code\s*\.\.\.|\brest of (?:the )?code\b|\bunchanged code\b|\bexisting implementation\b|^\s*(?:\/\/|#|\/\*)\s*replaced\b|\bomitted\b|\bplaceholder\b/i.test(normalizedContent);
}

export function isToolExecutionFailureResult(result: string): boolean {
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
