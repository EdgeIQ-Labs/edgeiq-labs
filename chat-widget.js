/* EdgeIQ Labs AI security assistant — self-contained chat widget.
   Adds a floating button bottom-right; click opens a modal chat panel
   that talks to /api/chat (Cloudflare Pages Function).

   To enable on a page: <script defer src="/chat-widget.js"></script> */
(function () {
  if (window.__edgeiqChatWidgetLoaded) return;
  window.__edgeiqChatWidgetLoaded = true;

  var ENDPOINT = '/api/chat';
  var STORAGE_OPENED = 'edgeiq_chat_opened';
  var GREETING =
    "Hi 👋 I'm EdgeIQ's AI security assistant. I can help with:\n\n" +
    "• Quick security questions (MFA, phishing, SSL, backups…)\n" +
    "• How EdgeIQ Labs plans work\n" +
    "• Pointing you to the right tool or trial\n\n" +
    "What's up?";

  var STYLES = `
    .edgeiq-chat-btn {
      position: fixed; right: 20px; bottom: 20px; z-index: 9999;
      width: 60px; height: 60px; border-radius: 50%; border: none;
      background: linear-gradient(135deg, #3dd9ff 0%, #a78bfa 100%);
      color: #071018; font-size: 1.6rem; cursor: pointer;
      box-shadow: 0 6px 22px rgba(61,217,255,0.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.15s, box-shadow 0.15s;
      font-family: Inter, system-ui, sans-serif;
    }
    .edgeiq-chat-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(61,217,255,0.45); }
    .edgeiq-chat-btn:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
    .edgeiq-chat-btn[aria-expanded="true"] { display: none; }
    .edgeiq-chat-btn .ed-pulse {
      position: absolute; top: -3px; right: -3px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #70f0a8; border: 2px solid #0b0f14;
      animation: edgeiqPulse 2.4s ease-in-out infinite;
    }
    @keyframes edgeiqPulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.15); opacity: 0.7; }
    }

    .edgeiq-chat-panel {
      position: fixed; right: 20px; bottom: 20px; z-index: 10000;
      width: 380px; max-width: calc(100vw - 30px);
      height: 560px; max-height: calc(100vh - 40px);
      background: #121923; border: 1px solid #233142; border-radius: 16px;
      box-shadow: 0 18px 48px rgba(0,0,0,0.55);
      display: none; flex-direction: column; overflow: hidden;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: #e8eef7;
    }
    .edgeiq-chat-panel.open { display: flex; animation: edgeiqSlideIn 0.18s ease-out; }
    @keyframes edgeiqSlideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

    .edgeiq-chat-head {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid #233142;
      background: linear-gradient(135deg, rgba(61,217,255,0.08), rgba(167,139,250,0.06));
    }
    .edgeiq-chat-head .ed-avatar {
      width: 34px; height: 34px; border-radius: 50%;
      background: linear-gradient(135deg, #3dd9ff, #a78bfa);
      display: flex; align-items: center; justify-content: center;
      font-size: 1rem; flex-shrink: 0;
    }
    .edgeiq-chat-head .ed-title { flex: 1; }
    .edgeiq-chat-head .ed-title strong { display: block; font-size: 0.95rem; color: #e8eef7; }
    .edgeiq-chat-head .ed-title span { font-size: 0.76rem; color: #9fb0c7; display: flex; align-items: center; gap: 5px; }
    .edgeiq-chat-head .ed-title span::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #70f0a8; display: inline-block; }
    .edgeiq-chat-close {
      background: transparent; border: none; color: #9fb0c7;
      font-size: 1.4rem; cursor: pointer; line-height: 1;
      padding: 4px 8px; border-radius: 6px;
    }
    .edgeiq-chat-close:hover { background: rgba(255,255,255,0.06); color: #e8eef7; }

    .edgeiq-chat-msgs {
      flex: 1; overflow-y: auto;
      padding: 16px; display: flex; flex-direction: column; gap: 10px;
      background: #0e1620;
    }
    .edgeiq-msg { max-width: 88%; padding: 9px 13px; border-radius: 12px; font-size: 0.9rem; line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }
    .edgeiq-msg a { color: #3dd9ff; }
    .edgeiq-msg.user { align-self: flex-end; background: #1d3a52; color: #e8eef7; border-bottom-right-radius: 4px; }
    .edgeiq-msg.assistant { align-self: flex-start; background: #121923; color: #e8eef7; border: 1px solid #233142; border-bottom-left-radius: 4px; }
    .edgeiq-msg.error { align-self: flex-start; background: rgba(255,107,129,0.08); color: #ff6b81; border: 1px solid rgba(255,107,129,0.3); border-bottom-left-radius: 4px; }
    .edgeiq-typing { align-self: flex-start; padding: 10px 13px; background: #121923; border: 1px solid #233142; border-radius: 12px; border-bottom-left-radius: 4px; display: flex; gap: 4px; }
    .edgeiq-typing span { width: 7px; height: 7px; border-radius: 50%; background: #9fb0c7; animation: edgeiqDot 1.2s ease-in-out infinite; }
    .edgeiq-typing span:nth-child(2) { animation-delay: 0.15s; }
    .edgeiq-typing span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes edgeiqDot { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); } 40% { opacity: 1; transform: scale(1); } }

    .edgeiq-chat-form {
      padding: 12px; border-top: 1px solid #233142;
      display: flex; gap: 8px; background: #121923;
    }
    .edgeiq-chat-input {
      flex: 1; background: #0d1420; border: 1px solid #233142; border-radius: 10px;
      color: #e8eef7; padding: 10px 12px; font-size: 0.9rem; outline: none;
      font-family: inherit; resize: none; max-height: 120px; min-height: 40px;
    }
    .edgeiq-chat-input:focus { border-color: #3dd9ff; }
    .edgeiq-chat-send {
      background: linear-gradient(135deg, #3dd9ff, #a78bfa); color: #071018;
      border: none; border-radius: 10px; padding: 0 16px; font-weight: 700; cursor: pointer;
      font-size: 0.9rem; transition: opacity 0.15s;
    }
    .edgeiq-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }

    .edgeiq-chat-foot {
      padding: 8px 12px; font-size: 0.7rem; color: #9fb0c7; text-align: center;
      background: #121923; border-top: 1px solid #1a2533;
    }
    .edgeiq-chat-foot a { color: #9fb0c7; text-decoration: underline; }

    @media (max-width: 480px) {
      .edgeiq-chat-panel { width: calc(100vw - 16px); right: 8px; bottom: 8px; height: calc(100vh - 80px); }
      .edgeiq-chat-btn { right: 14px; bottom: 14px; width: 56px; height: 56px; font-size: 1.4rem; }
    }
  `;

  function injectStyles() {
    var s = document.createElement('style');
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  function build() {
    // Floating button
    var btn = el('button', 'edgeiq-chat-btn', { 'aria-label': 'Open EdgeIQ AI security assistant', 'aria-expanded': 'false' });
    btn.innerHTML = '🛡️<span class="ed-pulse" aria-hidden="true"></span>';

    // Chat panel
    var panel = el('div', 'edgeiq-chat-panel', { role: 'dialog', 'aria-label': 'EdgeIQ AI security assistant', 'aria-hidden': 'true' });

    var head = el('div', 'edgeiq-chat-head');
    var avatar = el('div', 'ed-avatar');
    avatar.textContent = '🛡️';
    var title = el('div', 'ed-title');
    title.innerHTML = '<strong>EdgeIQ AI</strong><span>Online · usually replies instantly</span>';
    var closeBtn = el('button', 'edgeiq-chat-close', { 'aria-label': 'Close chat' });
    closeBtn.innerHTML = '✕';
    head.appendChild(avatar);
    head.appendChild(title);
    head.appendChild(closeBtn);

    var msgs = el('div', 'edgeiq-chat-msgs');
    msgs.setAttribute('aria-live', 'polite');

    var form = el('form', 'edgeiq-chat-form');
    form.setAttribute('autocomplete', 'off');
    var input = el('textarea', 'edgeiq-chat-input', { rows: '1', placeholder: 'Ask about security, our plans…', 'aria-label': 'Message' });
    var send = el('button', 'edgeiq-chat-send', { type: 'submit' });
    send.textContent = 'Send';
    form.appendChild(input);
    form.appendChild(send);

    var foot = el('div', 'edgeiq-chat-foot');
    foot.innerHTML = 'AI replies. Not a substitute for human review. <a href="/privacy.html">Privacy</a>';

    panel.appendChild(head);
    panel.appendChild(msgs);
    panel.appendChild(form);
    panel.appendChild(foot);

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // State
    var history = [];
    var busy = false;

    function addMsg(role, text, opts) {
      opts = opts || {};
      var div = el('div', 'edgeiq-msg ' + (opts.error ? 'error' : role));
      // Linkify URLs
      var safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      safe = safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      div.innerHTML = safe;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }

    function showTyping() {
      var t = el('div', 'edgeiq-typing');
      t.innerHTML = '<span></span><span></span><span></span>';
      msgs.appendChild(t);
      msgs.scrollTop = msgs.scrollHeight;
      return t;
    }

    function open() {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      btn.setAttribute('aria-expanded', 'true');
      try { localStorage.setItem(STORAGE_OPENED, '1'); } catch (e) {}
      if (history.length === 0) {
        addMsg('assistant', GREETING);
      }
      setTimeout(function () { input.focus(); }, 100);
    }
    function close() {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });

    async function send_message(text) {
      if (busy) return;
      busy = true;
      send.disabled = true;
      input.value = '';
      input.style.height = 'auto';

      addMsg('user', text);
      history.push({ role: 'user', content: text });

      var typing = showTyping();

      try {
        var resp = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history }),
        });
        var data = await resp.json().catch(function () { return null; });
        typing.remove();

        if (!data) {
          addMsg('assistant', "Couldn't reach the assistant just now. Try again in a moment, or email gpalmieri21@gmail.com.", { error: true });
        } else if (data.ok && data.reply) {
          addMsg('assistant', data.reply);
          history.push({ role: 'assistant', content: data.reply });
        } else {
          // Graceful fallback for unconfigured / rate-limited / no-credit states
          addMsg('assistant', data.reply || "Chat is temporarily unavailable.", { error: !data.ok });
        }
      } catch (err) {
        typing.remove();
        addMsg('assistant', "Network hiccup. Please try again — or email gpalmieri21@gmail.com.", { error: true });
      } finally {
        busy = false;
        send.disabled = false;
        input.focus();
      }
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || busy) return;
      send_message(text);
    });

    // Auto-grow textarea
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    });

    // Enter sends, Shift+Enter newline
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectStyles(); build(); });
  } else {
    injectStyles();
    build();
  }
})();
