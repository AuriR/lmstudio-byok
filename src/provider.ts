import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken, CancellationTokenSource, LanguageModelChatMessageRole, LanguageModelChatTool, LanguageModelChatToolMode, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelDataPart, Progress, workspace, ConfigurationChangeEvent, EventEmitter, window, OutputChannel, StatusBarAlignment, StatusBarItem, LanguageModelChatProvider, LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelResponsePart, ProvideLanguageModelChatResponseOptions } from "vscode";
import { LMStudioClient } from '@lmstudio/sdk';
import { createPlanner } from './planner/plan';
import { DefaultToolRegistry } from './planner/tools';
import { PlannerConfig, LmStudioMessage as PlannerLmStudioMessage } from './planner/types';
import { encode } from 'gpt-tokenizer';
import {
	CONFIGURATION_ROOT,
	DEFAULT_BASE_URL,
	DEFAULT_CONTEXT_OVERFLOW_POLICY,
	DEFAULT_MAX_RESPONSE_TOKENS,
	DEFAULT_MAX_TOOL_RESULT_TOKENS,
	DEFAULT_MIN_P,
	DEFAULT_REPETITION_PENALTY,
	DEFAULT_SYSTEM_PROMPT,
	DEFAULT_TEMPERATURE,
	DEFAULT_TOP_K,
	DEFAULT_TOP_P,
	CONTEXT_BUDGET_RECENT_MESSAGE_COUNT,
	MIN_MESSAGE_TEXT_BUDGET_TOKENS,
	USER_REQUEST_PATTERN as userRequestPattern,
	REQUEST_HEADER_PATTERN as requestHeaderPattern,
	PLANNER_OVERRIDE_PATTERN as plannerOverridePattern,
	MAX_TOKENS_RESET_PATTERN as maxTokensResetPattern,
	MAX_TOKENS_OVERRIDE_PATTERN as maxTokensOverridePattern,
} from './constants';

function getChatModelInfo(id: string, name: string, maxInputTokens: number, maxOutputTokens: number, supportsTools = true, supportsImageInput = false): LanguageModelChatInformation {
	return {
		id,
		// Prefix the display name with BYOK to avoid confusion
		name: `BYOK: ${name}`,
		// family MUST match the vendor from package.json languageModels contribution
		family: "lmstudio",
		maxInputTokens,
		maxOutputTokens,
		version: "1.0.0",
		// Required for models to appear in the model picker
		isUserSelectable: true,
		capabilities: {
			toolCalling: supportsTools,
			imageInput: supportsImageInput, // Dynamically determined based on model identifier
		}
	};
}

const textDecoder = new TextDecoder();

const userRequestPattern = /<userRequest>([\s\S]*?)<\/userRequest>/i;
const requestHeaderPattern = /^(\s*Latest user request:\s*\r?\n)?/i;
const plannerOverridePattern = /^\/(lmsplan|lmsnoplan)\b(?:[ \t]+|\r?\n+)*/i;
const maxTokensResetPattern = /^\/lmsmaxtokensreset\b(?:[ \t]+|\r?\n+)*/i;
const maxTokensOverridePattern = /^\/lmsmaxtokens\b(?:[ \t]+([^\s]+))?(?:[ \t]+|\r?\n+)*/i;
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 8000;
const CONTEXT_BUDGET_RECENT_MESSAGE_COUNT = 4;
const MIN_MESSAGE_TEXT_BUDGET_TOKENS = 128;
const DEFAULT_BASE_URL = 'ws://localhost:1234';
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.8;
const DEFAULT_TOP_K = 20;
const DEFAULT_MIN_P = 0.05;
const DEFAULT_REPETITION_PENALTY = 1.2;
const DEFAULT_MAX_RESPONSE_TOKENS = 4096;
const DEFAULT_SYSTEM_PROMPT = 'Think step-by-step. Break down the problem into detailed reasoning steps before answering.';

type ContextOverflowPolicy = typeof POLICY_STOP_AT_LIMIT | typeof POLICY_TRUNCATE_MIDDLE | typeof POLICY_ROLLING_WINDOW;
type CheckedNumericSetting = { enabled: boolean; value: number; };
type ModelTuningSettings = {
	temperature: CheckedNumericSetting;
	topP: CheckedNumericSetting;
	topK: CheckedNumericSetting;
	minP: CheckedNumericSetting;
	repetitionPenalty: CheckedNumericSetting;
	maxTokensInResponse: CheckedNumericSetting;
};
type PredictionOptions = {
	maxTokens: number;
	rawTools: ReturnType<typeof toLmStudioRawTools>;
	contextOverflowPolicy: ContextOverflowPolicy;
	temperature?: number;
	topPSampling?: number | false;
	topKSampling?: number;
	minPSampling?: number | false;
	repeatPenalty?: number | false;
};
type GeneratedContentFilterState = {
	skipThinkMode: boolean;
};
type PlannerRuntimeStatus = {
	percent?: number;
	processedTokens?: number;
	totalTokens?: number;
	tokensPerSecond?: number;
};
type DebugSmokeTestResult = {
	success: boolean;
	modelId?: string;
	baseUrl: string;
	visibleText: string;
	toolCalls: string[];
	hadStructuredMarkers: boolean;
	configuredPlannerEnabled: boolean;
	plannerExercised: boolean;
	forcedDirectMode: boolean;
	error?: string;
};

type DebugPlannerSmokeTestResult = {
	success: boolean;
	modelId?: string;
	baseUrl: string;
	configuredPlannerEnabled: boolean;
	plannerExercised: boolean;
	allowedTools: string[];
	iterations: number;
	toolCalls: string[];
	response: string;
	matchedSentinel: boolean;
	error?: string;
};

type PlannerModeOverride = 'plan' | 'noplan';
type RequestCommandOverrides = {
	plannerModeOverride?: PlannerModeOverride;
	maxTokensOverride?: number;
	resetMaxTokensOverride?: boolean;
	notices: string[];
};

const SMOKE_TEST_SENTINEL = 'SMOKE_TEST_OK';
const PLANNER_SMOKE_TEST_SENTINEL = 'PLANNER_SMOKE_TEST_OK';
const READ_ONLY_PLANNER_SMOKE_TEST_TOOLS = ['search_workspace', 'read_file'];
const DEBUG_SMOKE_TEST_MODEL_PREFERENCE = [
	'openai/gpt-oss-20b',
	'google/gemma-4-e4b',
	'qwen/qwen3.6-35b-a3b',
	'qwen/qwen3-coder-30b',
];

function pickPreferredItemByIdentifier<T extends { id?: string; identifier?: string; }>(items: T[]): T | undefined {
	// Smoke tests are only useful when the selected model can follow a tiny structured instruction.
	// Prefer models that have been more cooperative during local validation before falling back.
	for (const preferredId of DEBUG_SMOKE_TEST_MODEL_PREFERENCE) {
		const match = items.find(item => item.id === preferredId || item.identifier === preferredId);
		if (match) {
			return match;
		}
	}

	return items[0];
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function createDefaultModelTuningSettings(): ModelTuningSettings {
	return {
		temperature: { enabled: false, value: DEFAULT_TEMPERATURE },
		topP: { enabled: false, value: DEFAULT_TOP_P },
		topK: { enabled: false, value: DEFAULT_TOP_K },
		minP: { enabled: false, value: DEFAULT_MIN_P },
		repetitionPenalty: { enabled: false, value: DEFAULT_REPETITION_PENALTY },
		maxTokensInResponse: { enabled: false, value: DEFAULT_MAX_RESPONSE_TOKENS },
	};
}

function inferImageInputSupport(modelIdentifier: string): boolean {
	const normalizedIdentifier = modelIdentifier.toLowerCase();

	// Prefer explicit multimodal markers over broad family names. Advertising image input
	// for every Qwen/Llama/Gemma model causes false capability claims in the picker.
	// Note that LM Studio's API doesn't return model capabilities, at least as of the time of this comment.
	if (normalizedIdentifier.includes('llava') ||
		normalizedIdentifier.includes('cogvlm') ||
		normalizedIdentifier.includes('pixtral') ||
		normalizedIdentifier.includes('minicpm-v')) {
		return true;
	}

	return /(^|[\/_\-.])(vl|vision|image|multimodal)([\/_\-.]|$)/i.test(normalizedIdentifier);
}

function filterGeneratedFragmentContent(content: string, state: GeneratedContentFilterState): string | undefined {
	// Some models emit hidden reasoning or Copilot-style channel markers. The chat UI should only
	// receive the final visible text, and planner mode needs the same sanitization to parse JSON.
	if (content === '<think>' || content === '<|channel|>analysis<|message|>' || content === '<|channel|>analysis') {
		state.skipThinkMode = true;
		return undefined;
	}

	if (content === '</think>' || content === '<|end|>') {
		state.skipThinkMode = false;
		return undefined;
	}

	if (state.skipThinkMode) {
		return undefined;
	}

	if (content === '<|channel|>final<|message|>' ||
		content === '<|channel|>final' ||
		content === '<|message|>' ||
		content === '<|start|>assistant' ||
		content === '<|constrain|>JSON') {
		return undefined;
	}

	return content.length > 0 ? content : undefined;
}

function formatPlannerResponseForChat(
	planningResult: { response: string; toolCalls: Array<{ tool: string }>; iterations: number; success: boolean; error?: string; },
	maxIterations: number,
): string {
	const uniqueTools = Array.from(new Set(planningResult.toolCalls.map(toolCall => toolCall.tool)));
	const summaryLines = [
		`Planner summary: completed in ${planningResult.iterations} of ${maxIterations} allowed rounds.`,
		uniqueTools.length > 0
			? `Planner actions: ${uniqueTools.join(', ')}.`
			: 'Planner actions: none. The model answered without using workspace tools.',
	];

	if (!planningResult.success && planningResult.error) {
		summaryLines.push(`Planner note: ${planningResult.error}`);
	}

	const visibleResponse = planningResult.response.trim();
	if (!visibleResponse) {
		summaryLines.push('Planner note: no visible answer was produced.');
		return summaryLines.join('\n');
	}

	return `${summaryLines.join('\n')}\n\n${visibleResponse}`;
}

function formatPlannerRunningStatus(
	percent?: number,
	tokensPerSecond?: number,
	processedTokens?: number,
	totalTokens?: number,
): string {
	const details: string[] = [];
	if (typeof percent === 'number' && Number.isFinite(percent) && percent >= 0) {
		const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
		if (
			typeof processedTokens === 'number' && Number.isFinite(processedTokens) && processedTokens >= 0 &&
			typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0
		) {
			details.push(`${boundedPercent}% (~${Math.min(Math.round(processedTokens), Math.round(totalTokens))}/${Math.round(totalTokens)} tok)`);
		} else {
			details.push(`${boundedPercent}%`);
		}
	}

	if (typeof tokensPerSecond === 'number' && Number.isFinite(tokensPerSecond) && tokensPerSecond > 0) {
		details.push(`~${Math.max(0, Math.round(tokensPerSecond))} t/s`);
	}

	return details.length > 0
		? `Planner running... ${details.join(' | ')}`
		: 'Planner running...';
}

function summarizePlannerToolResultForChat(result: string, success: boolean | undefined): string {
	const normalized = result.trim();
	const shortened = normalized.length > 600
		? `${normalized.slice(0, 600)}\n\n[Planner transcript truncated for chat readability.]`
		: normalized;

	if (!shortened) {
		return success === false
			? 'Planner tool finished with no visible output and reported an error.'
			: 'Planner tool finished with no visible output.';
	}

	return shortened;
}

function formatPlannerToolCallForChat(toolName: string, toolInput: Record<string, unknown> | undefined): string {
	const serializedInput = toolInput && Object.keys(toolInput).length > 0
		? JSON.stringify(toolInput)
		: '{}';
	return `Planner action: ${toolName} ${serializedInput}`;
}

function formatPlannerToolResultForChat(result: string, success: boolean | undefined): string {
	const status = success === false ? 'Planner result (error):' : 'Planner result:';
	return `${status}\n${summarizePlannerToolResultForChat(result, success)}`;
}

function estimateTokenCount(text: string): number {
	try {
		return encode(text).length;
	} catch {
		return Math.ceil(text.length / 4);
	}
}

function hashPayload(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function truncateTextToTokenBudget(text: string, maxTokens: number): string {
	if (maxTokens <= 0 || !text) {
		return text;
	}

	const estimatedTokens = estimateTokenCount(text);
	if (estimatedTokens <= maxTokens) {
		return text;
	}

	const targetChars = Math.max(1200, Math.floor(text.length * (maxTokens / estimatedTokens)));
	const headChars = Math.max(400, Math.floor(targetChars * 0.7));
	const tailChars = Math.max(200, targetChars - headChars);

	return [
		text.slice(0, headChars),
		'',
		`[LM Studio note: truncated tool result from ~${estimatedTokens} tokens to keep local-model context manageable.]`,
		'',
		text.slice(-tailChars),
	].join('\n');
}

function normalizeContextOverflowPolicy(value: unknown): ContextOverflowPolicy {
	if (value === POLICY_STOP_AT_LIMIT || value === POLICY_TRUNCATE_MIDDLE || value === POLICY_ROLLING_WINDOW) {
		return value;
	}

	return DEFAULT_CONTEXT_OVERFLOW_POLICY;
}

function serializeUnknownPart(part: unknown, toolResultTokenLimit?: number): string {
	if (part instanceof LanguageModelTextPart) {
		return part.value;
	}

	if (part instanceof LanguageModelToolCallPart) {
		return `[Tool Call: ${part.name}(${JSON.stringify(part.input)})]`;
	}

	if (part instanceof LanguageModelToolResultPart) {
		const content = part.content.map(item => serializeUnknownPart(item, toolResultTokenLimit)).filter(Boolean).join('');
		const boundedContent = toolResultTokenLimit ? truncateTextToTokenBudget(content, toolResultTokenLimit) : content;
		return `[Tool Result ${part.callId}: ${boundedContent}]`;
	}

	if (part instanceof LanguageModelDataPart) {
		if (part.mimeType.startsWith('text/')) {
			return textDecoder.decode(part.data);
		}

		if (part.mimeType === 'application/json') {
			try {
				return JSON.stringify(JSON.parse(textDecoder.decode(part.data)));
			} catch {
				return textDecoder.decode(part.data);
			}
		}

		return `[Data: ${part.mimeType}]`;
	}

	if (typeof part === 'string') {
		return part;
	}

	if (part && typeof part === 'object') {
		try {
			return JSON.stringify(part);
		} catch {
			return '[Unsupported object part]';
		}
	}

	return '';
}

function toLmStudioRole(role: number): 'user' | 'assistant' | 'system' {
	switch (role) {
		case LanguageModelChatMessageRole.User:
			return 'user';
		case LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		case 3:
			return 'system';
		default:
			return 'user';
	}
}

function prioritizeExplicitUserRequest(content: string): string {
	const match = userRequestPattern.exec(content);
	if (!match) {
		return content;
	}

	const explicitRequest = match[1].trim();
	if (!explicitRequest) {
		return content;
	}

	return [
		`Latest user request:\n${explicitRequest}`,
		'Additional request context:',
		content,
	].join('\n\n');
}

function toLmStudioToolParameters(inputSchema?: object): {
	type: 'object';
	properties: Record<string, any>;
	required?: string[];
	additionalProperties?: boolean;
	$defs?: Record<string, any>;
} | undefined {
	if (!inputSchema || typeof inputSchema !== 'object') {
		return undefined;
	}

	const schema = inputSchema as Record<string, unknown>;
	if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
		return undefined;
	}

	const required = Array.isArray(schema.required)
		? schema.required.filter((value): value is string => typeof value === 'string')
		: undefined;

	return {
		type: 'object',
		properties: schema.properties as Record<string, any>,
		required: required && required.length > 0 ? required : undefined,
		additionalProperties: typeof schema.additionalProperties === 'boolean' ? schema.additionalProperties : undefined,
		$defs: schema.$defs && typeof schema.$defs === 'object' ? schema.$defs as Record<string, any> : undefined,
	};
}

function toLmStudioRawTools(tools: readonly LanguageModelChatTool[] | undefined, toolMode: LanguageModelChatToolMode): { type: 'none'; } | { type: 'toolArray'; tools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: ReturnType<typeof toLmStudioToolParameters>; }; }>; force?: boolean; } {
	if (!tools || tools.length === 0) {
		return { type: 'none' };
	}

	return {
		type: 'toolArray',
		tools: tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: toLmStudioToolParameters(tool.inputSchema),
			},
		})),
		force: toolMode === LanguageModelChatToolMode.Required ? true : undefined,
	};
}

function toLmStudioMessage(message: LanguageModelChatRequestMessage, toolResultTokenLimit = DEFAULT_MAX_TOOL_RESULT_TOKENS):
	| { role: 'assistant'; content: Array<{ type: 'text'; text: string; } | { type: 'toolCallRequest'; toolCallRequest: { type: 'function'; id?: string; name: string; arguments?: Record<string, any>; }; }>; }
	| { role: 'user'; content: Array<{ type: 'text'; text: string; }>; }
	| { role: 'system'; content: Array<{ type: 'text'; text: string; }>; }
	| { role: 'tool'; content: Array<{ type: 'toolCallResult'; toolCallId?: string; content: string; }>; } {
	const role = toLmStudioRole(Number(message.role));

	if (role === 'user') {
		const toolResults = message.content.filter((part): part is LanguageModelToolResultPart => part instanceof LanguageModelToolResultPart);
		const nonToolParts = message.content.filter(part => !(part instanceof LanguageModelToolResultPart));
		if (toolResults.length > 0 && nonToolParts.length === 0) {
			return {
				role: 'tool',
				content: toolResults.map(part => ({
					type: 'toolCallResult' as const,
					toolCallId: part.callId,
					content: truncateTextToTokenBudget(part.content.map(item => serializeUnknownPart(item, toolResultTokenLimit)).filter(Boolean).join('\n\n'), toolResultTokenLimit),
				})),
			};
		}
	}

	if (role === 'assistant') {
		const content: Array<{ type: 'text'; text: string; } | { type: 'toolCallRequest'; toolCallRequest: { type: 'function'; id?: string; name: string; arguments?: Record<string, any>; }; }> = [];

		for (const part of message.content) {
			if (part instanceof LanguageModelTextPart) {
				content.push({ type: 'text' as const, text: part.value });
				continue;
			}

			if (part instanceof LanguageModelToolCallPart) {
				content.push({
					type: 'toolCallRequest' as const,
					toolCallRequest: {
						type: 'function' as const,
						id: part.callId,
						name: part.name,
						arguments: part.input as Record<string, any>,
					},
				});
				continue;
			}

			const serialized = serializeUnknownPart(part, toolResultTokenLimit);
			if (serialized) {
				content.push({ type: 'text' as const, text: serialized });
			}
		}

		return {
			role,
			content,
		};
	}

	const baseContent = message.content.map(part => serializeUnknownPart(part, toolResultTokenLimit)).filter(Boolean).join('\n\n');
	const content = role === 'user'
		? prioritizeExplicitUserRequest(baseContent)
		: baseContent;

	return {
		role,
		content: content ? [{ type: 'text' as const, text: content }] : [],
	};
}

function createSystemTextMessage(text: string): Extract<LmStudioMessage, { role: 'system' }> {
	return {
		role: 'system',
		content: [{ type: 'text', text }],
	};
}

type LmStudioMessage = ReturnType<typeof toLmStudioMessage>;
type LmStudioChatHistory = { messages: LmStudioMessage[]; };

function estimateChatHistoryTokens(chatHistory: LmStudioChatHistory, rawTools: ReturnType<typeof toLmStudioRawTools>): number {
	return estimateTokenCount(JSON.stringify({
		chatHistory,
		rawTools: rawTools.type === 'toolArray' ? rawTools.tools : [],
	}));
}

function isTextOnlyLmStudioMessage(message: LmStudioMessage): boolean {
	return message.content.every(part => part.type === 'text');
}

function getLmStudioMessageText(message: LmStudioMessage): string | undefined {
	if (!isTextOnlyLmStudioMessage(message)) {
		return undefined;
	}

	return message.content
		.map(part => part.type === 'text' ? part.text : '')
		.filter(Boolean)
		.join('\n\n');
}

function truncateLmStudioMessageText(message: LmStudioMessage, maxTokens: number): LmStudioMessage {
	const text = getLmStudioMessageText(message);
	if (!text) {
		return message;
	}

	const truncatedText = truncateTextToTokenBudget(text, maxTokens);
	return {
		...message,
		content: truncatedText ? [{ type: 'text', text: truncatedText }] : [],
	} as LmStudioMessage;
}

function toPlannerLmStudioMessage(message: LmStudioMessage): PlannerLmStudioMessage {
	return {
		role: message.role,
		content: getLmStudioMessageText(message) ?? JSON.stringify(message.content),
	};
}

function didLikelyHitResponseTokenLimit(visibleResponseText: string, generatedTokens: number, maxTokens: number): boolean {
	if (!visibleResponseText.trim() || maxTokens <= 0) {
		return false;
	}

	const threshold = Math.max(1, maxTokens - Math.min(64, Math.max(8, Math.floor(maxTokens * 0.02))));
	return generatedTokens >= threshold;
}

function createResponseTokenLimitNotice(maxTokens: number): string {
	return `\n\nNot enough tokens to follow through on the response. LM Studio likely stopped at the current response cap (${maxTokens} max response tokens). Try a higher value with /lmsmaxtokens <number> or raise the LM Studio max-response-tokens setting.`;
}

function looksLikeResponseTokenLimitError(errorMessage: string): boolean {
	return /(max(?:imum)?(?: response| output)? tokens?|finish reason:?\s*length|response token limit|output token limit|completion length limit|max_new_tokens)/i.test(errorMessage);
}

function extractRequestCommandOverrides(text: string | undefined): { cleanedText: string | undefined; overrides: RequestCommandOverrides; consumedCommand: boolean; } {
	if (!text) {
		return { cleanedText: text, overrides: { notices: [] }, consumedCommand: false };
	}

	const headerMatch = requestHeaderPattern.exec(text);
	const prefix = headerMatch?.[1] ?? '';
	let remaining = text.slice(prefix.length);
	let plannerModeOverride: PlannerModeOverride | undefined;
	let maxTokensOverride: number | undefined;
	let resetMaxTokensOverride = false;
	const notices: string[] = [];
	let consumedCommand = false;

	while (true) {
		const trimmed = remaining.trimStart();
		const leadingWhitespace = remaining.slice(0, remaining.length - trimmed.length);

		const plannerMatch = plannerOverridePattern.exec(trimmed);
		if (plannerMatch) {
			plannerModeOverride = plannerMatch[1].toLowerCase() === 'lmsplan' ? 'plan' : 'noplan';
			remaining = `${leadingWhitespace}${trimmed.slice(plannerMatch[0].length)}`;
			consumedCommand = true;
			continue;
		}

		const maxTokensResetMatch = maxTokensResetPattern.exec(trimmed);
		if (maxTokensResetMatch) {
			maxTokensOverride = undefined;
			resetMaxTokensOverride = true;
			remaining = `${leadingWhitespace}${trimmed.slice(maxTokensResetMatch[0].length)}`;
			consumedCommand = true;
			continue;
		}

		const maxTokensMatch = maxTokensOverridePattern.exec(trimmed);
		if (maxTokensMatch) {
			const rawValue = maxTokensMatch[1];
			if (!rawValue) {
				notices.push('LM Studio note: ignoring /lmsmaxtokens because it requires a positive integer, for example /lmsmaxtokens 8192.');
			} else {
				const parsedValue = Number(rawValue);
				if (Number.isFinite(parsedValue) && parsedValue >= 1) {
					maxTokensOverride = Math.max(1, Math.floor(parsedValue));
					resetMaxTokensOverride = false;
				} else {
					notices.push(`LM Studio note: ignoring /lmsmaxtokens ${rawValue} because the value must be a positive integer.`);
				}
			}

			remaining = `${leadingWhitespace}${trimmed.slice(maxTokensMatch[0].length)}`;
			consumedCommand = true;
			continue;
		}

		break;
	}

	const cleanedText = `${prefix}${remaining}`.replace(/^\s+$/g, '').trimStart();
	return {
		cleanedText,
		overrides: {
			plannerModeOverride,
			maxTokensOverride,
			resetMaxTokensOverride,
			notices,
		},
		consumedCommand,
	};
}

function applyRequestCommandOverridesToChatHistory(chatHistory: LmStudioChatHistory): { chatHistory: LmStudioChatHistory; overrides: RequestCommandOverrides; } {
	const lastUserIndex = [...chatHistory.messages]
		.map((message, index) => ({ message, index }))
		.reverse()
		.find(entry => entry.message.role === 'user' && isTextOnlyLmStudioMessage(entry.message))?.index;

	if (lastUserIndex === undefined) {
		return { chatHistory, overrides: { notices: [] } };
	}

	const lastUserMessage = chatHistory.messages[lastUserIndex];
	const text = getLmStudioMessageText(lastUserMessage);
	const { cleanedText, overrides, consumedCommand } = extractRequestCommandOverrides(text);
	if (!consumedCommand || cleanedText === text) {
		return { chatHistory, overrides };
	}

	const updatedMessages = [...chatHistory.messages];
	updatedMessages[lastUserIndex] = {
		role: 'user',
		content: cleanedText ? [{ type: 'text', text: cleanedText }] : [],
	};

	return {
		chatHistory: { messages: updatedMessages },
		overrides,
	};
}

function enforceHistoryTokenBudget(
	chatHistory: LmStudioChatHistory,
	rawTools: ReturnType<typeof toLmStudioRawTools>,
	maxPromptTokens: number,
): {
	chatHistory: LmStudioChatHistory;
	originalTokens: number;
	finalTokens: number;
	droppedMessageCount: number;
	truncatedMessageCount: number;
	wasShortened: boolean;
	fitsWithinBudget: boolean;
} {
	const originalTokens = estimateChatHistoryTokens(chatHistory, rawTools);
	if (originalTokens <= maxPromptTokens) {
		return {
			chatHistory,
			originalTokens,
			finalTokens: originalTokens,
			droppedMessageCount: 0,
			truncatedMessageCount: 0,
			wasShortened: false,
			fitsWithinBudget: true,
		};
	}

	const entries = chatHistory.messages.map((message, index) => ({
		originalIndex: index,
		message,
		locked: message.role === 'system',
	}));

	let lockedRecentCount = 0;
	for (let index = entries.length - 1; index >= 0 && lockedRecentCount < CONTEXT_BUDGET_RECENT_MESSAGE_COUNT; index--) {
		if (entries[index].message.role === 'system') {
			continue;
		}

		entries[index].locked = true;
		lockedRecentCount++;
	}

	const getCurrentHistory = (): LmStudioChatHistory => ({ messages: entries.map(entry => entry.message) });
	const calculateCurrentTokens = () => estimateChatHistoryTokens(getCurrentHistory(), rawTools);

	let currentTokens = calculateCurrentTokens();
	let droppedMessageCount = 0;
	let truncatedMessageCount = 0;

	while (currentTokens > maxPromptTokens) {
		const removableIndex = entries.findIndex(entry => !entry.locked);
		if (removableIndex >= 0) {
			entries.splice(removableIndex, 1);
			droppedMessageCount++;
			currentTokens = calculateCurrentTokens();
			continue;
		}

		const truncatableIndex = (() => {
			for (let index = 0; index < entries.length - 1; index++) {
				if (entries[index].message.role !== 'system' && isTextOnlyLmStudioMessage(entries[index].message)) {
					return index;
				}
			}

			const lastIndex = entries.length - 1;
			if (lastIndex >= 0 && isTextOnlyLmStudioMessage(entries[lastIndex].message)) {
				return lastIndex;
			}

			for (let index = 0; index < entries.length; index++) {
				if (entries[index].message.role === 'system' && isTextOnlyLmStudioMessage(entries[index].message)) {
					return index;
				}
			}

			return -1;
		})();

		if (truncatableIndex < 0) {
			break;
		}

		const currentText = getLmStudioMessageText(entries[truncatableIndex].message);
		if (!currentText) {
			break;
		}

		const overage = currentTokens - maxPromptTokens;
		const currentTextTokens = estimateTokenCount(currentText);
		const targetTextTokens = Math.max(MIN_MESSAGE_TEXT_BUDGET_TOKENS, currentTextTokens - overage - 32);
		const truncatedMessage = truncateLmStudioMessageText(entries[truncatableIndex].message, targetTextTokens);
		if (JSON.stringify(truncatedMessage) === JSON.stringify(entries[truncatableIndex].message)) {
			break;
		}

		entries[truncatableIndex].message = truncatedMessage;
		truncatedMessageCount++;
		currentTokens = calculateCurrentTokens();
	}

	return {
		chatHistory: getCurrentHistory(),
		originalTokens,
		finalTokens: currentTokens,
		droppedMessageCount,
		truncatedMessageCount,
		wasShortened: droppedMessageCount > 0 || truncatedMessageCount > 0,
		fitsWithinBudget: currentTokens <= maxPromptTokens,
	};
}

export class LMStudioChatModelProvider implements LanguageModelChatProvider {
	private static readonly PROGRESS_STATUS_MIN_UPDATE_INTERVAL_MS = 400;

	private client: LMStudioClient | null = null;
	private lastBaseUrl: string | null = null;
	private lastApiKey: string | null = null;
	private _onDidChange = new EventEmitter<void>();
	private cachedModels: LanguageModelChatInformation[] | null = null;
	private cacheTimestamp = 0;
	private readonly CACHE_DURATION = 30000; // 30 seconds
	private output: OutputChannel;
	private readonly statusBar: StatusBarItem;
	private statusBarHideTimer: NodeJS.Timeout | undefined;
	private progressStatusTimer: NodeJS.Timeout | undefined;
	private pendingProgressStatusText: string | undefined;
	private lastProgressStatusText = '';
	private lastProgressStatusUpdateAt = 0;
	private readonly chaChingSoundPath: string;
	private verbose = false;
	private verboseProgress = false;
	private playTokenThresholdSound = false;
	private tokenSoundThreshold = 10000;
	private autoCavemanPrompts = false;
	private performanceOptimizations = true;
	private toggleAllPerformance = false;
	private tokenBudgeting = false;
	private contextOverflowPolicy: ContextOverflowPolicy = DEFAULT_CONTEXT_OVERFLOW_POLICY;
	private blockOversizedRequests = true;
	private configuredSystemPrompt = DEFAULT_SYSTEM_PROMPT;
	private plannerEnabled = false;
	private plannerMaxIterations = 10;
	private plannerMaxToolResultTokens = DEFAULT_MAX_TOOL_RESULT_TOKENS;
	private plannerFyiInstructionPath = '';
	private modelTuning: ModelTuningSettings = createDefaultModelTuningSettings();
	private sessionMaxTokensOverride: number | undefined;
	private _maxTokensRemainsNoticeShown = false;
	private cacheHits = 0;
	private cacheMisses = 0;
	private readonly requestSignatureCounts = new Map<string, number>();
	private readonly responseSignatureCounts = new Map<string, number>();
	private requestReuseHits = 0;
	private requestReuseMisses = 0;
	private responseReuseHits = 0;
	private responseReuseMisses = 0;
	private readonly MAX_SIGNATURE_HISTORY = 100;

	// Must match the property name expected by LanguageModelChatProvider interface
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(extensionPath: string) {
		this.output = window.createOutputChannel(OUTPUT_CHANNEL_NAME);
		this.statusBar = window.createStatusBarItem(STATUS_BAR_ID, StatusBarAlignment.Left, 100);
		this.statusBar.name = STATUS_BAR_NAME;
		this.statusBar.hide();
		this.chaChingSoundPath = path.join(extensionPath, SOUND_FILE_NAME);
		this.loadSettings();
		// Listen for configuration changes to refresh the client
		workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
			if (e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_BASE_URL}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_API_KEY}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_VERBOSE_LOGGING}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_VERBOSE_PROGRESS_REPORTING}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_PLAY_TOKEN_THRESHOLD_SOUND}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_TOKEN_SOUND_THRESHOLD}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_AUTO_CAVEMAN_PROMPTS}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_TOKEN_BUDGETING}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_CONTEXT_OVERFLOW_POLICY}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_BLOCK_OVERSIZED_REQUESTS}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_SYSTEM_PROMPT}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_PERFORMANCE_OPTIMIZATIONS}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.${SETTING_TOGGLE_ALL_PERFORMANCE}`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.planner`) ||
				e.affectsConfiguration(`${CONFIGURATION_ROOT}.modelTuning')) {
				this.log('Configuration changed, will refresh client on next request');
				this.loadSettings();
				// Reset the client so it gets recreated with new settings
				this.client = null;
				this.lastBaseUrl = null;
				this.lastApiKey = null;
				// Clear cache and notify of changes
				this.cachedModels = null;
				this.cacheTimestamp = 0;
				this._onDidChange.fire();
			}
		});
	}

	private loadSettings() {
		try {
			const config = workspace.getConfiguration(CONFIGURATION_ROOT);
			this.verbose = !!config.get<boolean>(SETTING_VERBOSE_LOGGING);
			this.verboseProgress = !!config.get<boolean>(SETTING_VERBOSE_PROGRESS_REPORTING);
			this.playTokenThresholdSound = !!config.get<boolean>(SETTING_PLAY_TOKEN_THRESHOLD_SOUND);
			this.tokenSoundThreshold = Math.max(1, config.get<number>(SETTING_TOKEN_SOUND_THRESHOLD, 10000));
			this.autoCavemanPrompts = !!config.get<boolean>(SETTING_AUTO_CAVEMAN_PROMPTS);
			this.performanceOptimizations = !!config.get<boolean>(SETTING_PERFORMANCE_OPTIMIZATIONS);
			this.contextOverflowPolicy = normalizeContextOverflowPolicy(config.get<string>(SETTING_CONTEXT_OVERFLOW_POLICY, DEFAULT_CONTEXT_OVERFLOW_POLICY));
			this.blockOversizedRequests = config.get<boolean>(SETTING_BLOCK_OVERSIZED_REQUESTS, true);
			this.configuredSystemPrompt = config.get<string>(SETTING_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT).trim();
			
			// Handle toggle all performance setting
			const toggleAll = !!config.get<boolean>(SETTING_TOGGLE_ALL_PERFORMANCE);
			if (toggleAll) {
				// Turn all performance features on
				this.autoCavemanPrompts = true;
				this.performanceOptimizations = true;
				this.tokenBudgeting = true;
			} else {
				// Respect individual settings if toggle is off
				this.autoCavemanPrompts = !!config.get<boolean>(SETTING_AUTO_CAVEMAN_PROMPTS);
				this.performanceOptimizations = !!config.get<boolean>(SETTING_PERFORMANCE_OPTIMIZATIONS);
				this.tokenBudgeting = !!config.get<boolean>(SETTING_TOKEN_BUDGETING);
			}
			
			this.toggleAllPerformance = toggleAll;
			this.plannerEnabled = !!config.get<boolean>(SETTING_PLANNER_ENABLED);
			this.plannerMaxIterations = Math.max(1, Math.min(50, Math.floor(config.get<number>(SETTING_PLANNER_MAX_ITERATIONS, 10))));
			this.plannerMaxToolResultTokens = Math.max(1000, Math.floor(config.get<number>(SETTING_PLANNER_MAX_TOOL_RESULT_TOKENS, DEFAULT_MAX_TOOL_RESULT_TOKENS)));
			this.plannerFyiInstructionPath = config.get<string>(SETTING_PLANNER_FYI_INSTRUCTION_PATH, '').trim();
			this.modelTuning = {
				temperature: {
					enabled: !!config.get<boolean>(SETTING_MODEL_TUNING_TEMPERATURE_ENABLED),
					value: clampNumber(config.get<number>(SETTING_MODEL_TUNING_TEMPERATURE_VALUE, DEFAULT_TEMPERATURE), 0, 1),
				},
				topP: {
					enabled: !!config.get<boolean>(SETTING_MODEL_TUNING_TOP_P_ENABLED),
					value: clampNumber(config.get<number>(SETTING_MODEL_TUNING_TOP_P_VALUE, DEFAULT_TOP_P), 0, 1),
				},
				topK: {
					enabled: !!config.get<boolean>(SETTING_MODEL_TUNING_TOP_K_ENABLED),
					value: Math.max(1, Math.floor(config.get<number>(SETTING_MODEL_TUNING_TOP_K_VALUE, DEFAULT_TOP_K))),
				},
				minP: {
					enabled: !!config.get<boolean>(SETTING_MODEL_TUNING_MIN_P_ENABLED),
					value: clampNumber(config.get<number>(SETTING_MODEL_TUNING_MIN_P_VALUE, DEFAULT_MIN_P), 0, 1),
				},
				repetitionPenalty: {
					enabled: !!config.get<boolean>(SETTING_MODEL_TUNING_REPETITION_PENALTY_ENABLED),
					value: Math.max(0, config.get<number>(SETTING_MODEL_TUNING_REPETITION_PENALTY_VALUE, DEFAULT_REPETITION_PENALTY)),
				},
				maxTokensInResponse: {
					enabled: !!config.get<boolean>(SETTING_MODEL_TUNING_MAX_TOKENS_IN_RESPONSE_ENABLED),
					value: Math.max(1, Math.floor(config.get<number>(SETTING_MODEL_TUNING_MAX_TOKENS_IN_RESPONSE_VALUE, DEFAULT_MAX_RESPONSE_TOKENS))),
				},
			};
		} catch {
			this.verbose = false;
			this.verboseProgress = false;
			this.playTokenThresholdSound = false;
			this.tokenSoundThreshold = 10000;
			this.autoCavemanPrompts = false;
			this.performanceOptimizations = true;
			this.tokenBudgeting = false;
			this.contextOverflowPolicy = DEFAULT_CONTEXT_OVERFLOW_POLICY;
			this.blockOversizedRequests = true;
			this.configuredSystemPrompt = DEFAULT_SYSTEM_PROMPT;
			this.toggleAllPerformance = false;
			this.plannerEnabled = false;
			this.plannerMaxIterations = 10;
			this.plannerMaxToolResultTokens = DEFAULT_MAX_TOOL_RESULT_TOKENS;
			this.plannerFyiInstructionPath = '';
			this.modelTuning = createDefaultModelTuningSettings();
		}
	}

	private resolveConfiguredMaxTokens(options: ProvideLanguageModelChatResponseOptions): number {
		const configuredMaxTokens = this.modelTuning.maxTokensInResponse.enabled
			? this.modelTuning.maxTokensInResponse.value
			: undefined;
		return Math.max(1, Math.floor(configuredMaxTokens ?? options.modelOptions?.maxTokens ?? 8192));
	}

	private getEffectiveMaxTokens(options: ProvideLanguageModelChatResponseOptions, includeSessionOverride = true): number {
		const sessionOverride = includeSessionOverride ? this.sessionMaxTokensOverride : undefined;
		return Math.max(1, Math.floor(sessionOverride ?? this.resolveConfiguredMaxTokens(options)));
	}

	private buildPredictionOptions(options: ProvideLanguageModelChatResponseOptions, includeSessionOverride = true): PredictionOptions {
		const predictionOptions: PredictionOptions = {
			maxTokens: this.getEffectiveMaxTokens(options, includeSessionOverride),
			rawTools: toLmStudioRawTools(options.tools, options.toolMode),
			contextOverflowPolicy: this.contextOverflowPolicy,
		};

		if (this.modelTuning.temperature.enabled) {
			predictionOptions.temperature = this.modelTuning.temperature.value;
		}

		if (this.modelTuning.topP.enabled) {
			predictionOptions.topPSampling = this.modelTuning.topP.value;
		}

		if (this.modelTuning.topK.enabled) {
			predictionOptions.topKSampling = this.modelTuning.topK.value;
		}

		if (this.modelTuning.minP.enabled) {
			predictionOptions.minPSampling = this.modelTuning.minP.value;
		}

		if (this.modelTuning.repetitionPenalty.enabled) {
			predictionOptions.repeatPenalty = this.modelTuning.repetitionPenalty.value;
		}

		return predictionOptions;
	}

	private describeActiveModelTuning(predictionOptions: PredictionOptions): string {
		const activeSettings: string[] = [];

		if (predictionOptions.temperature !== undefined) {
			activeSettings.push(`temperature=${predictionOptions.temperature}`);
		}

		if (predictionOptions.topPSampling !== undefined) {
			activeSettings.push(`topP=${predictionOptions.topPSampling}`);
		}

		if (predictionOptions.topKSampling !== undefined) {
			activeSettings.push(`topK=${predictionOptions.topKSampling}`);
		}

		if (predictionOptions.minPSampling !== undefined) {
			activeSettings.push(`minP=${predictionOptions.minPSampling}`);
		}

		if (predictionOptions.repeatPenalty !== undefined) {
			activeSettings.push(`repetitionPenalty=${predictionOptions.repeatPenalty}`);
		}

		if (this.sessionMaxTokensOverride !== undefined) {
			activeSettings.push(`maxResponseTokens=${predictionOptions.maxTokens} (session override)`);
		} else if (this.modelTuning.maxTokensInResponse.enabled) {
			activeSettings.push(`maxResponseTokens=${predictionOptions.maxTokens}`);
		}

		return activeSettings.length > 0 ? activeSettings.join(', ') : 'none';
	}

	private getPlannerConfig(): PlannerConfig {
		return {
			enabled: this.plannerEnabled,
			maxIterations: this.plannerMaxIterations,
			maxToolResultTokens: this.plannerMaxToolResultTokens,
			useToolCalling: false,
			fyiInstructionPath: this.plannerFyiInstructionPath || undefined,
			modelFamily: 'lmstudio',
			allowedTools: undefined,
		};
	}

	private getWorkspaceRoot(): string | undefined {
		return workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private shouldInjectConfiguredSystemPrompt(requestInitiator: string | undefined): boolean {
		if (!this.configuredSystemPrompt) {
			return false;
		}

		return requestInitiator !== 'lmstudio.debugSmokeTest' && requestInitiator !== 'lmstudio.debugPlannerSmokeTest';
	}

	private async invokePlannerModel(
		llmModel: { respond: (history: LmStudioChatHistory, options: Omit<PredictionOptions, 'rawTools'> & Record<string, unknown>) => AsyncIterable<{ content?: string; tokensCount?: number; }> & PromiseLike<{ content?: string; }>; },
		messages: PlannerLmStudioMessage[],
		predictionOptions: PredictionOptions,
		token: CancellationToken,
		onRuntimeStatus?: (status: PlannerRuntimeStatus) => void,
	): Promise<string> {
		const plannerPredictionOptions: Omit<PredictionOptions, 'rawTools'> = {
			maxTokens: predictionOptions.maxTokens,
			contextOverflowPolicy: predictionOptions.contextOverflowPolicy,
			temperature: predictionOptions.temperature,
			topPSampling: predictionOptions.topPSampling,
			topKSampling: predictionOptions.topKSampling,
			minPSampling: predictionOptions.minPSampling,
			repeatPenalty: predictionOptions.repeatPenalty,
		};
		const estimatedPromptTokens = Math.max(1, estimateTokenCount(JSON.stringify(messages)));
		let lastPromptPercent = -1;
		let generatedTokens = 0;
		let firstFragmentTime: number | undefined;
		let accumulatedResponse = '';
		const filterState: GeneratedContentFilterState = { skipThinkMode: false };
		const predictionCallbacks = {
			onPromptProcessingProgress: (promptProgress: number) => {
				const percent = Math.max(0, Math.min(100, Math.round(promptProgress * 100)));
				if (percent === lastPromptPercent) {
					return;
				}

				lastPromptPercent = percent;
				onRuntimeStatus?.({
					percent,
					processedTokens: Math.min(estimatedPromptTokens, Math.round(estimatedPromptTokens * promptProgress)),
					totalTokens: estimatedPromptTokens,
					tokensPerSecond: undefined,
				});
			},
			onFirstToken: () => {
				onRuntimeStatus?.({
					percent: 100,
					processedTokens: estimatedPromptTokens,
					totalTokens: estimatedPromptTokens,
					tokensPerSecond: undefined,
				});
			},
		};
		const prediction = llmModel.respond(
			{ messages: messages as unknown as LmStudioMessage[] },
			{ ...plannerPredictionOptions, ...predictionCallbacks },
		);

		for await (const fragment of prediction) {
			if (token.isCancellationRequested) {
				void Promise.resolve(prediction).catch(() => undefined);
				break;
			}


		if (didLikelyHitResponseTokenLimit(accumulatedResponse, generatedTokens, plannerPredictionOptions.maxTokens)) {
			accumulatedResponse += createResponseTokenLimitNotice(plannerPredictionOptions.maxTokens);
		}
			generatedTokens += Math.max(0, fragment.tokensCount || 0);

			if (fragment.content) {
				if (firstFragmentTime === undefined) {
					firstFragmentTime = Date.now();
				}

				const filteredContent = filterGeneratedFragmentContent(fragment.content, filterState);
				if (filteredContent) {
					accumulatedResponse += filteredContent;
				}

				if (firstFragmentTime !== undefined && generatedTokens > 0) {
					const elapsedSeconds = (Date.now() - firstFragmentTime) / 1000;
					if (elapsedSeconds > 0) {
						onRuntimeStatus?.({
							percent: 100,
							processedTokens: estimatedPromptTokens,
							totalTokens: estimatedPromptTokens,
							tokensPerSecond: Math.floor(generatedTokens / elapsedSeconds),
						});
					}
				}
			}
		}

		if (token.isCancellationRequested) {
			return accumulatedResponse.trim();
		}

		const finalResult = await prediction;
		if (!accumulatedResponse && finalResult.content) {
			const filteredFinalContent = filterGeneratedFragmentContent(finalResult.content, filterState);
			if (filteredFinalContent) {
				accumulatedResponse = filteredFinalContent;
			}
		}

		return accumulatedResponse.trim();
	}

	private async providePlannerResponse(
		llmModel: { identifier: string; respond: (history: LmStudioChatHistory, options: Omit<PredictionOptions, 'rawTools'> & Record<string, unknown>) => AsyncIterable<{ content?: string; tokensCount?: number; }> & PromiseLike<{ content?: string; }>; },
		processedChatHistory: LmStudioChatHistory,
		predictionOptions: PredictionOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken,
	): Promise<void> {
		const plannerConfig = this.getPlannerConfig();
		let plannerRuntimeStatus: PlannerRuntimeStatus = {};
		let emittedPlannerRunningNote = false;
		const showPlannerRunningStatus = () => {
			this.showProgressStatus(formatPlannerRunningStatus(
				plannerRuntimeStatus.percent,
				plannerRuntimeStatus.tokensPerSecond,
				plannerRuntimeStatus.processedTokens,
				plannerRuntimeStatus.totalTokens,
			));
		};
		const ensurePlannerRunningNote = () => {
			if (emittedPlannerRunningNote) {
				return;
			}

			emittedPlannerRunningNote = true;
			progress.report(new LanguageModelTextPart('Planner running...\n\n'));
		};
		const planner = createPlanner(
			plannerConfig,
			{
				workspaceRoot: this.getWorkspaceRoot(),
				outputChannel: this.output,
				token,
				onProgress: (plannerProgress) => {
					if (plannerProgress.type === 'iteration' && plannerProgress.iteration !== undefined) {
						ensurePlannerRunningNote();
						if (typeof plannerProgress.percent === 'number' && Number.isFinite(plannerProgress.percent)) {
							plannerRuntimeStatus = {
								...plannerRuntimeStatus,
								percent: plannerProgress.percent,
							};
						}
						showPlannerRunningStatus();
						return;
					}

					if (plannerProgress.type === 'toolCall' && plannerProgress.toolName) {
						ensurePlannerRunningNote();
						if (typeof plannerProgress.percent === 'number' && Number.isFinite(plannerProgress.percent)) {
							plannerRuntimeStatus = {
								...plannerRuntimeStatus,
								percent: plannerProgress.percent,
							};
						}
						showPlannerRunningStatus();
						progress.report(new LanguageModelTextPart(`${formatPlannerToolCallForChat(plannerProgress.toolName, plannerProgress.toolInput)}\n\n`));
						return;
					}

					if (plannerProgress.type === 'toolResult') {
						ensurePlannerRunningNote();
						progress.report(new LanguageModelTextPart(`${formatPlannerToolResultForChat(plannerProgress.toolResult ?? '', plannerProgress.toolSuccess)}\n\n`));
						return;
						showPlannerRunningStatus();
					}

					if (plannerProgress.type === 'complete') {
						this.showProgressStatus('Planner finalizing...');
					}
				},
			},
			this.output,
		);

		const lastMessage = processedChatHistory.messages.at(-1);
		const plannerPrompt = lastMessage
			? getLmStudioMessageText(lastMessage) ?? JSON.stringify(lastMessage.content)
			: 'Continue assisting with the latest request.';
		const plannerHistory = (lastMessage?.role === 'user'
			? processedChatHistory.messages.slice(0, -1)
			: processedChatHistory.messages
		).map(toPlannerLmStudioMessage);
		const activeTuningSummary = this.describeActiveModelTuning(predictionOptions);

		this.log(`Routing request through planner for model ${llmModel.identifier} with maxIterations=${plannerConfig.maxIterations}`);
		this.log(`Active model tuning for planner request: ${activeTuningSummary}`);
		this.maybeLogProgress(`planner request tuning: ${activeTuningSummary}`);
		const planningResult = await planner.plan(
			plannerPrompt,
			plannerHistory,
			async (plannerMessages) => this.invokePlannerModel(
				llmModel,
				plannerMessages,
				predictionOptions,
				token,
				(status) => {
					plannerRuntimeStatus = status;
					showPlannerRunningStatus();
				},
			),
			token,
		);

		ensurePlannerRunningNote();
		progress.report(new LanguageModelTextPart(formatPlannerResponseForChat(planningResult, plannerConfig.maxIterations)));

		this.log(`Planner completed success=${planningResult.success} iterations=${planningResult.iterations} toolCalls=${planningResult.toolCalls.length}`);
		if (planningResult.success) {
			this.showCompletedStatus('Planner complete');
		} else {
			this.showCompletedStatus('Planner stopped');
		}
	}

	private log(msg: string) {
		if (this.verbose) {
			this.output.appendLine(`[${new Date().toISOString()}] ${msg}`);
		}
		console.log(`LM Studio: ${msg}`);
	}

	private logError(msg: string, err: unknown) {
		const detail = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
		if (this.verbose) {
			this.output.appendLine(`[${new Date().toISOString()}] ERROR ${msg}: ${detail}`);
		}
		console.error(`LM Studio: ${msg}`, err);
	}

	private applyProgressStatusText(spinnerText: string): void {
		this.pendingProgressStatusText = undefined;
		this.lastProgressStatusText = spinnerText;
		this.lastProgressStatusUpdateAt = Date.now();
		this.statusBar.text = spinnerText;
		this.statusBar.show();
	}

	private showProgressStatus(text: string): void {
		if (!this.verboseProgress) {
			return;
		}

		if (this.statusBarHideTimer) {
			clearTimeout(this.statusBarHideTimer);
			this.statusBarHideTimer = undefined;
		}

		const spinnerText = `$(sync~spin) ${text}`;
		if (spinnerText === this.lastProgressStatusText) {
			this.statusBar.show();
			return;
		}

		const now = Date.now();
		const elapsedMs = now - this.lastProgressStatusUpdateAt;
		if (elapsedMs >= LMStudioChatModelProvider.PROGRESS_STATUS_MIN_UPDATE_INTERVAL_MS && !this.progressStatusTimer) {
			this.applyProgressStatusText(spinnerText);
			return;
		}

		this.pendingProgressStatusText = spinnerText;
		if (this.progressStatusTimer) {
			return;
		}

		const remainingMs = Math.max(0, LMStudioChatModelProvider.PROGRESS_STATUS_MIN_UPDATE_INTERVAL_MS - elapsedMs);
		this.progressStatusTimer = setTimeout(() => {
			this.progressStatusTimer = undefined;
			if (!this.pendingProgressStatusText) {
				return;
			}

			this.applyProgressStatusText(this.pendingProgressStatusText);
		}, remainingMs);
	}

	private showCompletedStatus(text: string, hideAfterMs = 8000): void {
		if (!this.verboseProgress) {
			return;
		}

		if (this.statusBarHideTimer) {
			clearTimeout(this.statusBarHideTimer);
		}
		if (this.progressStatusTimer) {
			clearTimeout(this.progressStatusTimer);
			this.progressStatusTimer = undefined;
		}
		this.pendingProgressStatusText = undefined;
		this.lastProgressStatusText = `$(check) ${text}`;

		this.statusBar.text = `$(check) ${text}`;
		this.statusBar.show();
		this.statusBarHideTimer = setTimeout(() => {
			this.statusBar.hide();
			this.statusBarHideTimer = undefined;
		}, hideAfterMs);
	}

	private hideProgressStatus(): void {
		if (!this.verboseProgress) {
			return;
		}

		if (this.statusBarHideTimer) {
			clearTimeout(this.statusBarHideTimer);
			this.statusBarHideTimer = undefined;
		}
		if (this.progressStatusTimer) {
			clearTimeout(this.progressStatusTimer);
			this.progressStatusTimer = undefined;
		}
		this.pendingProgressStatusText = undefined;
		this.lastProgressStatusText = '';
		this.lastProgressStatusUpdateAt = 0;
		this.statusBar.hide();
	}

	private maybeLogProgress(msg: string): void {
		if (this.verboseProgress) {
			this.output.appendLine(`[${new Date().toISOString()}] PROGRESS ${msg}`);
		}
	}

	private playChaChingSound(): void {
		if (!this.playTokenThresholdSound) {
			return;
		}

		if (process.platform !== 'win32') {
			this.log('Token threshold sound is only implemented on Windows in this extension build');
			return;
		}

		if (!fs.existsSync(this.chaChingSoundPath)) {
			this.log(`Token threshold sound file not found: ${this.chaChingSoundPath}`);
			return;
		}

		try {
			const escapedPath = this.chaChingSoundPath.replace(/'/g, "''");
			const command = `$player = New-Object System.Media.SoundPlayer '${escapedPath}'; $player.Load(); Start-Sleep -Seconds 1; $player.Play(); Start-Sleep -Seconds 1`;
			// Use spawn with proper options to ensure the sound plays correctly
			const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
				stdio: 'ignore',
			});
			// Don't detach the process - let it complete naturally otherwise sound won't play.
			child.unref();
		} catch (error) {
			this.logError('Failed to play token threshold sound', error);
		}
	}

	private syncCachedModelMetadata(modelId: string, maxInputTokens: number): void {
		if (!this.cachedModels) {
			return;
		}

		const updatedModels = this.cachedModels.map(existingModel => {
			if (existingModel.id !== modelId || existingModel.maxInputTokens === maxInputTokens) {
				return existingModel;
			}

			const maxOutputTokens = Math.min(8192, Math.floor(maxInputTokens / 4));
			return {
				...existingModel,
				maxInputTokens,
				maxOutputTokens,
			};
		});

		const didChange = updatedModels.some((existingModel, index) => existingModel !== this.cachedModels?.[index]);
		if (!didChange) {
			return;
		}

		this.cachedModels = updatedModels;
		this.cacheTimestamp = Date.now();
		this.log(`Updated cached metadata for ${modelId} to context length ${maxInputTokens}`);
		this._onDidChange.fire();
	}

	private recordSignatureObservation(store: Map<string, number>, signature: string): { seenBefore: boolean; count: number; } {
		const previousCount = store.get(signature) ?? 0;
		const nextCount = previousCount + 1;
		store.set(signature, nextCount);

		if (store.size > this.MAX_SIGNATURE_HISTORY) {
			const oldestKey = store.keys().next().value;
			if (oldestKey) {
				store.delete(oldestKey);
			}
		}

		return {
			seenBefore: previousCount > 0,
			count: nextCount,
		};
	}

	private ensureClient(): LMStudioClient | null {
		const baseUrl = this.getBaseUrl();
		const apiKey = this.getApiKey();

		// If we have a client and the settings haven't changed, reuse it
		if (this.client && this.lastBaseUrl === baseUrl && this.lastApiKey === apiKey) {
			return this.client;
		}

		// Create new client with current settings
		try {
			this.log(`Creating client with baseUrl: ${baseUrl}`);

			// Create client options with proper configuration
			const clientOptions: { baseUrl?: string; apiKey?: string } = {};

			// Only set baseUrl if it's not the default localhost:1234
			if (baseUrl !== DEFAULT_BASE_URL) {
				clientOptions.baseUrl = baseUrl;
				this.log(`Using custom base URL: ${baseUrl}`);
			}

			// Add API key if provided
			if (apiKey) {
				clientOptions.apiKey = apiKey;
				this.log('Using API key for authentication');
			} else {
				this.log('No API key provided (OK for local instances)');
			}

			// Create client - if no custom options, use default constructor
			this.client = Object.keys(clientOptions).length > 0
				? new LMStudioClient(clientOptions)
				: new LMStudioClient();
			this.lastBaseUrl = baseUrl;
			this.lastApiKey = apiKey;

			this.log('Client created successfully');
			return this.client;
		} catch (error) {
			this.logError('Failed to create client', error);
			this.client = null;
			this.lastBaseUrl = null;
			this.lastApiKey = null;
			return null;
		}
	}

	private getBaseUrl(): string {
		// Check VS Code workspace configuration first
		const config = workspace.getConfiguration(CONFIGURATION_ROOT);
		const configUrl = config.get<string>(SETTING_BASE_URL);
		if (configUrl) {
			this.log('Using base URL from VS Code settings');
			// Convert http/https to ws/wss for WebSocket protocol
			return configUrl.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
		}

		// Fall back to default
		this.log('Using default base URL');
		return DEFAULT_BASE_URL;
	}

	private getApiKey(): string | null {
		// First try environment variable
		const envKey = process.env[ENV_API_KEY];
		if (envKey) {
			this.log('Using API key from environment variable');
			return envKey;
		}

		// Then try VS Code workspace configuration
		const config = workspace.getConfiguration(CONFIGURATION_ROOT);
		const configKey = config.get<string>(SETTING_API_KEY);
		if (configKey) {
			this.log('Using API key from VS Code settings');
			return configKey;
		}

		this.log('No API key found (this is OK for local instances)');
		return null;
	}

	async prepareLanguageModelChat(_options: { silent: boolean; }, _token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		// Check if we have cached models that are still valid
		const now = Date.now();
		if (this.cachedModels && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
			this.cacheHits++;
			this.log('Using cached models');
			return this.cachedModels;
		}

		this.cacheMisses++;

		// Try to get loaded models from LM Studio dynamically
		try {
			const client = this.ensureClient();
			if (!client) {
				this.log('Client not available, using fallback model');
				const fallbackModels = [
					getChatModelInfo(STATUS_SERVER_NOT_STARTED, "🚨 Start LM Studio Server First!", 32768, 8192, false),
				];
				this.cachedModels = fallbackModels;
				this.cacheTimestamp = now;
				return fallbackModels;
			}

			// Test connection by trying to get loaded models
			this.log('Testing connection and fetching loaded models...');
			const loadedModels = await client.llm.listLoaded();
			this.log(`Successfully connected! Found ${loadedModels.length} loaded models`);

			// Convert LM Studio loaded models to VS Code model info
			const models: LanguageModelChatInformation[] = [];

			for (const model of loadedModels) {
				// Use the model identifier as both ID and name
				const id = model.identifier;
				const name = model.identifier; // LLM object doesn't have a separate display name

				// Get context length from model, use default if not available
				let maxInputTokens = 32768;
				try {
					maxInputTokens = await model.getContextLength();
				} catch (error) {
					this.logError(`Could not get context length for ${id}, using default`, error);
				}

				const maxOutputTokens = Math.min(8192, Math.floor(maxInputTokens / 4)); // Conservative output limit

				// Assume tool calling support for loaded models (can be refined later)
				const supportsTools = true;

				const supportsImageInput = inferImageInputSupport(id);

				this.log(`Adding loaded model ${id} - Context: ${maxInputTokens}, Image Input: ${supportsImageInput}`);

				models.push(getChatModelInfo(id, name, maxInputTokens, maxOutputTokens, supportsTools, supportsImageInput));
			}

			// If we found loaded models, return them, otherwise provide helpful guidance
			if (models.length > 0) {
				this.cachedModels = models;
				this.cacheTimestamp = now;
				// Notify VS Code that the model list has changed
				this._onDidChange.fire();
				return models;
			} else {
				this.log('No models are currently loaded in LM Studio');
				const fallbackModels = [
					getChatModelInfo(STATUS_NO_MODELS_LOADED, "📱 Load a Model in LM Studio", 32768, 8192, false),
				];
				this.cachedModels = fallbackModels;
				this.cacheTimestamp = now;
					this._onDidChange.fire();
					return fallbackModels;
			}

		} catch (error) {
			this.logError('Could not connect to LM Studio server', error);

			// Provide helpful error message based on the error type
			let errorModelName = "Connection Error - Check LM Studio";
			if (error instanceof Error) {
				this.logError('Connection error details', error);
				if (error.message.includes('ECONNREFUSED') || error.message.includes('connection')) {
					errorModelName = "🔌 Start LM Studio Server (Local Server tab)";
				} else if (error.message.includes('unauthorized') || error.message.includes('401')) {
					errorModelName = "🔐 Authentication Error (Check API key)";
				} else if (error.message.includes('timeout')) {
					errorModelName = "⏱️ Connection Timeout - Check Network";
				} else {
					errorModelName = `❌ Connection Error: ${error.message.substring(0, 40)}...`;
				}
			}

			const fallbackModels = [
				getChatModelInfo(STATUS_CONNECTION_ERROR, errorModelName, 32768, 8192, false),
			];
			this.cachedModels = fallbackModels;
			this.cacheTimestamp = now;
			this._onDidChange.fire();
			return fallbackModels;
		}
	}

	/**
	 * Manually refresh the model cache. This can be called when users want to update
	 * the available models without waiting for the cache to expire.
	 */
	public refreshModels(): void {
		console.log('LM Studio: Manually refreshing model cache');
		this.cachedModels = null;
		this.cacheTimestamp = 0;
		this._onDidChange.fire();
	}

	public async runDebugSmokeTest(): Promise<DebugSmokeTestResult> {
		const baseUrl = this.getBaseUrl();
		const tokenSource = new CancellationTokenSource();
		const originalPlannerEnabled = this.plannerEnabled;

		this.output.show(true);
		this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Starting debug-only smoke test against ${baseUrl}`);

		try {
			const models = await this.prepareLanguageModelChat({ silent: false }, tokenSource.token);
			const selectedModel = pickPreferredItemByIdentifier(
				models.filter(candidate => ![STATUS_CONNECTION_ERROR, STATUS_NO_MODELS_LOADED, STATUS_SERVER_NOT_STARTED].includes(candidate.id)),
			);

			if (!selectedModel) {
				return {
					success: false,
					baseUrl,
					visibleText: '',
					toolCalls: [],
					hadStructuredMarkers: false,
					configuredPlannerEnabled: originalPlannerEnabled,
					plannerExercised: false,
					forcedDirectMode: true,
					error: 'No loaded LM Studio model is available for the smoke test.',
				};
			}

			const collectedText: string[] = [];
			const toolCalls: string[] = [];
			const progressCollector: Progress<LanguageModelResponsePart> = {
				report: (part: LanguageModelResponsePart) => {
					if (part instanceof LanguageModelTextPart) {
						collectedText.push(part.value);
						return;
					}

					if (part instanceof LanguageModelToolCallPart) {
						toolCalls.push(part.name);
					}
				},
			};

			const smokeMessages: LanguageModelChatRequestMessage[] = [
				{
					role: LanguageModelChatMessageRole.User,
					// Keep the prompt intentionally tiny so this command validates transport, sanitization,
					// and active request settings without becoming a general-purpose chat shortcut.
					content: [new LanguageModelTextPart(`Debug smoke test. Reply with the exact text ${SMOKE_TEST_SENTINEL} and nothing else.`)],
					name: 'LM Studio Smoke Test',
				},
			];

			// This command intentionally forces direct mode. Planner mode can expose write-capable tools,
			// which would make a debug smoke test unsafe to run casually in an arbitrary workspace.
			this.plannerEnabled = false;
			await this.provideLanguageModelChatResponse(
				selectedModel,
				smokeMessages,
				{ modelOptions: { maxTokens: 48 }, tools: undefined, toolMode: LanguageModelChatToolMode.Auto, requestInitiator: 'lmstudio.debugSmokeTest' },
				progressCollector,
				tokenSource.token,
			);

			const visibleText = collectedText.join('');
			const normalizedVisibleText = visibleText.trim();
			const hadStructuredMarkers = /<\|channel\|>|<\|start\|>|<\|end\|>|<think>/i.test(visibleText);
			const matchedSentinel = normalizedVisibleText === SMOKE_TEST_SENTINEL;
			const success = matchedSentinel && toolCalls.length === 0 && !hadStructuredMarkers;

			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Model: ${selectedModel.id}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Model preference order: ${DEBUG_SMOKE_TEST_MODEL_PREFERENCE.join(', ')}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Planner enabled in settings: ${originalPlannerEnabled}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Planner exercised: false (forced direct mode for safety)`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Forced direct mode: true`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Tool calls observed: ${toolCalls.length === 0 ? 'none' : toolCalls.join(', ')}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Structured markers present after filtering: ${hadStructuredMarkers}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Sentinel matched exactly: ${matchedSentinel}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Visible output: ${visibleText || '<empty>'}`);

			return {
				success,
				modelId: selectedModel.id,
				baseUrl,
				visibleText,
				toolCalls,
				hadStructuredMarkers,
				configuredPlannerEnabled: originalPlannerEnabled,
				plannerExercised: false,
				forcedDirectMode: true,
				error: success ? undefined : `Smoke test expected exact sentinel '${SMOKE_TEST_SENTINEL}' without tools or structured markers.`,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[${new Date().toISOString()}] [Smoke Test] Error: ${detail}`);
			return {
				success: false,
				baseUrl,
				visibleText: '',
				toolCalls: [],
				hadStructuredMarkers: false,
				configuredPlannerEnabled: originalPlannerEnabled,
				plannerExercised: false,
				forcedDirectMode: true,
				error: detail,
			};
		} finally {
			this.plannerEnabled = originalPlannerEnabled;
			tokenSource.dispose();
		}
	}

	public async runDebugPlannerSmokeTest(): Promise<DebugPlannerSmokeTestResult> {
		const baseUrl = this.getBaseUrl();
		const tokenSource = new CancellationTokenSource();
		const originalPlannerEnabled = this.plannerEnabled;
		const originalPlannerMaxIterations = this.plannerMaxIterations;

		this.output.show(true);
		this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Starting debug-only planner smoke test against ${baseUrl}`);

		try {
			const models = await this.prepareLanguageModelChat({ silent: false }, tokenSource.token);
			const selectedModel = pickPreferredItemByIdentifier(
				models.filter(candidate => ![STATUS_CONNECTION_ERROR, STATUS_NO_MODELS_LOADED, STATUS_SERVER_NOT_STARTED].includes(candidate.id)),
			);

			if (!selectedModel) {
				return {
					success: false,
					baseUrl,
					configuredPlannerEnabled: originalPlannerEnabled,
					plannerExercised: false,
					allowedTools: [...READ_ONLY_PLANNER_SMOKE_TEST_TOOLS],
					iterations: 0,
					toolCalls: [],
					response: '',
					matchedSentinel: false,
					error: 'No loaded LM Studio model is available for the planner smoke test.',
				};
			}

			const client = this.ensureClient();
			if (!client) {
				throw new Error('LM Studio client is not available for the planner smoke test.');
			}

			const loadedModels = await client.llm.listLoaded();
			const llmModel = loadedModels.find(candidate => candidate.identifier === selectedModel.id)
				?? pickPreferredItemByIdentifier(loadedModels);
			if (!llmModel) {
				throw new Error('No loaded LM Studio runtime model is available for planner smoke test execution.');
			}

			// The planner smoke test intentionally exposes only read-only tools. This validates the real
			// planner loop while making it safe to run during code review or in a random workspace.
			const readOnlyRegistry = new DefaultToolRegistry(READ_ONLY_PLANNER_SMOKE_TEST_TOOLS);
			const plannerConfig: PlannerConfig = {
				...this.getPlannerConfig(),
				enabled: true,
				maxIterations: Math.max(2, Math.min(4, originalPlannerMaxIterations)),
				allowedTools: [...READ_ONLY_PLANNER_SMOKE_TEST_TOOLS],
			};
			const predictionOptions: PredictionOptions = {
				...this.buildPredictionOptions({ modelOptions: { maxTokens: 96 }, tools: undefined, toolMode: LanguageModelChatToolMode.Auto, requestInitiator: 'lmstudio.debugPlannerSmokeTest' }, false),
				rawTools: { type: 'none' },
			};

			const planner = createPlanner(
				plannerConfig,
				{
					workspaceRoot: this.getWorkspaceRoot(),
					outputChannel: this.output,
					token: tokenSource.token,
				},
				this.output,
				readOnlyRegistry,
			);

			const planningResult = await planner.plan(
				[
					`You must call one of the allowed read-only tools before giving any final answer.`,
					`First, use search_workspace to look for the exact text LMStudioChatModelProvider.`,
					`If search_workspace returns a match, you may optionally use read_file on the matched file for confirmation.`,
					`After at least one successful tool call, return exactly {"response":"${PLANNER_SMOKE_TEST_SENTINEL}"} and nothing else.`,
				].join(' '),
				[],
				async (plannerMessages) => this.invokePlannerModel(llmModel, plannerMessages, predictionOptions, tokenSource.token),
				tokenSource.token,
			);

			const matchedSentinel = planningResult.response.trim() === PLANNER_SMOKE_TEST_SENTINEL;
			const toolCalls = planningResult.toolCalls.map(toolCall => toolCall.tool);
			const success = planningResult.success && matchedSentinel && toolCalls.length > 0;

			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Model: ${llmModel.identifier}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Model preference order: ${DEBUG_SMOKE_TEST_MODEL_PREFERENCE.join(', ')}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Planner enabled in settings: ${originalPlannerEnabled}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Planner exercised: true`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Allowed tools: ${READ_ONLY_PLANNER_SMOKE_TEST_TOOLS.join(', ')}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Iterations: ${planningResult.iterations}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Tool calls observed: ${toolCalls.length === 0 ? 'none' : toolCalls.join(', ')}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Sentinel matched exactly: ${matchedSentinel}`);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Final response: ${planningResult.response || '<empty>'}`);

			return {
				success,
				modelId: llmModel.identifier,
				baseUrl,
				configuredPlannerEnabled: originalPlannerEnabled,
				plannerExercised: true,
				allowedTools: [...READ_ONLY_PLANNER_SMOKE_TEST_TOOLS],
				iterations: planningResult.iterations,
				toolCalls,
				response: planningResult.response,
				matchedSentinel,
				error: success ? undefined : `Planner smoke test expected at least one read-only tool call and exact sentinel '${PLANNER_SMOKE_TEST_SENTINEL}'.`,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`[${new Date().toISOString()}] [Planner Smoke Test] Error: ${detail}`);
			return {
				success: false,
				baseUrl,
				configuredPlannerEnabled: originalPlannerEnabled,
				plannerExercised: true,
				allowedTools: [...READ_ONLY_PLANNER_SMOKE_TEST_TOOLS],
				iterations: 0,
				toolCalls: [],
				response: '',
				matchedSentinel: false,
				error: detail,
			};
		} finally {
			this.plannerEnabled = originalPlannerEnabled;
			this.plannerMaxIterations = originalPlannerMaxIterations;
			tokenSource.dispose();
		}
	}

	/**
	 * Get the list of available language models provided by this provider
	 */
	async provideLanguageModelChatInformation(_options: { silent: boolean; }, _token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		// This method is called by VS Code to get the initial list of models
		// We can return cached models or fetch fresh ones
		return this.prepareLanguageModelChat(_options, _token);
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		// Ensure client is initialized with current settings
		const client = this.ensureClient();
		const started = Date.now();
		this.log(`Chat request started with model='${model.id}' messages=${messages.length} maxTokens=${options.modelOptions?.maxTokens}`);

		if (!client) {
			progress.report(new LanguageModelTextPart(
				"🚨 **LM Studio Server Not Started**\\n\\n" +
				"**Quick Fix Steps:**\\n" +
				"1. 🚀 **Open LM Studio application**\\n" +
				"2. 🌐 **Click the 'Local Server' tab at the top**\\n" +
				"3. ▶️ **Click 'Start Server' button**\\n" +
				"4. 📱 **Load a model** (click 'Select a model' if none loaded)\\n" +
				"5. 🔄 **Try your chat request again**\\n\\n" +
				"**Current settings:**\\n" +
				`• Connecting to: ${this.getBaseUrl()}\\n` +
				`• API Key: ${this.getApiKey() ? 'Configured' : 'None (OK for local)'}\\n\\n` +
				"💡 **Tip:** The server must be running AND have a model loaded to work!"
			));
			return;
		}

		try {
		this.showProgressStatus('LM Studio preparing prompt');
		// Convert VS Code messages to LM Studio chat format
		let currentContextLength = model.maxInputTokens;
		const maxToolResultTokens = Math.max(1200, Math.min(DEFAULT_MAX_TOOL_RESULT_TOKENS, Math.floor(model.maxInputTokens * 0.08)));
		const convertedMessages = messages.map((msg, index) => {
			const convertedMessage = toLmStudioMessage(msg, maxToolResultTokens);
			const preview = JSON.stringify(convertedMessage).substring(0, 160);
			this.log(`Message ${index}: role=${msg.role}->${convertedMessage.role} parts=${msg.content.length} payload=${preview}${preview.length >= 160 ? '...' : ''}`);
			return convertedMessage;
		});
		const baseChatHistory: LmStudioChatHistory = {
			messages: this.shouldInjectConfiguredSystemPrompt(options.requestInitiator)
				? [createSystemTextMessage(this.configuredSystemPrompt), ...convertedMessages]
				: convertedMessages,
		};
		if (this.shouldInjectConfiguredSystemPrompt(options.requestInitiator)) {
			this.log(`Injected configured system prompt (${estimateTokenCount(this.configuredSystemPrompt)} tokens)`);
		}
		const requestOverrideResult = applyRequestCommandOverridesToChatHistory(baseChatHistory);
		const chatHistory = requestOverrideResult.chatHistory;
		const effectivePlannerEnabled = requestOverrideResult.overrides.plannerModeOverride === 'plan'
			? true
			: requestOverrideResult.overrides.plannerModeOverride === 'noplan'
				? false
				: this.plannerEnabled;
		if (requestOverrideResult.overrides.plannerModeOverride) {
			const plannerCommandName = requestOverrideResult.overrides.plannerModeOverride === 'plan' ? '/lmsplan' : '/lmsnoplan';
			this.log(`Per-request planner override detected: ${plannerCommandName} (configured planner.enabled=${this.plannerEnabled})`);
		}
		for (const notice of requestOverrideResult.overrides.notices) {
			progress.report(new LanguageModelTextPart(`${notice}\n\n`));
		}
		if (requestOverrideResult.overrides.resetMaxTokensOverride) {
			const previousEffectiveMaxTokens = this.getEffectiveMaxTokens(options);
			const previousSessionMaxTokens = this.sessionMaxTokensOverride;
			this.sessionMaxTokensOverride = undefined;
			const restoredEffectiveMaxTokens = this.getEffectiveMaxTokens(options);
			const resetNotice = previousSessionMaxTokens !== undefined
				? `LM Studio note: cleared the session max response tokens override (was ${previousSessionMaxTokens}; previously effective cap ${previousEffectiveMaxTokens}). Requests now use the configured/default cap (${restoredEffectiveMaxTokens}). Use /lmsmaxtokens <number> to set a new session override.`
				: `LM Studio note: no session max response tokens override was active. Requests are using the configured/default cap (${restoredEffectiveMaxTokens}).`;
			this.log(`Session max response tokens override cleared; effective cap is now ${restoredEffectiveMaxTokens}`);
			progress.report(new LanguageModelTextPart(`${resetNotice}\n\n`));
		}
		if (requestOverrideResult.overrides.maxTokensOverride !== undefined) {
			const previousEffectiveMaxTokens = this.getEffectiveMaxTokens(options);
			this.sessionMaxTokensOverride = requestOverrideResult.overrides.maxTokensOverride;
			const currentEffectiveMaxTokens = this.getEffectiveMaxTokens(options);
			this.log(`Session max response tokens override set via /lmsmaxtokens ${currentEffectiveMaxTokens} (previous effective cap ${previousEffectiveMaxTokens})`);
			if (previousEffectiveMaxTokens === currentEffectiveMaxTokens && !this._maxTokensRemainsNoticeShown) {
				this._maxTokensRemainsNoticeShown = true;
				const overrideNotice = `LM Studio note: session max response tokens remains ${currentEffectiveMaxTokens}. This value stays in effect for later LM Studio requests until you change it again, use /lmsmaxtokensreset, or reload VS Code.`;
				progress.report(new LanguageModelTextPart(`${overrideNotice}\n\n`));
			} else if (previousEffectiveMaxTokens !== currentEffectiveMaxTokens) {
				const overrideNotice = `LM Studio note: session max response tokens changed from ${previousEffectiveMaxTokens} to ${currentEffectiveMaxTokens}. This value stays in effect for later LM Studio requests until you change it again, use /lmsmaxtokensreset, or reload VS Code.`;
				progress.report(new LanguageModelTextPart(`${overrideNotice}\n\n`));
			}
		}
			// Get a model instance - try to get the requested model or use the first available one
			let llmModel;
			try {
				if (model.id === STATUS_NO_MODELS_LOADED || model.id === STATUS_CONNECTION_ERROR || model.id === STATUS_SERVER_NOT_STARTED) {
					throw new Error("No models available or connection error. Please start LM Studio server and load a model.");
				}

				// Get list of currently loaded models
				const loadedModels = await client.llm.listLoaded();

				if (loadedModels.length === 0) {
					throw new Error("No models are currently loaded in LM Studio. Please load a model first.");
				}

				// Try to find the specific model requested
				llmModel = loadedModels.find(m => m.identifier === model.id);

				if (!llmModel) {
					// If specific model not found, use the first available one
					llmModel = loadedModels[0];
					this.log(`Requested model '${model.id}' not found, using: ${llmModel.identifier}`);
				} else {
					this.log(`Using requested model: ${llmModel.identifier}`);
				}

				try {
					const actualContextLength = await llmModel.getContextLength();
					currentContextLength = actualContextLength;
					if (actualContextLength !== model.maxInputTokens) {
						this.log(`Model context length changed from ${model.maxInputTokens} to ${actualContextLength}; refreshing cached metadata`);
						this.syncCachedModelMetadata(llmModel.identifier, actualContextLength);
					}
				} catch (contextError) {
					this.logError(`Could not refresh context length for ${llmModel.identifier}`, contextError);
				}

			} catch (loadError) {
				throw new Error(`No models available. Please load a model in LM Studio first. Error: ${loadError}`);
			}

			let receivedToolCalls = 0;
			let receivedChars = 0;
			let firstFragmentTime: number | undefined;
			let skipThinkMode = false;
			let accumulatedContent = '';
			let lastReportTime = Date.now();
			const BATCH_DELAY_MS = 100; // Slightly longer delay for stability
			let fragmentCount = 0;
			let lastPromptProgress = -1;
			let generatedTokens = 0;
			let tokenTimestamps: number[] = [];
			let minTokensPerSecond = Infinity;
			let maxTokensPerSecond = -Infinity;
			let totalTokensPerSecond = 0;
			let tokenCount = 0;
			let visibleResponseText = '';
			const filterState: GeneratedContentFilterState = { skipThinkMode: false };

			// Helper function to flush accumulated content
			const flushContent = () => {
				if (accumulatedContent.trim().length > 0) {
					this.log(`Flushing batch: "${accumulatedContent.substring(0, 50)}${accumulatedContent.length > 50 ? '...' : ''}"`);
					try {
						progress.report(new LanguageModelTextPart(accumulatedContent));
						receivedChars += accumulatedContent.length;
						accumulatedContent = '';
					} catch (error) {
						this.logError('Error reporting fragment', error);
					}
				}
			};

			const predictionOptions = this.buildPredictionOptions(options);
			const activeTuningSummary = this.describeActiveModelTuning(predictionOptions);
			this.log(`Active model tuning for request: ${activeTuningSummary}`);
			this.maybeLogProgress(`request tuning: ${activeTuningSummary}`);

			// Apply auto-caveman prompt reduction if enabled
			let processedChatHistory = chatHistory;
			if (this.autoCavemanPrompts && this.performanceOptimizations) {
				this.log('Auto-caveman prompt reduction enabled; prepending compression instruction to the request');
				// Preprocess the chat history to make prompts more concise
				const cavemanPrompt = "Please make this prompt as concise as possible while preserving all essential information and meaning. Keep it brief but complete.";
				
				// Create a system message with the caveman instruction
				const systemMessage = {
					role: 'system' as const,
					content: [{ type: 'text' as const, text: cavemanPrompt }]
				};
				
				// Insert the system message at the beginning of the conversation
				processedChatHistory = {
					messages: [systemMessage, ...chatHistory.messages]
				};
				
				// Calculate token savings if verbose logging is enabled
				if (this.verbose) {
					const originalTokens = estimateTokenCount(JSON.stringify(chatHistory));
					const processedTokens = estimateTokenCount(JSON.stringify(processedChatHistory));
					const tokenSavings = originalTokens - processedTokens;
					
					if (tokenSavings > 0) {
						this.log(`🗿 Caveman prompt reduction: ${tokenSavings} tokens saved (${Math.round((tokenSavings/originalTokens)*100)}% reduction)`);
					} else {
						this.log(`🗿 Caveman prompt reduction active; prompt size changed by ${tokenSavings} tokens after adding the compression instruction`);
					}
				}
			}
			
			const requestedOutputTokens = Math.min(predictionOptions.maxTokens, model.maxOutputTokens || predictionOptions.maxTokens);
			const contextSafetyMargin = Math.min(2048, Math.max(256, Math.floor(currentContextLength * 0.05)));
			const maxPromptTokens = Math.max(1024, currentContextLength - requestedOutputTokens - contextSafetyMargin);

			// Apply token budgeting if enabled - monitor and warn about approaching limits
			let budgetResult = {
				chatHistory: processedChatHistory,
				originalTokens: estimateChatHistoryTokens(processedChatHistory, predictionOptions.rawTools),
				finalTokens: estimateChatHistoryTokens(processedChatHistory, predictionOptions.rawTools),
				droppedMessageCount: 0,
				truncatedMessageCount: 0,
				wasShortened: false,
				fitsWithinBudget: true,
			};
			if (this.tokenBudgeting && this.performanceOptimizations) {
				budgetResult = enforceHistoryTokenBudget(processedChatHistory, predictionOptions.rawTools, maxPromptTokens);
				processedChatHistory = budgetResult.chatHistory;
				const totalEstimatedTokens = budgetResult.finalTokens;
				const contextLimit = currentContextLength;
				const warningThreshold = Math.floor(contextLimit * 0.8); // Warn at 80% usage
				this.log(`Token budgeting active: estimated ${totalEstimatedTokens}/${maxPromptTokens} prompt tokens before sending request (context ${contextLimit}, reserved output ${requestedOutputTokens}, safety margin ${contextSafetyMargin}, overflow policy ${this.contextOverflowPolicy})`);

				if (budgetResult.wasShortened) {
					const budgetNotice = `💸 Context shortened due to max size (~${budgetResult.originalTokens} -> ~${budgetResult.finalTokens} prompt tokens)\n\n`;
					this.log(`Context budget enforced: ${budgetResult.originalTokens} -> ${budgetResult.finalTokens} prompt tokens, dropped ${budgetResult.droppedMessageCount} message(s), truncated ${budgetResult.truncatedMessageCount} message(s), prompt budget ${maxPromptTokens}, overflow policy ${this.contextOverflowPolicy}`);
					progress.report(new LanguageModelTextPart(budgetNotice));
				}

				if (!budgetResult.fitsWithinBudget) {
					if (this.blockOversizedRequests) {
						const budgetFailureMessage = [
							`💸 Context shortened due to max size (~${budgetResult.originalTokens} -> ~${budgetResult.finalTokens} prompt tokens).`,
							'',
							`The request is still too large to send safely. LM Studio currently reports a context size of ~${currentContextLength} tokens for this model.`,
							'Consider increasing the context size in LM Studio, reducing the conversation history, or lowering tool output volume.',
						].join('\n');
						this.log(`Provider-side budgeter could not fully fit the request within ~${maxPromptTokens} prompt tokens; aborting before LM Studio call. Current LM Studio context length is ~${currentContextLength} tokens. Overflow policy '${this.contextOverflowPolicy}' was not used because the request was blocked locally.`);
						progress.report(new LanguageModelTextPart(budgetFailureMessage));
						this.showCompletedStatus(`LM Studio blocked oversized request (~${budgetResult.finalTokens}/${maxPromptTokens} prompt tok)`);
						return;
					}

					const continueAnywayMessage = [
						`💸 Context shortened due to max size (~${budgetResult.originalTokens} -> ~${budgetResult.finalTokens} prompt tokens).`,
						'',
						`The request is still estimated to exceed the safe prompt budget. LM Studio currently reports a context size of ~${currentContextLength} tokens for this model.`,
						'Continuing anyway because local blocking is disabled. Consider increasing the context size in LM Studio if this fails.',
					].join('\n');
					this.log(`Provider-side budgeter could not fully fit the request within ~${maxPromptTokens} prompt tokens, but continuing because oversized-request blocking is disabled. Current LM Studio context length is ~${currentContextLength} tokens. Overflow policy '${this.contextOverflowPolicy}' may still trim or reject the request.`);
					progress.report(new LanguageModelTextPart(continueAnywayMessage));
				}
				
				if (totalEstimatedTokens > warningThreshold) {
					this.log(`⚠️ Token budget warning: ${totalEstimatedTokens} tokens used, approaching limit of ${contextLimit} tokens`);
				}
			}

			// A per-request /lmsplan or /lmsnoplan prefix can override the global planner setting for
			// this single request, which is a better UX fit than flipping the setting back and forth.
			if (effectivePlannerEnabled) {
				await this.providePlannerResponse(llmModel, processedChatHistory, predictionOptions, progress, token);
				return;
			}
			
			// Calculate system prompt size if there are system messages
			let systemPromptTokens = 0;
			const systemMessages = processedChatHistory.messages.filter(msg => msg.role === 'system');
			if (systemMessages.length > 0) {
				const systemPromptContent = systemMessages.map(msg => 
					msg.content.map(c => c.type === 'text' ? c.text : '').join('')
				).join('\n\n');
				
				if (systemPromptContent.trim()) {
					systemPromptTokens = estimateTokenCount(systemPromptContent);
					this.log(`System Prompt Size: ${systemPromptTokens} tokens`);
				}
			}
			
			const estimatedPromptTokens = estimateChatHistoryTokens(processedChatHistory, predictionOptions.rawTools);
			const requestSignature = hashPayload({
				modelId: llmModel.identifier,
				chatHistory: processedChatHistory,
				maxTokens: predictionOptions.maxTokens,
				rawTools: predictionOptions.rawTools,
				temperature: predictionOptions.temperature,
				topPSampling: predictionOptions.topPSampling,
				topKSampling: predictionOptions.topKSampling,
				minPSampling: predictionOptions.minPSampling,
				repeatPenalty: predictionOptions.repeatPenalty,
				contextOverflowPolicy: predictionOptions.contextOverflowPolicy,
			});
			const requestObservation = this.recordSignatureObservation(this.requestSignatureCounts, requestSignature);
			if (requestObservation.seenBefore) {
				this.requestReuseHits++;
				this.log(`Request reuse detected: signature=${requestSignature} seen ${requestObservation.count} time(s)`);
			} else {
				this.requestReuseMisses++;
				this.log(`Request signature miss: signature=${requestSignature}`);
			}

			const predictionCallbacks = {
				onPromptProcessingProgress: (promptProgress: number) => {
					const percent = Math.max(0, Math.min(100, Math.round(promptProgress * 100)));
					if (percent === lastPromptProgress) {
						return;
					}

					lastPromptProgress = percent;
					const processedTokens = Math.min(estimatedPromptTokens, Math.round(estimatedPromptTokens * promptProgress));
					this.maybeLogProgress(`prompt ${percent}% (~${processedTokens}/${estimatedPromptTokens} tokens)`);
					this.showProgressStatus(`LM Studio prompt ${percent}% (~${processedTokens}/${estimatedPromptTokens} tokens)`);
				},
				onFirstToken: () => {
					this.maybeLogProgress('generation started');
					this.showProgressStatus('LM Studio generating response');
				},
				onToolCallRequestEnd: (_callId: number, info: { toolCallRequest: { type: string; id?: string; name: string; arguments?: Record<string, any>; }; rawContent: string | undefined; }) => {
					flushContent();

					if (info.toolCallRequest.type !== 'function') {
						this.log(`Skipping unsupported LM Studio tool call type: ${info.toolCallRequest.type}`);
						return;
					}

					const toolCallId = info.toolCallRequest.id ?? `lmstudio-${Date.now()}-${receivedToolCalls}`;
					receivedToolCalls++;
					this.log(`Reporting tool call '${info.toolCallRequest.name}' id=${toolCallId}`);
					progress.report(new LanguageModelToolCallPart(toolCallId, info.toolCallRequest.name, info.toolCallRequest.arguments ?? {}));
				},
				onToolCallRequestFailure: (_callId: number, error: Error) => {
					this.logError('LM Studio tool call generation failed', error);
				},
			};

			const responseOptions = {
				...predictionOptions,
				...predictionCallbacks,
			};

			this.log(`Invoking respond() with options ${JSON.stringify({ maxTokens: predictionOptions.maxTokens, temperature: predictionOptions.temperature, topPSampling: predictionOptions.topPSampling, topKSampling: predictionOptions.topKSampling, minPSampling: predictionOptions.minPSampling, repeatPenalty: predictionOptions.repeatPenalty, hasTools: predictionOptions.rawTools.type === 'toolArray', forceTool: predictionOptions.rawTools.type === 'toolArray' ? !!predictionOptions.rawTools.force : false, contextOverflowPolicy: predictionOptions.contextOverflowPolicy })} historyLength=${processedChatHistory.messages.length}`);
			this.log(`Estimated prompt tokens before send: ~${estimatedPromptTokens}`);
			const prediction = llmModel.respond(processedChatHistory, responseOptions);

			// Stream the response
			for await (const fragment of prediction) {
				if (token.isCancellationRequested) {
					this.log('Cancellation requested by VS Code token');
						void Promise.resolve(prediction).catch(() => undefined);
					break;
				}

				generatedTokens += Math.max(0, fragment.tokensCount || 0);

				if (fragment.content) {
					if (firstFragmentTime === undefined) {
						firstFragmentTime = Date.now();
						this.log(`First fragment received after ${firstFragmentTime - started}ms`);
					}

					const content = fragment.content;
					fragmentCount++;
					const filteredContent = filterGeneratedFragmentContent(content, filterState);
					if (!filteredContent) {
						continue;
					}

					// Only accumulate non-empty content
					if (filteredContent.length > 0) {
						visibleResponseText += filteredContent;
						accumulatedContent += filteredContent;
						
						const now = Date.now();
						
						// Track tokens per second for real-time display and statistics
						if (firstFragmentTime !== undefined && now > firstFragmentTime) {
							const elapsedSeconds = (now - firstFragmentTime) / 1000;
							const tokensPerSecond = Math.floor(generatedTokens / elapsedSeconds);
							
							// Update statistics for final logging
							tokenCount++;
							totalTokensPerSecond += tokensPerSecond;
							minTokensPerSecond = Math.min(minTokensPerSecond, tokensPerSecond);
							maxTokensPerSecond = Math.max(maxTokensPerSecond, tokensPerSecond);
							
							// Store timestamp for calculating rate
							tokenTimestamps.push(now);
							
							// Show real-time tokens per second when verbose progress is enabled
							if (this.verboseProgress) {
								const progressText = `LM Studio generating response (~${tokensPerSecond} t/s)`;
								this.showProgressStatus(progressText);
							}
						}
						
						// More conservative flushing strategy
						const shouldFlush = 
							// Flush on paragraph breaks (double newlines)
							content.includes('\n\n') ||
							// Flush on code block boundaries  
							content.includes('```') ||
							// Flush if we've accumulated a reasonable amount
							accumulatedContent.length >= 50 ||
							// Flush if enough time has passed
							(now - lastReportTime) >= BATCH_DELAY_MS ||
							// Flush every 10 fragments to prevent too much accumulation
							(fragmentCount % 10 === 0);

						if (shouldFlush) {
							flushContent();
							lastReportTime = now;
						}
					}
				}
			}

			// Always flush any remaining content at the end
			flushContent();
			if (token.isCancellationRequested) {
				this.showCompletedStatus('LM Studio request cancelled');
				return;
			}
			await prediction;
			if (didLikelyHitResponseTokenLimit(visibleResponseText, generatedTokens, predictionOptions.maxTokens)) {
				const tokenLimitNotice = createResponseTokenLimitNotice(predictionOptions.maxTokens);
				progress.report(new LanguageModelTextPart(tokenLimitNotice));
				visibleResponseText += tokenLimitNotice;
				this.log(`🏧 Likely hit LM Studio response token cap at ${predictionOptions.maxTokens} max tokens.`);
			}
			const ended = Date.now();
			this.log(`Streaming complete fragments=${fragmentCount} chars=${receivedChars} toolCalls=${receivedToolCalls} duration=${ended-started}ms firstFragmentLatency=${firstFragmentTime?firstFragmentTime-started:'n/a'}ms`);
			if (visibleResponseText || receivedToolCalls > 0) {
				const responseSignature = hashPayload({
					modelId: llmModel.identifier,
					responseText: visibleResponseText,
					toolCalls: receivedToolCalls,
				});
				const responseObservation = this.recordSignatureObservation(this.responseSignatureCounts, responseSignature);
				if (responseObservation.seenBefore) {
					this.responseReuseHits++;
					this.log(`Response reuse detected: signature=${responseSignature} seen ${responseObservation.count} time(s)`);
				} else {
					this.responseReuseMisses++;
					this.log(`Response signature miss: signature=${responseSignature}`);
				}
			}
			const totalTokens = estimatedPromptTokens + generatedTokens;
			
			// Calculate final statistics for tokens per second
			let avgTokensPerSecond = 0;
			if (tokenCount > 0 && firstFragmentTime !== undefined) {
				const totalSeconds = (ended - firstFragmentTime) / 1000;
				avgTokensPerSecond = Math.floor(totalTokens / totalSeconds);
			}
			
			const finalSummary = `LM Studio done: ~${estimatedPromptTokens} prompt tok, ~${generatedTokens} gen tok, ~${totalTokens} total tok, ${Math.round((ended - started) / 1000)}s`;
			this.log(finalSummary);
			
			// Log model cache statistics if we have data
			if (this.verbose && (this.cacheHits > 0 || this.cacheMisses > 0)) {
				const totalRequests = this.cacheHits + this.cacheMisses;
				const hitRate = ((this.cacheHits / totalRequests) * 100).toFixed(1);
				const cacheStats = `Model cache stats: ${this.cacheHits} hits, ${this.cacheMisses} misses, ${hitRate}% hit rate`;
				this.log(cacheStats);
			}

			if (this.verbose && (this.requestReuseHits > 0 || this.requestReuseMisses > 0)) {
				const totalRequests = this.requestReuseHits + this.requestReuseMisses;
				const hitRate = ((this.requestReuseHits / totalRequests) * 100).toFixed(1);
				this.log(`Request reuse stats: ${this.requestReuseHits} repeated, ${this.requestReuseMisses} new, ${hitRate}% repeated`);
			}

			if (this.verbose && (this.responseReuseHits > 0 || this.responseReuseMisses > 0)) {
				const totalResponses = this.responseReuseHits + this.responseReuseMisses;
				const hitRate = ((this.responseReuseHits / totalResponses) * 100).toFixed(1);
				this.log(`Response reuse stats: ${this.responseReuseHits} repeated, ${this.responseReuseMisses} new, ${hitRate}% repeated`);
			}
			
			// Log token statistics if we have data
			if (tokenCount > 0 && firstFragmentTime !== undefined) {
				const stats = `Tokens/second stats: avg=${avgTokensPerSecond}, min=${minTokensPerSecond === Infinity ? 0 : minTokensPerSecond}, max=${maxTokensPerSecond === -Infinity ? 0 : maxTokensPerSecond}`;
				this.log(stats);
				this.maybeLogProgress(`${finalSummary} | ${stats}`);
			} else {
				this.maybeLogProgress(finalSummary);
			}
			
			if (totalTokens > this.tokenSoundThreshold) {
				this.log(`Token threshold exceeded (~${totalTokens} > ${this.tokenSoundThreshold}); playing completion sound`);
				this.playChaChingSound();
			}
			this.showCompletedStatus(finalSummary);

		} catch (error) {
			this.hideProgressStatus();
			let errorMessage = 'Unknown error occurred';

			if (error instanceof Error) {
				errorMessage = error.message;

				// Provide more helpful error messages for common issues
				if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connection')) {
					errorMessage = "🔌 **Cannot connect to LM Studio**\\n\\n" +
						"**Troubleshooting steps:**\\n" +
						"1. 🚀 Start LM Studio application\\n" +
						"2. 🌐 Go to 'Local Server' tab\\n" +
						"3. ▶️ Click 'Start Server'\\n" +
						"4. 📱 Load a model (click 'Select a model')\\n" +
						"5. ✅ Wait for model to load completely\\n" +
						"6. 🔄 Try your request again\\n\\n" +
						`**Current settings:**\\n` +
						`• Trying to connect to: ${this.getBaseUrl()}\\n` +
						`• API Key: ${this.getApiKey() ? 'Set' : 'Not required for local'}\\n\\n` +
						"**Quick fix:** Check LM Studio's 'Local Server' tab and ensure it shows 'Server running'.";
				} else if (errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
					errorMessage = "🔐 **Authentication failed**\\n\\nPlease check your LM Studio API key in VS Code settings.";
				} else if (errorMessage.includes('No models available') || errorMessage.includes('No models are currently loaded')) {
					errorMessage = "📱 **No models loaded in LM Studio**\\n\\n" +
						"**Step-by-step fix:**\\n" +
						"1. 🚀 **Open LM Studio app**\\n" +
						"2. 🌐 **Go to 'Local Server' tab**\\n" +
						"3. ▶️ **Start the server** (if not already running)\\n" +
						"4. 📋 **Click 'Select a model to load'**\\n" +
						"5. ⚡ **Choose and load a model**\\n" +
						"6. ✅ **Wait for model to finish loading**\\n" +
						"7. 🔄 **Try your chat request again**\\n\\n" +
						"💡 **Quick check:** Look for a green indicator next to your model in LM Studio!";
				} else if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
					errorMessage = "⏱️ **Rate limit exceeded**\\n\\nPlease wait a moment and try again.";
				} else if (looksLikeResponseTokenLimitError(errorMessage)) {
					errorMessage = 'Not enough tokens to follow through on the response. LM Studio likely stopped because the response token limit was reached. Try a higher value with /lmsmaxtokens <number> or raise the LM Studio max-response-tokens setting.';
				}
			}

			progress.report(new LanguageModelTextPart(errorMessage));
		}
	}

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatRequestMessage, _token: CancellationToken): Promise<number> {
		try {
			let content: string;
			if (typeof text === 'string') {
				content = text;
			} else {
				content = text.content.map((part: unknown) => serializeUnknownPart(part)).join('');
			}

			// Use gpt-tokenizer for approximation since we don't know the exact tokenizer
			// Note: This gives an approximation since LM Studio models may use different tokenizers
			const tokens = encode(content);
			return tokens.length;
		} catch {
			// Fallback to simple estimation if tokenizer fails
			let content: string;
			if (typeof text === 'string') {
				content = text;
			} else {
				content = text.content.map((part: unknown) => serializeUnknownPart(part)).join('');
			}
			// Rough estimation: 1 token per 4 characters
			return Math.ceil(content.length / 4);
		}
	}
}