import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ToolCall {
  id: string;
  name: string;
  inputSummary: string;
  result?: string;
  isError?: boolean;
  timestamp?: string;
  sessionId: string;
}

export interface Session {
  id: string;
  projectId: string;
  summary: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  toolCalls: ToolCall[];
  modifiedFiles: string[];
  readFiles: string[];
  model: string;
  cwd: string;
  version: string;
}

export interface Project {
  id: string;
  displayPath: string;
  sessions: Session[];
}

// ── Chat message types ──────────────────────────────────────────────────────

export interface ChatBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  toolId?: string;
  toolName?: string;
  toolInputSummary?: string;
  toolInputRaw?: string;
  toolResultContent?: string;
  isError?: boolean;
}

export interface ChatEntry {
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  timestamp?: string;
  model?: string;
}

// ── Chat history parser ─────────────────────────────────────────────────────

export function loadChatMessages(projectId: string, sessionId: string): ChatEntry[] {
  const sessionFile = path.join(os.homedir(), '.claude', 'projects', projectId, `${sessionId}.jsonl`);
  if (!fs.existsSync(sessionFile)) return [];

  const entries: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(sessionFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip */ }
  }

  // Build tool_result map: tool_use_id → { content, isError }
  const toolResultMap = new Map<string, { content: string; isError: boolean }>();
  for (const entry of entries) {
    if (entry['type'] !== 'user') continue;
    const content = (entry['message'] as Record<string, unknown>)?.['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block['type'] !== 'tool_result') continue;
      const raw = block['content'];
      toolResultMap.set(block['tool_use_id'] as string, {
        content: (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 2000),
        isError: (block['is_error'] as boolean) ?? false,
      });
    }
  }

  const messages: ChatEntry[] = [];

  for (const entry of entries) {
    const type = entry['type'] as string;
    if (type !== 'user' && type !== 'assistant') continue;
    const msg = entry['message'] as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg['role'] as 'user' | 'assistant' | undefined;
    if (!role) continue;

    const rawContent = msg['content'];
    const blocks: ChatBlock[] = [];

    if (typeof rawContent === 'string' && rawContent.trim()) {
      blocks.push({ type: 'text', text: rawContent });
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent as Record<string, unknown>[]) {
        const btype = block['type'] as string;
        if (btype === 'text') {
          const text = String(block['text'] ?? '').trim();
          if (text) blocks.push({ type: 'text', text });
        }
        if (btype === 'thinking') {
          const text = String(block['thinking'] ?? '').trim();
          if (text) blocks.push({ type: 'thinking', text });
        }
        if (btype === 'tool_use') {
          const input = (block['input'] ?? {}) as Record<string, unknown>;
          const toolId = block['id'] as string;
          const toolName = block['name'] as string;
          const result = toolResultMap.get(toolId);
          blocks.push({
            type: 'tool_use',
            toolId,
            toolName,
            toolInputSummary: summarizeInput(toolName, input),
            toolInputRaw: JSON.stringify(input, null, 2).slice(0, 2000),
            toolResultContent: result?.content,
            isError: result?.isError,
          });
        }
        // tool_result handled via map above – skip here
      }
    }

    if (blocks.length === 0) continue;
    messages.push({ role, blocks, timestamp: entry['timestamp'] as string | undefined, model: msg['model'] as string | undefined });
  }

  return messages;
}

// ── Project path ────────────────────────────────────────────────────────────

function decodeProjectPath(folderName: string): string {
  return '/' + folderName.slice(1).replace(/-/g, '/');
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  if (!input) return '';
  if (name === 'Bash') return String(input['command'] ?? '').slice(0, 120);
  if (name === 'Read') return String(input['file_path'] ?? '');
  if (name === 'Write') return String(input['file_path'] ?? '');
  if (name === 'Edit') return String(input['file_path'] ?? '');
  if (name === 'WebFetch' || name === 'WebSearch') return String(input['url'] ?? input['query'] ?? '');
  if (name === 'Agent') return String(input['description'] ?? input['prompt'] ?? '').slice(0, 100);
  const vals = Object.values(input);
  return vals.length ? String(vals[0]).slice(0, 100) : '';
}

export function parseSession(sessionFile: string, projectId: string): Session {
  const content = fs.readFileSync(sessionFile, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  const entries: Record<string, unknown>[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip */ }
  }

  const toolCallMap = new Map<string, ToolCall>();
  let startTime = '';
  let endTime = '';
  let model = '';
  let cwd = '';
  let version = '';
  let summary = '';
  const modifiedFiles = new Set<string>();
  const readFiles = new Set<string>();
  let messageCount = 0;
  const sessionId = path.basename(sessionFile, '.jsonl');

  for (const entry of entries) {
    const type = entry['type'] as string;
    const ts = entry['timestamp'] as string | undefined;
    if (ts) {
      if (!startTime) startTime = ts;
      endTime = ts;
    }

    if (type === 'system' && (entry['subtype'] as string) === 'turn_duration') {
      if (entry['cwd']) cwd = entry['cwd'] as string;
      if (entry['version']) version = entry['version'] as string;
    }

    if (type === 'user' || type === 'assistant') messageCount++;

    if (type === 'assistant') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (msg?.['model']) model = msg['model'] as string;
      const content = (msg?.['content'] ?? []) as Record<string, unknown>[];
      for (const block of content) {
        if (block['type'] === 'tool_use') {
          const input = (block['input'] ?? {}) as Record<string, unknown>;
          const tc: ToolCall = {
            id: block['id'] as string,
            name: block['name'] as string,
            inputSummary: summarizeInput(block['name'] as string, input),
            timestamp: ts,
            sessionId,
          };
          toolCallMap.set(tc.id, tc);
          const fp = input['file_path'] as string | undefined;
          if (['Write', 'Edit'].includes(tc.name) && fp) modifiedFiles.add(fp);
          if (tc.name === 'Read' && fp) readFiles.add(fp);
        }
      }
    }

    if (type === 'user') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      const rawContent = msg?.['content'];

      // Extract summary from first meaningful user text message
      if (!summary) {
        let text = '';
        if (typeof rawContent === 'string') {
          text = rawContent.trim();
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent as Record<string, unknown>[]) {
            if (block['type'] === 'text') {
              text = String(block['text'] ?? '').trim();
              if (text) break;
            }
          }
        }
        // Ignore system-like messages (e.g. "[Request interrupted...]")
        if (text && !text.startsWith('[')) {
          summary = text.replace(/\s+/g, ' ').slice(0, 80);
        }
      }

      if (Array.isArray(rawContent)) {
        for (const block of rawContent as Record<string, unknown>[]) {
          if (block['type'] === 'tool_result') {
            const tc = toolCallMap.get(block['tool_use_id'] as string);
            if (tc) {
              const raw = block['content'];
              tc.result = typeof raw === 'string' ? raw.slice(0, 400) : JSON.stringify(raw).slice(0, 400);
              tc.isError = (block['is_error'] as boolean) ?? false;
            }
          }
        }
      }
    }
  }

  const stat = fs.statSync(sessionFile);
  return {
    id: sessionId,
    projectId,
    summary: summary || sessionId.slice(0, 8),
    startTime: startTime || stat.birthtime.toISOString(),
    endTime: endTime || stat.mtime.toISOString(),
    messageCount,
    toolCalls: Array.from(toolCallMap.values()),
    modifiedFiles: Array.from(modifiedFiles),
    readFiles: Array.from(readFiles),
    model,
    cwd,
    version,
  };
}

export function loadAllProjects(): Project[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const projects: Project[] = [];

  for (const folder of fs.readdirSync(projectsDir)) {
    const folderPath = path.join(projectsDir, folder);
    if (!fs.statSync(folderPath).isDirectory()) continue;

    const sessions: Session[] = [];
    for (const file of fs.readdirSync(folderPath)) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        sessions.push(parseSession(path.join(folderPath, file), folder));
      } catch { /* skip malformed */ }
    }

    sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
    projects.push({ id: folder, displayPath: decodeProjectPath(folder), sessions });
  }

  projects.sort((a, b) =>
    (b.sessions[0]?.startTime ?? '').localeCompare(a.sessions[0]?.startTime ?? '')
  );

  return projects;
}
