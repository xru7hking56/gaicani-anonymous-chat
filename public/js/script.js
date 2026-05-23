const socket = io();
window.socket = socket;

// ── Bot Detection + Challenge Token ──────────────────────────────────────────
// Runs silently on page load. Checks for Selenium/WebDriver/headless signals.
// If detected: token is never fetched → setName fails → bot disconnected.

let _challengeToken  = null;
let _challengePow    = null; // computed proof-of-work answer
let _isBotDetected   = false;

function _detectBot() {
  try {
    // #1 — navigator.webdriver is TRUE in ALL WebDriver sessions
    //      (Selenium, Playwright, Puppeteer default mode). This is spec-mandated.
    if (navigator.webdriver === true) return true;

    // #2 — No plugins: headless Chrome / most bots have zero plugins
    if (!navigator.plugins || navigator.plugins.length === 0) return true;

    // #3 — No language list: automation tools often skip this
    if (!navigator.languages || navigator.languages.length === 0) return true;

    // #4 — Real Chrome always has window.chrome; modified/headless builds don't
    if (/Chrome/.test(navigator.userAgent) && !window.chrome) return true;

    // #5 — Selenium leaves traces in window properties
    if ('__webdriver_evaluate'        in window) return true;
    if ('__selenium_evaluate'         in window) return true;
    if ('__webdriver_script_function' in window) return true;
    if ('__fxdriver_evaluate'         in window) return true;
    if ('_phantom'                    in window) return true;
    if ('callPhantom'                 in window) return true;
    if ('__nightmare'                 in window) return true;
    if ('domAutomation'               in window) return true;
    if ('domAutomationController'     in window) return true;

    return false;
  } catch {
    return true; // if the check itself throws, treat as bot
  }
}

_isBotDetected = _detectBot();

if (!_isBotDetected) {
  // Fetch challenge token and compute proof-of-work
  fetch("/api/challenge")
    .then(r => r.json())
    .then(d => {
      _challengeToken = d.token;
      // POW: same formula as server expects — (nonce * 31 + nonce % 97)
      _challengePow   = (d.nonce * 31 + d.nonce % 97);
    })
    .catch(() => {});
}

// ── State ─────────────────────────────────────────────────────────────────────
let userName            = "";
let userBio             = "";
let partnerConnected    = false;
let partnerName         = "";
let isFirstLogin        = true;
let isReconnecting      = false;

let msgCounter          = 0;
let typingTimeout       = null;
let isTyping            = false;
let searchRetryInterval = null;
let pendingScrollRaf    = false;
let gifFetchController  = null;
let gifSearchTimer      = null;
let gifPickerOpen       = false;
let unreadCount         = 0;
let replyTo             = null;   // { text, senderName, messageId }
let lastPartnerName     = "";     // remember partner name after disconnect for blocking
let canBlockDisconnected = false; // allow blocking a partner who just left
const originalTitle     = document.title;

// Tab-away feature intentionally disabled — nothing happens when partner hides tab

// ── DOM refs ──────────────────────────────────────────────────────────────────
const chat           = document.getElementById("chat");
const messageInput   = document.getElementById("messageInput");
const sendBtn        = document.getElementById("sendBtn");
const nextBtn        = document.getElementById("nextBtn");
const blockBtn       = document.getElementById("blockBtn");
const changeNameBtn  = document.getElementById("changeNameBtn");
const interestsBtn   = document.getElementById("interestsBtn");
const bioPopup       = document.getElementById("bioPopup");
const bioInput       = document.getElementById("bioInput");
const bioSaveBtn     = document.getElementById("bioSaveBtn");
const bioClearBtn    = document.getElementById("bioClearBtn");
const bioCharCount   = document.getElementById("bioCharCount");
const nameModal      = document.getElementById("nameModal");
const nameInput      = document.getElementById("nameInput");
const saveNameBtn    = document.getElementById("saveNameBtn");
const nameError      = document.getElementById("nameError");
const onlineCountEl  = document.getElementById("onlineCount");
const gifBtn         = document.getElementById("gifBtn");
const gifPicker      = document.getElementById("gifPicker");
const gifSearch      = document.getElementById("gifSearch");
const gifResults     = document.getElementById("gifResults");
const gifPickerClose = document.getElementById("gifPickerClose");
const charCount      = document.getElementById("charCount");
const questionBtn    = document.getElementById("questionBtn");
const replyPreview   = document.getElementById("replyPreview");
const replyPreviewName = document.getElementById("replyPreviewName");
const replyPreviewText = document.getElementById("replyPreviewText");
const replyPreviewClose = document.getElementById("replyPreviewClose");

// ── Sound ─────────────────────────────────────────────────────────────────────
let _audioCtx = null;

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

function ensureAudioReady() {
  if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
}

document.addEventListener("click",   ensureAudioReady, { passive: true });
document.addEventListener("keydown", ensureAudioReady, { passive: true });

function playTone(freq, duration = 0.2, volume = 0.07) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) { /* audio not supported */ }
}

function playNotification(type) {
  if (type === "partnerFound") {
    playTone(880, 0.12); setTimeout(() => playTone(1100, 0.18), 110);
  } else if (type === "message") {
    playTone(660, 0.1, 0.04);
  }
}

// ── Tab unread badge ──────────────────────────────────────────────────────────
function incrementUnread() {
  if (document.hidden) {
    unreadCount++;
    document.title = `(${unreadCount}) ${originalTitle}`;
  }
}

// ── Tab visibility — reset unread badge + reconnect on foreground ─────────────
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unreadCount    = 0;
    document.title = originalTitle;

    // If socket dropped while backgrounded, kick it to reconnect immediately
    if (!socket.connected && userName) {
      socket.connect();
    }
  }
});

// ── Scroll ────────────────────────────────────────────────────────────────────
function scheduleScroll() {
  if (pendingScrollRaf) return;
  pendingScrollRaf = true;
  requestAnimationFrame(() => {
    chat.scrollTop   = chat.scrollHeight;
    pendingScrollRaf = false;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateMsgId() {
  return `${socket.id}_${++msgCounter}_${Date.now()}`;
}

function formatTimestamp(date) {
  const h    = date.getHours();
  const m    = date.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12  = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function _appendInfoMessage(text, className, id) {
  const el       = document.createElement("div");
  el.className   = className;
  el.textContent = text;
  if (id) el.id  = id;
  chat.appendChild(el);
  scheduleScroll();
}

function addSystemMessage(text)            { _appendInfoMessage(text, "system-message"); }
function addDisconnectMessage(text)        { _appendInfoMessage(text, "system-message-disconnect"); }
function addReconnectingMessage(name)      {
  document.getElementById("reconnectingMsg")?.remove();
  _appendInfoMessage(
    `${name} - კავშირი გაწყდა, ველოდებით... ⏳`,
    "system-message-reconnecting",
    "reconnectingMsg"
  );
}
function removeReconnectingMessage()       { document.getElementById("reconnectingMsg")?.remove(); }

// ── Searching message with random fact ───────────────────────────────────────
function addSearchingMessage() {
  // Remove any existing searching block
  document.getElementById("searchingMsg")?.remove();
  // Ensure inputs are disabled while searching so user can't type into a non-existent chat
  setInputsEnabled(false);

  const wrapper     = document.createElement("div");
  wrapper.id        = "searchingMsg";
  wrapper.className = "searching-block";

  const searchText       = document.createElement("div");
  searchText.className   = "system-message";
  searchText.textContent = "ვეძებთ ახალ პარტნიორს... 🔎";
  wrapper.appendChild(searchText);

  // Fact card
  const factCard       = document.createElement("div");
  factCard.className   = "fact-card";

  const factLabel       = document.createElement("span");
  factLabel.className   = "fact-label";
  factLabel.textContent = "💡 Random Fact";

  const factText       = document.createElement("span");
  factText.className   = "fact-text";
  factText.textContent = "...";

  // Arrow button — bottom-right corner
  const nextFactBtn       = document.createElement("button");
  nextFactBtn.className   = "fact-next-btn";
  nextFactBtn.title       = "სხვა ფაქტი";
  nextFactBtn.textContent = "→";

  factCard.appendChild(factLabel);
  factCard.appendChild(factText);
  factCard.appendChild(nextFactBtn);
  wrapper.appendChild(factCard);

  const warningEl = document.createElement("div");
  warningEl.className = "searching-warning";
  warningEl.textContent = "⚠️ WARNING : გთხოვთ არ ჩაკეცოთ ბრაუზერი";
  wrapper.appendChild(warningEl);

  chat.appendChild(wrapper);
  scheduleScroll();

  function loadFact() {
    nextFactBtn.classList.add("spinning");
    fetch("/api/random-fact")
      .then(r => r.json())
      .then(data => {
        if (data.fact) {
          // Fade out → swap text → fade in
          factText.style.transition = "opacity 0.15s";
          factText.style.opacity    = "0";
          setTimeout(() => {
            factText.textContent      = data.fact;
            factText.style.opacity    = "1";
          }, 150);
        }
      })
      .catch(() => {
        factText.textContent = "ფაქტი ვერ ჩაიტვირთა 😕";
      })
      .finally(() => {
        nextFactBtn.classList.remove("spinning");
      });
  }

  // Load initial fact
  loadFact();

  // Arrow click → load next fact
  nextFactBtn.addEventListener("click", loadFact);
}

function addMessage(text, isYou, messageId, replyToData) {
  const id = messageId || generateMsgId();

  const wrapper         = document.createElement("div");
  wrapper.className     = `message-wrapper ${isYou ? "you" : "partner"}`;
  wrapper.dataset.messageId = id;

  // ── Reply quote block ────────────────────────────────────────────────────
  if (replyToData && replyToData.text) {
    const quote       = document.createElement("div");
    quote.className   = `reply-quote ${isYou ? "you" : "partner"}`;

    if (replyToData.senderName) {
      const quoteName       = document.createElement("span");
      quoteName.className   = "reply-quote-name";
      quoteName.textContent = replyToData.senderName;
      quote.appendChild(quoteName);
    }

    const quoteText       = document.createElement("span");
    quoteText.className   = "reply-quote-text";
    const raw = replyToData.text;
    quoteText.textContent = raw.length > 80 ? raw.slice(0, 80) + "…" : raw;

    quote.appendChild(quoteText);
    wrapper.appendChild(quote);
  }

  const msgRow      = document.createElement("div");
  msgRow.className  = "message-row";

  const content     = document.createElement("div");
  content.className = `message-content${isYou ? " you" : ""}`;
  content.textContent = text;

  const timestamp       = document.createElement("div");
  timestamp.className   = "timestamp inline-ts";
  timestamp.textContent = formatTimestamp(new Date());

  // ── Reply button ──────────────────────────────────────────────────────────
  const replyBtn     = document.createElement("button");
  replyBtn.className = "reply-btn";
  replyBtn.innerHTML = "↩";
  replyBtn.title     = "Reply";
  replyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setReplyTo({
      text,
      senderName: isYou ? userName : (partnerName || "Partner"),
      messageId: id,
    });
  });

  if (isYou) {
    // You: [reply-btn]  [timestamp]  [bubble]
    msgRow.appendChild(replyBtn);
    msgRow.appendChild(timestamp);
    msgRow.appendChild(content);
  } else {
    // Partner: [bubble]  [react-btn]  [reply-btn]  [timestamp]
    const reactBtn     = document.createElement("button");
    reactBtn.className = "react-btn";
    reactBtn.innerHTML = "🙂";
    reactBtn.title     = "React";
    reactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showReactionPicker(reactBtn, id);
    });
    msgRow.appendChild(content);
    msgRow.appendChild(reactBtn);
    msgRow.appendChild(replyBtn);
    msgRow.appendChild(timestamp);
  }

  const reactionArea    = document.createElement("div");
  reactionArea.className = "reaction-area";
  reactionArea.id       = `reactions_${id}`;

  wrapper.appendChild(msgRow);
  wrapper.appendChild(reactionArea);

  // Seen indicator — only for messages you sent
  if (isYou) {
    const seen       = document.createElement("div");
    seen.className   = "seen-status";
    seen.id          = `seen_${id}`;
    seen.textContent = "✓";
    wrapper.appendChild(seen);
  }

  chat.appendChild(wrapper);
  scheduleScroll();
  return id;
}

function addGifMessage(gifUrl, isYou) {
  const wrapper     = document.createElement("div");
  wrapper.className = `message-wrapper gif-msg-wrapper ${isYou ? "you" : "partner"}`;

  const img       = document.createElement("img");
  img.src         = gifUrl;
  img.className   = "gif-message-img";
  img.loading     = "lazy";
  img.decoding    = "async";

  const timestamp       = document.createElement("div");
  timestamp.className   = "timestamp";
  timestamp.textContent = formatTimestamp(new Date());

  wrapper.appendChild(img);
  wrapper.appendChild(timestamp);
  chat.appendChild(wrapper);
  scheduleScroll();
}

// ── Question card ─────────────────────────────────────────────────────────────
function addQuestionCard(questionText, isYou) {
  const card       = document.createElement("div");
  card.className   = `question-card ${isYou ? "you" : "partner"}`;

  const label      = document.createElement("div");
  label.className  = "question-card-label";
  label.textContent = isYou ? "❓ შენ გამოგზავნე კითხვა" : `❓ ${partnerName || "პარტნიორი"} გიგზავნის კითხვას`;

  const text       = document.createElement("div");
  text.className   = "question-card-text";
  text.textContent = questionText;

  const ts         = document.createElement("div");
  ts.className     = "timestamp";
  ts.textContent   = formatTimestamp(new Date());

  card.appendChild(label);
  card.appendChild(text);
  card.appendChild(ts);
  chat.appendChild(card);
  scheduleScroll();
}

// ── Typing indicator (fixed overlay — Instagram style) ────────────────────────
// The element lives in the HTML outside the chat scroll area so it never
// appears between messages. We just show/hide it and update its bottom offset.

function updateTypingIndicatorPosition() {
  const kbH = getKeyboardHeight();
  const bottom = kbH + chatInputBar.offsetHeight + 8;
  document.documentElement.style.setProperty("--typing-bottom", bottom + "px");
}

function showTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (!el) return;
  el.style.display = "flex";
  updateTypingIndicatorPosition();
  // Add indicator height on top of the existing input-bar padding so the
  // last message is never hidden behind the dots
  chat.style.paddingBottom = "calc(72px + env(safe-area-inset-bottom, 0px) + 56px)";
  scheduleScroll();
}

function hideTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) el.style.display = "none";
  // Restore normal padding
  chat.style.paddingBottom = "";
}

function clearChat() { chat.innerHTML = ""; clearReply(); }

// Stub — countdown was removed but the call site still references this
function clearPartnerAwayCountdown() {}

function updateOnlineCount(count) {
  onlineCountEl.textContent = `Users: ${count}`;
}

// ── Reply helpers ──────────────────────────────────────────────────────────────
function setReplyTo({ text, senderName, messageId }) {
  replyTo = { text, senderName, messageId };
  replyPreviewName.textContent = senderName;
  replyPreviewText.textContent = text.length > 80 ? text.slice(0, 80) + "…" : text;
  replyPreview.style.display = "flex";
  messageInput.focus();
}

function clearReply() {
  replyTo = null;
  replyPreview.style.display = "none";
  replyPreviewName.textContent = "";
  replyPreviewText.textContent = "";
}

replyPreviewClose.addEventListener("click", () => clearReply());

function setInputsEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendBtn.disabled      = !enabled;
  gifBtn.disabled       = !enabled;
  questionBtn.disabled  = !enabled;
  // blockBtn is managed separately via updateBlockBtn()
}

// Block button is enabled when chatting OR when partner just left normally.
// It stays disabled during the reconnecting grace-period ("გავიდა საიტიდან").
function updateBlockBtn() {
  blockBtn.disabled = !(partnerConnected || canBlockDisconnected);
}

function showNameError(msg) {
  nameError.textContent   = msg;
  nameError.style.display = "block";
  nameInput.classList.add("error");
}

function clearNameError() {
  nameError.textContent   = "";
  nameError.style.display = "none";
  nameInput.classList.remove("error");
}

// ── Toast popup — used for name-change confirmation ───────────────────────────
function showToast(text, duration = 3000) {
  document.querySelectorAll(".toast-popup").forEach(t => t.remove());
  const toast       = document.createElement("div");
  toast.className   = "toast-popup";
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

// ── Search retry ──────────────────────────────────────────────────────────────
function startSearchRetry() {
  stopSearchRetry();
  searchRetryInterval = setInterval(() => {
    // Double-check both flags before re-emitting — partnerFound can arrive
    // between ticks and set partnerConnected=true; we must not clobber that.
    if (!partnerConnected && !isReconnecting && userName) {
      socket.emit("findPartner");
    } else if (partnerConnected) {
      // Already matched — clean up the interval immediately
      stopSearchRetry();
    }
  }, 2000);
}

function stopSearchRetry() {
  if (searchRetryInterval !== null) {
    clearInterval(searchRetryInterval);
    searchRetryInterval = null;
  }
}

// ── GIF Picker ────────────────────────────────────────────────────────────────
const TENOR_PROXY = "/api/gifs"; // key stays on the server

async function fetchGifs(query) {
  if (gifFetchController) gifFetchController.abort();
  gifFetchController = new AbortController();
  gifResults.innerHTML = '<div class="gif-placeholder">Loading...</div>';

  try {
    const url  = query ? `${TENOR_PROXY}?q=${encodeURIComponent(query)}` : TENOR_PROXY;
    const res  = await fetch(url, { signal: gifFetchController.signal });
    const data = await res.json();
    renderGifResults(data.results || []);
  } catch (err) {
    if (err.name !== "AbortError") {
      gifResults.innerHTML = '<div class="gif-placeholder">Failed to load GIFs 😢</div>';
    }
  } finally {
    gifFetchController = null;
  }
}

function renderGifResults(results) {
  const frag = document.createDocumentFragment();

  if (!results.length) {
    gifResults.innerHTML =
      '<div class="gif-placeholder">No GIFs found</div>';
    return;
  }

  const col1 = document.createElement("div");
  const col2 = document.createElement("div");

  col1.className = "gif-col";
  col2.className = "gif-col";

  results.forEach((result, i) => {

    // Klipy API format
    const previewUrl =
      result.media_formats?.tinygif?.url ||
      result.media_formats?.gif?.url;

    const fullUrl =
      result.media_formats?.gif?.url ||
      result.media_formats?.tinygif?.url;

    if (!previewUrl || !fullUrl) return;

    const img = document.createElement("img");
    img.src = previewUrl;
    img.className = "gif-item";
    img.loading = "lazy";
    img.decoding = "async";

    img.addEventListener("click", () => {
      sendGif(fullUrl, previewUrl);
    });

    (i % 2 === 0 ? col1 : col2).appendChild(img);
  });

  frag.appendChild(col1);
  frag.appendChild(col2);

  gifResults.innerHTML = "";
  gifResults.appendChild(frag);
}

// ── Visual Viewport — drives BOTH the input bar and GIF picker ────────────────
// On iOS Safari the keyboard (+ its accessory bar) shrinks the visual viewport
// but NOT the layout viewport, so position:fixed elements stay hidden behind it.
// We read the gap and push everything up by exactly that amount — the same trick
// Instagram uses so their input sits flush above the keyboard with no extra bar.
const chatInputBar = document.querySelector(".chat-input");

function getKeyboardHeight() {
  if (!window.visualViewport) return 0;
  const vv = window.visualViewport;
  return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
}

function updateViewportOffsets() {
  const vv  = window.visualViewport;
  const kbH = getKeyboardHeight();

  // Clamp body to the visual viewport height so the flex chat area fills
  // exactly the space above the keyboard — maximum messages visible and
  // the container stays scrollable (same trick Instagram uses).
  document.body.style.height = kbH > 0 ? vv.height + "px" : "";

  // Toggle a class so CSS can zoom out messages slightly when keyboard is open
  document.body.classList.toggle("keyboard-open", kbH > 0);

  // Input bar is position:fixed (layout-viewport coords) so still needs
  // shifting up by the full keyboard height (accessory bar included).
  chatInputBar.style.bottom     = kbH + "px";
  chatInputBar.style.transition = kbH === 0 ? "bottom 0.22s ease" : "none";

  // GIF picker floats 8 px above the input bar
  if (gifPickerOpen) {
    gifPicker.style.bottom = (kbH + chatInputBar.offsetHeight + 8) + "px";
  }

  // Pin scroll to bottom whenever the viewport shifts
  scheduleScroll();
  // Keep typing indicator pinned above the input bar
  updateTypingIndicatorPosition();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateViewportOffsets, { passive: true });
  window.visualViewport.addEventListener("scroll", updateViewportOffsets, { passive: true });
}

function updateGifPickerPosition() {
  if (!gifPickerOpen) return;
  const kbH = getKeyboardHeight();
  gifPicker.style.bottom = (kbH + chatInputBar.offsetHeight + 8) + "px";
}

function openGifPicker() {
  gifPicker.style.display = "flex";
  gifPickerOpen = true;
  gifSearch.value = "";
  gifSearch.focus();
  updateGifPickerPosition();
  fetchGifs("");
}

function closeGifPickerPanel() {
  gifPicker.style.display = "none";
  gifPicker.style.bottom  = ""; // reset Visual Viewport override
  gifPickerOpen = false;
}

gifBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  gifPickerOpen ? closeGifPickerPanel() : openGifPicker();
});

gifPickerClose.addEventListener("click", (e) => { e.stopPropagation(); closeGifPickerPanel(); });

gifSearch.addEventListener("input", () => {
  clearTimeout(gifSearchTimer);
  gifSearchTimer = setTimeout(() => fetchGifs(gifSearch.value.trim()), 400);
});

gifSearch.addEventListener("keydown", (e) => e.stopPropagation());

document.addEventListener("click", (e) => {
  if (gifPickerOpen && !gifPicker.contains(e.target) && e.target !== gifBtn) {
    closeGifPickerPanel();
  }
});

function sendGif(fullUrl, previewUrl) {
  if (!partnerConnected) return;
  socket.emit("gif", { url: fullUrl, preview: previewUrl });
  addGifMessage(fullUrl, true);
  closeGifPickerPanel();
}

socket.on("gif", (data) => addGifMessage(data.url, false));
socket.on("nameChanged", ({ name }) => {

  userName = name;

  appendSystemMessage(`✅ You changed name to ${name}`);

  nameModal.style.display = "none";
});
socket.on("partnerNameChanged", ({ name }) => {

  appendSystemMessage(`ℹ️ Partner changed name to ${name}`);

  const partnerNameEl = document.getElementById("partnerName");

  if (partnerNameEl) {
    partnerNameEl.textContent = name;
  }
});
// ── Question button ───────────────────────────────────────────────────────────
let questionBtnCooldown = false;

questionBtn.addEventListener("click", async () => {
  if (!partnerConnected || questionBtnCooldown) return;
  questionBtnCooldown = true;
  questionBtn.disabled = true;
  questionBtn.textContent = "⌛";

  try {
    const res  = await fetch("/api/random-question");
    const data = await res.json();
    if (data.question) {
      // Show question card locally for you
      addQuestionCard(data.question, true);
      // Relay to partner via socket
      socket.emit("sendQuestion", { text: data.question });
    }
  } catch {
    addSystemMessage("კითხვა ვერ ჩაიტვირთა 😕");
  } finally {
    setTimeout(() => {
      questionBtnCooldown  = false;
      questionBtn.disabled = !partnerConnected;
      questionBtn.textContent = "?";
    }, 3000); // 3 s cooldown
  }
});

// Partner received a question card from us
socket.on("partnerQuestion", ({ text }) => {
  addQuestionCard(text, false);
  playNotification("message");
  incrementUnread();
});

// ── Reactions ─────────────────────────────────────────────────────────────────
const REACTIONS          = ["❤️","😂","😢"];
let activeReactionPicker = null;

function showReactionPicker(anchorEl, messageId) {
  closeReactionPicker();
  const picker      = document.createElement("div");
  picker.className  = "reaction-picker";
  const frag = document.createDocumentFragment();
  REACTIONS.forEach(emoji => {
    const btn       = document.createElement("button");
    btn.className   = "reaction-emoji-btn";
    btn.textContent = emoji;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      reactToMessage(messageId, emoji);
      closeReactionPicker();
    });
    frag.appendChild(btn);
  });
  picker.appendChild(frag);
  document.body.appendChild(picker);
  activeReactionPicker = picker;
  requestAnimationFrame(() => {
    const rect = anchorEl.getBoundingClientRect();
    const pw = picker.offsetWidth, ph = picker.offsetHeight;
    let left = rect.left, top = rect.top - ph - 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top < 4) top = rect.bottom + 8;
    picker.style.cssText += `left:${left}px;top:${top}px;opacity:1;transform:scale(1)`;
  });
}

function closeReactionPicker() {
  activeReactionPicker?.remove();
  activeReactionPicker = null;
}

document.addEventListener("click", () => closeReactionPicker());

function reactToMessage(messageId, emoji) {
  socket.emit("react", { messageId, emoji });
  displayReaction(messageId, emoji, true);
}

function displayReaction(messageId, emoji, isMine) {
  const area = document.getElementById(`reactions_${messageId}`);
  if (!area) return;
  const cls = isMine ? "reaction-mine" : "reaction-partner";
  let pill   = area.querySelector(`.${cls}`);
  if (pill) {
    pill.classList.remove("reaction-pop");
    void pill.offsetWidth;
    pill.textContent = emoji;
    pill.classList.add("reaction-pop");
  } else {
    pill = document.createElement("span");
    pill.className   = `reaction-pill ${cls} reaction-pop`;
    pill.textContent = emoji;
    area.appendChild(pill);
  }
}

// ── Message sending ───────────────────────────────────────────────────────────
function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || !partnerConnected || !userName) return;
  const msgId = generateMsgId();
  const currentReply = replyTo ? { ...replyTo } : null;
  addMessage(message, true, msgId, currentReply);
  socket.emit("message", { text: message, messageId: msgId, replyTo: currentReply });
  messageInput.value = "";
  charCount.textContent = "";
  charCount.classList.remove("warning");
  clearReply();
  // Keep focus on input so the keyboard stays open on mobile
  messageInput.focus();
}

// ── Bio / Interests popup ─────────────────────────────────────────────────────
let bioPopupOpen = false;

function openBioPopup() {
  bioInput.value       = userBio;
  bioCharCount.textContent = `${userBio.length}/60`;
  bioPopup.style.display = "flex";
  bioPopupOpen = true;
  setTimeout(() => bioInput.focus(), 50);
}

function closeBioPopup() {
  bioPopup.style.display = "none";
  bioPopupOpen = false;
}

interestsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  bioPopupOpen ? closeBioPopup() : openBioPopup();
});

bioInput.addEventListener("input", () => {
  bioCharCount.textContent = `${bioInput.value.length}/60`;
});

bioInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") { e.preventDefault(); saveBio(); }
  if (e.key === "Escape") closeBioPopup();
});

function saveBio() {
  const text = bioInput.value.trim().slice(0, 60);
  userBio = text;
  socket.emit("setBio", text);
  interestsBtn.classList.toggle("has-bio", text.length > 0);
  closeBioPopup();
  if (text) showToast("✅ ინფო შენახულია!");
}

function clearBio() {
  bioInput.value = "";
  bioCharCount.textContent = "0/60";
  userBio = "";
  socket.emit("setBio", "");
  interestsBtn.classList.remove("has-bio");
}

bioSaveBtn.addEventListener("click", saveBio);
bioClearBtn.addEventListener("click", clearBio);
document.getElementById("bioCloseBtn").addEventListener("click", (e) => { e.stopPropagation(); closeBioPopup(); });

// Close popup when clicking outside it
document.addEventListener("click", (e) => {
  if (bioPopupOpen && !bioPopup.contains(e.target) && e.target !== interestsBtn) {
    closeBioPopup();
  }
});

// ── Name modal ────────────────────────────────────────────────────────────────
let _saveNameTimeout = null; // tracks the freeze-recovery timer

function _resetSaveBtn() {
  clearTimeout(_saveNameTimeout);
  _saveNameTimeout        = null;
  saveNameBtn.disabled    = false;
  saveNameBtn.textContent = isFirstLogin ? "საუბრის დაწყება" : "Save Name";
}

function saveName() {
  const name = nameInput.value.trim();
  if (!name)            { showNameError("შეიყვანეთ სახელი ..."); return; }
  if (name.length < 2)  { showNameError("სახელი უნდა შედგებოდეს მინიმუმ ორი სიმბოლოსგან!"); return; }
  if (name.length > 20) { showNameError("20 სიმბოლოზე მეტი ვერ იქნება სახელი ! "); return; }
  clearNameError();

  // If socket isn't connected yet, don't freeze — show a clear error
  if (!socket.connected) {
    showNameError("იტვირთება საიტი, კიდევ სცადეთ 🔄");
    return;
  }

  saveNameBtn.disabled    = true;
  saveNameBtn.textContent = "Checking...";

  // ── Token not ready yet (slow network on page load) ──────────────────────
  // Re-fetch and retry once rather than sending null and getting a tokenInvalid loop
  if (!_challengeToken || !_challengePow) {
    fetch("/api/challenge")
      .then(r => r.json())
      .then(d => {
        _challengeToken = d.token;
        _challengePow   = (d.nonce * 31 + d.nonce % 97);
        _doSetName(name);
      })
      .catch(() => {
        showNameError("კავშირის შეცდომა. გთხოვთ გვერდი განაახლოთ.");
        _resetSaveBtn();
      });
    return;
  }

  _doSetName(name);
}

function _doSetName(name) {
  // Safety timeout — re-enable button if server never replies within 8 s
  clearTimeout(_saveNameTimeout);
  _saveNameTimeout = setTimeout(() => {
    showNameError("სერვერი არ პასუხობს. სცადეთ ხელახლა. 🔄");
    _resetSaveBtn();
  }, 8000);

  socket.emit("setName", {
    name,
    token:     _challengeToken,
    powAnswer: _challengePow,
    webdriver: !!navigator.webdriver,
  });
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on("connect", () => {
  _reconnectNameRetries = 0; // reset on every fresh connect
  if (userName && !isFirstLogin) {
    isReconnecting = true;
    // Hide the name modal — silently reconnecting, not asking for a new name
    if (nameModal) nameModal.style.display = "none";
    // Fetch a fresh token — the previous one was one-time-use and already consumed
    fetch("/api/challenge")
      .then(r => r.json())
      .then(d => {
        _challengeToken = d.token;
        _challengePow   = (d.nonce * 31 + d.nonce % 97);
        socket.emit("setName", { name: userName, token: _challengeToken, powAnswer: _challengePow });
      })
      .catch(() => {
        // Token fetch failed — send empty so server replies tokenInvalid → retry loop
        socket.emit("setName", { name: userName, token: "", powAnswer: 0 });
      });
  }
});

// Challenge token was missing or expired — silently re-fetch and retry
socket.on("tokenInvalid", () => {
  fetch("/api/challenge")
    .then(r => r.json())
    .then(d => {
      _challengeToken = d.token;
      _challengePow   = (d.nonce * 31 + d.nonce % 97);
      const name = userName || nameInput.value.trim();
      if (name) {
        socket.emit("setName", { name, token: _challengeToken, powAnswer: _challengePow });
      }
    })
    .catch(() => {
      if (!isReconnecting) {
        showNameError("კავშირის შეცდომა. გთხოვთ გვერდი განაახლოთ.");
        saveNameBtn.disabled    = false;
        saveNameBtn.textContent = isFirstLogin ? "საუბრის დაწყება" : "Save Name";
      }
    });
});

socket.on("nameAccepted", (acceptedName) => {
  const wasNameChange = !isFirstLogin && !isReconnecting;
  _resetSaveBtn(); // cancel the 8-second safety timeout and re-enable button
  userName                = acceptedName;
  nameModal.style.display = "none";
  clearNameError();

  // Persist username so a page reload (iOS background kill) auto-reconnects
  try { sessionStorage.setItem("gaicani_username", acceptedName); } catch (_) {}

  // Show the username in the top bar
  const displayEl = document.getElementById("userNameDisplay");
  if (displayEl) {
    displayEl.textContent = `👤 ${acceptedName}`;
    displayEl.style.display = "block";
  }

  // Show interests/bio button
  if (interestsBtn) interestsBtn.style.display = "inline-block";

  if (isFirstLogin) {
    isFirstLogin = false;
    clearChat();
    addSearchingMessage();
    socket.emit("findPartner");
    startSearchRetry();
  } else if (isReconnecting) {
    isReconnecting = false;
    _reconnectNameRetries = 0; // reset retry counter on success
    removeReconnectingMessage();
    // Keep inputs and chat as-is — server follows with partnerRestored or partnerDisconnected
  }
  // else: mid-session name change — no extra action
  if (wasNameChange) {
    addSystemMessage(`🟢 თქვენ წარმატებით შეიცვალეთ სახელი „${acceptedName}" 🟢`);
  }
});

// Tracks how many times we've retried the original name after a reconnect collision
let _reconnectNameRetries = 0;
const _RECONNECT_NAME_MAX_RETRIES = 5;

socket.on("nameTaken", () => {
  saveNameBtn.disabled    = false;
  saveNameBtn.textContent = isFirstLogin ? "საუბრის დაწყება" : "Save Name";

  if (isReconnecting) {
    // The server still has our old socket registered under our name.
    // Wait a short moment and retry with the SAME original name — the old
    // socket entry will be cleaned up within a second or two.
    if (_reconnectNameRetries < _RECONNECT_NAME_MAX_RETRIES) {
      _reconnectNameRetries++;
      const delay = 800 + _reconnectNameRetries * 400; // back off slightly each attempt
      setTimeout(() => {
        if (!socket.connected) return; // don't retry if socket dropped again
        const originalName = userName || nameInput.value.trim();
        fetch("/api/challenge")
          .then(r => r.json())
          .then(d => {
            _challengeToken = d.token;
            _challengePow   = (d.nonce * 31 + d.nonce % 97);
            socket.emit("setName", { name: originalName, token: _challengeToken, powAnswer: _challengePow });
          })
          .catch(() => {
            // Network error — give up silently, user is still logged in with old name
            isReconnecting = false;
            _reconnectNameRetries = 0;
          });
      }, delay);
      return; // still reconnecting — do not reset isReconnecting yet
    }

    // Exhausted retries — name is genuinely taken by someone else.
    // Keep the user's existing session intact without renaming them.
    isReconnecting = false;
    _reconnectNameRetries = 0;
    // Don't show modal or change name — just continue as-is
    return;
  }

  _reconnectNameRetries = 0;
  isReconnecting = false;
  showNameError("ეს სახელი დაკავებულია. სხვა აირჩიეთ. 😟 ");
  nameInput.focus();
  nameInput.select();
});

socket.on("onlineCount", (count) => updateOnlineCount(count));

socket.on("queuePosition", ({ position, total }) => {
  const wrapper = document.getElementById("searchingMsg");
  if (wrapper) {
    const msg = wrapper.querySelector(".system-message");
    if (msg) msg.textContent = `ვეძებთ ახალ პარტნიორს... 🔎 `;
  }
});

socket.on("partnerFound", (partner) => {
  stopSearchRetry();
  clearChat();
  partnerName          = partner.name || "Anonymous";
  partnerConnected     = true;
  lastPartnerName      = "";
  canBlockDisconnected = false;
  addSystemMessage(`გილოცავთ პარტნიორი ნაპოვნია 🥳 : ${partnerName}`);

  // Show partner's bio if they set one
  if (partner.partnerBio) {
    const bioEl       = document.createElement("div");
    bioEl.className   = "partner-bio-line";
    bioEl.textContent = `💬 ${partner.partnerBio}`;
    chat.appendChild(bioEl);
    scheduleScroll();
  }

  setInputsEnabled(true);
  updateBlockBtn();
  playNotification("partnerFound");
  incrementUnread();
  // Focus the input so the user can start typing immediately (especially on mobile)
  setTimeout(() => messageInput.focus(), 100);
});

// Reconnect grace-period events
let partnerWasReconnecting = false;

socket.on("partnerReconnecting", (data) => {
  partnerWasReconnecting = true;
  // Silent — keep chat and inputs running
});

socket.on("partnerReconnected", (data) => {
  stopSearchRetry();
  partnerWasReconnecting = false;
  partnerName            = data.name || partnerName;
  partnerConnected       = true;
  canBlockDisconnected   = false;
  removeReconnectingMessage();
  clearPartnerAwayCountdown();
  setInputsEnabled(true);
  updateBlockBtn();
});

// Own socket restored to previous partner after reconnecting
socket.on("partnerRestored", (data) => {
  stopSearchRetry();
  partnerName          = data.name || "Anonymous";
  partnerConnected     = true;
  lastPartnerName      = "";
  canBlockDisconnected = false;
  setInputsEnabled(true);
  updateBlockBtn();
  setTimeout(() => messageInput.focus(), 100);
  // No clearChat(), no system message — messages stay, chat resumes silently
});

socket.on("waitingForPartner", () => {
  // Guard: never disable inputs if partnerConnected is already true
  // (race condition: partnerFound can arrive just before waitingForPartner)
  if (!partnerConnected) {
    partnerName = "";
    setInputsEnabled(false);
  }
  // If partnerConnected is true, partnerFound already won the race — do nothing
});

socket.on("partnerTyping", (typing) => {
  typing ? showTypingIndicator() : hideTypingIndicator();
});

socket.on("message", (msg) => {
  hideTypingIndicator();
  addMessage(msg.text, false, msg.messageId, msg.replyTo || null);
  playNotification("message");
  incrementUnread();
  // Only send seen receipt if the tab is actually visible
  if (msg.messageId && !document.hidden) socket.emit("seen", { messageId: msg.messageId });
});

socket.on("partnerSeen", ({ messageId }) => {
  const el = document.getElementById(`seen_${messageId}`);
  if (el) { el.textContent = "✓✓"; el.classList.add("seen"); }
});

socket.on("reacted", ({ messageId, emoji }) => {
  displayReaction(messageId, emoji, false);
});

// Tab-away events disabled — intentionally ignored
socket.on("partnerTabAway", () => {});
socket.on("partnerTabBack", () => {});

socket.on("partnerDisconnected", (data) => {
  partnerWasReconnecting = false;
  removeReconnectingMessage();
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = data.name || lastPartnerName || "";
  canBlockDisconnected = !!lastPartnerName;
  setInputsEnabled(false);
  updateBlockBtn();

  // Show disconnect notice + inline block offer
  const disconnectEl = document.createElement("div");
  disconnectEl.className = "system-message-disconnect";
  disconnectEl.textContent = `❌ ${lastPartnerName || "პარტნიორი"} გათიშა.`;
  chat.appendChild(disconnectEl);

  if (lastPartnerName) {
    const offerEl = document.createElement("div");
    offerEl.className = "block-offer";
    offerEl.innerHTML = `<span>გსურთ დაბლოკოთ <strong>"${lastPartnerName}"</strong>? ის ვეღარ შეძლებს თქვენს შეწუხებას.</span>` +
      `<button class="block-offer-btn" id="blockOfferBtn">🚫 დაბლოკვა</button>`;
    chat.appendChild(offerEl);
    scheduleScroll();

    document.getElementById("blockOfferBtn").addEventListener("click", () => {
      offerEl.remove();
      socket.emit("blockUser", { targetName: lastPartnerName });
    });
  } else {
    scheduleScroll();
  }

});

socket.on("userBlocked", (data) => {
  const blockedName = data.name || lastPartnerName || "მომხმარებელი";
  stopSearchRetry();
  clearChat();
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = "";
  canBlockDisconnected = false;
  updateBlockBtn();
  closeGifPickerPanel();
  addSystemMessage(`🔴 „${blockedName}" -  წარმატებით იქნა დაბლოკილი 🔴`);
  setInputsEnabled(false);
  // Do NOT auto-search — user must press Next manually
});

socket.on("blockLimitReached", () => {
  addSystemMessage("🚫 ბლოკირების ლიმიტს მიაღწიეთ ამ სესიისთვის.");
});

socket.on("youWereBlocked", (data) => {
  const blockerName = data.name || "მომხმარებელი";
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  addDisconnectMessage(`${blockerName} -მა დაგბლოკათ :(`);
  // Do NOT auto-search — user must press Next manually
});

socket.on("reportConfirmed", () => {
  addSystemMessage("შეტყობინება გაგზავნილია. გმადლობთ. 🙏");
});

socket.on("messageFlagged", () => {
  // silently drop — no notice shown to user
});

// Sender gets kicked for sending a link
socket.on("linkKicked", () => {
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  clearChat();
  addDisconnectMessage("🚫 ლინკების გაგზავნა აკრძალულია! თქვენ გაირიცხეთ საიტიდან.");
});

// Partner of the link-sender sees a notice and gets unlinked
socket.on("partnerLinkKicked", () => {
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  addDisconnectMessage("🚫 ლინკების გაგზავნა აკრძალულია! პარტნიორი გაირიცხა საიტიდან.");
});

socket.on("autoKicked", () => {
  try { sessionStorage.removeItem("gaicani_username"); } catch (_) {}
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  clearChat();
  // Do NOT reload — just show message
});

// awayTimeout disabled — intentionally ignored
socket.on("awayTimeout", () => {});

// ── Button handlers ───────────────────────────────────────────────────────────

nextBtn.addEventListener("click", () => {
  nextBtn.disabled = true;
  setTimeout(() => { nextBtn.disabled = false; }, 1000);
  hideTypingIndicator();
  clearChat();
  addSearchingMessage();
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = "";
  canBlockDisconnected = false;
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  clearReply();
  socket.emit("next");
  startSearchRetry();
});

blockBtn.addEventListener("click", () => {
  const targetName = partnerName || lastPartnerName;
  if (!targetName) return;
  const confirmed = confirm(
    `Block "${targetName}"? თქვენ ვეღარ შეხვდებით ამ იუზერს ბლოკის შემდეგ. 😡 `
  );
  if (confirmed) socket.emit("blockUser", { targetName });
});

sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

messageInput.addEventListener("input", () => {
  // Character counter
  const len = messageInput.value.length;
  charCount.textContent = len > 0 ? `${len}/2000` : ``;
  charCount.classList.toggle("warning", len > 1800);

  // Typing indicator
  if (!partnerConnected) return;
  if (!isTyping) { isTyping = true; socket.emit("typing", true); }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    socket.emit("typing", false);
  }, 1500);
});

changeNameBtn.addEventListener("click", () => {
  nameInput.value         = userName;
  saveNameBtn.textContent = "Save Name";
  clearNameError();
  nameModal.style.display = "flex";
  const closeBtn = document.getElementById("nameModalClose");
  if (closeBtn) closeBtn.style.display = "block";
  setTimeout(() => nameInput.focus(), 50);
});

saveNameBtn.addEventListener("click", () => {

  const newName = nameInput.value.trim();

  if (!newName) return;

  // FIRST LOGIN
  if (!userName) {

    socket.emit("setName", {
      name: newName,
      token,
      powAnswer,
      webdriver: navigator.webdriver
    });

  } else {

    // CHANGE EXISTING NAME
    socket.emit("changeName", newName);
  }
});

// ── Swipe-right gesture → Next (mobile) ──────────────────────────────────────
let touchStartX = 0, touchStartY = 0;

document.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
  // Swipe right > 150 px, mostly horizontal (dy < 30% of dx),
  // AND must start from the left edge (first 30px) to avoid accidental triggers
  if (dx > 150 && dy < dx * 0.3 && touchStartX < 30 && !nextBtn.disabled) {
    nextBtn.click();
  }
}, { passive: true });

// ── Welcome page / logo home ──────────────────────────────────────────────────
// Called when user clicks the GAICANI logo to return to the welcome screen.
function goToWelcome() {
  socket.emit("next"); // tell server we're leaving current chat
  stopSearchRetry();
  hideTypingIndicator();
  closeGifPickerPanel();
  clearChat();
  clearReply();

  // Reset all session state
  partnerConnected     = false;
  partnerName          = "";
  lastPartnerName      = "";
  canBlockDisconnected = false;
  userName             = "";
  isFirstLogin         = true;
  isReconnecting       = false;
  setInputsEnabled(false);
  updateBlockBtn();

  // Clear saved name so a page reload also shows welcome
  try { sessionStorage.removeItem("gaicani_username"); } catch (_) {}

  // Show the welcome/name modal fresh
  const nameModalClose = document.getElementById("nameModalClose");
  if (nameModalClose) nameModalClose.style.display = "none";
  nameInput.value         = "";
  saveNameBtn.textContent = "საუბრის დაწყება";
  clearNameError();
  nameModal.style.display = "flex";
  setTimeout(() => nameInput.focus(), 100);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  userName       = "";
  isFirstLogin   = true;
  isReconnecting = false;
  stopSearchRetry();
  setInputsEnabled(false);
  updateBlockBtn();
  saveNameBtn.textContent  = "საუბრის დაწყება";
  charCount.textContent    = "";

  // X button on name modal — only active during mid-session name change
  const nameModalClose = document.getElementById("nameModalClose");
  if (nameModalClose) {
    nameModalClose.addEventListener("click", () => {
      nameModal.style.display = "none";
      nameModalClose.style.display = "none";
      clearNameError();
    });
  }

  // ── Auto-reconnect after iOS page kill ───────────────────────────────────
  // iOS Safari can fully unload the page when the app is backgrounded.
  // If we have a saved username, skip the modal and reconnect silently.
  // If site data was cleared, sessionStorage returns null → show welcome modal.
  const savedName = (() => { try { return sessionStorage.getItem("gaicani_username"); } catch(_) { return null; } })();

  if (savedName) {
    // Pre-fill the modal but don't show it — submit automatically once socket connects
    nameInput.value = savedName;
    nameModal.style.display = "none";

    const autoReconnect = () => {
      if (socket.connected) {
        // Fetch a fresh challenge token then set name
        fetch("/api/challenge")
          .then(r => r.json())
          .then(d => {
            _challengeToken = d.token;
            _challengePow   = (d.nonce * 31 + d.nonce % 97);
            isReconnecting  = true;
            socket.emit("setName", {
              name:      savedName,
              token:     _challengeToken,
              powAnswer: _challengePow,
              webdriver: !!navigator.webdriver,
            });
          })
          .catch(() => {
            // Token fetch failed — fall back to showing the welcome modal
            nameInput.value = "";
            nameModal.style.display = "flex";
            setTimeout(() => nameInput.focus(), 100);
          });
      } else {
        // Socket not yet connected — wait for the connect event
        socket.once("connect", autoReconnect);
      }
    };
    autoReconnect();
    return; // don't show the modal
  }

  // No saved name (fresh visit OR site data cleared) — always show welcome modal
  nameModal.style.display = "flex";
  setTimeout(() => nameInput.focus(), 100);
});

// ══════════════════════════════════════════════════════════════════════════════
// VOICE MESSAGES
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const voiceBtn = document.getElementById('voiceBtn');
  if (!voiceBtn) return;

  let mediaRecorder = null;
  let activeStream  = null;  // mic stream, kept so stopRecording can release tracks
  let audioChunks   = [];
  let recTimerEl    = null;
  let recBarEl      = null;
  let recInterval   = null;
  let recSeconds    = 0;
  const MAX_SECONDS = 120;

  // ── Enable / disable with chat inputs ──────────────────────────────────────
  // Patch setInputsEnabled to also toggle voiceBtn
  const _origSetInputsEnabled = window.setInputsEnabled || setInputsEnabled;
  function patchedSetInputsEnabled(enabled) {
    _origSetInputsEnabled(enabled);
    voiceBtn.disabled = !enabled;
  }
  // Override globally (script.js already called setInputsEnabled on load)
  window.setInputsEnabled = patchedSetInputsEnabled;
  // Also wire directly to partner events
  socket.on('partnerFound',    () => { voiceBtn.disabled = false; });
  socket.on('partnerRestored', () => { voiceBtn.disabled = false; });
  socket.on('partnerDisconnected', () => { voiceBtn.disabled = true; stopRecording(false); });
  socket.on('youWereBlocked',      () => { voiceBtn.disabled = true; stopRecording(false); });

  // ── Recording timer display ────────────────────────────────────────────────
  function fmtTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function showRecordingBar() {
    if (recBarEl) return;
    const chatInput = document.querySelector('.chat-input');
    recBarEl = document.createElement('div');
    recBarEl.id = 'voiceRecordingBar';
    recBarEl.innerHTML = `
      <div class="voice-rec-dot"></div>
      <span class="voice-rec-timer" id="voiceRecTimer">0:00</span>
      <span class="voice-rec-label">ჩაწერა მიმდინარეობს...</span>
      <button class="voice-rec-cancel" title="Cancel">✕</button>`;
    chatInput.prepend(recBarEl);
    recTimerEl = document.getElementById('voiceRecTimer');
    recBarEl.querySelector('.voice-rec-cancel').addEventListener('click', () => stopRecording(false));
  }

  function hideRecordingBar() {
    if (recBarEl) { recBarEl.remove(); recBarEl = null; recTimerEl = null; }
  }

  // ── Start recording ────────────────────────────────────────────────────────
  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('თქვენი ბრაუზერი ხმის ჩაწერას არ უჭერს მხარს.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      activeStream = stream;

      // Pick a supported MIME type
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', '']
        .find(t => !t || MediaRecorder.isTypeSupported(t)) || '';

      const options = mimeType ? { mimeType } : {};
      mediaRecorder = new MediaRecorder(stream, options);
      audioChunks   = [];

      mediaRecorder.addEventListener('dataavailable', e => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      });

      // NOTE: stop handler is registered in stopRecording() so it can
      // capture mimeType/recSeconds synchronously before mediaRecorder is nulled.

      mediaRecorder.start(200); // collect every 200 ms

      voiceBtn.classList.add('recording');
      voiceBtn.title = 'გაჩერება და გაგზავნა';
      showRecordingBar();

      recSeconds  = 0;
      recInterval = setInterval(() => {
        recSeconds++;
        if (recTimerEl) recTimerEl.textContent = fmtTime(recSeconds);
        if (recSeconds >= MAX_SECONDS) stopRecording(true);
      }, 1000);

    } catch (err) {
      console.warn('Mic access denied:', err);
      alert('მიკროფონი ვერ მოიძებნა ან უფლება უარყოფილ იქნა.');
    }
  }

  // ── Stop recording ─────────────────────────────────────────────────────────
  function stopRecording(send = true) {
    clearInterval(recInterval);
    recInterval = null;
    voiceBtn.classList.remove('recording');
    voiceBtn.title = 'Send voice message';
    hideRecordingBar();

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      // Capture everything BEFORE nulling mediaRecorder — stop event fires async
      const mr             = mediaRecorder;
      const capturedMime   = mr.mimeType || 'audio/webm';
      const capturedSecs   = recSeconds;
      const shouldSend     = send;

      mr.addEventListener('stop', () => {
        if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
        if (shouldSend && audioChunks.length > 0) {
          const blob = new Blob(audioChunks, { type: capturedMime });
          sendVoiceBlob(blob, capturedSecs);
        }
        audioChunks = [];
      }, { once: true });

      mr.stop();
    }
    mediaRecorder = null;
  }

  voiceBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording(true);
    } else {
      startRecording();
    }
  });

  // ── Convert blob → base64, emit to server ─────────────────────────────────
  function sendVoiceBlob(blob, duration) {
    if (blob.size > 3_000_000) {
      alert('ჩანაწერი ძალიან გრძელია. მაქსიმუმი 2 წუთია.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      socket.emit('voiceMessage', { audioData: base64, duration });
      // Show own bubble immediately
      addVoiceMessage(blob, duration, true);
    };
    reader.readAsDataURL(blob);
  }

  // ── Render voice bubble ────────────────────────────────────────────────────
  function makeWaveform() {
    const bars = 20;
    let html = '';
    for (let i = 0; i < bars; i++) {
      const h = 6 + Math.floor(Math.random() * 18);
      html += `<span style="height:${h}px"></span>`;
    }
    return html;
  }

  function addVoiceMessage(blobOrBase64, duration, isYou) {
    const wrapper = document.createElement('div');
    wrapper.className = `voice-message-wrapper ${isYou ? 'you' : 'partner'}`;

    const dur   = duration ? fmtTime(Math.round(duration)) : '…';
    const wfId  = `wf_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    wrapper.innerHTML = `
      <div class="voice-bubble">
        <button class="voice-play-btn" title="Play">▶</button>
        <div class="voice-waveform" id="${wfId}">${makeWaveform()}</div>
        <span class="voice-duration">${dur}</span>
      </div>`;

    const chat = document.getElementById('chat');
    chat.appendChild(wrapper);
    chat.scrollTop = chat.scrollHeight;

    // Wire up player
    const playBtn = wrapper.querySelector('.voice-play-btn');
    const wfEl    = wrapper.querySelector('.voice-waveform');
    let audioEl   = null;

    playBtn.addEventListener('click', () => {
      if (audioEl && !audioEl.paused) {
        audioEl.pause();
        audioEl.currentTime = 0;
        playBtn.textContent = '▶';
        playBtn.classList.remove('playing');
        wfEl.classList.remove('playing');
        return;
      }

      // Build audio element from blob or base64
      if (!audioEl) {
        if (blobOrBase64 instanceof Blob) {
          audioEl = new Audio(URL.createObjectURL(blobOrBase64));
        } else {
          // base64 string received from partner
          audioEl = new Audio('data:audio/webm;base64,' + blobOrBase64);
        }
        audioEl.addEventListener('ended', () => {
          playBtn.textContent = '▶';
          playBtn.classList.remove('playing');
          wfEl.classList.remove('playing');
        });
      }

      audioEl.play().catch(e => console.warn('Audio play error:', e));
      playBtn.textContent = '⏹';
      playBtn.classList.add('playing');
      wfEl.classList.add('playing');
    });
  }

  // ── Receive partner's voice message ───────────────────────────────────────
  socket.on('voiceMessage', ({ audioData, duration }) => {
    addVoiceMessage(audioData, duration, false);
    // Reuse existing notification sound
    if (typeof playNotification === 'function') playNotification('message');
    if (typeof incrementUnread  === 'function') incrementUnread();
  });

})();
