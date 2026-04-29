export {};

// ── Types ──────────────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  name: string;
  inputSummary: string;
  result?: string;
  isError?: boolean;
  timestamp?: string;
  sessionId: string;
}

interface Session {
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

interface Project {
  id: string;
  displayPath: string;
  sessions: Session[];
}

interface ChatBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  toolId?: string;
  toolName?: string;
  toolInputSummary?: string;
  toolInputRaw?: string;
  toolResultContent?: string;
  isError?: boolean;
}

interface ChatEntry {
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  timestamp?: string;
  model?: string;
}

interface ElectronAPI {
  getAppVersion: () => Promise<string>;
  getProjects: () => Promise<Project[]>;
  getChatMessages: (projectId: string, sessionId: string) => Promise<ChatEntry[]>;
  sendChatMessage: (args: { requestId: string; sessionId: string | null; message: string; cwd: string; yolo?: boolean }) => void;
  cancelChatMessage: (requestId: string) => void;
  onChatEvent: (cb: (data: { requestId: string; ev: unknown }) => void) => void;
  onChatDone: (cb: (data: { requestId: string; code: number | null }) => void) => void;
  removeAllChatListeners: () => void;
  deleteSession: (projectId: string, sessionId: string) => Promise<void>;
  clearSessionChat: (projectId: string, sessionId: string) => Promise<void>;
  resumeSession: (sessionId: string, cwd: string) => Promise<boolean>;
  copyToClipboard: (text: string) => Promise<void>;
  checkCLI: () => Promise<boolean>;
  installCLI: () => Promise<void>;
  onOpenNewChat: (cb: (cwd: string) => void) => void;
  platform: string;
}

declare global {
  interface Window { electronAPI?: ElectronAPI; }
}

// ── State ──────────────────────────────────────────────────────────────────

let projects: Project[] = [];
let selectedProjectId: string | null = null;
let expandedSessionId: string | null = null;

// ── Utils ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function shortTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shortPath(p: string): string {
  if (!p) return '—';
  const home = '/Users/';
  const idx = p.indexOf(home);
  if (idx !== -1) {
    const rest = p.slice(idx + home.length);
    const slash = rest.indexOf('/');
    return slash > -1 ? '~/' + rest.slice(slash + 1) : rest;
  }
  const parts = p.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}

function toolBadgeClass(name: string): string {
  if (name === 'Bash') return 'tool-bash';
  if (name === 'Read') return 'tool-read';
  if (name === 'Write') return 'tool-write';
  if (name === 'Edit') return 'tool-edit';
  if (name.startsWith('Web')) return 'tool-web';
  if (name === 'Agent') return 'tool-agent';
  return 'tool-default';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ── Markdown renderer ─────────────────────────────────────────────────────

function inlineMd(text: string): string {
  let s = esc(text);
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  return s;
}

function renderMarkdown(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1] ?? '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      const code = codeLines.join('\n');
      const langLabel = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
      const copyBtn = `<button class="code-copy-btn" data-code="${esc(code)}">Copy</button>`;
      out.push(`<div class="code-block-wrapper">${langLabel}${copyBtn}<pre class="code-block"><code>${esc(code)}</code></pre></div>`);
      continue;
    }

    // Headers
    const h3 = line.match(/^### (.+)/);
    if (h3) { out.push(`<h3 class="md-h">${inlineMd(h3[1])}</h3>`); i++; continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { out.push(`<h2 class="md-h">${inlineMd(h2[1])}</h2>`); i++; continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { out.push(`<h1 class="md-h">${inlineMd(h1[1])}</h1>`); i++; continue; }

    // Horizontal rule
    if (/^---+$|^\*\*\*+$/.test(line.trim())) { out.push('<hr class="md-hr">'); i++; continue; }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^[-*] /, ''))}</li>`);
        i++;
      }
      out.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\d+\. /, ''))}</li>`);
        i++;
      }
      out.push(`<ol class="md-list">${items.join('')}</ol>`);
      continue;
    }

    // Empty line
    if (line.trim() === '') { out.push('<div class="md-gap"></div>'); i++; continue; }

    // Regular paragraph
    out.push(`<p class="md-p">${inlineMd(line)}</p>`);
    i++;
  }

  return out.join('');
}

// ── Data loading ───────────────────────────────────────────────────────────

async function loadData(): Promise<void> {
  const indicator = el('loading-indicator');
  indicator.classList.remove('hidden');
  try {
    projects = ((await window.electronAPI?.getProjects()) ?? []) as Project[];
  } catch (e) {
    console.error('Failed to load projects', e);
  } finally {
    indicator.classList.add('hidden');
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────

function renderDashboard(): void {
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0);
  const totalTools = projects.reduce((s, p) =>
    s + p.sessions.reduce((ss, se) => ss + se.toolCalls.length, 0), 0);
  const totalFiles = new Set(
    projects.flatMap((p) => p.sessions.flatMap((s) => s.modifiedFiles))
  ).size;

  el('stat-projects').textContent = String(projects.length);
  el('stat-sessions').textContent = String(totalSessions);
  el('stat-tools').textContent = String(totalTools);
  el('stat-files').textContent = String(totalFiles);

  // Recent sessions (last 8 across all projects)
  const allSessions: Array<{ project: Project; session: Session }> = [];
  for (const p of projects) {
    for (const s of p.sessions) allSessions.push({ project: p, session: s });
  }
  allSessions.sort((a, b) => b.session.startTime.localeCompare(a.session.startTime));
  const recent = allSessions.slice(0, 8);

  const rsList = el('recent-sessions-list');
  if (recent.length === 0) {
    rsList.innerHTML = '<div class="empty-state"><p>No sessions found</p></div>';
  } else {
    rsList.innerHTML = recent.map(({ project, session }) => `
      <div class="recent-session-item">
        <div class="rs-dot"></div>
        <div class="rs-info">
          <div class="rs-project">${esc(session.summary)}</div>
          <div class="rs-meta">${esc(shortPath(project.displayPath))} · ${session.toolCalls.length} tools</div>
        </div>
        <div class="rs-time">${relativeTime(session.startTime)}</div>
      </div>
    `).join('');
  }

  // Tool usage breakdown
  const toolCounts = new Map<string, number>();
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const tc of s.toolCalls) {
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
      }
    }
  }
  const sorted = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxCount = sorted[0]?.[1] ?? 1;

  const topToolsList = el('top-tools-list');
  if (sorted.length === 0) {
    topToolsList.innerHTML = '<div class="empty-state"><p>No tool data</p></div>';
  } else {
    topToolsList.innerHTML = sorted.map(([name, count]) => `
      <div class="top-tool-row">
        <div class="top-tool-header">
          <span class="top-tool-name">${esc(name)}</span>
          <span class="top-tool-count">${count}</span>
        </div>
        <div class="top-tool-bar">
          <div class="top-tool-fill" style="width:${Math.round((count / maxCount) * 100)}%"></div>
        </div>
      </div>
    `).join('');
  }
}

// ── Sessions view ──────────────────────────────────────────────────────────

function renderProjectList(): void {
  const list = el('project-list');
  // Only show projects that have at least one session with messages
  const visible = projects.filter((p) => p.sessions.some((s) => s.messageCount > 0));
  if (visible.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>No projects</p></div>';
    return;
  }
  list.innerHTML = visible.map((p) => {
    const count = p.sessions.filter((s) => s.messageCount > 0).length;
    return `
      <div class="project-item${p.id === selectedProjectId ? ' active' : ''}" data-project="${esc(p.id)}">
        <div class="project-name">${esc(shortPath(p.displayPath))}</div>
        <div class="project-meta">${count} session${count !== 1 ? 's' : ''}</div>
      </div>
    `;
  }).join('');

  list.querySelectorAll<HTMLElement>('.project-item').forEach((item) => {
    item.addEventListener('click', () => {
      selectedProjectId = item.dataset['project'] ?? null;
      expandedSessionId = null;
      renderProjectList();
      renderSessionList();
    });
  });
}

function renderSessionList(): void {
  const list = el('session-list');
  const titleEl = el('sessions-panel-title');
  const project = projects.find((p) => p.id === selectedProjectId);

  if (!project) {
    titleEl.textContent = 'Select a project';
    list.innerHTML = '<div class="empty-state"><p>Select a project on the left</p></div>';
    return;
  }

  titleEl.textContent = shortPath(project.displayPath);

  // Only show sessions with messages
  const visibleSessions = project.sessions.filter((s) => s.messageCount > 0);
  if (visibleSessions.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>No sessions</p></div>';
    return;
  }

  list.innerHTML = visibleSessions.map((s) => {
    const expanded = s.id === expandedSessionId;
    const detailHtml = expanded ? `
      <div class="session-detail">
        <div class="session-action-row">
          <button class="btn-resume"
            data-resume-id="${esc(s.id)}"
            data-resume-cwd="${esc(s.cwd)}"
            data-resume-pid="${esc(project.id)}">
            ◉ Open Chat
          </button>
          <button class="btn-copy-id" data-copy-id="${esc(s.id)}">
            ⎘ Copy ID
          </button>
        </div>
        <div class="session-detail-row">
          <span class="detail-label">Session ID</span>
          <span class="detail-val mono">${esc(s.id)}</span>
        </div>
        <div class="session-detail-row">
          <span class="detail-label">Start</span>
          <span class="detail-val">${shortDate(s.startTime)}</span>
        </div>
        <div class="session-detail-row">
          <span class="detail-label">End</span>
          <span class="detail-val">${shortDate(s.endTime)}</span>
        </div>
        ${s.cwd ? `<div class="session-detail-row"><span class="detail-label">Working dir</span><span class="detail-val mono small">${esc(s.cwd)}</span></div>` : ''}
        ${s.version ? `<div class="session-detail-row"><span class="detail-label">Version</span><span class="detail-val">${esc(s.version)}</span></div>` : ''}
        ${s.modifiedFiles.length > 0 ? `
          <div class="session-detail-row">
            <span class="detail-label">Modified</span>
            <span class="detail-val">${s.modifiedFiles.map((f) => esc(shortPath(f))).join('<br>')}</span>
          </div>` : ''}
      </div>` : '';

    return `
      <div class="session-item${expanded ? ' expanded' : ''}" data-session="${esc(s.id)}">
        <div class="session-header">
          <span class="session-id" title="${esc(s.id)}">${esc(s.summary)}</span>
          <div class="session-header-right">
            <span class="session-time">${relativeTime(s.startTime)}</span>
            <button class="btn-delete-session"
              data-del-pid="${esc(project.id)}"
              data-del-sid="${esc(s.id)}"
              title="Delete session">🗑</button>
          </div>
        </div>
        <div class="session-meta">
          <span class="session-badge">💬 ${s.messageCount}</span>
          <span class="session-badge">⚙ ${s.toolCalls.length}</span>
          <span class="session-badge">◫ ${s.modifiedFiles.length}</span>
        </div>
        ${s.model ? `<div class="session-model">${esc(s.model)}</div>` : ''}
        ${detailHtml}
      </div>
    `;
  }).join('');

  // Open Chat buttons
  list.querySelectorAll<HTMLButtonElement>('.btn-resume').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sessionId = btn.dataset['resumeId'] ?? '';
      const cwd = btn.dataset['resumeCwd'] ?? '';
      const pid = btn.dataset['resumePid'] ?? '';
      await navigateToChat(pid, sessionId, cwd);
    });
  });

  // Copy ID buttons
  list.querySelectorAll<HTMLButtonElement>('.btn-copy-id').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset['copyId'] ?? '';
      await window.electronAPI?.copyToClipboard(id);
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = '⎘ Copy ID'; }, 1500);
    });
  });

  // Delete session buttons (Sessions view)
  list.querySelectorAll<HTMLButtonElement>('.btn-delete-session').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pid = btn.dataset['delPid'] ?? '';
      const sid = btn.dataset['delSid'] ?? '';
      if (!confirm('Delete this session and all its messages?')) return;
      await window.electronAPI?.deleteSession(pid, sid);
      expandedSessionId = null;
      await loadData();
      renderProjectList();
      renderSessionList();
    });
  });

  list.querySelectorAll<HTMLElement>('.session-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const sid = item.dataset['session'] ?? null;
      expandedSessionId = expandedSessionId === sid ? null : sid;
      renderSessionList();
    });
  });
}

// ── Tools view ─────────────────────────────────────────────────────────────

function renderTools(filter = ''): void {
  const list = el('tools-list');
  const lf = filter.toLowerCase();

  const allTools: Array<{ tc: ToolCall; session: Session; project: Project }> = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const tc of s.toolCalls) allTools.push({ tc, session: s, project: p });
    }
  }

  allTools.sort((a, b) =>
    (b.tc.timestamp ?? b.session.startTime).localeCompare(a.tc.timestamp ?? a.session.startTime)
  );

  const filtered = lf
    ? allTools.filter(({ tc }) =>
        tc.name.toLowerCase().includes(lf) || tc.inputSummary.toLowerCase().includes(lf)
      )
    : allTools;

  const shown = filtered.slice(0, 300);

  if (shown.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>No tool calls found</p></div>';
    return;
  }

  list.innerHTML = shown.map(({ tc, session }) => `
    <div class="tool-item">
      <span class="tool-time">${tc.timestamp ? shortTime(tc.timestamp) : '—'}</span>
      <span class="tool-badge ${toolBadgeClass(tc.name)}">${esc(tc.name)}</span>
      <span class="tool-input" title="${esc(tc.inputSummary)}">${esc(tc.inputSummary)}</span>
      <span class="tool-status ${tc.isError ? 'tool-err' : 'tool-ok'}">${tc.isError ? '✗ error' : '✓ ok'}</span>
    </div>
  `).join('');

  if (filtered.length > 300) {
    list.innerHTML += `<div class="empty-state hint" style="padding:12px">Showing 300 of ${filtered.length}</div>`;
  }
}

// ── Files view ─────────────────────────────────────────────────────────────

function renderFiles(): void {
  const list = el('files-list');

  const writeCounts = new Map<string, number>();
  const readCounts = new Map<string, number>();

  for (const p of projects) {
    for (const s of p.sessions) {
      for (const f of s.modifiedFiles) writeCounts.set(f, (writeCounts.get(f) ?? 0) + 1);
      for (const f of s.readFiles) readCounts.set(f, (readCounts.get(f) ?? 0) + 1);
    }
  }

  const allFiles = new Set([...writeCounts.keys(), ...readCounts.keys()]);

  if (allFiles.size === 0) {
    list.innerHTML = '<div class="empty-state"><p>No file activity recorded</p></div>';
    return;
  }

  const sorted = Array.from(allFiles).sort((a, b) =>
    (writeCounts.get(b) ?? 0) - (writeCounts.get(a) ?? 0)
  );

  list.innerHTML = sorted.map((f) => {
    const w = writeCounts.get(f) ?? 0;
    const r = readCounts.get(f) ?? 0;
    return `
      <div class="file-item">
        <span class="file-path" title="${esc(f)}">${esc(shortPath(f))}</span>
        <div class="file-ops">
          ${w > 0 ? `<span class="file-op-badge op-write">W×${w}</span>` : ''}
          ${r > 0 ? `<span class="file-op-badge op-read">R×${r}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ── Chat view ──────────────────────────────────────────────────────────────

interface ChatState {
  projectId: string | null;
  sessionId: string | null;
  cwd: string;
  messages: ChatEntry[];
  streaming: boolean;
  activeRequestId: string | null;
  collapsedProjects: Set<string>;
}

const chat: ChatState = {
  projectId: null,
  sessionId: null,
  cwd: '',
  messages: [],
  streaming: false,
  activeRequestId: null,
  collapsedProjects: new Set(),
};

function renderChatProjectList(): void {
  const container = el('chat-project-list');
  if (projects.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:20px"><p>No projects</p></div>';
    return;
  }

  const html: string[] = [];
  for (const p of projects) {
    const collapsed = chat.collapsedProjects.has(p.id);
    const name = shortPath(p.displayPath);
    html.push(`
      <div class="chat-project-group">
        <div class="chat-project-name${collapsed ? ' collapsed' : ''}" data-pid="${esc(p.id)}">
          <span class="chat-project-arrow">▾</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
        </div>
        ${collapsed ? '' : p.sessions
          .filter((s) => s.messageCount > 0)
          .slice(0, 30).map((s) => `
          <div class="chat-session-entry${s.id === chat.sessionId ? ' active' : ''}"
               data-pid="${esc(p.id)}" data-sid="${esc(s.id)}" data-cwd="${esc(s.cwd)}"
               title="${esc(s.summary)}">
            <span class="chat-session-name">${esc(s.summary)}</span>
            <div class="chat-session-actions">
              <span class="chat-session-rel">${relativeTime(s.startTime)}</span>
              <button class="session-del-btn" data-del-pid="${esc(p.id)}" data-del-sid="${esc(s.id)}" title="Delete session">✕</button>
            </div>
          </div>
        `).join('')}
      </div>
    `);
  }

  container.innerHTML = html.join('');

  // Project collapse toggle
  container.querySelectorAll<HTMLElement>('.chat-project-name').forEach((el_) => {
    el_.addEventListener('click', () => {
      const pid = el_.dataset['pid'] ?? '';
      if (chat.collapsedProjects.has(pid)) chat.collapsedProjects.delete(pid);
      else chat.collapsedProjects.add(pid);
      renderChatProjectList();
    });
  });

  // Session click
  container.querySelectorAll<HTMLElement>('.chat-session-entry').forEach((el_) => {
    el_.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.session-del-btn')) return;
      const pid = el_.dataset['pid'] ?? '';
      const sid = el_.dataset['sid'] ?? '';
      const cwd = el_.dataset['cwd'] ?? '';
      void openChatSession(pid, sid, cwd);
    });
  });

  // Session delete
  container.querySelectorAll<HTMLButtonElement>('.session-del-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pid = btn.dataset['delPid'] ?? '';
      const sid = btn.dataset['delSid'] ?? '';
      if (!confirm('Delete this session and all its messages?')) return;
      await window.electronAPI?.deleteSession(pid, sid);
      if (chat.sessionId === sid) {
        chat.sessionId = null;
        chat.messages = [];
        updateChatHeader();
        renderChatMessages();
        el<HTMLButtonElement>('chat-send-btn').disabled = true;
      }
      await loadData();
      renderChatProjectList();
    });
  });
}

async function openChatSession(projectId: string, sessionId: string, cwd: string): Promise<void> {
  if (chat.streaming) cancelCurrentChat();

  chat.projectId = projectId;
  chat.sessionId = sessionId;
  chat.cwd = cwd;

  const msgs = (await window.electronAPI?.getChatMessages(projectId, sessionId)) ?? [];
  chat.messages = msgs as ChatEntry[];

  renderChatProjectList();
  updateChatHeader();
  renderChatMessages();
  el<HTMLButtonElement>('chat-send-btn').disabled = false;

  const msgsEl = el('chat-messages');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function startNewChat(projectId: string | null, cwd: string): void {
  if (chat.streaming) cancelCurrentChat();
  chat.projectId = projectId;
  chat.sessionId = null;
  chat.cwd = cwd;
  chat.messages = [];
  renderChatProjectList();
  updateChatHeader();
  renderChatMessages();
  el<HTMLButtonElement>('chat-send-btn').disabled = false;
}

function updateChatHeader(): void {
  const header = el('chat-header');
  if (!chat.projectId && !chat.cwd) {
    header.innerHTML = '<span class="chat-header-label">No session selected</span>';
    return;
  }
  if (!chat.projectId && chat.cwd) {
    header.innerHTML = `
      <span class="chat-header-label">New Chat</span>
      <span class="chat-header-meta">${esc(chat.cwd)}</span>
    `;
    return;
  }
  const project = projects.find((p) => p.id === chat.projectId);
  const label = chat.sessionId
    ? `${shortPath(project?.displayPath ?? '')}  ·  ${chat.sessionId.slice(0, 8)}`
    : `${shortPath(project?.displayPath ?? '')}  ·  New Chat`;
  header.innerHTML = `
    <span class="chat-header-label">${esc(label)}</span>
    <span class="chat-header-meta">${esc(chat.cwd)}</span>
    ${chat.sessionId ? `<button class="chat-header-del-btn" id="chat-header-del-btn" title="Delete session">Delete Session</button>` : ''}
  `;

  document.getElementById('chat-header-del-btn')?.addEventListener('click', async () => {
    if (!chat.projectId || !chat.sessionId) return;
    if (!confirm('Delete this session and all its messages?')) return;
    const pid = chat.projectId;
    const sid = chat.sessionId;
    await window.electronAPI?.deleteSession(pid, sid);
    chat.sessionId = null;
    chat.messages = [];
    updateChatHeader();
    renderChatMessages();
    el<HTMLButtonElement>('chat-send-btn').disabled = true;
    await loadData();
    renderChatProjectList();
  });
}

function toolCardHtml(block: ChatBlock): string {
  const badgeClass = toolBadgeClass(block.toolName ?? '');
  const status = block.toolResultContent !== undefined
    ? (block.isError ? '<span class="tool-card-status err">✗</span>' : '<span class="tool-card-status ok">✓</span>')
    : '';
  return `
    <div class="tool-card" data-tool-id="${esc(block.toolId ?? '')}">
      <div class="tool-card-header">
        <span class="tool-card-badge ${badgeClass}">${esc(block.toolName ?? '')}</span>
        <span class="tool-card-summary">${esc(block.toolInputSummary ?? '')}</span>
        ${status}
        <span class="tool-card-toggle">▸</span>
      </div>
      <div class="tool-card-body">
        <div class="tool-card-section">
          <div class="tool-card-section-label">Input</div>
          <div class="tool-card-code">${esc(block.toolInputRaw ?? '')}</div>
        </div>
        ${block.toolResultContent !== undefined ? `
        <div class="tool-card-section">
          <div class="tool-card-section-label">Result</div>
          <div class="tool-card-code ${block.isError ? 'error' : 'result'}">${esc(block.toolResultContent ?? '')}</div>
        </div>` : ''}
      </div>
    </div>
  `;
}

function msgRowHtml(entry: ChatEntry, idx: number): string {
  const roleLabel = entry.role === 'user' ? 'You' : 'Claude';
  const blockHtml = entry.blocks.map((b) => {
    if (b.type === 'text') return `<div class="msg-text md-body">${renderMarkdown(b.text ?? '')}</div>`;
    if (b.type === 'tool_use') return toolCardHtml(b);
    if (b.type === 'thinking') {
      return `<div class="thinking-block" data-thinking-idx="${idx}">
        <div class="thinking-block-label">◈ Thinking</div>
        <div class="thinking-text">${esc(b.text ?? '')}</div>
      </div>`;
    }
    return '';
  }).join('');

  return `<div class="msg-row ${entry.role}" data-msg-idx="${idx}">
    <div class="msg-role">${roleLabel}</div>
    ${blockHtml}
  </div>`;
}

function renderChatMessages(): void {
  const container = el('chat-messages');

  if (chat.messages.length === 0 && !chat.streaming) {
    container.innerHTML = chat.sessionId
      ? '<div class="empty-state"><p>No messages in this session</p></div>'
      : '<div class="empty-state"><p>Start a new conversation</p><p class="hint">Type below and press Enter</p></div>';
    return;
  }

  container.innerHTML = chat.messages.map((m, i) => msgRowHtml(m, i)).join('');

  if (chat.streaming) {
    const streamEl = document.createElement('div');
    streamEl.className = 'msg-row assistant';
    streamEl.id = 'streaming-msg';
    streamEl.innerHTML = `
      <div class="msg-role">Claude</div>
      <div class="msg-streaming">
        <div class="streaming-dots"><span></span><span></span><span></span></div>
        <span>Thinking…</span>
      </div>
    `;
    container.appendChild(streamEl);
  }

  // Wire code copy buttons
  container.querySelectorAll<HTMLButtonElement>('.code-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset['code'] ?? '';
      window.electronAPI?.copyToClipboard(code);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });

  // Wire tool card toggles
  container.querySelectorAll<HTMLElement>('.tool-card-header').forEach((h) => {
    h.addEventListener('click', () => {
      const card = h.closest('.tool-card');
      if (card) {
        card.classList.toggle('expanded');
        const toggle = h.querySelector('.tool-card-toggle');
        if (toggle) toggle.textContent = card.classList.contains('expanded') ? '▾' : '▸';
      }
    });
  });

  // Wire thinking toggles
  container.querySelectorAll<HTMLElement>('.thinking-block').forEach((b) => {
    b.addEventListener('click', () => b.classList.toggle('expanded'));
  });

  container.scrollTop = container.scrollHeight;
}

let streamingBuffer = '';

function appendStreamingText(text: string): void {
  streamingBuffer += text;
  const streamEl = document.getElementById('streaming-msg');
  if (!streamEl) return;
  streamEl.innerHTML = `<div class="msg-role">Claude</div><div class="msg-text md-body">${renderMarkdown(streamingBuffer)}</div>`;
  el('chat-messages').scrollTop = el('chat-messages').scrollHeight;
}

function initChatListeners(): void {
  window.electronAPI?.removeAllChatListeners();

  window.electronAPI?.onChatEvent(({ requestId, ev }) => {
    if (requestId !== chat.activeRequestId) return;
    const event = ev as Record<string, unknown>;

    // Capture session_id from the system init event (new sessions)
    if (event['type'] === 'system' && event['session_id']) {
      chat.sessionId = String(event['session_id']);
    }

    if (event['type'] === 'assistant') {
      const msg = event['message'] as Record<string, unknown>;
      const content = (msg?.['content'] ?? []) as Record<string, unknown>[];
      for (const block of content) {
        if (block['type'] === 'text') {
          appendStreamingText(String(block['text'] ?? ''));
        }
      }
    }

    if (event['type'] === 'text_chunk') {
      appendStreamingText(String(event['text'] ?? ''));
    }

    if (event['type'] === 'result') {
      const resultText = String(event['result'] ?? '');
      const streamEl = document.getElementById('streaming-msg');
      const existing = streamEl?.querySelector('.streaming-text')?.textContent ?? '';
      if (!existing && resultText) appendStreamingText(resultText);
    }
  });

  window.electronAPI?.onChatDone(async ({ requestId }) => {
    if (requestId !== chat.activeRequestId) return;
    chat.streaming = false;
    chat.activeRequestId = null;

    // Reload data so we can find the project for a newly-created session
    await loadData();

    if (chat.sessionId) {
      // If we still don't have a projectId, find it by matching session id
      if (!chat.projectId) {
        for (const p of projects) {
          if (p.sessions.some((s) => s.id === chat.sessionId)) {
            chat.projectId = p.id;
            break;
          }
        }
      }
      if (chat.projectId) {
        const msgs = (await window.electronAPI?.getChatMessages(chat.projectId, chat.sessionId)) ?? [];
        chat.messages = msgs as ChatEntry[];
      }
    }

    renderChatProjectList();
    renderChatMessages();
    el<HTMLButtonElement>('chat-send-btn').disabled = false;
    el<HTMLButtonElement>('chat-send-btn').textContent = 'Send';
  });
}

function cancelCurrentChat(): void {
  if (chat.activeRequestId) {
    window.electronAPI?.cancelChatMessage(chat.activeRequestId);
    chat.streaming = false;
    chat.activeRequestId = null;
  }
}

async function sendChatMessage(): Promise<void> {
  const input = el<HTMLTextAreaElement>('chat-input');
  const message = input.value.trim();
  if (!message || chat.streaming) return;

  // Add user message to display immediately
  chat.messages.push({ role: 'user', blocks: [{ type: 'text', text: message }] });
  chat.streaming = true;
  input.value = '';
  input.style.height = 'auto';

  streamingBuffer = '';
  const requestId = `req-${Date.now()}`;
  chat.activeRequestId = requestId;

  renderChatMessages();
  el<HTMLButtonElement>('chat-send-btn').disabled = true;
  el<HTMLButtonElement>('chat-send-btn').textContent = 'Sending…';

  initChatListeners();

  const yolo = el<HTMLInputElement>('yolo-checkbox').checked;
  window.electronAPI?.sendChatMessage({
    requestId,
    sessionId: chat.sessionId,
    message,
    cwd: chat.cwd,
    yolo,
  });
}

function initChatView(): void {
  const input = el<HTMLTextAreaElement>('chat-input');
  const sendBtn = el<HTMLButtonElement>('chat-send-btn');

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  // Enter to send, Shift+Enter for newline
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendChatMessage();
    }
  });

  sendBtn.addEventListener('click', () => { void sendChatMessage(); });
}

// ── Navigate to chat with a specific session ───────────────────────────────

export async function navigateToChat(projectId: string, sessionId: string, cwd: string): Promise<void> {
  switchView('chat');
  await openChatSession(projectId, sessionId, cwd);
}

// ── Navigation ─────────────────────────────────────────────────────────────

const viewTitles: Record<string, string> = {
  dashboard: 'Dashboard',
  chat: 'Chat',
  sessions: 'Sessions',
  tools: 'Tools',
  files: 'Files',
};

function switchView(viewId: string): void {
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset['view'] === viewId);
  });
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${viewId}`);
  });

  const topbar = document.getElementById('topbar');
  if (topbar) topbar.style.display = viewId === 'chat' ? 'none' : '';
  el('page-title').textContent = viewTitles[viewId] ?? viewId;

  if (viewId === 'dashboard') renderDashboard();
  if (viewId === 'chat') renderChatProjectList();
  if (viewId === 'sessions') { renderProjectList(); renderSessionList(); }
  if (viewId === 'tools') renderTools();
  if (viewId === 'files') renderFiles();
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Nav clicks
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const v = item.dataset['view'];
      if (v) switchView(v);
    });
  });

  // Refresh button
  el('refresh-btn').addEventListener('click', async () => {
    const btn = el<HTMLButtonElement>('refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    try {
      await loadData();
      const activeView = document.querySelector<HTMLElement>('.view.active')?.id?.replace('view-', '') ?? 'dashboard';
      switchView(activeView);
    } finally {
      btn.disabled = false;
      btn.textContent = '↺ Refresh';
    }
  });

  // Tool filter
  const toolFilter = el<HTMLInputElement>('tool-filter');
  toolFilter.addEventListener('input', () => renderTools(toolFilter.value));

  // Version
  if (window.electronAPI) {
    const v = await window.electronAPI.getAppVersion();
    el('version-info').textContent = `Claudia v${v}`;
  }

  // Init chat view
  initChatView();

  // Handle claudia:// URL open-new-chat from CLI
  window.electronAPI?.onOpenNewChat((cwd) => {
    startNewChat(null, cwd);
    switchView('chat');
    el<HTMLTextAreaElement>('chat-input').focus();
  });

  // Install CLI button
  const cliBtn = el<HTMLButtonElement>('install-cli-btn');
  const hideCLIBtn = () => { cliBtn.style.display = 'none'; };

  if (await window.electronAPI?.checkCLI()) {
    hideCLIBtn();
  } else {
    cliBtn.addEventListener('click', async () => {
      cliBtn.disabled = true;
      cliBtn.textContent = 'Installing…';
      try {
        await window.electronAPI?.installCLI();
        hideCLIBtn();
      } catch {
        cliBtn.textContent = 'Failed';
        setTimeout(() => {
          cliBtn.textContent = 'Install CLI';
          cliBtn.disabled = false;
        }, 2000);
      }
    });
  }

  // Load and render
  await loadData();
  renderDashboard();
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
