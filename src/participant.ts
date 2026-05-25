import * as vscode from 'vscode';

type ClarificationMetadata = {
	kind: 'clarification-request';
	originalPrompt: string;
	question: string;
	rewrittenPrompt?: string;
	missing?: string[];
	modelId: string;
};

type CompletionMetadata = {
	kind: 'completion';
	usedClarification: boolean;
	modelId: string;
	rewrittenPrompt?: string;
	clarificationQuestion?: string;
	clarificationAnswer?: string;
	missing?: string[];
};

type ParticipantResultMetadata = ClarificationMetadata | CompletionMetadata;

type ClarificationDecision = {
	needsClarification: boolean;
	question?: string;
	rewrittenPrompt?: string;
	missing?: string[];
};

const PARTICIPANT_ID = 'lmstudio-byok-chat-provider-auri.lmstudio';
const LMSTUDIO_VENDOR = 'lmstudio';
const CLARIFICATION_INSTRUCTIONS = [
	'You decide whether a user request is too ambiguous to execute responsibly.',
	'Return valid JSON only, with no markdown or extra commentary.',
	'Use this schema: {"needsClarification": boolean, "question"?: string, "rewrittenPrompt"?: string, "missing"?: string[]}.',
	'Set needsClarification to true only when a single short follow-up question is necessary before doing useful work.',
	'Ask at most one clarifying question.',
	'If the request is actionable, set needsClarification to false and provide a concise rewrittenPrompt that preserves the user intent.',
	'Examples of missing details that justify clarification: unclear target file, conflicting constraints, missing desired output format when it changes the work, or missing scope when multiple materially different actions are possible.',
	'If ordinary engineering assumptions would let you continue safely, do not ask a question.',
].join(' ');

function readMarkdownText(part: vscode.ChatResponseMarkdownPart): string {
	return part.value.value;
}

function getPendingClarification(context: vscode.ChatContext): ClarificationMetadata | undefined {
	for (let index = context.history.length - 1; index >= 0; index -= 1) {
		const turn = context.history[index];
		if (!(turn instanceof vscode.ChatResponseTurn)) {
			continue;
		}

		const metadata = turn.result.metadata as ParticipantResultMetadata | undefined;
		if (metadata?.kind === 'clarification-request') {
			return metadata;
		}

		if (metadata?.kind === 'completion') {
			return undefined;
		}
	}

	return undefined;
}

function getConversationHistory(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];

	for (const turn of context.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
			continue;
		}

		if (turn instanceof vscode.ChatResponseTurn) {
			const text = turn.response
				.filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
				.map(readMarkdownText)
				.join('\n\n')
				.trim();

			if (text) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(text));
			}
		}
	}

	return messages;
}

function extractJsonObject(text: string): string | undefined {
	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		return undefined;
	}

	return text.slice(firstBrace, lastBrace + 1);
}

function parseClarificationDecision(text: string): ClarificationDecision | undefined {
	const jsonCandidate = extractJsonObject(text.trim()) ?? text.trim();
	try {
		const parsed = JSON.parse(jsonCandidate) as Partial<ClarificationDecision>;
		if (typeof parsed.needsClarification !== 'boolean') {
			return undefined;
		}

		const missing = Array.isArray(parsed.missing)
			? parsed.missing.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 4)
			: undefined;

		return {
			needsClarification: parsed.needsClarification,
			question: typeof parsed.question === 'string' ? parsed.question.trim() : undefined,
			rewrittenPrompt: typeof parsed.rewrittenPrompt === 'string' ? parsed.rewrittenPrompt.trim() : undefined,
			missing,
		};
	} catch {
		return undefined;
	}
}

function fallbackClarificationDecision(prompt: string): ClarificationDecision {
	const normalized = prompt.trim().toLowerCase();
	const terseAction = /^(fix|update|change|add|make|create|improve|refactor|clean up)\b/.test(normalized);
	const hasTargetSignal = /(file|function|class|component|setting|test|readme|docs|provider|planner|extension|package\.json|src\/|src\\)/.test(normalized);
	const veryShort = normalized.split(/\s+/).filter(Boolean).length <= 4;

	if ((terseAction && !hasTargetSignal) || veryShort) {
		return {
			needsClarification: true,
			question: 'What should I operate on specifically, and what outcome do you want?',
			missing: ['target', 'desired outcome'],
		};
	}

	return {
		needsClarification: false,
		rewrittenPrompt: prompt.trim(),
	};
}

async function resolveLmStudioModel(request: vscode.ChatRequest, token: vscode.CancellationToken): Promise<vscode.LanguageModelChat | undefined> {
	if (request.model.vendor === LMSTUDIO_VENDOR) {
		return request.model;
	}

	const models = await vscode.lm.selectChatModels({ vendor: LMSTUDIO_VENDOR, id: request.model.id });
	if (models.length > 0) {
		return models[0];
	}

	const fallbackModels = await vscode.lm.selectChatModels({ vendor: LMSTUDIO_VENDOR });
	if (fallbackModels.length > 0) {
		return fallbackModels[0];
	}

	return undefined;
}

async function readResponseText(response: vscode.LanguageModelChatResponse): Promise<string> {
	let accumulated = '';
	for await (const chunk of response.text) {
		accumulated += chunk;
	}

	return accumulated;
}

async function decideClarification(
	model: vscode.LanguageModelChat,
	prompt: string,
	token: vscode.CancellationToken,
): Promise<ClarificationDecision> {
	try {
		const response = await model.sendRequest([
			vscode.LanguageModelChatMessage.User(`${CLARIFICATION_INSTRUCTIONS}\n\nUser request:\n${prompt}`),
		], {
			justification: 'Check whether the LM Studio participant should ask a clarifying question before proceeding.',
		}, token);

		const decision = parseClarificationDecision(await readResponseText(response));
		if (decision) {
			if (!decision.needsClarification) {
				return {
					needsClarification: false,
					rewrittenPrompt: decision.rewrittenPrompt || prompt.trim(),
				};
			}

			if (decision.question) {
				return decision;
			}
		}
	} catch {
		// Fall through to heuristics when the classifier request fails or returns malformed output.
	}

	return fallbackClarificationDecision(prompt);
}

async function streamModelReply(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<void> {
	const response = await model.sendRequest(messages, {
		justification: 'Answer an LM Studio participant request after clarification has been resolved.',
	}, token);

	for await (const part of response.stream) {
		if (part instanceof vscode.LanguageModelTextPart) {
			stream.markdown(part.value);
		}
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('text/')) {
			stream.markdown(new TextDecoder().decode(part.data));
		}
	}
}

function toChatErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return `LM Studio request failed: ${error.message}`;
	}

	return 'LM Studio request failed for the @lmstudio participant.';
}

export function registerLmStudioParticipant(context: vscode.ExtensionContext): vscode.ChatParticipant {
	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
		try {
			const model = await resolveLmStudioModel(request, token);
			if (!model) {
				stream.markdown('LM Studio is not available in the chat model list. Load this extension and make sure at least one LM Studio model is visible in the picker.');
				return {
					metadata: {
						kind: 'completion',
						usedClarification: false,
						modelId: 'unavailable',
					} satisfies CompletionMetadata,
				};
			}

			const pendingClarification = getPendingClarification(chatContext);
			if (pendingClarification) {
				const resumedPrompt = [
					pendingClarification.rewrittenPrompt || pendingClarification.originalPrompt,
					`Clarification answer: ${request.prompt.trim()}`,
				].join('\n\n');

				stream.progress('Continuing with your clarification...');
				await streamModelReply(
					model,
					[
						...getConversationHistory(chatContext),
						vscode.LanguageModelChatMessage.User(resumedPrompt),
					],
					stream,
					token,
				);

				return {
					metadata: {
						kind: 'completion',
						usedClarification: true,
						modelId: model.id,
						rewrittenPrompt: pendingClarification.rewrittenPrompt,
						clarificationQuestion: pendingClarification.question,
						clarificationAnswer: request.prompt.trim(),
						missing: pendingClarification.missing,
					} satisfies CompletionMetadata,
				};
			}

			stream.progress('Checking whether more detail is needed...');
			const decision = await decideClarification(model, request.prompt, token);
			if (decision.needsClarification) {
				const question = decision.question || 'What additional detail should I use before I continue?';
				const missingLine = decision.missing && decision.missing.length > 0
					? `\n\nMissing detail: ${decision.missing.join(', ')}.`
					: '';

				stream.markdown(`I need one detail before I continue:\n\n${question}${missingLine}`);
				return {
					metadata: {
						kind: 'clarification-request',
						originalPrompt: request.prompt,
						question,
						rewrittenPrompt: decision.rewrittenPrompt,
						missing: decision.missing,
						modelId: model.id,
					} satisfies ClarificationMetadata,
				};
			}

			stream.progress('Sending request to LM Studio...');
			await streamModelReply(
				model,
				[
					...getConversationHistory(chatContext),
					vscode.LanguageModelChatMessage.User(decision.rewrittenPrompt || request.prompt.trim()),
				],
				stream,
				token,
			);

			return {
				metadata: {
					kind: 'completion',
					usedClarification: false,
					modelId: model.id,
					rewrittenPrompt: decision.rewrittenPrompt,
				} satisfies CompletionMetadata,
			};
		} catch (error) {
			return {
				errorDetails: {
					message: toChatErrorMessage(error),
				},
				metadata: {
					kind: 'completion',
					usedClarification: false,
					modelId: 'error',
				} satisfies CompletionMetadata,
			};
		}
	});

	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon_marketplace.png');
	participant.followupProvider = {
		provideFollowups(result) {
			const metadata = result.metadata as ParticipantResultMetadata | undefined;
			if (metadata?.kind === 'completion' && metadata.usedClarification) {
				return [{
					prompt: 'Refine that answer with one more constraint.',
					label: 'Refine with another constraint',
				} satisfies vscode.ChatFollowup];
			}

			return [];
		},
	};

	return participant;
}