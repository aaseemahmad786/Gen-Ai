const providerSelect = document.querySelector('#providerSelect');
const modelPresetSelect = document.querySelector('#modelPresetSelect');
const modelInput = document.querySelector('#modelInput');
const conversation = document.querySelector('#conversation');
const messagesEl = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const promptInput = document.querySelector('#promptInput');
const sendButton = document.querySelector('#sendButton');
const temperatureInput = document.querySelector('#temperatureInput');
const systemPrompt = document.querySelector('#systemPrompt');
const activeModelName = document.querySelector('#activeModelName');
const providerNote = document.querySelector('#providerNote');
const temperatureValue = document.querySelector('#temperatureValue');
const temperatureNote = document.querySelector('#temperatureNote');

const state = {
  config: null,
  messages: [],
  busy: false,
  chats: [],
  activeChat: null,
  abortController: null,
};

const storageKey = 'genai-workbench-chats-v2';

// Simple and robust Markdown to HTML renderer
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function renderMarkdown(rawText) {
  if (!rawText) return '';
  
  // Protect code blocks first
  const codeBlocks = [];
  let text = rawText.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang.trim() || 'code', code: code.replace(/\n$/, '') });
    return `@@CODE_BLOCK_${idx}@@`;
  });

  // Protect inline code
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `@@INLINE_CODE_${idx}@@`;
  });

  // Escape remaining text
  text = escapeHtml(text);

  // Headers
  text = text.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  text = text.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  text = text.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // Bold & Italic
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.*?)~~/g, '<del>$1</del>');

  // Blockquotes
  text = text.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

  // Links
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Lists
  text = text.replace(/^[\*\-] (.*$)/gim, '<li>$1</li>');
  text = text.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  text = text.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');

  // Paragraphs / line breaks
  text = text.split(/\n\n+/).map(para => {
    para = para.trim();
    if (para.startsWith('<h') || para.startsWith('<ul') || para.startsWith('<ol') || para.startsWith('<blockquote') || para.startsWith('@@CODE_BLOCK_')) {
      return para;
    }
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  // Restore inline codes
  text = text.replace(/@@INLINE_CODE_(\d+)@@/g, (match, idx) => {
    return `<code class="inline-code">${escapeHtml(inlineCodes[Number(idx)])}</code>`;
  });

  // Restore code blocks
  text = text.replace(/@@CODE_BLOCK_(\d+)@@/g, (match, idx) => {
    const block = codeBlocks[Number(idx)];
    const escapedCode = escapeHtml(block.code);
    return `<div class="code-block">
      <div class="code-header">
        <span class="code-lang">${escapeHtml(block.lang)}</span>
        <button type="button" class="copy-code-btn" data-code="${encodeURIComponent(block.code)}">Copy</button>
      </div>
      <pre><code>${escapedCode}</code></pre>
    </div>`;
  });

  return text;
}

async function initialize() {
  try {
    const response = await fetch('/api/config');
    state.config = await response.json();
    populateProviders();
  } catch (error) {
    showToast('Could not load configuration. Refresh the page to retry.');
  }

  try {
    state.chats = JSON.parse(localStorage.getItem(storageKey) || '[]');
  } catch {
    state.chats = [];
  }

  renderHistory();
  bindEvents();
}

function populateProviders() {
  if (!state.config || !state.config.providers) return;
  providerSelect.innerHTML = '';

  for (const [id, provider] of Object.entries(state.config.providers)) {
    const option = document.createElement('option');
    option.value = id;
    let label = provider.name;
    if (provider.is_local) {
      label += ' · Local';
    } else if (!provider.configured) {
      label += ' · key needed';
    }
    option.textContent = label;
    option.disabled = !provider.configured && !provider.is_local;
    providerSelect.append(option);
  }

  const defaultKey = state.config.default_provider || Object.keys(state.config.providers)[0];
  if (defaultKey) {
    providerSelect.value = defaultKey;
  }
  updateProviderAndModels();
}

function updateProviderAndModels() {
  const providerKey = providerSelect.value;
  const info = state.config?.providers?.[providerKey];
  if (!info) return;

  // Populate presets
  modelPresetSelect.innerHTML = '';
  const models = info.models || [info.default_model || ''];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelPresetSelect.append(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Custom model ID…';
  modelPresetSelect.append(customOpt);

  // Set default model
  const defModel = info.default_model || models[0] || '';
  modelPresetSelect.value = defModel;
  modelInput.value = defModel;

  updateActiveLabel();

  // Update note
  if (info.is_local) {
    providerNote.textContent = 'Local provider. Ensure the local service is running.';
  } else if (info.configured) {
    providerNote.textContent = `API key detected for ${info.name}. Ready to chat.`;
  } else {
    providerNote.textContent = `No API key detected for ${info.name}. Add it to .env and restart.`;
  }

  updateTemperatureControl();
}

function updateActiveLabel() {
  const providerKey = providerSelect.value;
  const info = state.config?.providers?.[providerKey];
  const pName = info?.name || providerKey;
  const mName = modelInput.value.trim() || 'Default';
  activeModelName.textContent = `${pName} · ${mName}`;
}

function updateTemperatureControl() {
  const mName = modelInput.value.trim().toLowerCase();
  const isReasoning = mName.startsWith('o1') || mName.startsWith('o3') || mName.startsWith('gpt-5');
  temperatureInput.disabled = isReasoning;
  temperatureValue.textContent = isReasoning ? 'Fixed' : temperatureInput.value;
  temperatureNote.textContent = isReasoning
    ? 'Reasoning models manage their own temperature.'
    : 'Adjust how focused or varied responses will be.';
}

function bindEvents() {
  providerSelect.addEventListener('change', updateProviderAndModels);

  modelPresetSelect.addEventListener('change', () => {
    if (modelPresetSelect.value === '__custom__') {
      modelInput.focus();
      modelInput.select();
    } else {
      modelInput.value = modelPresetSelect.value;
      updateActiveLabel();
      updateTemperatureControl();
    }
  });

  modelInput.addEventListener('input', () => {
    const val = modelInput.value.trim();
    const hasMatch = Array.from(modelPresetSelect.options).some(o => o.value === val);
    modelPresetSelect.value = hasMatch ? val : '__custom__';
    updateActiveLabel();
    updateTemperatureControl();
  });

  temperatureInput.addEventListener('input', () => {
    temperatureValue.textContent = temperatureInput.value;
  });

  // Instruction presets
  document.querySelectorAll('#systemPresets .preset-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      document.querySelectorAll('#systemPresets .preset-tag').forEach(t => t.classList.remove('active'));
      tag.classList.add('active');
      systemPrompt.value = tag.dataset.preset || '';
      systemPrompt.focus();
    });
  });

  sendButton.addEventListener('click', () => {
    if (state.busy && state.abortController) {
      state.abortController.abort();
      return;
    }
    sendMessage();
  });

  promptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 155)}px`;
  });

  document.querySelectorAll('.suggestion').forEach(button => {
    button.addEventListener('click', () => {
      promptInput.value = button.dataset.prompt;
      promptInput.focus();
      promptInput.dispatchEvent(new Event('input'));
    });
  });

  // Global & header controls
  document.querySelector('#newChat').addEventListener('click', startNewChat);
  document.querySelector('#clearAllChats').addEventListener('click', clearAllChats);
  document.querySelector('#exportChat').addEventListener('click', exportConversation);
  document.querySelector('#openSettings').addEventListener('click', openSettings);
  document.querySelector('#focusModel').addEventListener('click', openSettings);
  document.querySelector('#activeModelName').parentElement.addEventListener('click', openSettings);
  document.querySelector('#closeSettings').addEventListener('click', closeSettings);
  document.querySelector('#doneSettings').addEventListener('click', closeSettings);
  document.querySelector('#systemPromptButton').addEventListener('click', openSettings);
  document.querySelector('#openSidebar').addEventListener('click', () => setSidebar(true));
  document.querySelector('#closeSidebar').addEventListener('click', () => setSidebar(false));
  document.querySelector('#sidebarScrim').addEventListener('click', () => setSidebar(false));

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      startNewChat();
    }
    if (event.key === 'Escape') {
      closeSettings();
      setSidebar(false);
    }
  });

  // Code copy delegation
  messagesEl.addEventListener('click', event => {
    const copyBtn = event.target.closest('.copy-code-btn');
    if (copyBtn) {
      const code = decodeURIComponent(copyBtn.dataset.code || '');
      navigator.clipboard.writeText(code).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = orig; }, 2000);
      });
      return;
    }

    const copyMsgBtn = event.target.closest('.copy-msg-btn');
    if (copyMsgBtn) {
      const idx = Number(copyMsgBtn.dataset.index);
      const msg = state.messages[idx];
      if (msg) {
        navigator.clipboard.writeText(msg.content).then(() => {
          showToast('Response copied to clipboard!');
        });
      }
      return;
    }

    const retryBtn = event.target.closest('.retry-msg-btn');
    if (retryBtn) {
      retryLastMessage();
    }
  });
}

function openSettings() { document.querySelector('#settingsPanel').classList.add('open'); }
function closeSettings() { document.querySelector('#settingsPanel').classList.remove('open'); }
function setSidebar(open) {
  document.querySelector('#sidebar').classList.toggle('open', open);
  document.querySelector('#sidebarScrim').classList.toggle('open', open);
}

function startNewChat() {
  if (state.messages.length) saveActiveChat();
  state.messages = [];
  state.activeChat = null;
  messagesEl.innerHTML = '';
  welcome.hidden = false;
  promptInput.value = '';
  promptInput.style.height = 'auto';
  setSidebar(false);
  promptInput.focus();
}

function clearAllChats() {
  if (!state.chats.length) return;
  if (confirm('Clear all conversation history?')) {
    state.chats = [];
    localStorage.removeItem(storageKey);
    renderHistory();
    startNewChat();
    showToast('Conversation history cleared.');
  }
}

function exportConversation() {
  if (!state.messages.length) {
    showToast('No messages to export.');
    return;
  }
  const title = state.messages.find(m => m.role === 'user')?.content.slice(0, 30) || 'conversation';
  let md = `# Conversation Export\n\n`;
  for (const m of state.messages) {
    const roleName = m.role === 'user' ? 'User' : 'Assistant';
    md += `### ${roleName}\n\n${m.content}\n\n---\n\n`;
  }
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Conversation exported!');
}

function saveActiveChat() {
  if (!state.messages.length) return;
  const firstUser = state.messages.find(m => m.role === 'user')?.content || 'New conversation';
  const record = {
    id: state.activeChat || (crypto.randomUUID?.() || String(Date.now())),
    title: firstUser.slice(0, 48),
    messages: state.messages,
    updated: Date.now(),
  };
  state.activeChat = record.id;
  state.chats = [record, ...state.chats.filter(chat => chat.id !== record.id)].slice(0, 40);
  try {
    localStorage.setItem(storageKey, JSON.stringify(state.chats));
  } catch {
    /* storage quota exceeded or disabled */
  }
  renderHistory();
}

function renderHistory() {
  const list = document.querySelector('#historyList');
  if (!state.chats.length) {
    list.innerHTML = '<div class="history-empty">Your conversations will appear here.</div>';
    return;
  }
  list.innerHTML = '';
  for (const chat of state.chats.slice(0, 20)) {
    const wrap = document.createElement('div');
    wrap.className = 'history-item-wrap';

    const button = document.createElement('button');
    button.className = 'history-item';
    button.textContent = chat.title;
    button.title = chat.title;
    button.addEventListener('click', () => loadChat(chat.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-chat-btn';
    delBtn.innerHTML = '&times;';
    delBtn.title = 'Delete chat';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });

    wrap.append(button, delBtn);
    list.append(wrap);
  }
}

function deleteChat(id) {
  state.chats = state.chats.filter(c => c.id !== id);
  try { localStorage.setItem(storageKey, JSON.stringify(state.chats)); } catch {}
  renderHistory();
  if (state.activeChat === id) {
    startNewChat();
  }
  showToast('Conversation deleted.');
}

function loadChat(id) {
  const chat = state.chats.find(item => item.id === id);
  if (!chat) return;
  state.activeChat = id;
  state.messages = [...chat.messages];
  messagesEl.innerHTML = '';
  welcome.hidden = true;
  state.messages.forEach((msg, idx) => renderMessage(msg, idx));
  scrollToBottom();
  setSidebar(false);
}

function addMessage(role, content) {
  const item = { role, content };
  state.messages.push(item);
  const el = renderMessage(item, state.messages.length - 1);
  return { item, el };
}

function renderMessage(message, index) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${message.role}`;
  wrapper.dataset.index = index;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = message.role === 'user' ? 'Y' : '✳';

  const body = document.createElement('div');
  body.className = 'message-body';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = message.role === 'user'
    ? 'You'
    : (state.config?.providers?.[providerSelect.value]?.name || 'Assistant');

  const content = document.createElement('div');
  content.className = 'message-content';

  if (message.role === 'user') {
    content.textContent = message.content;
  } else {
    content.innerHTML = renderMarkdown(message.content);
  }

  body.append(meta, content);

  if (message.role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.innerHTML = `
      <button type="button" class="action-btn copy-msg-btn" data-index="${index}" title="Copy response">⎘ Copy</button>
      <button type="button" class="action-btn retry-msg-btn" data-index="${index}" title="Retry response">↺ Retry</button>
    `;
    body.append(actions);
  }

  wrapper.append(avatar, body);
  messagesEl.append(wrapper);
  return wrapper;
}

function renderTyping() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant typing';
  wrapper.id = 'typingMessage';
  wrapper.innerHTML = `
    <div class="message-avatar">✳</div>
    <div class="message-body">
      <div class="message-meta">Thinking</div>
      <div class="message-content">Working on a response <span class="typing-dots"><span></span><span></span><span></span></span></div>
    </div>
  `;
  messagesEl.append(wrapper);
  scrollToBottom();
  return wrapper;
}

function setBusyState(busy) {
  state.busy = busy;
  if (busy) {
    sendButton.classList.add('stop-btn');
    sendButton.innerHTML = '<span>■</span>';
    sendButton.title = 'Stop generating';
    sendButton.disabled = false;
  } else {
    sendButton.classList.remove('stop-btn');
    sendButton.innerHTML = '<span>↑</span>';
    sendButton.title = 'Send message';
    sendButton.disabled = false;
    state.abortController = null;
  }
}

async function sendMessage() {
  const content = promptInput.value.trim();
  if (!content || state.busy) return;

  const provider = providerSelect.value;
  const provConfig = state.config?.providers?.[provider];
  if (!provConfig?.configured && !provConfig?.is_local) {
    showToast('Add an API key for this provider to .env, then restart the app.');
    openSettings();
    return;
  }

  welcome.hidden = true;
  setBusyState(true);
  state.abortController = new AbortController();

  addMessage('user', content);
  promptInput.value = '';
  promptInput.style.height = 'auto';

  const typingEl = renderTyping();
  scrollToBottom();

  const reqPayload = {
    provider,
    model: modelInput.value.trim(),
    messages: state.messages,
    system_prompt: systemPrompt.value,
    temperature: Number(temperatureInput.value),
  };

  let assistantItem = null;
  let assistantContentEl = null;

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqPayload),
      signal: state.abortController.signal,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${response.status}`);
    }

    typingEl.remove();

    // Prepare assistant message bubble
    const { item, el } = addMessage('assistant', '');
    assistantItem = item;
    assistantContentEl = el.querySelector('.message-content');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6).trim();
        try {
          const payload = JSON.parse(jsonStr);
          if (payload.chunk) {
            assistantItem.content += payload.chunk;
            assistantContentEl.innerHTML = renderMarkdown(assistantItem.content);
            scrollToBottom();
          } else if (payload.error) {
            throw new Error(payload.error);
          } else if (payload.done) {
            break;
          }
        } catch (e) {
          if (e.message && e.message !== 'Unexpected end of JSON input') {
            throw e;
          }
        }
      }
    }

    if (!assistantItem.content.trim()) {
      throw new Error('No content returned from model.');
    }
    saveActiveChat();
  } catch (error) {
    typingEl.remove();
    if (error.name === 'AbortError') {
      if (assistantItem && assistantContentEl) {
        assistantItem.content += ' *(Stopped by user)*';
        assistantContentEl.innerHTML = renderMarkdown(assistantItem.content);
        saveActiveChat();
      }
      showToast('Generation stopped.');
    } else {
      const errMsg = error.message || 'Unable to complete response.';
      if (assistantItem && assistantContentEl) {
        assistantItem.content += `\n\n**Error:** ${errMsg}`;
        assistantContentEl.innerHTML = renderMarkdown(assistantItem.content);
      } else {
        addMessage('assistant', `I couldn't generate a response: ${errMsg}`);
      }
      showToast(errMsg);
    }
  } finally {
    setBusyState(false);
    promptInput.focus();
    scrollToBottom();
  }
}

function retryLastMessage() {
  if (state.busy) return;
  // Find last user message
  const lastUserIndex = state.messages.map(m => m.role).lastIndexOf('user');
  if (lastUserIndex === -1) return;

  const lastUserMessage = state.messages[lastUserIndex].content;
  // Truncate messages up to last user message
  state.messages = state.messages.slice(0, lastUserIndex);
  messagesEl.innerHTML = '';
  state.messages.forEach((msg, idx) => renderMessage(msg, idx));

  promptInput.value = lastUserMessage;
  sendMessage();
}

function scrollToBottom() {
  conversation.scrollTop = conversation.scrollHeight;
}

let toastTimer;
function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

initialize();
