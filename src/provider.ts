import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken, LanguageModelChatMessageRole, LanguageModelChatTool, LanguageModelChatToolMode, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelDataPart, Progress, workspace, ConfigurationChangeEvent, EventEmitter, window, OutputChannel, StatusBarAlignment, StatusBarItem, LanguageModelChatProvider, LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelResponsePart, ProvideLanguageModelChatResponseOptions } from "vscode";
import { LMStudioClient } from '@lmstudio/sdk';
import { encode } from 'gpt-tokenizer';

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
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 8000;
const DEFAULT_CONTEXT_OVERFLOW_POLICY = 'truncateMiddle';
const CONTEXT_BUDGET_RECENT_MESSAGE_COUNT = 4;
const MIN_MESSAGE_TEXT_BUDGET_TOKENS = 128;

type ContextOverflowPolicy = 'stopAtLimit' | 'truncateMiddle' | 'rollingWindow';

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
	if (value === 'stopAtLimit' || value === 'truncateMiddle' || value === 'rollingWindow') {
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
		this.output = window.createOutputChannel('LM Studio');
		this.statusBar = window.createStatusBarItem('lmstudio.progress', StatusBarAlignment.Left, 100);
		this.statusBar.name = 'LM Studio Progress';
		this.statusBar.hide();
		this.chaChingSoundPath = path.join(extensionPath, 'cha-ching.wav');
		this.loadSettings();
		// Listen for configuration changes to refresh the client
		workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('lmstudio.baseUrl') ||
				e.affectsConfiguration('lmstudio.apiKey') ||
				e.affectsConfiguration('lmstudio.verboseLogging') ||
				e.affectsConfiguration('lmstudio.verboseProgressReporting') ||
				e.affectsConfiguration('lmstudio.playTokenThresholdSound') ||
				e.affectsConfiguration('lmstudio.tokenSoundThreshold') ||
				e.affectsConfiguration('lmstudio.autoCavemanPrompts') ||
				e.affectsConfiguration('lmstudio.tokenBudgeting') ||
				e.affectsConfiguration('lmstudio.contextOverflowPolicy') ||
				e.affectsConfiguration('lmstudio.blockOversizedRequests') ||
				e.affectsConfiguration('lmstudio.performanceOptimizations') ||
				e.affectsConfiguration('lmstudio.toggleAllPerformance')) {
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
			const config = workspace.getConfiguration('lmstudio');
			this.verbose = !!config.get<boolean>('verboseLogging');
			this.verboseProgress = !!config.get<boolean>('verboseProgressReporting');
			this.playTokenThresholdSound = !!config.get<boolean>('playTokenThresholdSound');
			this.tokenSoundThreshold = Math.max(1, config.get<number>('tokenSoundThreshold', 10000));
			this.autoCavemanPrompts = !!config.get<boolean>('autoCavemanPrompts');
			this.performanceOptimizations = !!config.get<boolean>('performanceOptimizations');
			this.contextOverflowPolicy = normalizeContextOverflowPolicy(config.get<string>('contextOverflowPolicy', DEFAULT_CONTEXT_OVERFLOW_POLICY));
			this.blockOversizedRequests = config.get<boolean>('blockOversizedRequests', true);
			
			// Handle toggle all performance setting
			const toggleAll = !!config.get<boolean>('toggleAllPerformance');
			if (toggleAll) {
				// Turn all performance features on
				this.autoCavemanPrompts = true;
				this.performanceOptimizations = true;
				this.tokenBudgeting = true;
			} else {
				// Respect individual settings if toggle is off
				this.autoCavemanPrompts = !!config.get<boolean>('autoCavemanPrompts');
				this.performanceOptimizations = !!config.get<boolean>('performanceOptimizations');
				this.tokenBudgeting = !!config.get<boolean>('tokenBudgeting');
			}
			
			this.toggleAllPerformance = toggleAll;
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
			this.toggleAllPerformance = false;
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

	private showProgressStatus(text: string): void {
		if (!this.verboseProgress) {
			return;
		}

		if (this.statusBarHideTimer) {
			clearTimeout(this.statusBarHideTimer);
			this.statusBarHideTimer = undefined;
		}
		this.statusBar.text = `$(sync~spin) ${text}`;
		this.statusBar.show();
	}

	private showCompletedStatus(text: string, hideAfterMs = 8000): void {
		if (!this.verboseProgress) {
			return;
		}

		if (this.statusBarHideTimer) {
			clearTimeout(this.statusBarHideTimer);
		}

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
			if (baseUrl !== 'http://localhost:1234') {
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
		const config = workspace.getConfiguration('lmstudio');
		const configUrl = config.get<string>('baseUrl');
		if (configUrl) {
			this.log('Using base URL from VS Code settings');
			// Convert http/https to ws/wss for WebSocket protocol
			return configUrl.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
		}

		// Fall back to default
		this.log('Using default base URL');
		return 'ws://localhost:1234';
	}

	private getApiKey(): string | null {
		// First try environment variable
		const envKey = process.env.LMSTUDIO_API_KEY;
		if (envKey) {
			this.log('Using API key from environment variable');
			return envKey;
		}

		// Then try VS Code workspace configuration
		const config = workspace.getConfiguration('lmstudio');
		const configKey = config.get<string>('apiKey');
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
					getChatModelInfo("server-not-started", "🚨 Start LM Studio Server First!", 32768, 8192, false),
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

				// Detect if model supports image input based on model identifier
				// Common vision model patterns in LM Studio
				let supportsImageInput = false;
				
				// Check for known vision-capable models by pattern matching
				if (id.includes('vision') || 
					id.includes('llava') || 
					id.includes('qwen') ||
					id.includes('gemma') ||
					id.includes('phi') ||
					id.includes('cogvlm') ||
					id.includes('minicpm') ||
					id.includes('llama') ||
					id.includes('pixtral') ||
					id.includes('deepseek') ||
					id.includes('nous-hermes')) {
					supportsImageInput = true;
				}
				
				// Additional heuristic: if model name contains "image" or "vision" patterns, it's likely vision-capable
				if (id.toLowerCase().includes('image') || id.toLowerCase().includes('vision')) {
					supportsImageInput = true;
				}

				this.log(`Adding loaded model ${id} - Context: ${maxInputTokens}, Image Input: ${supportsImageInput}`);

				models.push(getChatModelInfo(id, name, maxInputTokens, maxOutputTokens, supportsTools, supportsImageInput));
			}

			// If we found loaded models, return them, otherwise provide helpful guidance
			if (models.length > 0) {
				this.cachedModels = models;
				this.cacheTimestamp = now;
					this.cachedModels = models;
					this.cacheTimestamp = now;
					// Notify VS Code that the model list has changed
					this._onDidChange.fire();
					return models;
			} else {
				this.log('No models are currently loaded in LM Studio');
				const fallbackModels = [
					getChatModelInfo("no-models-loaded", "📱 Load a Model in LM Studio", 32768, 8192, false),
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
				getChatModelInfo("connection-error", errorModelName, 32768, 8192, false),
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
		const chatHistory: LmStudioChatHistory = {
			messages: messages.map((msg, index) => {
			const convertedMessage = toLmStudioMessage(msg, maxToolResultTokens);
			const preview = JSON.stringify(convertedMessage).substring(0, 160);
			this.log(`Message ${index}: role=${msg.role}->${convertedMessage.role} parts=${msg.content.length} payload=${preview}${preview.length >= 160 ? '...' : ''}`);
			return convertedMessage;
			}),
		};			// Get a model instance - try to get the requested model or use the first available one
			let llmModel;
			try {
				if (model.id === "no-models-loaded" || model.id === "connection-error" || model.id === "server-not-started") {
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

			// Define predictionOptions before using it
			const predictionOptions = {
				maxTokens: options.modelOptions?.maxTokens || 8192,
				rawTools: toLmStudioRawTools(options.tools, options.toolMode),
				contextOverflowPolicy: this.contextOverflowPolicy,
			};

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

			this.log(`Invoking respond() with options ${JSON.stringify({ maxTokens: predictionOptions.maxTokens, hasTools: predictionOptions.rawTools.type === 'toolArray', forceTool: predictionOptions.rawTools.type === 'toolArray' ? !!predictionOptions.rawTools.force : false, contextOverflowPolicy: predictionOptions.contextOverflowPolicy })} historyLength=${processedChatHistory.messages.length}`);
			this.log(`Estimated prompt tokens before send: ~${estimatedPromptTokens}`);
			const prediction = llmModel.respond(processedChatHistory, responseOptions);

			// Stream the response
			for await (const fragment of prediction) {
				if (token.isCancellationRequested) {
					this.log('Cancellation requested by VS Code token');
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

					// Handle thinking mode - skip <think> content entirely
					if (content === '<think>' || content === '<|channel|>analysis<|message|>') {
						skipThinkMode = true;
						this.log(`Fragment skipped (start thinking): raw="${content}"`);
						continue;
					} else if (content === '</think>' || content === '<|end|>') {
						skipThinkMode = false;
						this.log(`Fragment skipped (end thinking): raw="${content}"`);
						continue;
					} else if (skipThinkMode) {
						// Skip all content while in thinking mode
						this.log(`Fragment skipped (thinking mode): raw="${content}"`);
						continue;
					}

					// Skip empty structured tokens
					if (content === '<|channel|>final<|message|>' ||
						content === '<|start|>assistant' ||
						content === '<|end|>') {
						this.log(`Fragment skipped (empty token): raw="${content}"`);
						continue;
					}

					// Only accumulate non-empty content
					if (content.length > 0) {
						visibleResponseText += content;
						accumulatedContent += content;
						
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
			await prediction;
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