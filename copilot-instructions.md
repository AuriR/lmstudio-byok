# Project Guidelines and Design Principles

These instructions guide the AI agent on coding style, design philosophy, and best practices for the current project.

## 🎨 Design Philosophy (Calm & Minimal)
1.  **Aesthetics:** Always aim for a calm, muted, and aesthetically pleasing design. Use soft color gradients, subtle shadows, and ample whitespace. Avoid harsh, high-contrast colors unless absolutely necessary for critical feedback.
2.  **Responsiveness:** All components must be fully responsive, prioritizing the mobile-first approach. Use modern CSS techniques (Flexbox/Grid) and media queries.
3.  **Interactivity:** User interactions (like button hovers, state changes, or animations) must be accompanied by smooth, engaging visual feedback using CSS transitions and keyframe animations (e.g., 3D transforms for physical actions like coin flips).

## ⚛️ React & JavaScript Best Practices
1.  **Hooks:** Favor the use of React hooks (`useState`, `useCallback`, `useEffect`) for state management and performance optimization.
2.  **Performance:** Use `useCallback` for event handlers passed down to child components to prevent unnecessary re-renders.
3.  **State Management:** Keep state logic clean and encapsulated within the component or a dedicated hook.

## 🛠️ General Coding Practices
1.  **Clarity:** Code must be highly readable, well-commented, and follow standard industry conventions.
2.  **Completeness:** When implementing a feature, ensure all necessary supporting files (CSS, utility functions, etc.) are updated to support the functionality fully.
3.  **Review:** Always perform an adversarial review of the completed code to identify potential edge cases, security vulnerabilities, or performance bottlenecks before concluding a task.

## 📊 Implementation Guidelines for Metrics and Progress Tracking
1.  **Real-time Indicators:** When adding progress indicators (like tokens per second), ensure they only appear when verbose mode is enabled to maintain clean UI.
2.  **Performance Monitoring:** Implement metrics that track performance without impacting the core functionality or introducing significant overhead.
3.  **Statistics Logging:** For end-of-process statistics, calculate and log meaningful data points such as average, min, and max values for performance metrics.
4.  **User Experience:** Progress indicators should provide useful information to users without overwhelming them, and should be consistent with existing UI patterns in the extension.

## 🧪 Testing Considerations
1.  **Edge Cases:** Always consider edge cases like cancellation requests, empty content, or initialization delays when implementing progress tracking.
2.  **Backward Compatibility:** All new features must maintain backward compatibility with existing functionality.
3.  **Configuration-Driven:** Features should respect user configuration settings (like verbose mode) to avoid breaking existing workflows.

## 📚 Knowledge Base and Implementation Details
1.  **Vision Support Detection**: The LM Studio BYOK extension now implements dynamic detection of vision support capabilities for models using pattern matching on model identifiers, since the LM Studio SDK does not directly expose this information. Models with "vision", "llava", "qwen", "gemma", "phi", "cogvlm", "minicpm", "pixtral", "deepseek", or "nous-hermes" in their names are flagged as supporting image input. This resolves the issue where VS Code was incorrectly reporting Gemma 4 as not supporting images despite LM Studio UI showing it does support vision.

## 📁 File Structure and Organization
1.  **Consistent Patterns:** Follow established patterns in the codebase for organizing files and implementing features.
2.  **Modular Design:** Keep features modular and well-separated to facilitate maintenance and future enhancements.
3.  **Documentation:** Include appropriate comments and documentation to help future developers understand implementation details.

## 📚 LM Studio Extension Specific Patterns and Best Practices

### Language Model Provider Implementation
1. **Manifest Requirements**: The `languageModels` contribution in package.json must be updated to `languageModelChatProviders` for VS Code 1.103+
2. **Vendor Matching**: The model family name in the provider must exactly match the vendor name specified in package.json
3. **User Selection**: All models must have `isUserSelectable: true` to appear in the model picker

### Role and Content Handling
1. **Role Preservation**: VS Code role=3 (system) should be preserved as system messages, not converted to user messages
2. **Message Part Serialization**: All message parts (text, data, tools) must be properly serialized to prevent data loss
3. **Structured Prompt Framing**: When using structured prompts with XML tags like `<userRequest>`, ensure proper extraction and prioritization

### Metadata Management
1. **Context Length Refresh**: Model metadata caching can become stale; implement automatic refresh when context length changes
2. **Model Discovery**: Proper model discovery requires correct implementation of the LanguageModelChatProvider interface
3. **API Compatibility**: Always verify API signatures with documentation to avoid runtime errors

### Performance and User Experience
1. **Progress Reporting**: Implement optional verbose progress reporting for long-running requests
2. **Token Threshold Notifications**: Add configurable sound notifications for high-token usage scenarios
3. **Error Handling**: Gracefully handle connection issues, model loading problems, and API inconsistencies
4. **Configuration-Driven Features**: Make all enhanced features configurable via VS Code settings
5. **Performance Optimization Features**: Implement toggleable performance optimizations including token budgeting, auto-caveman prompts, and rolling summaries that can be enabled/disabled through VS Code settings to allow users to test and compare performance impact

### Planner Mode Documentation Expectations
1. **What Planner Mode Does**: User-facing docs should explain that planner mode routes a request through a local planning loop that can inspect the workspace and use the extension's built-in tools before returning a final answer
2. **What Planner Mode Does Not Do**: User-facing docs should explicitly state that planner mode does not create a dedicated Copilot-style plan pane, does not expose VS Code chat tools directly to the model, and does not guarantee a successful file edit
3. **Planner Telemetry**: When documenting planner progress, note that verbose progress reporting can show `Planner running...` with prompt progress and tokens-per-second while the planner is active
4. **Consistency Across Surfaces**: Keep README, Architecture.md, and the extension's Documentation window aligned whenever planner mode behavior or wording changes
5. **Slash Command Scope**: Document `/lmsplan` and `/lmsnoplan` as per-request routing overrides, but document `/lmsmaxtokens <number>` as a session-scoped response-cap override that remains active for later LM Studio requests until changed again, cleared with `/lmsmaxtokensreset`, or discarded by reloading VS Code
6. **Token Cap Messaging**: When documenting `/lmsmaxtokens`, mention that chat reports the previous effective cap and the new active cap when the session override changes, and that a best-effort warning appears if a reply likely stopped because the cap was too low

### Testing Considerations
1. **Local Environment Testing**: Always test with actual LM Studio instances to verify functionality
2. **Model Context Verification**: Verify that context length metadata accurately reflects loaded models
3. **Role Mapping Validation**: Test that system messages are correctly preserved through the conversion process
4. **Feature Toggle Testing**: Ensure optional features (progress reporting, sounds, performance optimizations) work correctly when enabled/disabled

## 📦 Constants Management
1. **Centralize Reused Strings**: Any string, ID, or value that is referenced in multiple places across the codebase must live in `src/constants.ts`. This includes VS Code setting keys, command IDs, status/error model IDs, context overflow policies, tool names, display strings, regex patterns, and default values.
2. **Naming Convention**: Use `SETTING_<KEY>` for VS Code configuration keys (e.g., `SETTING_BASE_URL`), `COMMAND_<NAME>` for command IDs (e.g., `COMMAND_REFRESH_MODELS`), `STATUS_<DESC>` for status/error IDs (e.g., `STATUS_CONNECTION_ERROR`), `POLICY_<NAME>` for policy strings (e.g., `POLICY_TRUNCATE_MIDDLE`), `TOOL_<NAME>` for tool names (e.g., `TOOL_READ_FILE`), `*_PATTERN` for regex patterns, and `DEFAULT_<DESC>` for default values.
3. **Grouping**: Organize constants in `src/constants.ts` into clearly labeled sections (Settings, Commands, Status, Policies, Tools, Display, Patterns, Defaults, etc.) with blank-line separators.
4. **What NOT to centralize**: VS Code contribution points in `package.json` must remain as literal strings (they are part of the extension manifest contract). Documentation strings in `README.md` and user-facing docs should remain as literals. Default configuration objects embedded in code (e.g., `vscode.workspace.getConfiguration()` default values) may stay inline if they are tightly coupled to a single function.
5. **Import, Don't Duplicate**: When a file needs a constant, import it from `src/constants.ts` rather than redefining it locally. Never copy-paste a constant value into a new file.
6. **Type Safety**: For string literal types used as discriminated unions (e.g., `ContextOverflowPolicy`), reference the constants in the type definition using `typeof` to keep the type in sync with the values.