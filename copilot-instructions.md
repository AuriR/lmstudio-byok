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

### Testing Considerations
1. **Local Environment Testing**: Always test with actual LM Studio instances to verify functionality
2. **Model Context Verification**: Verify that context length metadata accurately reflects loaded models
3. **Role Mapping Validation**: Test that system messages are correctly preserved through the conversion process
4. **Feature Toggle Testing**: Ensure optional features (progress reporting, sounds, performance optimizations) work correctly when enabled/disabled