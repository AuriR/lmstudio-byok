/**
 * Centralized constants for the LM Studio BYOK extension.
 * All hard-coded strings, IDs, and shared values live here to avoid duplication
 * and make future refactoring trivial.
 */


// Extension details.
export const PARTICIPANT_ID = 'lmstudio-byok-chat-provider-auri.lmstudio';
export const LMSTUDIO_VENDOR = 'lmstudio';
export const CLARIFICATION_INSTRUCTIONS = [
	'You decide whether a user request is too ambiguous to execute responsibly.',
	'Return valid JSON only, with no markdown or extra commentary.',
	'Use this schema: {"needsClarification": boolean, "question"?: string, "rewrittenPrompt"?: string, "missing"?: string[]}.',
	'Set needsClarification to true only when a single short follow-up question is necessary before doing useful work.',
	'Ask at most one clarifying question.',
	'If the request is actionable, set needsClarification to false and provide a concise rewrittenPrompt that preserves the user intent.',
	'Examples of missing details that justify clarification: unclear target file, conflicting constraints, missing desired output format when it changes the work, or missing scope when multiple materially different actions are possible.',
	'If ordinary engineering assumptions would let you continue safely, do not ask a question.',
].join(' ');

// ─── VS Code Settings Keys ───────────────────────────────────────────────────────
// Keys used with workspace.getConfiguration('lmstudio').get<T>(key)

export const SETTING_BASE_URL = 'baseUrl';
export const SETTING_API_KEY = 'apiKey';
export const SETTING_SYSTEM_PROMPT = 'systemPrompt';
export const SETTING_VERBOSE_LOGGING = 'verboseLogging';
export const SETTING_VERBOSE_PROGRESS_REPORTING = 'verboseProgressReporting';
export const SETTING_PLAY_TOKEN_THRESHOLD_SOUND = 'playTokenThresholdSound';
export const SETTING_TOKEN_SOUND_THRESHOLD = 'tokenSoundThreshold';
export const SETTING_AUTO_CAVEMAN_PROMPTS = 'autoCavemanPrompts';
export const SETTING_TOKEN_BUDGETING = 'tokenBudgeting';
export const SETTING_CONTEXT_OVERFLOW_POLICY = 'contextOverflowPolicy';
export const SETTING_BLOCK_OVERSIZED_REQUESTS = 'blockOversizedRequests';
export const SETTING_PERFORMANCE_OPTIMIZATIONS = 'performanceOptimizations';
export const SETTING_TOGGLE_ALL_PERFORMANCE = 'toggleAllPerformance';

// Planner settings (nested under 'planner')
export const SETTING_PLANNER_ENABLED = 'planner.enabled';
export const SETTING_PLANNER_MAX_ITERATIONS = 'planner.maxIterations';
export const SETTING_PLANNER_MAX_TOOL_RESULT_TOKENS = 'planner.maxToolResultTokens';
export const SETTING_PLANNER_FYI_INSTRUCTION_PATH = 'planner.fyiInstructionPath';

// Model tuning settings (nested under 'modelTuning')
export const SETTING_MODEL_TUNING_TEMPERATURE_ENABLED = 'modelTuning.temperature.enabled';
export const SETTING_MODEL_TUNING_TEMPERATURE_VALUE = 'modelTuning.temperature.value';
export const SETTING_MODEL_TUNING_TOP_P_ENABLED = 'modelTuning.topP.enabled';
export const SETTING_MODEL_TUNING_TOP_P_VALUE = 'modelTuning.topP.value';
export const SETTING_MODEL_TUNING_TOP_K_ENABLED = 'modelTuning.topK.enabled';
export const SETTING_MODEL_TUNING_TOP_K_VALUE = 'modelTuning.topK.value';
export const SETTING_MODEL_TUNING_MIN_P_ENABLED = 'modelTuning.minP.enabled';
export const SETTING_MODEL_TUNING_MIN_P_VALUE = 'modelTuning.minP.value';
export const SETTING_MODEL_TUNING_REPETITION_PENALTY_ENABLED = 'modelTuning.repetitionPenalty.enabled';
export const SETTING_MODEL_TUNING_REPETITION_PENALTY_VALUE = 'modelTuning.repetitionPenalty.value';
export const SETTING_MODEL_TUNING_MAX_TOKENS_IN_RESPONSE_ENABLED = 'modelTuning.maxTokensInResponse.enabled';
export const SETTING_MODEL_TUNING_MAX_TOKENS_IN_RESPONSE_VALUE = 'modelTuning.maxTokensInResponse.value';

// ─── Configuration Root ──────────────────────────────────────────────────────────

export const CONFIGURATION_ROOT = 'lmstudio';

// ─── VS Code Command IDs ─────────────────────────────────────────────────────────

export const COMMAND_REFRESH_MODELS = 'lmstudio.refreshModels';
export const COMMAND_TEST_CONNECTION = 'lmstudio.testConnection';
export const COMMAND_RUN_SMOKE_TEST = 'lmstudio.runSmokeTest';
export const COMMAND_RUN_PLANNER_SMOKE_TEST = 'lmstudio.runPlannerSmokeTest';
export const COMMAND_SHOW_DOCUMENTATION = 'lmstudio.showDocumentation';
export const COMMAND_SHOW_WELCOME = 'lmstudio.showWelcome';

// ─── Status / Error Model IDs ────────────────────────────────────────────────────

export const STATUS_CONNECTION_ERROR = 'connection-error';
export const STATUS_NO_MODELS_LOADED = 'no-models-loaded';
export const STATUS_SERVER_NOT_STARTED = 'server-not-started';

// ─── Context Overflow Policies ───────────────────────────────────────────────────

export const POLICY_STOP_AT_LIMIT = 'stopAtLimit';
export const POLICY_TRUNCATE_MIDDLE = 'truncateMiddle';
export const POLICY_ROLLING_WINDOW = 'rollingWindow';

// ─── Tool Names ──────────────────────────────────────────────────────────────────

export const TOOL_READ_FILE = 'read_file';
export const TOOL_WRITE_FILE = 'write_file';
export const TOOL_WRITE_PROJECT_FILES = 'write_project_files';
export const TOOL_APPLY_WORKSPACE_EDIT = 'apply_workspace_edit';
export const TOOL_RUN_VSCODE_COMMAND = 'run_vscode_command';
export const TOOL_SEARCH_WORKSPACE = 'search_workspace';

// ─── Display Strings ─────────────────────────────────────────────────────────────

export const DISPLAY_PREFIX = 'BYOK: ';
export const OUTPUT_CHANNEL_NAME = 'LM Studio';
export const STATUS_BAR_NAME = 'LM Studio Progress';
export const STATUS_BAR_ID = 'lmstudio.progress';

// ─── Environment Variables ───────────────────────────────────────────────────────

export const ENV_API_KEY = 'LMSTUDIO_API_KEY';

// ─── Default Values ──────────────────────────────────────────────────────────────

export const DEFAULT_BASE_URL = 'ws://localhost:1234';
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_TOP_P = 0.8;
export const DEFAULT_TOP_K = 20;
export const DEFAULT_MIN_P = 0.05;
export const DEFAULT_REPETITION_PENALTY = 1.2;
export const DEFAULT_MAX_RESPONSE_TOKENS = 4096;
export const DEFAULT_MAX_TOOL_RESULT_TOKENS = 8000;
export const DEFAULT_CONTEXT_OVERFLOW_POLICY = POLICY_TRUNCATE_MIDDLE;
export const DEFAULT_SYSTEM_PROMPT = 'Think step-by-step. Break down the problem into detailed reasoning steps before answering.';

// ─── File Paths ──────────────────────────────────────────────────────────────────

export const SOUND_FILE_NAME = 'cha-ching.wav';

// ─── Timing Constants ────────────────────────────────────────────────────────────

export const COMMAND_MESSAGE_TIMEOUT_MS = 5000;
export const PROGRESS_STATUS_MIN_UPDATE_INTERVAL_MS = 100;

// ─── Context Budget Constants ────────────────────────────────────────────────────

export const CONTEXT_BUDGET_RECENT_MESSAGE_COUNT = 4;
export const MIN_MESSAGE_TEXT_BUDGET_TOKENS = 128;

// ─── Cache ───────────────────────────────────────────────────────────────────────

export const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ─── Regex Patterns ──────────────────────────────────────────────────────────────

export const USER_REQUEST_PATTERN = /<userRequest>([\s\S]*?)<\/userRequest>/i;
export const REQUEST_HEADER_PATTERN = /^(\s*Latest user request:\s*\r?\n)?/i;
export const PLANNER_OVERRIDE_PATTERN = /^\/(lmsplan|lmsnoplan)\b(?:[ \t]+|\r?\n+)*/i;
export const MAX_TOKENS_RESET_PATTERN = /^\/lmsmaxtokensreset\b(?:[ \t]+|\r?\n+)*/i;
export const MAX_TOKENS_OVERRIDE_PATTERN = /^\/lmsmaxtokens\b(?:[ \t]+([^\s]+))?(?:[ \t]+|\r?\n+)*/i;

// ─── Heuristic Task Patterns ─────────────────────────────────────────────────────

export const TASK_LIKELY_REQUIRES_WORKSPACE_CHANGES_PATTERN = /\b(update|edit|modify|change|fix|implement|add|write|rewrite|rename|remove|document|documentation|create|build|scaffold|generate|setup|set up|bootstrap)\b/i;
export const TASK_LIKELY_TARGETS_DOCUMENTATION_PATTERN = /\b(readme|architecture|documentation|docs|webview|markdown|md\b|welcome text)\b/i;
export const TASK_LIKELY_TARGETS_PROJECT_SETUP_PATTERN = /\b(create|scaffold|bootstrap|vite|react|website|web site|webapp|web app|single page|single-page|project from scratch)\b/i;
export const RESPONSE_LOOKS_LIKE_INCOMPLETE_PROGRESS_NOTE_PATTERN = /planning|working on|going to|will start|about to|next step/i;
