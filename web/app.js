const providerSelect = document.querySelector('#providerSelect');
const modelInput = document.querySelector('#modelInput');
const conversation = document.querySelector('#conversation');
const messagesEl = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const promptInput = document.querySelector('#promptInput');
const sendButton = document.querySelector('#sendButton');
const temperatureInput = document.querySelector('#temperatureInput');
const systemPrompt = document.querySelector('#systemPrompt');
const state = { config: null, messages: [], busy: false, chats: [], activeChat: null };
const storageKey = 'genai-workbench-chats-v1';

const defaultModels = { openai: 'gpt-5-nano', groq: 'openai/gpt-oss-20b', google: 'gemini-4-hydrogen', huggingface: 'openai/gpt-oss-120b' };

async function initialize() {
  try {
    const response = await fetch('/api/config');
    state.config = await response.json();
    providerSelect.innerHTML = '';
    for (const [id, provider] of Object.entries(state.config.providers)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = provider.name + (provider.configured ? '' : ' · add key to .env');
      option.disabled = !provider.configured;
      providerSelect.append(option);
    }
    providerSelect.value = state.config.default_provider;
    updateModel();
  } catch (error) {
    showToast('Could not load the app settings. Refresh the page to retry.');
  }
  try { state.chats = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { state.chats = []; }
  renderHistory();
  bindEvents();
}

function updateModel() {
  const provider = providerSelect.value;
  const info = state.config?.providers?.[provider];
  modelInput.value = info?.model || defaultModels[provider] || '';
  document.querySelector('#activeModelName').textContent = `${info?.name || provider} · ${modelInput.value}`;
  document.querySelector('#providerNote').textContent = info?.configured
    ? `API key detected for ${info.name}. Access, credits, and model availability are checked when you send a message.`
    : `No ${info?.name || provider} key found. Add one to .env and restart the app.`;
  updateTemperatureControl();
}

function updateTemperatureControl() {
  const usesDefaultTemperature = providerSelect.value === 'openai' && modelInput.value.trim().toLowerCase().startsWith('gpt-5');
  temperatureInput.disabled = usesDefaultTemperature;
  document.querySelector('#temperatureValue').textContent = usesDefaultTemperature ? 'Default' : temperatureInput.value;
  document.querySelector('#temperatureNote').textContent = usesDefaultTemperature
    ? 'GPT-5 models use their built-in temperature setting.'
    : 'Adjust how focused or varied the response should be.';
}

function bindEvents() {
  providerSelect.addEventListener('change', updateModel);
  modelInput.addEventListener('input', () => {
    const name = state.config?.providers?.[providerSelect.value]?.name || providerSelect.value;
    document.querySelector('#activeModelName').textContent = `${name} · ${modelInput.value}`;
    updateTemperatureControl();
  });
  temperatureInput.addEventListener('input', () => { document.querySelector('#temperatureValue').textContent = temperatureInput.value; });
  sendButton.addEventListener('click', () => sendMessage());
  promptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
  });
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 155)}px`;
  });
  document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => {
    promptInput.value = button.dataset.prompt;
    promptInput.focus();
    promptInput.dispatchEvent(new Event('input'));
  }));
  document.querySelector('#newChat').addEventListener('click', startNewChat);
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); startNewChat(); }
    if (event.key === 'Escape') { closeSettings(); setSidebar(false); }
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

function saveActiveChat() {
  const firstUser = state.messages.find(message => message.role === 'user')?.content || 'New conversation';
  const record = { id: state.activeChat || (crypto.randomUUID?.() || String(Date.now())), title: firstUser.slice(0, 48), messages: state.messages, updated: Date.now() };
  state.activeChat = record.id;
  state.chats = [record, ...state.chats.filter(chat => chat.id !== record.id)].slice(0, 30);
  try { localStorage.setItem(storageKey, JSON.stringify(state.chats)); } catch { /* Storage is optional. */ }
  renderHistory();
}

function renderHistory() {
  const list = document.querySelector('#historyList');
  if (!state.chats.length) { list.innerHTML = '<div class="history-empty">Your conversations will appear here.</div>'; return; }
  list.innerHTML = '';
  for (const chat of state.chats.slice(0, 12)) {
    const button = document.createElement('button');
    button.className = 'history-item';
    button.textContent = chat.title;
    button.title = chat.title;
    button.addEventListener('click', () => loadChat(chat.id));
    list.append(button);
  }
}

function loadChat(id) {
  const chat = state.chats.find(item => item.id === id);
  if (!chat) return;
  state.activeChat = id;
  state.messages = [...chat.messages];
  messagesEl.innerHTML = '';
  welcome.hidden = true;
  state.messages.forEach(renderMessage);
  scrollToBottom();
  setSidebar(false);
}

function addMessage(role, content) {
  const item = { role, content };
  state.messages.push(item);
  renderMessage(item);
  return item;
}

function renderMessage(message) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${message.role}`;
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = message.role === 'user' ? 'Y' : '✳';
  const body = document.createElement('div');
  body.className = 'message-body';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = message.role === 'user' ? 'You' : (state.config?.providers?.[providerSelect.value]?.name || 'Assistant');
  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = message.content;
  body.append(meta, content);
  wrapper.append(avatar, body);
  messagesEl.append(wrapper);
}

function renderTyping() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant typing';
  wrapper.id = 'typingMessage';
  wrapper.innerHTML = '<div class="message-avatar">✳</div><div class="message-body"><div class="message-meta">Thinking</div><div class="message-content">Working on a response <span class="typing-dots"><span></span><span></span><span></span></span></div></div>';
  messagesEl.append(wrapper);
  scrollToBottom();
}

async function sendMessage() {
  const content = promptInput.value.trim();
  if (!content || state.busy) return;
  if (!state.config?.providers?.[providerSelect.value]?.configured) {
    showToast('Add an API key for this provider to .env, then restart the app.');
    openSettings();
    return;
  }
  welcome.hidden = true;
  state.busy = true;
  sendButton.disabled = true;
  addMessage('user', content);
  promptInput.value = '';
  promptInput.style.height = 'auto';
  renderTyping();
  scrollToBottom();
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerSelect.value, model: modelInput.value, messages: state.messages, system_prompt: systemPrompt.value, temperature: Number(temperatureInput.value) })
    });
    const data = await response.json();
    document.querySelector('#typingMessage')?.remove();
    if (!response.ok) throw new Error(data.error || 'The request did not complete.');
    addMessage('assistant', data.reply);
    saveActiveChat();
  } catch (error) {
    document.querySelector('#typingMessage')?.remove();
    const errorMessage = error.message || 'Unable to reach the model provider.';
    addMessage('assistant', `I couldn't generate a response: ${errorMessage}`);
    showToast(errorMessage);
  } finally {
    state.busy = false;
    sendButton.disabled = false;
    promptInput.focus();
    scrollToBottom();
  }
}

function scrollToBottom() { conversation.scrollTop = conversation.scrollHeight; }
let toastTimer;
function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

initialize();
