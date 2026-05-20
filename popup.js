const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';

const apiKeyInput = document.getElementById('apiKey');
const endpointInput = document.getElementById('endpoint');
const modelInput = document.getElementById('model');
const saveButton = document.getElementById('save');
const statusEl = document.getElementById('status');

init();

async function init() {
  const settings = await chrome.storage.sync.get({
    apiKey: '',
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL
  });

  apiKeyInput.value = settings.apiKey || '';
  endpointInput.value = settings.endpoint || DEFAULT_ENDPOINT;
  modelInput.value = settings.model || DEFAULT_MODEL;
}

saveButton.addEventListener('click', async () => {
  await chrome.storage.sync.set({
    apiKey: apiKeyInput.value.trim(),
    endpoint: endpointInput.value.trim() || DEFAULT_ENDPOINT,
    model: modelInput.value.trim() || DEFAULT_MODEL
  });

  statusEl.textContent = '已保存。回到网页刷新后即可使用。';
  setTimeout(() => {
    statusEl.textContent = '';
  }, 2500);
});
