# LM Studio BYOK Chat Provider

This VS Code extension provides access to local LLM models running in LM Studio, allowing you to use local models with GitHub Copilot Chat and other VS Code AI features.

## Features

- 🖥️ **Local Inference**: Run models completely locally for full privacy
- 🚀 **High Performance**: Direct integration with LM Studio for optimal performance
- 🔄 **Streaming Responses**: Real-time response streaming
- 🛠️ **Tool Calling**: Function calling support (if supported by the model)
- �️ **Vision Support**: Heuristic image-input capability detection for common vision-model identifiers
- �🔌 **Easy Setup**: Minimal configuration required
- 🏷️ **Model Variety**: Support for Llama, Qwen, CodeGemma, Phi, and other popular models
- 🧠 **Performance Tuning**: Advanced optimizations including token budgeting, caveman prompts, and more
- 🧭 **Planner Mode**: Optional ReAct-style planning loop that can inspect the workspace, use built-in tools, and iterate before producing a final answer
- 🎛️ **Global Model Tuning**: Optional per-setting overrides for temperature, top-p, top-k, min-p, repetition penalty, and max response tokens

## Prerequisites

1. **VS Code**: Version 1.103.0 or higher
2. **LM Studio**: Downloaded and installed from [lmstudio.ai](https://lmstudio.ai/)

## Setup for VS Code Users

Refer to the **Documentation** window. You can reach this at any time by pressing **Ctrl-Shift-P**, then choosing **LM Studio: Show Documentation**

## Usage

Once configured, you can use LM Studio models in:

- **GitHub Copilot Chat**: Select "LM Studio" provider in the model picker
- **VS Code Chat**: Access through the chat interface
- **Other Extensions**: Any extension using the VS Code Language Model API

Per-request planner overrides are also available in chat:

- Start a prompt with `/plan` to force planner mode for that one request, even if `lmstudio.planner.enabled` is off.
- Start a prompt with `/noplan` to force direct mode for that one request, even if `lmstudio.planner.enabled` is on.

These prefixes are stripped before the request is sent to the model. The global planner setting still acts as the default when neither prefix is present.

## Configuration Settings

Press Ctrl-, for VS Code preferences and select LM Studio to update these easily.

### Core Settings

- `lmstudio.baseUrl`: Base URL for LM Studio server (default: "<http://localhost:1234>")
- `lmstudio.apiKey`: API key for authentication (optional for local instances)
- `lmstudio.verboseLogging`: Enable verbose diagnostic logging to the 'LM Studio' output channel for troubleshooting (default: false)
- `lmstudio.verboseProgressReporting`: Show detailed LM Studio prompt/generation progress in the status bar, token usage, and output channel (default: false) - Fun to watch 💰🪙 **Tokenmaxxing!** 🪙💰
- `lmstudio.playTokenThresholdSound`: Play a short cash-register style completion sound when a request exceeds the configured token threshold (default: false)
- `lmstudio.tokenSoundThreshold`: Approximate total token count required before the completion sound plays (default: 10000)

### Performance Tuning Settings

- `lmstudio.autoCavemanPrompts`: Prepends a system instruction that asks the model to be concise and preserve essentials. This is a lightweight behavior hint, not a true prompt compaction pass. (default: false)
- `lmstudio.performanceOptimizations`: Master gate for implemented performance features. When false, feature-specific settings such as caveman prompts and token budgeting are ignored. (default: true)
- `lmstudio.tokenBudgeting`: Estimates prompt plus tool token usage before send, shortens older context when needed, and logs a warning when the request approaches the model context window. (default: false)
- `lmstudio.contextOverflowPolicy`: Dropdown that chooses how LM Studio should handle any overflow that remains after provider-side trimming: `stopAtLimit`, `truncateMiddle`, or `rollingWindow`. (default: `truncateMiddle`)
- `lmstudio.blockOversizedRequests`: Blocks requests locally when they still exceed the estimated prompt budget after trimming. Disable this to let LM Studio attempt the request anyway, even if it may fail. (default: true)
- `lmstudio.toggleAllPerformance`: Turns on all currently implemented performance features at once for quick testing. (default: false)

### Planner Settings

- `lmstudio.planner.enabled`: Routes requests through the planner loop instead of sending a single direct chat request. (default: false)
- `lmstudio.planner.maxIterations`: Maximum planner iterations before the loop stops and returns its accumulated result. (default: 10)
- `lmstudio.planner.maxToolResultTokens`: Caps how much tool output the planner feeds back into later rounds. (default: 8000)
- `lmstudio.planner.fyiInstructionPath`: Optional absolute path to extra instructions injected into the planner system prompt. (default: empty)

### Model Tuning Settings

Each model-tuning override is only enforced when its matching `.enabled` setting is checked.

- `lmstudio.modelTuning.temperature.enabled` / `value`: Optional global temperature override in the range 0.0-1.0
- `lmstudio.modelTuning.topP.enabled` / `value`: Optional global top-p override (default value: 0.8)
- `lmstudio.modelTuning.topK.enabled` / `value`: Optional global top-k override (default value: 20)
- `lmstudio.modelTuning.minP.enabled` / `value`: Optional global min-p override (default value: 0.05)
- `lmstudio.modelTuning.repetitionPenalty.enabled` / `value`: Optional global repetition penalty override (default value: 1.2)
- `lmstudio.modelTuning.maxTokensInResponse.enabled` / `value`: Optional global response-token cap (default value: 4096)

When verbose logging or verbose progress reporting is enabled, the extension logs which of these overrides were active for each request.

**Where can I see prompt progress bar and token count?**: Bottom left of editor window, not in the chat window.

## Performance Tuning

This extension provides a small set of implemented performance tuning features to help manage context windows when working with local LLMs. Feature-specific settings are off by default, while `lmstudio.performanceOptimizations` acts as the master gate and defaults to on.

### Key Performance Features

1. **Auto-Caveman Prompts** - Adds a concision instruction to the request so the model is nudged toward shorter, denser output
2. **Token Budgeting** - Estimates request size before send, drops or truncates older history when needed, and notifies the user in chat when context is shortened
3. **Context Overflow Policy** - Lets LM Studio apply `stopAtLimit`, `truncateMiddle`, or `rollingWindow` behavior if a request still exceeds the effective budget after provider-side trimming
4. **Oversized Request Blocking** - Prevents obviously too-large prompts from being sent to LM Studio by default, while allowing advanced users to disable the block and continue anyway
5. **Toggle All Performance** - Enables the currently implemented performance features at once for convenient testing

When enabled alongside verbose logging, these features emit request-time diagnostics in the `LM Studio` output channel so you can confirm they were applied.

## Planner Mode

Planner mode is optional and off by default. When enabled, the provider routes the prepared chat history through a local ReAct-style loop instead of sending a single one-shot request to LM Studio. That loop can inspect the workspace, call built-in extension tools, and then return a final answer after it has gathered more context or attempted edits.

You can override the default planner behavior per request:

1. Start a prompt with `/plan` when you want the planner loop for that message only.
2. Start a prompt with `/noplan` when you want a direct one-shot response for that message only.
3. If neither prefix is present, the extension falls back to `lmstudio.planner.enabled`.

Current behavior and constraints:

1. Planner mode uses the extension's built-in planner tools rather than VS Code chat tool callbacks.
2. The planner can read files, write files, apply workspace edits, search the workspace, and run VS Code commands before answering.
3. Planner tool results are truncated to the configured planner token budget before being fed back into later rounds.
4. Global model-tuning overrides are reused during planner rounds, and provider-side prompt budgeting still runs before planner mode starts.
5. Planner mode emits a lightweight live transcript in chat when workspace tools run, then appends a short summary explaining how many planner rounds were used and whether any workspace tools actually ran.
6. When verbose progress reporting is enabled, the status bar shows `Planner running...` with prompt progress and, during generation, an estimated tokens-per-second indicator instead of raw iteration counts.
7. Planner mode does not create an interactive Copilot-style plan pane, does not expose VS Code chat tools to the model, and does not guarantee that the model will successfully edit files.
8. The planner may decide no change is needed, stop after `lmstudio.planner.maxIterations`, or fail on malformed local-model tool output, so it is best treated as an advanced feature that trades latency for extra reasoning and tool execution.
9. `/plan` and `/noplan` only affect the request they are typed on; they do not change your saved settings.

## Adversarial Review Notes

Current implementation risks worth keeping in mind:

1. Planner mode is intentionally separate from direct LM Studio raw tool-calling, so models will not see VS Code chat tools while planner mode is enabled.
2. The planner now explains its final outcome in the chat response and surfaces tool calls/results live in the transcript, but it still does not provide a dedicated Copilot-style plan pane with editable step tracking.
3. Global tuning overrides are requested consistently, but LM Studio or the loaded backend may still clamp unsupported values.
4. Image-input support is currently inferred from model identifiers, so treat vision capability as heuristic until the provider can verify it more precisely.

## Debug Smoke Test

The command `LM Studio: Run Smoke Test (Debug Only)` is intentionally conservative.

1. It forces direct mode even if planner mode is enabled in settings.
2. It is meant to validate transport, request shaping, filtering, and basic visible output only.
3. It now expects the exact sentinel response `SMOKE_TEST_OK`; gibberish or partial output is treated as a failure.
4. It does not count as planner coverage, and the output channel explicitly logs that planner was not exercised.

The companion command `LM Studio: Run Planner Smoke Test (Debug Only)` exercises the planner path with a restricted read-only tool set.

1. It uses the real planner loop rather than the direct response path.
2. It only exposes `search_workspace` and `read_file` so it cannot write to the workspace.
3. It expects at least one read-only tool call and the exact sentinel response `PLANNER_SMOKE_TEST_OK`.
4. It is intended for debugging planner behavior, not for general use.

Current validation status:

1. The direct smoke test and planner smoke test both passed against a LAN-hosted LM Studio instance.
2. Some local models may still emit one nonconforming planner response before recovering; a single `Could not parse model output, retrying...` log line is acceptable when the planner later reaches a tool call and the final sentinel.
3. Extra planner telemetry is optional, not required for correctness, because the current output already records iterations, tool calls, and sentinel matching.

---

## Troubleshooting

### Models not appearing

- Ensure LM Studio is running and server is started
- Check VS Code Developer Console for errors
- Verify the extension compiled successfully (`npm run compile`)

### Connection errors

- Confirm LM Studio server is running on the configured port
- Check your `lmstudio.baseUrl` setting
- Ensure no firewall is blocking the connection

### No models loaded

- Load at least one model in LM Studio
- Verify the model is loaded in LM Studio's interface
- Try using the "Any Loaded Model" option

### Performance issues

- Ensure your system meets LM Studio's requirements
- Consider using smaller models for better performance
- Check LM Studio's GPU acceleration settings

## API Reference

This extension uses the [LM Studio SDK](https://github.com/lmstudio-ai/lmstudio-js) for communication with LM Studio.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with a local LM Studio instance
5. Submit a pull request

## License

This extension is licensed under the terms described in the [LICENSE.md](./LICENSE.md) file, which was originally developed by Pierce Boggan (@pierceboggan) at Microsoft and subsequently updated to use the latest LM Studio API by Auri Rahimzadeh. The license includes specific provisions regarding AI accountability and indemnification. Pierce and Auri have no relation to each other.

## Contact

If you have any questions, suggestions, or run into issues, please reach out! You can find me:

- [YouTube](https://www.youtube.com/watch?v=gd4Ji_K-CVc&list=PLlLqmBbRNU_tycxTWuCBVAA9zjALXr0Cr)
- [Blog](https://auri.net)
- [LinkedIn](https://www.linkedin.com/in/aurirahimzadeh)
- [GitHub (this project)](https://github.com/AuriR/lmstudio-byok)

---

## Setup for Developers (if you downloaded the code and want to debug this locally)

### 1. Install LM Studio

Download and install LM Studio from [lmstudio.ai](https://lmstudio.ai/)

### 2. Load a Model in LM Studio

1. Open LM Studio
2. Browse and download a model (e.g., Llama 3.2, Qwen 2.5, etc.)
3. Load the model into memory

### 3. Start the LM Studio Server

1. In LM Studio, go to the "Local Server" tab
2. Click "Start Server" (default: <http://localhost:1234>)
3. Note the server URL if you changed the default port

### 4. Configure VS Code Settings

```json
{
  // Optional: Set custom base URL if not using default
  "lmstudio.baseUrl": "http://localhost:1234",
  
  // Optional: Set API key if your LM Studio instance requires authentication
  "lmstudio.apiKey": "your_api_key_here"
}
```

Or set environment variables:

```bash
# Optional: Custom base URL
export LMSTUDIO_BASE_URL="http://localhost:1234"

# Optional: API key
export LMSTUDIO_API_KEY="your_api_key_here"
```

### 5. Install and Activate Extension

1. Build the extension: `npm run compile`
2. Open VS Code
3. Press F5 to launch Extension Development Host
4. The LM Studio models should appear in the VS Code chat model picker

### Environment Variables

- `LMSTUDIO_API_KEY`: API key for LM Studio authentication
- `LMSTUDIO_BASE_URL`: Base URL for LM Studio server

## Supported Models

The extension provides access to any models your server hosts, such as:

- Llama 3.2 (1B, 3B Instruct)
- Llama 3.1 (8B Instruct)
- Qwen 2.5 (7B Instruct)
- CodeGemma (7B Instruct)
- Phi-3.5 (Mini Instruct)
- DeepSeek R1 Distill Llama 8B
- Any loaded model in LM Studio

### Building

```bash
npm install
npm run compile
```

### Debugging

```bash
npm run watch    # Watch for changes
npm run lint     # Run linter
```

### Testing

1. Start LM Studio with a loaded model
2. Press F5 in VS Code to launch Extension Development Host
3. Test chat functionality with the LM Studio provider
4. Optionally enable `lmstudio.planner.enabled` and one `lmstudio.modelTuning.*.enabled` setting to verify planner routing and active tuning logs
