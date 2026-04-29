import { contextBridge, ipcRenderer } from 'electron';

type ChatEventCb = (data: { requestId: string; ev: unknown }) => void;
type ChatDoneCb = (data: { requestId: string; code: number | null }) => void;

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  getProjects: (): Promise<unknown> => ipcRenderer.invoke('get-projects'),
  getChatMessages: (projectId: string, sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('get-chat-messages', projectId, sessionId),
  sendChatMessage: (args: {
    requestId: string;
    sessionId: string | null;
    message: string;
    cwd: string;
    yolo?: boolean;
  }): void => ipcRenderer.send('chat:send', args),
  cancelChatMessage: (requestId: string): void => ipcRenderer.send('chat:cancel', requestId),
  onChatEvent: (cb: ChatEventCb): void => {
    ipcRenderer.on('chat:event', (_e, data) => cb(data as { requestId: string; ev: unknown }));
  },
  onChatDone: (cb: ChatDoneCb): void => {
    ipcRenderer.on('chat:done', (_e, data) => cb(data as { requestId: string; code: number | null }));
  },
  removeAllChatListeners: (): void => {
    ipcRenderer.removeAllListeners('chat:event');
    ipcRenderer.removeAllListeners('chat:done');
  },
  deleteSession: (projectId: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke('delete-session', projectId, sessionId),
  clearSessionChat: (projectId: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke('clear-session-chat', projectId, sessionId),
  copyToClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke('copy-to-clipboard', text),
  checkCLI: (): Promise<boolean> =>
    ipcRenderer.invoke('check-cli'),
  installCLI: (): Promise<void> =>
    ipcRenderer.invoke('install-cli'),
  onOpenNewChat: (cb: (cwd: string) => void): void => {
    ipcRenderer.on('open-new-chat', (_e, cwd) => cb(cwd as string));
  },
  platform: process.platform,
});
