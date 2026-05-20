(() => {
  if (window.__VOICE_WEB_GUIDE_LOADED__) {
    return;
  }
  window.__VOICE_WEB_GUIDE_LOADED__ = true;

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const MAX_ELEMENTS = 260;
  const MAX_HEADINGS = 60;
  const MAX_TEXT_LENGTH = 180;
  const MAX_SELECTION_TEXT_LENGTH = 1200;
  const DRAG_THRESHOLD_PX = 8;
  const ZH_TTS_RATE = 2;
  const EN_TTS_RATE = 1.25;
  const HIGHLIGHT_AUTO_CLEAR_MS = 12000;
  const HIGHLIGHT_SCROLL_DELAY_MS = 450;
  const SENSITIVE_RE = /password|passwd|pwd|secret|token|api[-_\s]?key|apikey|access[-_\s]?key|credential|card|cvv|ssn/i;

  let root;
  let statusEl;
  let answerEl;
  let startStopButton;
  let interruptButton;
  let recognition = null;
  let isSessionActive = false;
  let isListening = false;
  let isProcessing = false;
  let isSpeaking = false;
  let ignoreNextEnd = false;
  let currentTranscript = '';
  let currentSpeechResolve = null;
  let sessionStartedAt = 0;
  let restartTimer = null;
  let sessionId = createSessionId();
  let dragState = null;
  let cachedTtsVoices = {};
  let elementMap = new Map();
  let highlightNodes = [];
  let highlightClearTimer = null;
  let recentTurns = [];
  let lastMouse = {
    x: null,
    y: null,
    time: 0,
    elementSnapshot: null
  };

  init();

  function init() {
    createUi();
    attachMouseTracking();
    attachHighlightDismissal();
    attachRuntimeMessages();
    setStatus('准备就绪');
  }

  function attachRuntimeMessages() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'VOICE_WEB_GUIDE_FORCE_STOP') {
        stopSession({
          notifyBackground: false,
          statusText: '已在其他页面启动'
        });
        sendResponse({ ok: true });
      }
      return false;
    });
  }

  function createUi() {
    root = document.createElement('div');
    root.className = 'vwg-root';
    restoreRootPosition();

    const card = document.createElement('div');
    card.className = 'vwg-card';

    statusEl = document.createElement('p');
    statusEl.className = 'vwg-status';

    answerEl = document.createElement('p');
    answerEl.className = 'vwg-answer';
    answerEl.textContent = '点击开始后，可以自然提问当前网页相关问题。';

    const controls = document.createElement('div');
    controls.className = 'vwg-controls';

    startStopButton = document.createElement('button');
    startStopButton.type = 'button';
    startStopButton.className = 'vwg-button';
    startStopButton.textContent = '开始语音指导';

    interruptButton = document.createElement('button');
    interruptButton.type = 'button';
    interruptButton.className = 'vwg-button vwg-interrupt';
    interruptButton.textContent = '打断';
    interruptButton.hidden = true;

    controls.append(startStopButton, interruptButton);
    card.append(statusEl, answerEl);
    card.hidden = true;
    root.sessionCard = card;
    root.append(card, controls);
    document.documentElement.append(root);
    attachDrag();

    window.addEventListener('pagehide', releaseSessionLock);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' && isSessionActive) {
        stopListening();
      }
    });
  }

  function attachDrag() {
    root.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }

      const rect = root.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        pressTarget: event.target,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        moved: false
      };
      root.classList.add('vwg-dragging');
      root.setPointerCapture(event.pointerId);
    });

    root.addEventListener('pointermove', (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const movedX = event.clientX - dragState.startX;
      const movedY = event.clientY - dragState.startY;
      if (!dragState.moved && Math.sqrt(movedX * movedX + movedY * movedY) < DRAG_THRESHOLD_PX) {
        return;
      }

      dragState.moved = true;
      moveRootTo(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
    });

    root.addEventListener('pointerup', (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      root.releasePointerCapture(event.pointerId);
      root.classList.remove('vwg-dragging');

      const movedX = event.clientX - dragState.startX;
      const movedY = event.clientY - dragState.startY;
      const totalDistance = Math.sqrt(movedX * movedX + movedY * movedY);
      const wasDrag = dragState.moved && totalDistance >= DRAG_THRESHOLD_PX;
      const pressTarget = dragState.pressTarget;

      dragState = null;

      if (wasDrag) {
        saveRootPosition();
        return;
      }

      activateControlFromPressTarget(pressTarget);
    });

    root.addEventListener('pointercancel', () => {
      dragState = null;
      root.classList.remove('vwg-dragging');
    });
  }

  function activateControlFromPressTarget(pressTarget) {
    const button = pressTarget && pressTarget.closest
      ? pressTarget.closest('.vwg-button')
      : null;

    if (!button || !root.contains(button)) {
      return;
    }

    if (button === startStopButton) {
      toggleSession();
      return;
    }

    if (button === interruptButton && !interruptButton.hidden) {
      interruptSpeech();
    }
  }

  function revealSessionCard() {
    if (root && root.sessionCard) {
      root.sessionCard.hidden = false;
    }
  }

  function moveRootTo(left, top) {
    const rect = root.getBoundingClientRect();
    const clampedLeft = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - rect.width - 8));
    const clampedTop = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - rect.height - 8));

    root.style.left = `${Math.round(clampedLeft)}px`;
    root.style.top = `${Math.round(clampedTop)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.alignItems = clampedLeft > window.innerWidth / 2 ? 'flex-end' : 'flex-start';
  }

  function saveRootPosition() {
    const rect = root.getBoundingClientRect();
    chrome.storage.local.set({
      voiceWebGuidePosition: {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }
    });
  }

  async function restoreRootPosition() {
    try {
      const data = await chrome.storage.local.get({ voiceWebGuidePosition: null });
      const position = data.voiceWebGuidePosition;
      if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
        window.requestAnimationFrame(() => moveRootTo(position.left, position.top));
      }
    } catch (_error) {
      // Position persistence is a convenience; ignore storage failures.
    }
  }

  function attachMouseTracking() {
    document.addEventListener(
      'mousemove',
      (event) => {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        lastMouse = {
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          time: Date.now(),
          elementSnapshot: target ? describeElement(target, null, { includeNearbyText: true }) : null
        };
      },
      { passive: true }
    );
  }

  function attachHighlightDismissal() {
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (isExtensionUi(event.target)) {
          return;
        }
        clearHighlights();
      },
      true
    );

    window.addEventListener('scroll', clearHighlights, { passive: true });
  }

  function toggleSession() {
    if (isSessionActive) {
      stopSession();
      return;
    }
    startSession();
  }

  async function startSession() {
    if (!SpeechRecognitionCtor) {
      revealSessionCard();
      showAnswer('当前浏览器不支持 SpeechRecognition。请换 Chrome/Edge，或先实现文本输入版。');
      speak('当前浏览器不支持语音识别。');
      return;
    }

    if (document.visibilityState !== 'visible') {
      revealSessionCard();
      showAnswer('请在当前可见页面启动语音指导。');
      return;
    }

    const lock = await acquireSessionLock();
    if (!lock.ok) {
      revealSessionCard();
      showAnswer(lock.reason || '已有另一个页面正在语音指导。');
      speak(lock.reason || '已有另一个页面正在语音指导，请先结束那个页面。');
      return;
    }

    isSessionActive = true;
    sessionStartedAt = Date.now();
    currentTranscript = '';
    interruptSpeech();
    revealSessionCard();
    startStopButton.textContent = '结束';
    startStopButton.classList.add('vwg-stop');
    answerEl.textContent = '我在听。你可以问当前网页相关问题。';
    setupRecognition();
    startListening();
  }

  function stopSession(options = {}) {
    const notifyBackground = options.notifyBackground !== false;
    isSessionActive = false;
    isProcessing = false;
    currentTranscript = '';
    ignoreNextEnd = true;
    startStopButton.textContent = '开始语音指导';
    startStopButton.classList.remove('vwg-stop');
    interruptButton.hidden = true;
    setStatus(options.statusText || '已结束');
    answerEl.textContent = '';
    root.sessionCard.hidden = true;
    interruptSpeech();
    stopListening();
    clearHighlights();
    if (notifyBackground) {
      releaseSessionLock();
    }
  }

  function setupRecognition() {
    if (recognition) {
      return;
    }

    recognition = new SpeechRecognitionCtor();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      isListening = true;
      setStatus('正在听...');
    };

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const part = event.results[i][0] ? event.results[i][0].transcript : '';
        if (event.results[i].isFinal) {
          finalText += part;
        } else {
          interimText += part;
        }
      }

      if (interimText.trim()) {
        setStatus(`听到：${interimText.trim().slice(0, 24)}`);
      }

      if (finalText.trim()) {
        const cleanFinalText = finalText.trim();
        if (shouldIgnoreStartupNoise(cleanFinalText)) {
          setStatus('正在听...');
          return;
        }
        currentTranscript = `${currentTranscript} ${cleanFinalText}`.trim();
        processTranscriptSoon();
      }
    };

    recognition.onerror = (event) => {
      if (!isSessionActive) {
        return;
      }

      if (['aborted', 'no-speech'].includes(event.error)) {
        setStatus('继续等待提问');
        return;
      }

      const message = event.error === 'not-allowed'
        ? '麦克风权限被拒绝。请允许当前浏览器使用麦克风。'
        : event.error === 'audio-capture'
          ? '没有检测到可用麦克风，或麦克风正被其他页面占用。'
        : `语音识别出错：${event.error}`;
      showAnswer(message);
      setStatus('语音异常');
    };

    recognition.onend = () => {
      isListening = false;
      if (ignoreNextEnd) {
        ignoreNextEnd = false;
        return;
      }
      if (isSessionActive && !isProcessing) {
        window.setTimeout(startListening, 350);
      }
    };
  }

  function startListening() {
    if (!recognition || isListening || isProcessing || isSpeaking || !isSessionActive || document.visibilityState !== 'visible') {
      return;
    }
    window.clearTimeout(restartTimer);
    try {
      recognition.start();
    } catch (_error) {
      restartTimer = window.setTimeout(() => {
        if (isSessionActive && !isListening && !isProcessing && !isSpeaking && document.visibilityState === 'visible') {
          try {
            recognition.start();
          } catch (_innerError) {
            setStatus('等待语音服务可用');
          }
        }
      }, 600);
    }
  }

  function stopListening() {
    window.clearTimeout(restartTimer);
    if (!recognition) {
      return;
    }
    try {
      recognition.stop();
    } catch (_error) {
      // Ignore stop races from the browser speech engine.
    }
  }

  function processTranscriptSoon() {
    if (isProcessing || !currentTranscript.trim()) {
      return;
    }

    window.setTimeout(() => {
      if (!isProcessing && currentTranscript.trim()) {
        askModel(currentTranscript.trim());
        currentTranscript = '';
      }
    }, 250);
  }

  function shouldIgnoreStartupNoise(text) {
    if (Date.now() - sessionStartedAt > 1800) {
      return false;
    }

    return /^(你好|您好|喂|hello|hi|hey)[。.!！\s]*$/i.test(cleanText(text));
  }

  async function askModel(question) {
    if (!isSessionActive) {
      return;
    }

    isProcessing = true;
    setStatus('正在理解页面...');
    stopListening();
    clearHighlights();

    const pageSnapshot = buildPageSnapshot();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VOICE_WEB_GUIDE_ASK',
        payload: {
          question,
          pageSnapshot,
          recentTurns: recentTurns.slice(-4)
        }
      });

      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : '请求失败。');
      }

      const result = response.result;
      recentTurns.push({
        question,
        answer: result.answer,
        targetElementIds: result.targetElementIds || []
      });
      recentTurns = recentTurns.slice(-8);

      const answer = buildSpokenAnswer(result);
      showAnswer(answer);
      highlightElements(result.targetElementIds || [], result.nextStep || result.answer);
      await speak(answer);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      showAnswer(message);
      await speak(message);
    } finally {
      isProcessing = false;
      if (isSessionActive) {
        if (currentTranscript.trim()) {
          window.setTimeout(processTranscriptSoon, 250);
        } else {
          window.setTimeout(startListening, 500);
        }
      }
    }
  }

  function buildSpokenAnswer(result) {
    const outputLang = detectTextLanguage(`${result.answer || ''} ${result.nextStep || ''}`);
    const caution = result.riskLevel === 'dangerous'
      ? outputLang === 'en'
        ? 'Careful: this may be a high-risk action.'
        : '注意：这是高风险操作，请确认后再继续。'
      : result.riskLevel === 'caution'
        ? outputLang === 'en'
          ? 'Heads up: please check this step carefully.'
          : '提醒：这一步要谨慎确认。'
        : '';
    const answer = cleanText(result.answer || '');
    const next = shouldSpeakNextStep(result)
      ? outputLang === 'en'
        ? `Suggestion: ${cleanText(result.nextStep)}`
        : `建议：${cleanText(result.nextStep)}`
      : '';
    return [caution, answer, next].filter(Boolean).join('\n');
  }

  function shouldSpeakNextStep(result) {
    if (!result || !result.nextStep || !String(result.nextStep).trim()) {
      return false;
    }

    const answer = String(result.answer || '');
    const next = String(result.nextStep || '').trim();
    if (!next || answer.includes(next)) {
      return false;
    }

    return true;
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || !text) {
        resolve();
        return;
      }

      window.speechSynthesis.cancel();
      currentSpeechResolve = resolve;
      isSpeaking = true;
      interruptButton.hidden = false;
      setStatus('正在回答...');

      const speechLang = detectTextLanguage(text);
      const utterance = new SpeechSynthesisUtterance(toSpeakableText(text, speechLang));
      utterance.lang = speechLang === 'en' ? 'en-US' : 'zh-CN';
      utterance.voice = pickTtsVoice(speechLang);
      utterance.rate = speechLang === 'en' ? EN_TTS_RATE : ZH_TTS_RATE;
      utterance.pitch = 1.04;
      utterance.onend = finishSpeech;
      utterance.onerror = finishSpeech;
      window.speechSynthesis.speak(utterance);
    });
  }

  function pickTtsVoice(lang) {
    const cacheKey = lang === 'en' ? 'en' : 'zh';
    if (cachedTtsVoices[cacheKey]) {
      return cachedTtsVoices[cacheKey];
    }

    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!voices.length) {
      return null;
    }

    const preferredChineseNamePatterns = [
      /xiaoxiao/i,
      /xiaoyi/i,
      /xiaobei/i,
      /yunxi/i,
      /yunyang/i,
      /natural/i,
      /neural/i,
      /google.*(mandarin|chinese|中文|普通话)/i,
      /microsoft.*(chinese|中文|普通话)/i
    ];

    const preferredEnglishNamePatterns = [
      /aria/i,
      /jenny/i,
      /guy/i,
      /natural/i,
      /neural/i,
      /google.*(us|uk|english)/i,
      /microsoft.*(english|aria|jenny|guy)/i
    ];

    cachedTtsVoices[cacheKey] = cacheKey === 'en'
      ? voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith('en') && preferredEnglishNamePatterns.some((pattern) => pattern.test(voice.name))) ||
        voices.find((voice) => voice.lang && voice.lang.toLowerCase() === 'en-us') ||
        voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith('en')) ||
        null
      : voices.find((voice) => voice.lang && voice.lang.toLowerCase() === 'zh-cn' && preferredChineseNamePatterns.some((pattern) => pattern.test(voice.name))) ||
        voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith('zh') && preferredChineseNamePatterns.some((pattern) => pattern.test(voice.name))) ||
        voices.find((voice) => voice.lang && voice.lang.toLowerCase() === 'zh-cn') ||
        voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith('zh')) ||
        null;

    return cachedTtsVoices[cacheKey];
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
      cachedTtsVoices = {};
      pickTtsVoice('zh');
      pickTtsVoice('en');
    };
  }

  function toSpeakableText(text, lang) {
    const lineBreak = lang === 'en' ? '. ' : '。';
    return String(text || '')
      .replace(/\n+/g, lineBreak)
      .replace(/\s+/g, ' ')
      .replace(/([。！？；])\s*/g, '$1 ')
      .replace(/([.!?;])\s*/g, '$1 ')
      .trim();
  }

  function detectTextLanguage(text) {
    const value = String(text || '');
    const chineseCount = (value.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishCount = (value.match(/[A-Za-z]/g) || []).length;
    if (chineseCount >= 2) {
      return 'zh';
    }
    return englishCount > 0 ? 'en' : 'zh';
  }

  function interruptSpeech() {
    if (!window.speechSynthesis) {
      return;
    }
    window.speechSynthesis.cancel();
    finishSpeech();
  }

  function finishSpeech() {
    if (!isSpeaking && !currentSpeechResolve) {
      return;
    }

    isSpeaking = false;
    interruptButton.hidden = true;
    const resolve = currentSpeechResolve;
    currentSpeechResolve = null;
    if (resolve) {
      resolve();
    }
  }

  function buildPageSnapshot() {
    elementMap = new Map();

    const interactiveElements = collectInteractiveElements();
    interactiveElements.forEach((entry) => {
      elementMap.set(entry.id, entry.element);
      delete entry.element;
    });

    return {
      title: document.title || '',
      url: sanitizeUrl(location.href),
      language: document.documentElement.lang || '',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY)
      },
      headings: getVisibleHeadings(),
      elements: interactiveElements,
      mouseContext: buildMouseContext(interactiveElements),
      selectionContext: buildSelectionContext(),
      visibleTextSample: getVisibleTextSample()
    };
  }

  function collectInteractiveElements() {
    const selector = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[contenteditable="true"]',
      'summary'
    ].join(',');

    const nodes = Array.from(document.querySelectorAll(selector))
      .filter((element) => isPageVisible(element) && !isExtensionUi(element))
      .sort(compareElementsByPagePosition)
      .slice(0, MAX_ELEMENTS);

    return nodes.map((element, index) => ({
      id: index + 1,
      element,
      ...describeElement(element, index + 1, { includeNearbyText: true })
    }));
  }

  function describeElement(element, id, options = {}) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type') || '';
    const label = getAssociatedLabel(element);
    const isSensitive = isSensitiveElement(element, label);
    const rect = element.getBoundingClientRect();

    return {
      id: id || undefined,
      tag,
      role: element.getAttribute('role') || '',
      type,
      text: cleanText(getElementText(element)).slice(0, MAX_TEXT_LENGTH),
      label: cleanText(label).slice(0, MAX_TEXT_LENGTH),
      ariaLabel: cleanText(element.getAttribute('aria-label') || '').slice(0, MAX_TEXT_LENGTH),
      placeholder: cleanText(element.getAttribute('placeholder') || '').slice(0, MAX_TEXT_LENGTH),
      title: cleanText(element.getAttribute('title') || '').slice(0, MAX_TEXT_LENGTH),
      required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
      disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      valueMasked: getMaskedValue(element, isSensitive),
      rect: rectToBucket(rect),
      pageY: Math.round(rect.top + window.scrollY),
      inViewport: isInViewport(element),
      nearbyText: options.includeNearbyText
        ? cleanText(getNearbyText(element)).slice(0, 260)
        : ''
    };
  }

  function buildMouseContext(elements) {
    const elementUnderMouse = lastMouse.elementSnapshot;
    const nearestElementIds = [];

    if (lastMouse.x !== null && lastMouse.y !== null) {
      const ranked = elements
        .map((entry) => ({
          id: entry.id,
          distance: distanceToRect(lastMouse.x, lastMouse.y, entry.rect)
        }))
        .filter((entry) => Number.isFinite(entry.distance))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);

      ranked.forEach((entry) => nearestElementIds.push(entry.id));
    }

    return {
      x: lastMouse.x,
      y: lastMouse.y,
      ageMs: lastMouse.time ? Date.now() - lastMouse.time : null,
      elementUnderMouse,
      nearestElementIds
    };
  }

  function getVisibleHeadings() {
    return Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .filter((element) => isPageVisible(element) && !isExtensionUi(element))
      .sort(compareElementsByPagePosition)
      .map((element) => cleanText(element.innerText || element.textContent || '').slice(0, 160))
      .filter(Boolean)
      .slice(0, MAX_HEADINGS);
  }

  function getVisibleTextSample() {
    const main = document.querySelector('main') || document.body;
    const text = cleanText(main ? main.innerText || '' : '');
    return text.slice(0, 1800);
  }

  function buildSelectionContext() {
    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0) {
      return {
        text: '',
        nearbyText: '',
        rect: null
      };
    }

    const text = cleanText(selection.toString());
    if (!text) {
      return {
        text: '',
        nearbyText: '',
        rect: null
      };
    }

    const range = selection.getRangeAt(0);
    const containerElement = getSelectionContainerElement(range);
    const rect = range.getBoundingClientRect();

    return {
      text: text.slice(0, MAX_SELECTION_TEXT_LENGTH),
      truncated: text.length > MAX_SELECTION_TEXT_LENGTH,
      nearbyText: cleanText(containerElement ? getNearbyText(containerElement) : '').slice(0, 500),
      rect: rectToBucket(rect)
    };
  }

  function getSelectionContainerElement(range) {
    const container = range.commonAncestorContainer;
    if (!container) {
      return null;
    }

    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!element || isExtensionUi(element)) {
      return null;
    }

    return element;
  }

  function isVisible(element) {
    return isPageVisible(element) && isInViewport(element);
  }

  function isPageVisible(element) {
    if (!element || isExtensionUi(element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      return false;
    }

    return true;
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth;
  }

  function isExtensionUi(element) {
    return Boolean(element && root && root.contains(element));
  }

  function getElementText(element) {
    if (!element) {
      return '';
    }

    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      return element.value && !isSensitiveElement(element, '') ? element.value : '';
    }

    if (tag === 'select') {
      const selected = element.selectedOptions && element.selectedOptions[0];
      return selected ? selected.textContent || '' : '';
    }

    return element.innerText || element.textContent || '';
  }

  function getAssociatedLabel(element) {
    if (!element) {
      return '';
    }

    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText || label.textContent || '') : [];
    if (labels.length) {
      return labels.join(' ');
    }

    const id = element.getAttribute('id');
    if (id) {
      const escaped = cssEscape(id);
      const label = document.querySelector(`label[for="${escaped}"]`);
      if (label) {
        return label.innerText || label.textContent || '';
      }
    }

    const ariaLabelledBy = element.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      return ariaLabelledBy
        .split(/\s+/)
        .map((labelId) => document.getElementById(labelId))
        .filter(Boolean)
        .map((labelElement) => labelElement.innerText || labelElement.textContent || '')
        .join(' ');
    }

    const parentLabel = element.closest('label');
    if (parentLabel) {
      return parentLabel.innerText || parentLabel.textContent || '';
    }

    return '';
  }

  function getNearbyText(element) {
    const chunks = [];
    let node = element;
    for (let depth = 0; depth < 2 && node && node.parentElement; depth += 1) {
      node = node.parentElement;
      const text = cleanText(node.innerText || node.textContent || '');
      if (text) {
        chunks.push(text.slice(0, 240));
      }
    }
    return chunks.join(' | ');
  }

  function isSensitiveElement(element, label) {
    const fields = [
      element.getAttribute('type') || '',
      element.getAttribute('name') || '',
      element.getAttribute('id') || '',
      element.getAttribute('autocomplete') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('placeholder') || '',
      label || ''
    ].join(' ');

    return SENSITIVE_RE.test(fields);
  }

  function getMaskedValue(element, isSensitive) {
    const tag = element.tagName.toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag)) {
      return '';
    }

    if (isSensitive) {
      return element.value ? '[REDACTED]' : '';
    }

    const value = tag === 'select'
      ? (element.selectedOptions && element.selectedOptions[0] ? element.selectedOptions[0].textContent || '' : '')
      : element.value || '';

    return cleanText(value).slice(0, 120);
  }

  function rectToBucket(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      inViewport: rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth
    };
  }

  function distanceToRect(x, y, rect) {
    if (!rect) {
      return Number.POSITIVE_INFINITY;
    }

    const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
    const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
    return Math.sqrt(dx * dx + dy * dy);
  }

  function compareElementsByPagePosition(a, b) {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const topA = rectA.top + window.scrollY;
    const topB = rectB.top + window.scrollY;
    if (Math.abs(topA - topB) > 8) {
      return topA - topB;
    }

    return rectA.left + window.scrollX - (rectB.left + window.scrollX);
  }

  function highlightElements(ids, labelText) {
    clearHighlights();
    const targetIds = ids.slice(0, 4);
    const visibleTargetIds = targetIds.filter((id) => {
      const element = elementMap.get(Number(id));
      return element && isPageVisible(element) && isInViewport(element);
    });

    if (visibleTargetIds.length) {
      drawHighlights(visibleTargetIds, labelText);
      return;
    }

    const firstTarget = targetIds
      .map((id) => elementMap.get(Number(id)))
      .find((element) => element && isPageVisible(element));

    if (firstTarget && !isInViewport(firstTarget)) {
      firstTarget.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'center'
      });
      window.setTimeout(() => drawHighlights(targetIds, labelText), HIGHLIGHT_SCROLL_DELAY_MS);
      return;
    }

    drawHighlights(targetIds, labelText);
  }

  function drawHighlights(ids, labelText) {
    clearHighlights();
    ids.forEach((id, index) => {
      const element = elementMap.get(Number(id));
      if (!element || !isPageVisible(element)) {
        return;
      }

      const rect = element.getBoundingClientRect();
      if (
        rect.bottom < 0 ||
        rect.right < 0 ||
        rect.top > window.innerHeight ||
        rect.left > window.innerWidth
      ) {
        return;
      }

      const box = document.createElement('div');
      box.className = 'vwg-highlight';
      box.style.left = `${Math.max(0, rect.left - 4)}px`;
      box.style.top = `${Math.max(0, rect.top - 4)}px`;
      box.style.width = `${rect.width + 8}px`;
      box.style.height = `${rect.height + 8}px`;

      document.documentElement.append(box);
      highlightNodes.push(box);

      if (index === 0 && labelText) {
        const label = document.createElement('div');
        label.className = 'vwg-highlight-label';
        label.textContent = String(labelText).slice(0, 80);
        label.style.left = `${Math.min(window.innerWidth - 280, Math.max(8, rect.left))}px`;
        label.style.top = `${Math.max(8, rect.top - 42)}px`;
        document.documentElement.append(label);
        highlightNodes.push(label);
      }
    });

    if (highlightNodes.length) {
      highlightClearTimer = window.setTimeout(clearHighlights, HIGHLIGHT_AUTO_CLEAR_MS);
    }
  }

  function clearHighlights() {
    window.clearTimeout(highlightClearTimer);
    highlightClearTimer = null;
    highlightNodes.forEach((node) => node.remove());
    highlightNodes = [];
  }

  function showAnswer(text) {
    answerEl.textContent = text;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  async function acquireSessionLock() {
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'VOICE_WEB_GUIDE_ACQUIRE_SESSION',
          sessionId
        }),
        new Promise((_, reject) => {
          window.setTimeout(() => reject(new Error('session lock timeout')), 4000);
        })
      ]);
      return response && response.ok ? response : { ok: false, reason: response && response.reason };
    } catch (_error) {
      return { ok: true };
    }
  }

  function releaseSessionLock() {
    try {
      chrome.runtime.sendMessage({
        type: 'VOICE_WEB_GUIDE_RELEASE_SESSION',
        sessionId
      });
    } catch (_error) {
      // The extension context may already be shutting down.
    }
  }

  function compactText(text, maxLength) {
    const cleaned = cleanText(text);
    if (cleaned.length <= maxLength) {
      return cleaned;
    }

    return `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  function createSessionId() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function sanitizeUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch (_error) {
      return '';
    }
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) {
      return window.CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
  }
})();
