const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
let activeVoiceSession = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === 'VOICE_WEB_GUIDE_ACQUIRE_SESSION') {
    acquireVoiceSession(message.sessionId, sender).then(sendResponse);
    return true;
  }

  if (message.type === 'VOICE_WEB_GUIDE_RELEASE_SESSION') {
    releaseVoiceSession(message.sessionId, sender);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== 'VOICE_WEB_GUIDE_ASK') {
    return false;
  }

  handleAsk(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    });

  return true;
});

async function acquireVoiceSession(sessionId, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;

  if (
    activeVoiceSession &&
    activeVoiceSession.sessionId !== sessionId &&
    (activeVoiceSession.tabId !== tabId || activeVoiceSession.frameId !== frameId)
  ) {
    await stopPreviousSession(activeVoiceSession);
  }

  activeVoiceSession = {
    sessionId,
    tabId,
    frameId,
    updatedAt: Date.now()
  };

  return { ok: true };
}

async function stopPreviousSession(session) {
  if (!session || typeof session.tabId !== 'number') {
    return;
  }

  try {
    await chrome.tabs.sendMessage(
      session.tabId,
      {
        type: 'VOICE_WEB_GUIDE_FORCE_STOP',
        sessionId: session.sessionId
      },
      { frameId: session.frameId }
    );
  } catch (_error) {
    // The previous page may have been closed, navigated, or be unable to receive messages.
  }
}

function releaseVoiceSession(sessionId, sender) {
  if (!activeVoiceSession) {
    return;
  }

  const tabId = sender && sender.tab ? sender.tab.id : null;
  const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
  const isSameSession = activeVoiceSession.sessionId === sessionId;
  const isSameFrame = activeVoiceSession.tabId === tabId && activeVoiceSession.frameId === frameId;

  if (isSameSession || isSameFrame) {
    activeVoiceSession = null;
  }
}

async function handleAsk(payload) {
  const settings = await chrome.storage.sync.get({
    apiKey: '',
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL
  });

  if (!settings.apiKey) {
    throw new Error('请先点击扩展图标，配置 DeepSeek API Key。');
  }

  const requestBody = buildRequestBody(payload, settings.model);
  const response = await fetch(settings.endpoint || DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`DeepSeek 请求失败：${response.status} ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';

  return normalizeModelResponse(content);
}

function buildRequestBody(payload, model) {
  return {
    model: model || DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          '你是一个网页语音指导助手。',
          '你只能指导用户自己操作网页，绝不能声称你已经替用户点击、填写、提交或删除。',
          '你会收到当前网页的压缩 DOM 快照、交互元素列表、鼠标上下文、用户选中文本上下文和用户语音转写问题。',
          '回答语言必须跟用户问题的主要语言一致：用户主要用中文问，就用中文回答；用户主要用英文问，就用英文回答。',
          '如果用户中英混合但包含明显中文表达，以中文为主回答。',
          '不要把产品名、按钮文案、字段名、API 术语、代码、URL、模型名、品牌名强行翻译成中文；这些词应保留原文，并可用中文简短解释。',
          '当 selectionContext.text 非空时，用户很可能在询问选中的文本，请优先围绕选中文本回答。',
          '请优先参考鼠标上下文回答“这个”“这里”“我指的这个”等问题。',
          'elements 包含全页面可见交互元素，不只包含当前视口内元素；每个元素可能有 inViewport 和 pageY。',
          '如果用户要找的信息或入口不在当前视口，也可以返回页面下方或上方的元素 id，前端会自动滚动到该元素。',
          '如果需要指出页面位置，请只返回 elements 中存在的 id。',
          '遇到删除、撤销、账单、付款、生产环境、密钥、token、secret、API key 等敏感操作时，riskLevel 设为 caution 或 dangerous，并提醒用户谨慎确认。',
          '回答必须很短：最多 2 句，中文尽量控制在 80 个字以内，英文尽量控制在 45 个词以内。',
          'nextStep 是可选字段。只有当用户明确问“怎么做、点哪里、下一步、如何完成任务”或确实需要继续引导时才填写。',
          '如果用户只是问含义、翻译、解释、报错原因、价格说明等，不要给下一步，nextStep 必须返回空字符串。',
          '如果要给操作建议，answer 里只说最关键解释；nextStep 里只放一个下一步动作。',
          '不要复述页面大段内容，不要列长清单。',
          '回答要像真人口语，避免书面化编号、括号、斜杠和过多术语；必要术语可保留原词并简短解释。',
          '必须返回 JSON 对象，字段为：answer、targetElementIds、riskLevel、nextStep。',
          'answer 用简洁自然的同语种表达，适合语音播报。targetElementIds 是数字数组。riskLevel 只能是 normal、caution、dangerous。nextStep 为空字符串或一句同语种的短建议。'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          question: payload.question,
          pageSnapshot: payload.pageSnapshot,
          recentTurns: payload.recentTurns || []
        })
      }
    ]
  };
}

function normalizeModelResponse(content) {
  if (!content) {
    return {
      answer: '我没有收到有效回答，请再问一次。',
      targetElementIds: [],
      riskLevel: 'normal',
      nextStep: ''
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_error) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (_innerError) {
        parsed = null;
      }
    }
  }

  if (!parsed) {
    return {
      answer: content,
      targetElementIds: [],
      riskLevel: 'normal',
      nextStep: ''
    };
  }

  const ids = Array.isArray(parsed.targetElementIds)
    ? parsed.targetElementIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : [];

  const risk = ['normal', 'caution', 'dangerous'].includes(parsed.riskLevel)
    ? parsed.riskLevel
    : 'normal';

  return {
    answer: String(parsed.answer || '我不太确定，请换一种说法再问一次。'),
    targetElementIds: ids,
    riskLevel: risk,
    nextStep: String(parsed.nextStep || '')
  };
}
