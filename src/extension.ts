import * as vscode from 'vscode';
import { LMStudioChatModelProvider } from './provider';
import { registerLmStudioParticipant } from './participant';
import {
	COMMAND_MESSAGE_TIMEOUT_MS,
	COMMAND_REFRESH_MODELS,
	COMMAND_RUN_PLANNER_SMOKE_TEST,
	COMMAND_RUN_SMOKE_TEST,
	COMMAND_SHOW_DOCUMENTATION,
	COMMAND_SHOW_WELCOME,
	COMMAND_TEST_CONNECTION,
	STATUS_CONNECTION_ERROR,
	STATUS_NO_MODELS_LOADED,
} from './constants';

function showTransientCommandMessage(message: string, kind: 'info' | 'error' = 'info'): void {
    const icon = kind === 'error' ? '$(error)' : '$(check)';
    vscode.window.setStatusBarMessage(`${icon} ${message}`, COMMAND_MESSAGE_TIMEOUT_MS);
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new LMStudioChatModelProvider(context.extensionPath);
    const participant = registerLmStudioParticipant(context);

	// Register the chat model provider
	const disposable = vscode.lm.registerLanguageModelChatProvider('lmstudio', provider);
	context.subscriptions.push(disposable);
    context.subscriptions.push(participant);

	// Command to refresh models
	const refreshCommand = vscode.commands.registerCommand(COMMAND_REFRESH_MODELS, () => {
		provider.refreshModels();
        showTransientCommandMessage('LM Studio models refreshed');
	});
	context.subscriptions.push(refreshCommand);

	// Command to test connection
	const testConnectionCommand = vscode.commands.registerCommand(COMMAND_TEST_CONNECTION, async () => {
		try {
			// Test the connection
			const models = await provider.prepareLanguageModelChat({ silent: false }, new vscode.CancellationTokenSource().token);

			if (models.some(m => m.id === STATUS_CONNECTION_ERROR || m.id === STATUS_NO_MODELS_LOADED)) {
                showTransientCommandMessage(`LM Studio connection failed. Found: ${models.map(m => m.name).join(', ')}`, 'error');
			} else {
                showTransientCommandMessage(`LM Studio connected successfully! Found ${models.length} models.`);
			}
		} catch (error) {
            showTransientCommandMessage(`LM Studio connection test failed: ${error}`, 'error');
		}
	});
	context.subscriptions.push(testConnectionCommand);

    const smokeTestCommand = vscode.commands.registerCommand(COMMAND_RUN_SMOKE_TEST, async () => {
        const result = await provider.runDebugSmokeTest();

        if (result.success) {
            showTransientCommandMessage(`LM Studio smoke test passed for ${result.modelId}.`);
            return;
        }

        showTransientCommandMessage(`LM Studio smoke test failed: ${result.error ?? 'Unknown error'}`, 'error');
    });
    context.subscriptions.push(smokeTestCommand);

    const plannerSmokeTestCommand = vscode.commands.registerCommand(COMMAND_RUN_PLANNER_SMOKE_TEST, async () => {
        const result = await provider.runDebugPlannerSmokeTest();

        if (result.success) {
            showTransientCommandMessage(`LM Studio planner smoke test passed for ${result.modelId}.`);
            return;
        }

        showTransientCommandMessage(`LM Studio planner smoke test failed: ${result.error ?? 'Unknown error'}`, 'error');
    });
    context.subscriptions.push(plannerSmokeTestCommand);

    // Command to show documentation page
    const showDocumentationCommand = vscode.commands.registerCommand(COMMAND_SHOW_DOCUMENTATION, () => {
        showDocumentationPage();
    });
    context.subscriptions.push(showDocumentationCommand);

    // Backward-compatible alias for older command references
    const showWelcomeAliasCommand = vscode.commands.registerCommand(COMMAND_SHOW_WELCOME, () => {
        showDocumentationPage();
    });
    context.subscriptions.push(showWelcomeAliasCommand);

    // Show documentation page on first activation (with a small delay to ensure UI is ready)
	setTimeout(() => {
        const hasShownDocumentation = context.globalState.get('lmstudio.documentationShown', context.globalState.get('lmstudio.welcomeShown', false));
        if (!hasShownDocumentation) {
            showDocumentationPage();
            context.globalState.update('lmstudio.documentationShown', true);
            context.globalState.update('lmstudio.welcomeShown', true);
		}
	}, 1000);
}

function showDocumentationPage() {
	const panel = vscode.window.createWebviewPanel(
        'lmstudioDocumentation',
        'LM Studio Documentation',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);

    panel.webview.html = getDocumentationContent();
}

function getDocumentationContent(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LM Studio Documentation</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.6;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        h1, h2 {
            color: var(--vscode-textPreformat-foreground);
            margin-top: 30px;
        }
        h1 {
            border-bottom: 2px solid var(--vscode-textSeparator-foreground);
            padding-bottom: 10px;
        }
        .step {
            background: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textLink-foreground);
            padding: 15px;
            margin: 15px 0;
            border-radius: 4px;
        }
        .step-number {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            font-size: 1.2em;
        }
        .command {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px 12px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            margin: 5px 0;
            display: inline-block;
        }
        .warning {
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
        }
        .success {
            background: var(--vscode-inputValidation-infoBackground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
        }
        .settings-code {
            background: var(--vscode-textCodeBlock-background);
            padding: 15px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
            margin: 10px 0;
            white-space: pre-wrap;
        }
        ul {
            margin: 10px 0;
            padding-left: 20px;
        }
        li {
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📘 LM Studio BYOK Documentation</h1>

        <div class="success">
            <strong>Extension Activated!</strong> Use this documentation to configure, troubleshoot, and tune LM Studio BYOK in VS Code.
        </div>

        <h2>📋 Quick Setup Steps</h2>

        <div class="step">
            <div class="step-number">Step 1: Download LM Studio</div>
            <p>If you haven't already, download LM Studio from <strong>lmstudio.ai</strong></p>
            <ul>
                <li>Free download for Windows, Mac, and Linux</li>
                <li>No account required</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Step 2: Download a Model</div>
            <p>In LM Studio, go to the <strong>Discover</strong> tab and download a model:</p>
            <ul>
                <li><strong>Recommended for beginners:</strong> Qwen3-Coder-Next</li>
                <li><strong>For better performance:</strong> Meta-Llama-3.1-8B-Instruct</li>
                <li><strong>Lightweight option:</strong> Ministral-8B-Instruct</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Step 3: Start the Server</div>
            <p>In LM Studio:</p>
            <ul>
                <li>Click the <strong>"Local Server"</strong> tab</li>
                <li>Click <strong>"Start Server"</strong></li>
                <li>Load a model by clicking <strong>"Select a model"</strong></li>
                <li>Wait for the model to finish loading (green indicator)</li>
            </ul>
            <p>LM Studio can also run over the network. Refer to LM Studio documentation for advanced network configuration if needed. It's pretty straightforward and generally does not affect performance.</p>
            <p>If you can't reach the server, ensure your firewall allows connections to the LM Studio server port (default 1234) and that you're using the correct base URL in the extension settings.</p>
            <p>If you have questions, check online or ping me on LinkedIn.</p>
        </div>

                <div class="step">
            <div class="step-number">Step 4: Confirm Settings in VS Code</div>
            <p>Open preferences in VS Code via Ctrl+, and search for LM Studio:</p>
            <div>Make sure Base URL is set. Use <i><b>ws://</b></i> instead of <i><b>http://</b></i></div>
            <div>Optionally enable verbose logging and progress reporting, if you want to see token usage and prompt percentage</div>
        </div>

        <div class="step">
            <div class="step-number">Step 5: Test Your Connection</div>
            <p>Use VS Code commands to verify everything works:</p>
            <div class="command">Ctrl+Shift+P → "LM Studio: Test Connection"</div>
            <div class="command">Ctrl+Shift+P → "LM Studio: Refresh Available Models"</div>
            <p>You should see a success message with the number of models found. If you get an error, check your LM Studio server status and settings.</p>
        </div>

                <div class="step">
            <div class="step-number">Step 6: Select a Model</div>
            <p>Make sure to select a model in the Copilot window. The BYOK servers will have <b>BYOK:</b> prepended to them so it's clear which are local.</p>
        </div>

        <div class="step">
            <div class="step-number">Step 7: Start Chatting!</div>
            <p>Open GitHub Copilot Chat and select your LM Studio model from the model picker. Look for models with the "LM Studio" family name.</p>
            <p>If you want to force planner mode for one request, start the prompt with <strong>/lmsplan</strong>. If you want to bypass planner mode for one request, start the prompt with <strong>/lmsnoplan</strong>. If you want to change the response cap for the rest of the current VS Code session, start with <strong>/lmsmaxtokens 8192</strong> or another positive integer, and use <strong>/lmsmaxtokensreset</strong> to clear it.</p>
        </div>

        <div class="step">
            <div class="step-number">Step 8: Use Clarification When Needed</div>
            <p>If you want LM Studio to stop and ask for one missing detail before it proceeds, invoke the chat participant with <strong>@lmstudio</strong>.</p>
            <ul>
                <li>Use <strong>@lmstudio</strong> for the clarification-aware flow</li>
                <li>Use <strong>@lmstudio /clarify</strong> if you want to be explicit about that path</li>
                <li>If the request is actionable, the participant forwards it immediately</li>
                <li>If the request is too ambiguous, the participant asks one short question and resumes after your next reply</li>
            </ul>
        </div>

        <h2>⚙️ Configuration (Optional)</h2>

        <p>You can customize settings in VS Code Settings (Ctrl+,) by searching for "LM Studio":</p>

        <div class="settings-code">{
  "lmstudio.baseUrl": "ws://localhost:1234",
  "lmstudio.apiKey": "your-api-key-here",
    "lmstudio.systemPrompt": "Think step-by-step. Break down the problem into detailed reasoning steps before answering.",
  "lmstudio.verboseLogging": false,
  "lmstudio.verboseProgressReporting": false,
  "lmstudio.playTokenThresholdSound": false,
    "lmstudio.tokenSoundThreshold": 10000,
    "lmstudio.tokenBudgeting": true,
    "lmstudio.contextOverflowPolicy": "truncateMiddle",
    "lmstudio.blockOversizedRequests": true,
    "lmstudio.planner.enabled": false,
    "lmstudio.modelTuning.temperature.enabled": false,
    "lmstudio.modelTuning.temperature.value": 0.7,
    "lmstudio.modelTuning.topP.enabled": false,
    "lmstudio.modelTuning.topP.value": 0.8,
    "lmstudio.modelTuning.topK.enabled": false,
    "lmstudio.modelTuning.topK.value": 20,
    "lmstudio.modelTuning.minP.enabled": false,
    "lmstudio.modelTuning.minP.value": 0.05,
    "lmstudio.modelTuning.repetitionPenalty.enabled": false,
    "lmstudio.modelTuning.repetitionPenalty.value": 1.2,
    "lmstudio.modelTuning.maxTokensInResponse.enabled": false,
    "lmstudio.modelTuning.maxTokensInResponse.value": 4096
}</div>

        <div class="warning">
            <strong>Note:</strong> API key is optional for local instances. Only needed if you're connecting to a remote LM Studio server that requires authentication. By default, LM Studio does not require an API key.
        </div>

        <div class="step">
            <div class="step-number">Custom System Prompt</div>
            <p>You can set <code>lmstudio.systemPrompt</code> to prepend your own system instruction to LM Studio requests.</p>
            <ul>
                <li>Default: <code>Think step-by-step. Break down the problem into detailed reasoning steps before answering.</code></li>
                <li>Clear the setting to an empty string if you do not want to send a custom system prompt</li>
                <li>Copilot instructions and other VS Code instruction layers are forwarded separately as system-role messages when VS Code includes them</li>
            </ul>
        </div>

        <h2>⌨️ Keyboard Shortcuts</h2>
        <p>
            <strong>Commands available:</strong><br>
            • <span class="command">LM Studio: Test Connection</span> - Verify server connectivity<br>
            • <span class="command">LM Studio: Refresh Available Models</span> - Update model list<br>
            • <span class="command">LM Studio: Show Documentation</span> - Show this guide again<br>
            • <span class="command">LM Studio: Run Smoke Test (Debug Only)</span> - Validate the direct request path without exercising planner mode<br>
            • <span class="command">LM Studio: Run Planner Smoke Test (Debug Only)</span> - Validate the planner loop with read-only tools only
        </p>

        <div class="step">
            <div class="step-number">Planner Shortcuts</div>
            <p>You can override the default planner setting per request and set a session-level LM Studio response cap:</p>
            <ul>
                <li><strong>/lmsplan</strong> forces planner mode for that one prompt</li>
                <li><strong>/lmsnoplan</strong> forces direct mode for that one prompt</li>
                <li><strong>/lmsmaxtokens 8192</strong> changes the response-token cap for later LM Studio requests in the current VS Code session</li>
                <li><strong>/lmsmaxtokensreset</strong> clears that session override and restores the configured/default cap</li>
                <li>If neither prefix is present, the extension uses the saved <code>lmstudio.planner.enabled</code> setting</li>
            </ul>
            <p>These prefixes are stripped before the request is sent to the model, so they act as local routing hints rather than part of the prompt content.</p>
        </div>

        <div class="step">
            <div class="step-number">Response Token Cap</div>
            <p>If a reply likely stops because the response-token cap is too low, the chat transcript now says <code>Not enough tokens to follow through on the response.</code></p>
            <ul>
                <li>Use <strong>/lmsmaxtokens 8192</strong> to raise the cap for later LM Studio requests in the current VS Code session</li>
                <li>Use a smaller number if you want a tighter cap for the current VS Code session</li>
                <li>When the session override changes, chat reports the previous effective cap and the new active cap so you can see what to change back to later</li>
                <li>Use <strong>/lmsmaxtokensreset</strong> to clear the session override and restore the configured/default cap</li>
                <li>Change <code>lmstudio.modelTuning.maxTokensInResponse</code> in settings if you want a persistent default</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Clarification Flow</div>
            <p>The <strong>@lmstudio</strong> participant is the extension's clarification-aware chat path.</p>
            <ul>
                <li>It is separate from the plain LM Studio model-provider request path</li>
                <li>It asks at most one targeted clarifying question before continuing</li>
                <li>It resumes by combining your follow-up answer with the original prompt on the next <strong>@lmstudio</strong> turn</li>
                <li>If the selected chat model is not from LM Studio, it tries to switch to an LM Studio model automatically</li>
            </ul>
        </div>

        <h2>🫤 Troubleshooting</h2>

        <div class="step">
            <div class="step-number">Enable Diagnostic Logging</div>
            <p>For detailed troubleshooting, enable verbose logging:</p>
            <ul>
                <li>Go to VS Code Settings</li>
                <li>Search for "lmstudio.verboseLogging"</li>
                <li>Enable it</li>
                <li>Check the "LM Studio" output channel for detailed logs</li>
            </ul>
        </div>

        <div class="step">
            <div class="step-number">Common Issues</div>
            <ul>
                <li><strong>Connection refused:</strong> Make sure LM Studio server is running</li>
                <li><strong>No models available:</strong> Load a model in LM Studio's Local Server tab</li>
                <li><strong>Weird response formatting:</strong> The extension now filters out model artifacts automatically</li>
                <li><strong>Planner parse warning on the first round:</strong> Some local models need one retry before they emit valid structured output. If the planner later executes a tool and reaches the sentinel, that warning is recoverable.</li>
                <li><strong>Need planner mode only sometimes?:</strong> Use <code>/lmsplan</code> or <code>/lmsnoplan</code> at the start of the prompt instead of changing the global planner setting back and forth.</li>
                <li><strong>Need a bigger or smaller reply cap for this VS Code session?:</strong> Use <code>/lmsmaxtokens 8192</code> with the value you want, then <code>/lmsmaxtokensreset</code> when you want to clear it.</li>
                <li><strong>Response stopped early with a token warning?:</strong> If chat says <code>Not enough tokens to follow through on the response.</code>, raise the cap with <code>/lmsmaxtokens</code>, reset it later with <code>/lmsmaxtokensreset</code>, or change the matching LM Studio setting.</li>
                <li><strong>Clarification did not resume?:</strong> Make sure your follow-up reply is still addressed to <code>@lmstudio</code>. The stored checkpoint belongs to that participant thread.</li>
                <li><strong>Slow responses:</strong> Try a smaller model or check your system resources</li>
                <li><strong>Ideal Context Size:</strong> I've found context size of 128K tokens for my use cases, but YMMV</li>
                <li><strong>LM Studio Context Size Errors:</strong> Increase context size in LM Studio for the selected model</li>
                <li><strong>LM Studio Slow:</strong> Decrease context size in LM Studio for the selected model. There are many tuning tips available online - it all depends on your config and model.</li>
            </ul>
            <p><b>IMPORTANT:</b> Your prompt isn't the "entire" prompt. System prompt, copilot instructions, and so forth are also sent. These increase the token count "behind the scenes." You can view LM Studio debug logs from VS Code's Output dropdown.</p>
        </div>

        <h2>🚀 New Features</h2>
        
        <div class="step">
            <div class="step-number">Progress Reporting</div>
            <p>Enable detailed progress reporting in the status bar and output channel by setting <code>"lmstudio.verboseProgressReporting": true</code> to see real-time feedback about prompt/generation progress. Tokenmaxxing locally FTW!</p>
        </div>

        <div class="step">
            <div class="step-number">Verbose Logging</div>
            <p>Enable detailed diagnostic logging by setting <code>"lmstudio.verboseLogging": true</code> to help troubleshoot connection issues or understand what's happening during model inference.</p>
        </div>

        <div class="step">
            <div class="step-number">Cha-Ching Sound</div>
            <p>Enable a cash-register style sound notification when responses exceed the token threshold by setting <code>"lmstudio.playTokenThresholdSound": true</code>. This feature plays a sound when a response exceeds the configured token count (default 10,000 tokens).</p>
        </div>

        <h2>🎯 Need Additional Help?</h2>
        <p>If you have any questions, suggestions, or run into issues, please reach out! You can find me on <a href="https://www.linkedin.com/in/aurirahimzadeh" target="_blank">LinkedIn</a> or open an issue on the <a href="https://github.com/AuriR/lmstudio-byok" target="_blank">GitHub repo</a>. You can also follow my <a href="https://auri.net" target="_blank">blog</a> and <a href="https://www.youtube.com/watch?v=gd4Ji_K-CVc&list=PLlLqmBbRNU_tycxTWuCBVAA9zjALXr0Cr" target="_blank">YouTube</a> adventures.</p>
        
        <h2>⚙️ Performance Tuning Features</h2>
        
        <div class="step">
            <div class="step-number">Performance Optimizations</div>
            <p>This extension provides several advanced performance tuning features that can help manage context windows and optimize performance when working with local LLMs:</p>
            <ul>
                <li><strong>Auto-Caveman Prompts:</strong> Prepends a concision instruction so the model aims for shorter, denser responses</li>
                <li><strong>Token Budgeting:</strong> Estimates request size before send, shortens older history when needed, and posts a chat notice when context is shortened</li>
                <li><strong>Context Overflow Policy:</strong> Lets you choose LM Studio's fallback behavior with a dropdown: Stop At Limit, Truncate Middle, or Rolling Window</li>
                <li><strong>Oversized Request Blocking:</strong> Blocks still-oversized requests locally by default, while allowing advanced users to continue anyway if they disable the safeguard</li>
                <li><strong>Toggle All Performance:</strong> Enables the currently implemented performance features at once for convenient testing</li>
            </ul>
            <p>The individual feature settings are off by default. Enable verbose logging as well if you want to confirm when these request-time paths are active.</p>
            <p>When context must be shortened, the chat window will show a notice. If the request is still too large, the extension can block it locally and report the current context size returned by LM Studio.</p>
            <p>Enable these features in VS Code Settings (Ctrl+,) by searching for "LM Studio" and setting the appropriate options to true.</p>
        </div>

        <div class="step">
            <div class="step-number">Model Tuning</div>
            <p>A dedicated <strong>Model Tuning</strong> subsection is available in VS Code Settings for global sampling overrides. Each value only applies when its matching enable checkbox is turned on.</p>
            <ul>
                <li><strong>Temperature:</strong> opt-in override from 0.0 to 1.0</li>
                <li><strong>Top-P / Top-K / Min-P:</strong> opt-in sampling overrides applied to every request</li>
                <li><strong>Repetition Penalty:</strong> opt-in repeat penalty override</li>
                <li><strong>Max Tokens in Response:</strong> opt-in global cap for generated output length</li>
            </ul>
            <p>If you enable the planner, these same tuning overrides are reused for planner rounds as well.</p>
            <p>Enable verbose logging or verbose progress reporting if you want the extension to explicitly log which tuning overrides were active for a given request.</p>
        </div>

        <div class="step">
            <div class="step-number">Planner Mode</div>
            <p>Planner mode is an advanced feature that routes requests through a ReAct-style loop before returning a final answer.</p>
            <ul>
                <li><strong>Enable:</strong> <code>lmstudio.planner.enabled</code></li>
                <li><strong>Iterations:</strong> cap the loop with <code>lmstudio.planner.maxIterations</code></li>
                <li><strong>Tool Result Budget:</strong> control how much tool output is carried forward with <code>lmstudio.planner.maxToolResultTokens</code></li>
                <li><strong>Extra Instructions:</strong> optionally inject a file with <code>lmstudio.planner.fyiInstructionPath</code></li>
            </ul>
            <p><strong>What it does:</strong> planner mode lets the extension inspect the workspace before answering. It can read files, search the workspace, write files, apply edits, and run selected VS Code commands as part of a local planning loop.</p>
            <p>When planner mode runs, the chat transcript shows planner tool activity live when tools are used, followed by a short planner summary that explains how many rounds were used and whether any workspace tools actually ran.</p>
            <p>When verbose progress reporting is enabled, the status bar shows <code>Planner running...</code> with prompt progress and, during generation, an estimated tokens-per-second indicator instead of raw iteration counts.</p>
            <p><strong>What it does not do:</strong> it does not open a dedicated Copilot-style plan pane, it does not expose VS Code chat tools directly to the model, and it does not guarantee that the model will successfully edit files. The planner may still decide no change is needed or stop after reaching the configured iteration cap.</p>
            <p>The debug-only smoke test command does <strong>not</strong> exercise planner mode. It forces a safe direct request and expects the exact sentinel response <code>SMOKE_TEST_OK</code>.</p>
            <p>The separate planner smoke test command exercises planner mode with a read-only tool allow-list and expects the exact sentinel response <code>PLANNER_SMOKE_TEST_OK</code>.</p>
            <p>Both debug commands have now been validated against a live LM Studio host. The current output already logs planner iterations, tool calls, and sentinel matching, so extra planner telemetry is optional rather than required.</p>
        </div>

        <div class="step">
            <div class="step-number">Clarification Participant</div>
            <p>The new <strong>@lmstudio</strong> participant approximates Copilot's ask-questions flow for local models.</p>
            <ul>
                <li>It runs a small ambiguity check before forwarding the request to LM Studio</li>
                <li>If the model classifier returns malformed output, the extension falls back to conservative heuristics</li>
                <li>It asks one question, stores the checkpoint in participant metadata, and resumes on your next answer</li>
                <li>It does not change how the plain LM Studio model-provider path behaves in the picker</li>
            </ul>
        </div>

        <div class="success">
            <strong>Happy coding with local LLMs! 🎉</strong><br>
            Your privacy is protected - everything runs locally on your machine.
        </div>
    </div>
</body>
</html>`;
}

export function deactivate() { }