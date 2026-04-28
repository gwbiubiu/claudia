import { ipcMain } from 'electron';
import { exec, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadAllProjects, loadChatMessages } from './claudeData';

function findClaudeBin(): string {
  try {
    const result = execSync('which claude', {
      encoding: 'utf-8',
      shell: process.env['SHELL'] ?? '/bin/zsh',
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* fallback */ }

  // Scan nvm node bins
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmDir)) {
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const v of versions) {
      const p = path.join(nvmDir, v, 'bin', 'claude');
      if (fs.existsSync(p)) return p;
    }
  }
  return 'claude';
}

// Active subprocess map: requestId → child process
const chatProcs = new Map<string, ReturnType<typeof spawn>>();

function sessionFile(projectId: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', projectId, `${sessionId}.jsonl`);
}

export function registerIPC(): void {
  ipcMain.handle('get-projects', () => loadAllProjects());

  ipcMain.handle('get-chat-messages', (_e, projectId: string, sessionId: string) =>
    loadChatMessages(projectId, sessionId)
  );

  ipcMain.handle('delete-session', (_e, projectId: string, sessionId: string) => {
    const file = sessionFile(projectId, sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  ipcMain.handle('clear-session-chat', (_e, projectId: string, sessionId: string) => {
    const file = sessionFile(projectId, sessionId);
    if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf-8');
  });

  // Streaming chat send (uses ipcMain.on so we can push events back)
  ipcMain.on('chat:send', (event, { requestId, sessionId, message, cwd }: {
    requestId: string;
    sessionId: string | null;
    message: string;
    cwd: string;
  }) => {
    const claudeBin = findClaudeBin();
    const args = ['-p', message, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn(claudeBin, args, {
      cwd: (cwd && fs.existsSync(cwd)) ? cwd : os.homedir(),
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });

    chatProcs.set(requestId, proc);

    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          event.sender.send('chat:event', { requestId, ev: JSON.parse(t) });
        } catch {
          event.sender.send('chat:event', { requestId, ev: { type: 'text_chunk', text: t } });
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      event.sender.send('chat:event', { requestId, ev: { type: 'stderr', text: chunk.toString() } });
    });

    proc.on('close', (code) => {
      if (buf.trim()) {
        try { event.sender.send('chat:event', { requestId, ev: JSON.parse(buf.trim()) }); } catch { }
      }
      chatProcs.delete(requestId);
      event.sender.send('chat:done', { requestId, code });
    });
  });

  ipcMain.on('chat:cancel', (_e, requestId: string) => {
    chatProcs.get(requestId)?.kill();
    chatProcs.delete(requestId);
  });

  ipcMain.handle('get-app-version', () => {
    const { app } = require('electron');
    return (app as Electron.App).getVersion();
  });

  ipcMain.handle('copy-to-clipboard', (_e, text: string) => {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
  });

  ipcMain.handle('check-cli', () => fs.existsSync('/usr/local/bin/claudia'));

  ipcMain.handle('install-cli', () => {
    const target = '/usr/local/bin/claudia';
    const script = `#!/bin/sh\nDIR=$(cd "\${1:-.}" && pwd)\nopen "claudia://chat?cwd=$DIR"\n`;

    // Try direct write first (works if /usr/local/bin is user-writable, e.g. Homebrew setup)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, script, { encoding: 'utf-8', mode: 0o755 });
      return;
    } catch { /* need elevated privileges */ }

    // Fall back to osascript admin dialog
    const tmp = path.join(os.tmpdir(), `claudia-cli-${Date.now()}.sh`);
    fs.writeFileSync(tmp, script, { encoding: 'utf-8', mode: 0o755 });
    try {
      execSync(
        `osascript -e 'do shell script "mkdir -p /usr/local/bin && cp \\"${tmp}\\" \\"${target}\\" && chmod 755 \\"${target}\\"" with administrator privileges'`
      );
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });

  // Legacy resume-in-terminal (kept for reference)
  ipcMain.handle('resume-session', async (_e, sessionId: string, cwd: string) => {
    const workDir = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
    const cmd = `cd "${workDir}" && claude --resume ${sessionId}`;
    const script = `tell application "Terminal"\n  activate\n  do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    const tmpFile = path.join(os.tmpdir(), `cr-${Date.now()}.scpt`);
    fs.writeFileSync(tmpFile, script, 'utf-8');
    return new Promise<boolean>((resolve) => {
      exec(`osascript "${tmpFile}"`, (err) => { fs.unlink(tmpFile, () => {}); resolve(!err); });
    });
  });
}
