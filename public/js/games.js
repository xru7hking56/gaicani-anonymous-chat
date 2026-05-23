/* ══════════════════════════════════════════════════════════════════
   games.js — Mini-Games for GAICANI Chat
   Depends on: socket.io (window.socket must be set in script.js)
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Wait until DOM + socket are ready ──────────────────────────
  function waitForSocket(cb) {
    if (window.socket) return cb(window.socket);
    let tries = 0;
    const iv = setInterval(() => {
      if (window.socket || ++tries > 100) {
        clearInterval(iv);
        if (window.socket) cb(window.socket);
        else console.warn('[games] socket never appeared on window');
      }
    }, 100);
  }

  waitForSocket(function (socket) {
    // ────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────
    const GAME_NAMES = {
      ttt:  '❌⭕  Tic Tac Toe',
      rps:  '✊✋✌️  Rock Paper Scissors',
      math: '🔢  Math Duel',
    };
    const RPS_EMOJI  = { rock: '✊', paper: '✋', scissors: '✌️' };
    const RPS_LABELS = { rock: 'ჭა', paper: 'ქაღალდი', scissors: 'მაკრატელი' };

    // ────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────
    let currentGame = null; // { type, role, opponentId, gameId }
    let rpsChosen   = false;

    // ────────────────────────────────────────────────────────────
    // DOM helpers
    // ────────────────────────────────────────────────────────────
    const el  = (id)  => document.getElementById(id);
    const qs  = (sel) => document.querySelector(sel);
    const qsa = (sel) => document.querySelectorAll(sel);

    // ────────────────────────────────────────────────────────────
    // 1.  Inject 🎮 button into top-bar
    // ────────────────────────────────────────────────────────────
    function injectGameButton() {
      const rightSide = qs('.right-side');
      if (!rightSide || el('gameBtn')) return;

      const btn = document.createElement('button');
      btn.id        = 'gameBtn';
      btn.className = 'game-btn';
      btn.disabled  = true;
      btn.title     = 'Play Games';
      btn.innerHTML =
        '<span class="btn-icon game-btn-icon">🎮</span>' +
        '<span class="btn-label">თამაში</span>';

      // Desktop: before changeNameBtn  |  Mobile: after interestsBtn
      const anchor = el('changeNameBtn');
      rightSide.insertBefore(btn, anchor);

      btn.addEventListener('click', toggleGameMenu);
    }

    // ────────────────────────────────────────────────────────────
    // 2.  Game Menu popup
    // ────────────────────────────────────────────────────────────
    function createGameMenu() {
      if (el('gameMenu')) return;
      const menu = document.createElement('div');
      menu.id        = 'gameMenu';
      menu.className = 'game-menu';
      menu.style.display = 'none';
      menu.innerHTML = `
        <div class="game-menu-header">
          <span class="game-menu-title">🎮 მინი თამაშები</span>
          <button class="game-menu-close" id="gameMenuClose">✕</button>
        </div>
        <div class="game-menu-list">
          <button class="game-menu-item" data-game="ttt">
            <span class="game-menu-icon">❌⭕</span>
            <div class="game-menu-info">
              <strong>Tic Tac Toe</strong>
              <small>3×3 ბადე · 3 ზედიზედ</small>
            </div>
          </button>
          <button class="game-menu-item" data-game="rps">
            <span class="game-menu-icon">✊✌️</span>
            <div class="game-menu-info">
              <strong>Rock Paper Scissors</strong>
              <small>ერთდროული არჩევანი</small>
            </div>
          </button>
          <button class="game-menu-item" data-game="math">
            <span class="game-menu-icon">🔢</span>
            <div class="game-menu-info">
              <strong>Math Duel</strong>
              <small>პირველი სწორი პასუხი იგებს</small>
            </div>
          </button>
        </div>`;
      document.body.appendChild(menu);

      el('gameMenuClose').addEventListener('click', () => { menu.style.display = 'none'; });

      qsa('.game-menu-item').forEach(btn => {
        btn.addEventListener('click', () => {
          menu.style.display = 'none';
          requestGame(btn.dataset.game);
        });
      });

      // Close on outside click
      document.addEventListener('click', e => {
        const _btn = el('gameBtn'); if (menu.style.display !== 'none' && !menu.contains(e.target) && !(_btn && _btn.contains(e.target)))
          menu.style.display = 'none';
      });
    }

    function toggleGameMenu() {
      const menu = el('gameMenu');
      if (!menu) return;
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    }

    // ────────────────────────────────────────────────────────────
    // 3.  Game overlay window
    // ────────────────────────────────────────────────────────────
    function createGameOverlay() {
      if (el('gameOverlay')) return;
      const overlay = document.createElement('div');
      overlay.id        = 'gameOverlay';
      overlay.className = 'game-overlay';
      overlay.style.display = 'none';
      overlay.innerHTML = `
        <div class="game-window">
          <div class="game-window-header">
            <span id="gameTitle" class="game-title"></span>
            <button id="gameCloseBtn" class="game-close-btn" title="დახურვა">✕</button>
          </div>
          <div id="gameContent" class="game-content"></div>
          <div id="gameResult" class="game-result" style="display:none">
            <div id="gameResultEmoji"  class="game-result-emoji"></div>
            <div id="gameResultText"   class="game-result-text"></div>
            <div class="game-result-actions">
              <button id="gameRematchBtn" class="game-rematch-btn">🔄 ხელახლა</button>
              <button id="gameExitBtn"    class="game-exit-btn">✕ დახურვა</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      el('gameCloseBtn').addEventListener('click',  closeGame);
      el('gameExitBtn') .addEventListener('click',  closeGame);
      el('gameRematchBtn').addEventListener('click', () => {
        if (!currentGame) return;
        const rematchType = currentGame.type;
        const rematchOpponent = currentGame.opponentId;
        closeGame(); // nulls currentGame — must read values first
        socket.emit('game:rematch', { gameType: rematchType, toId: rematchOpponent });
      });
    }

    function showOverlay() { el('gameOverlay').style.display = 'flex'; }
    function hideOverlay() { el('gameOverlay').style.display = 'none'; }

    function closeGame() {
      hideOverlay();
      currentGame = null;
      el('gameResult').style.display = 'none';
      el('gameContent').innerHTML = '';
    }

    // ────────────────────────────────────────────────────────────
    // 4.  Request / Invite flow
    // ────────────────────────────────────────────────────────────
    function requestGame(gameType) {
      socket.emit('game:request', { gameType });
      appendSystemMessage(`⏳ თამაშის მოთხოვნა გაიგზავნა: ${GAME_NAMES[gameType]}...`);
    }

    socket.on('game:invite', ({ gameType, fromId, isRematch }) => {
      const prefix = isRematch ? '🔄 ხელახლა' : '🎮 მოთხოვნა';
      showInviteBar(gameType, fromId, prefix);
      // Pulse the game button to signal incoming request
      const btn = el('gameBtn');
      if (btn) { btn.classList.add('game-btn--pulse'); }
    });

    function showInviteBar(gameType, fromId, prefix) {
      const existing = el('gameInviteBar');
      if (existing) existing.remove();

      const bar = document.createElement('div');
      bar.id        = 'gameInviteBar';
      bar.className = 'game-invite-bar';
      bar.innerHTML = `
        <span class="game-invite-text">${prefix}: <strong>${GAME_NAMES[gameType]}</strong></span>
        <div class="game-invite-actions">
          <button class="game-invite-accept"  id="gameAcceptBtn">✅ მიღება</button>
          <button class="game-invite-decline" id="gameDeclineBtn">❌ უარყოფა</button>
        </div>`;

      const chatInput = qs('.chat-input');
      if (chatInput) chatInput.prepend(bar);
      else document.body.appendChild(bar);

      let _inviteExpired = false;
      el('gameAcceptBtn').addEventListener('click', () => {
        if (_inviteExpired) return;
        _inviteExpired = true;
        bar.remove();
        clearGameBtnPulse();
        socket.emit('game:response', { accepted: true, gameType, toId: fromId });
      });
      el('gameDeclineBtn').addEventListener('click', () => {
        if (_inviteExpired) return;
        _inviteExpired = true;
        bar.remove();
        clearGameBtnPulse();
        socket.emit('game:response', { accepted: false, gameType, toId: fromId });
      });

      setTimeout(() => {
        if (el('gameInviteBar') && !_inviteExpired) {
          _inviteExpired = true;
          el('gameInviteBar').remove();
          clearGameBtnPulse();
          // Notify server so requester isn't left hanging
          socket.emit('game:response', { accepted: false, gameType, toId: fromId });
        }
      }, 30000);
    }

    function clearGameBtnPulse() {
      const btn = el('gameBtn');
      if (btn) btn.classList.remove('game-btn--pulse');
    }

    socket.on('game:declined', () => {
      appendSystemMessage('❌ თამაშის მოთხოვნა უარყოფილ იქნა.');
    });

    // ────────────────────────────────────────────────────────────
    // 5.  Game Start dispatcher
    // ────────────────────────────────────────────────────────────
    socket.on('game:start', ({ gameId, gameType, role, opponentId, state }) => {
      currentGame = { gameId, type: gameType, role, opponentId };

      el('gameTitle').textContent = GAME_NAMES[gameType];
      el('gameResult').style.display = 'none';
      el('gameContent').innerHTML = '';

      if (gameType === 'ttt')  renderTTT(state, role);
      else if (gameType === 'rps')  renderRPS();
      else if (gameType === 'math') renderMath(state);

      showOverlay();
    });

    // ────────────────────────────────────────────────────────────
    // 6.  TIC TAC TOE
    // ────────────────────────────────────────────────────────────
    function renderTTT(state, role) {
      const myTurn = state.currentTurnSocketId === socket.id;
      el('gameContent').innerHTML = `
        <div class="ttt-status" id="tttStatus">
          ${myTurn ? '🟢 შენი რიგია <strong>(' + role + ')</strong>' : '⏳ მოწინააღმდეგის რიგია...'}
        </div>
        <div class="ttt-board" id="tttBoard">
          ${Array(9).fill(null).map((_, i) => `
            <button class="ttt-cell" data-index="${i}" ${(!myTurn || state.board[i]) ? 'disabled' : ''}>${state.board[i] || ''}</button>
          `).join('')}
        </div>
        <div class="ttt-role-badge">შენ ხარ: <strong class="ttt-role-symbol">${role}</strong></div>`;

      qsa('.ttt-cell').forEach(cell => {
        cell.addEventListener('click', () => {
          socket.emit('game:move', { index: parseInt(cell.dataset.index) });
        });
      });
    }

    function updateTTT({ board, currentTurnSocketId, winnerSocketId, winLine, draw }) {
      if (!currentGame || currentGame.type !== 'ttt') return;

      const cells  = qsa('.ttt-cell');
      const myTurn = !winnerSocketId && !draw && currentTurnSocketId === socket.id;

      board.forEach((val, i) => {
        if (!cells[i]) return;
        cells[i].textContent = val || '';
        cells[i].dataset.val = val || '';
        cells[i].disabled    = !myTurn || !!val;
        cells[i].className   = 'ttt-cell' + (val ? ' ttt-cell--' + val.toLowerCase() : '');
      });

      if (winLine) winLine.forEach(i => cells[i] && cells[i].classList.add('ttt-cell--winner'));

      const status = el('tttStatus');
      if (winnerSocketId || draw) {
        cells.forEach(c => (c.disabled = true));
        if (status) status.textContent = '';
        const won = winnerSocketId === socket.id;
        showResult(draw ? '🤝' : won ? '🏆' : '😔',
                   draw ? 'ფრე!' : won ? 'გაიმარჯვე!' : 'წააგე!');
      } else if (status) {
        status.innerHTML = myTurn
          ? '🟢 შენი რიგია <strong>(' + currentGame.role + ')</strong>'
          : '⏳ მოწინააღმდეგის რიგია...';
      }
    }

    // ────────────────────────────────────────────────────────────
    // 7.  ROCK PAPER SCISSORS
    // ────────────────────────────────────────────────────────────
    function renderRPS() {
      rpsChosen = false;
      el('gameContent').innerHTML = `
        <div class="rps-status" id="rpsStatus">🎯 აირჩიე!</div>
        <div class="rps-choices" id="rpsChoices">
          <button class="rps-btn" data-choice="rock">
            <span class="rps-emoji">✊</span>
            <span class="rps-label">ჭა</span>
          </button>
          <button class="rps-btn" data-choice="paper">
            <span class="rps-emoji">✋</span>
            <span class="rps-label">ქაღალდი</span>
          </button>
          <button class="rps-btn" data-choice="scissors">
            <span class="rps-emoji">✌️</span>
            <span class="rps-label">მაკრატელი</span>
          </button>
        </div>
        <div class="rps-opponent-status" id="rpsOpponentStatus"></div>
        <div class="rps-reveal" id="rpsReveal" style="display:none"></div>`;

      qsa('.rps-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (rpsChosen) return;
          rpsChosen = true;
          const choice = btn.dataset.choice;
          qsa('.rps-btn').forEach(b => {
            b.disabled = true;
            b.classList.toggle('rps-btn--selected', b === btn);
          });
          el('rpsStatus').textContent = `✅ შენ: ${RPS_EMOJI[choice]} ${RPS_LABELS[choice]}`;
          el('rpsOpponentStatus').textContent = '⏳ ელოდება მოწინააღმდეგეს...';
          socket.emit('game:move', { choice });
        });
      });
    }

    function updateRPS({ opponentChose, choices, winnerSocketId, draw }) {
      if (!currentGame || currentGame.type !== 'rps') return;

      if (opponentChose && !choices) {
        const os = el('rpsOpponentStatus');
        if (os) os.textContent = '✅ მოწინააღმდეგემ აირჩია! — ელოდება შენ...';
        return;
      }

      if (choices) {
        const os = el('rpsOpponentStatus');
        if (os) os.textContent = '';

        const myChoice    = choices[socket.id];
        const theirId     = Object.keys(choices).find(id => id !== socket.id);
        const theirChoice = choices[theirId];

        const reveal = el('rpsReveal');
        if (reveal) {
          reveal.style.display = 'flex';
          reveal.innerHTML = `
            <div class="rps-reveal-item">
              <div class="rps-reveal-emoji">${RPS_EMOJI[myChoice]}</div>
              <div class="rps-reveal-name">შენ</div>
            </div>
            <div class="rps-reveal-vs">VS</div>
            <div class="rps-reveal-item">
              <div class="rps-reveal-emoji">${RPS_EMOJI[theirChoice]}</div>
              <div class="rps-reveal-name">ისინი</div>
            </div>`;
        }

        const won = winnerSocketId === socket.id;
        showResult(
          draw ? '🤝' : won ? '🏆' : '😔',
          draw ? 'ფრე!' : won ? 'გაიმარჯვე!' : 'წააგე!'
        );
      }
    }

    // ────────────────────────────────────────────────────────────
    // 8.  MATH DUEL
    // ────────────────────────────────────────────────────────────
    function renderMath(state) {
      el('gameContent').innerHTML = `
        <div class="math-status" id="mathStatus">🔢 პირველი სწორი პასუხი იგებს!</div>
        <div class="math-question" id="mathQuestion">${state.question.display} = ?</div>
        <div class="math-input-row">
          <input type="number" id="mathAnswer" class="math-input"
                 placeholder="შეიყვანე პასუხი..."
                 autocomplete="off" inputmode="numeric" />
          <button id="mathSubmit" class="math-submit-btn">✅</button>
        </div>
        <div class="math-feedback" id="mathFeedback"></div>`;

      const input  = el('mathAnswer');
      const submit = el('mathSubmit');

      function tryAnswer() {
        const val = input.value.trim();
        if (!val) return;
        socket.emit('game:move', { answer: parseInt(val, 10) });
        input.value = '';
        input.focus();
      }

      submit.addEventListener('click', tryAnswer);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') tryAnswer(); });

      // Auto-focus after a short delay (overlay animation)
      setTimeout(() => { if (input) input.focus(); }, 300);
    }

    function updateMath({ wrong, winnerSocketId, answer, question }) {
      if (!currentGame || currentGame.type !== 'math') return;

      if (wrong) {
        const fb = el('mathFeedback');
        if (fb) {
          fb.textContent  = '❌ არასწორია! სცადე ხელახლა.';
          fb.className    = 'math-feedback math-feedback--wrong';
          setTimeout(() => { if (fb) { fb.textContent = ''; fb.className = 'math-feedback'; } }, 1500);
        }
        return;
      }

      if (winnerSocketId !== undefined) {
        const status = el('mathStatus');
        if (status && question) status.textContent = `✅ სწორი პასუხი: ${question.display} = ${answer}`;

        const inp = el('mathAnswer');
        const sub = el('mathSubmit');
        if (inp) inp.disabled = true;
        if (sub) sub.disabled = true;

        const won = winnerSocketId === socket.id;
        showResult(
          won ? '🏆' : '😔',
          won ? 'გაიმარჯვე! პირველი სწორი!' : 'წააგე! მოწინააღმდეგე სწრაფი იყო.'
        );
      }
    }

    // ────────────────────────────────────────────────────────────
    // 9.  Unified socket update handler
    // ────────────────────────────────────────────────────────────
    socket.on('game:update', data => {
      if (!currentGame) return;
      if (currentGame.type === 'ttt')  updateTTT(data);
      else if (currentGame.type === 'rps')  updateRPS(data);
      else if (currentGame.type === 'math') updateMath(data);
    });

    socket.on('game:partnerLeft', () => {
      appendSystemMessage('🎮 მოწინააღმდეგე გათიშა — თამაში გაუქმდა.');
      closeGame();
    });

    // ────────────────────────────────────────────────────────────
    // 10. Result overlay
    // ────────────────────────────────────────────────────────────
    function showResult(emoji, text) {
      const result = el('gameResult');
      el('gameResultEmoji').textContent = emoji;
      el('gameResultText').textContent  = text;

      result.className = 'game-result ' + (
        text.includes('გაიმარჯვე') ? 'game-result--win'  :
        text.includes('ფრე')        ? 'game-result--draw' : 'game-result--lose'
      );
      result.style.display = 'flex';
    }

    // ────────────────────────────────────────────────────────────
    // 11. Enable / disable game button based on partner status
    // ────────────────────────────────────────────────────────────
    function setGameBtnEnabled(on) {
      const btn = el('gameBtn');
      if (btn) btn.disabled = !on;
    }

    // These event names match what the server actually emits:
    function onPartnerConnected() { setGameBtnEnabled(true); }
    function onPartnerGone() {
      setGameBtnEnabled(false);
      clearGameBtnPulse();
      const bar = el('gameInviteBar');
      if (bar) bar.remove();
      if (currentGame) closeGame();
    }

    socket.on('partnerFound',       onPartnerConnected);
    socket.on('partnerRestored',    onPartnerConnected);
    socket.on('partnerReconnected', onPartnerConnected);

    socket.on('partnerDisconnected', onPartnerGone);
    socket.on('youWereBlocked',      onPartnerGone);
    socket.on('queuePosition', () => setGameBtnEnabled(false));
    socket.on('partnerReconnecting', () => {
      setGameBtnEnabled(false);
      clearGameBtnPulse();
      const bar = el('gameInviteBar');
      if (bar) bar.remove();
    });

    // ────────────────────────────────────────────────────────────
    // 12. Utility — append system message to chat
    // ────────────────────────────────────────────────────────────
    function appendSystemMessage(text) {
      const chat = el('chat');
      if (!chat) return;
      const div = document.createElement('div');
      div.className   = 'system-message';
      div.textContent = text;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    // ────────────────────────────────────────────────────────────
    // Init
    // ────────────────────────────────────────────────────────────
    function init() {
      injectGameButton();
      createGameMenu();
      createGameOverlay();
    }

    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', init);
    else
      init();
  });

})();
