'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const crypto     = require('crypto');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 5e6, // 5 MB — needed for voice audio chunks
});

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const BLOCK_LIMIT   = 10;
const RECONNECT_TTL = 30000; // 30 s reconnect window

// ── In-memory stores ──────────────────────────────────────────────────────────
const users        = new Map(); // socketId → userObj
const nameIndex    = new Map(); // name (lower) → socketId
const queue        = [];        // waiting socket ids
const pairs        = new Map(); // socketId → partnerId
const challenges   = new Map(); // token → { nonce, expires }
const pendingRecon = new Map(); // name (lower) → { partnerId, timer, bio }
const gameRooms    = new Map(); // gameId → { type, players, state }

// ── Random data ───────────────────────────────────────────────────────────────
const FACTS = [
  "Honey never spoils — archaeologists found 3000-year-old honey in Egyptian tombs.",
  "A group of flamingos is called a flamboyance.",
  "The shortest war in history lasted only 38–45 minutes (Anglo-Zanzibar War, 1896).",
  "Octopuses have three hearts and blue blood.",
  "Bananas are technically berries, but strawberries are not.",
  "The Eiffel Tower can be 15 cm taller in summer due to thermal expansion.",
  "A day on Venus is longer than a year on Venus.",
  "Cleopatra lived closer in time to the Moon landing than to the Great Pyramid's construction.",
  "Water can boil and freeze at the same time — it's called the triple point.",
  "The human nose can detect over 1 trillion distinct scents.",
  "Crows can recognize human faces and hold grudges.",
  "There are more possible iterations of a game of chess than atoms in the observable universe.",
  "Wombat poop is cube-shaped — they use it to mark territory.",
  "The average person walks about 100,000 miles in their lifetime.",
  "A bolt of lightning is five times hotter than the surface of the Sun.",
  "Sharks are older than trees — they've been around for ~450 million years.",
  "The world's oldest known living tree is over 5,000 years old.",
  "Cats can't taste sweetness — they lack the taste receptors for it.",
  "There are more stars in the universe than grains of sand on all Earth's beaches.",
  "The inventor of the Pringles can was buried in one.",
];

const QUESTIONS = [
  "If you could live in any era of history, which would you pick?",
  "What's the most useless talent you have?",
  "Would you rather be invisible or be able to fly?",
  "What's the weirdest dream you remember?",
  "If you could instantly master one skill, what would it be?",
  "What's the last thing that made you laugh until you cried?",
  "What fictional world would you most want to live in?",
  "If animals could talk, which would be the rudest?",
  "What's a conspiracy theory you secretly find plausible?",
  "If you had a warning label, what would it say?",
  "What's the most embarrassing song on your playlist?",
  "What's something you believed as a child that turned out to be completely wrong?",
  "If your life were a movie, what genre would it be?",
  "What would you do if you woke up and had become 10 years younger?",
  "What's one thing you're irrationally afraid of?",
  "If you could uninvent one thing, what would it be?",
  "What's your most unpopular opinion?",
  "What's a small thing that instantly makes your day better?",
  "If you could ask your future self one question, what would it be?",
  "What's the most adventurous thing you've ever done?",
];

// ── API ───────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/challenge', (_req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const nonce = Math.floor(Math.random() * 100000);
  challenges.set(token, { nonce, expires: Date.now() + 60000 });
  for (const [t, v] of challenges) if (v.expires < Date.now()) challenges.delete(t);
  res.json({ token, nonce });
});

app.get('/api/random-fact', (_req, res) => {
  res.json({ fact: FACTS[Math.floor(Math.random() * FACTS.length)] });
});

app.get('/api/random-question', (_req, res) => {
  res.json({ question: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] });
});

// GIF proxy — uses Tenor v2.  Set TENOR_API_KEY env var.
// Get a free key at https://tenor.com/developer/dashboard
app.get('/api/gifs', async (req, res) => {
  const KLIPY_KEY = process.env.KLIPY_API_KEY || 'GNtnB78Y87TMg4nnafoaXntoaH7QDl6b77NQfg6ScXoXkMbNgAAfZNUCje5n1ONW';
  const q         = (req.query.q || '').trim();

  if (!KLIPY_KEY) return res.json({ results: [] });

  try {
    // 1. Swap the Google/Tenor URL for Klipy
    const base   = 'https://api.klipy.com/v2'; 
    const common = `key=${KLIPY_KEY}&limit=20&mediafilter=tinygif,gif&contentfilter=low`;
    
    const url    = q
      ? `${base}/search?q=${encodeURIComponent(q)}&${common}`
      : `${base}/featured?${common}`;

    const r    = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('Klipy error:', err.message);
    res.json({ results: [] });
  }
});

app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// FIX: only count users who have actually set their name
function broadcastOnlineCount() {
  io.emit('onlineCount', users.size);
}

function removeFromQueue(socketId) {
  const idx = queue.indexOf(socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

function tryMatchQueue() {
  while (queue.length >= 2) {
    const idA = queue.shift();
    const idB = queue.shift();
    const uA  = users.get(idA);
    const uB  = users.get(idB);
    if (!uA || !uB) continue;

    pairs.set(idA, idB);
    pairs.set(idB, idA);

    io.to(idA).emit('partnerFound', { name: uB.name, partnerBio: uB.bio || '' });
    io.to(idB).emit('partnerFound', { name: uA.name, partnerBio: uA.bio || '' });
  }
}

function disconnectPartner(socketId) {
  const partnerId = pairs.get(socketId);
  if (!partnerId) return;
  pairs.delete(socketId);
  pairs.delete(partnerId);
  const uSelf = users.get(socketId);
  io.to(partnerId).emit('partnerDisconnected', { name: uSelf ? uSelf.name : '' });
}

// ── Game helpers ──────────────────────────────────────────────────────────────
function newTTTState(players) {
  return {
    board: Array(9).fill(null),
    currentTurnSocketId: players[0], // X always goes first
  };
}

function tttWinner(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { mark: board[a], line: [a,b,c] };
  }
  return null;
}

function generateMathQuestion() {
  const ops = ['+', '-', '*'];
  const op  = ops[Math.floor(Math.random() * ops.length)];
  let a, b, answer;
  if (op === '+') { a = Math.floor(Math.random()*50)+1;  b = Math.floor(Math.random()*50)+1; answer = a+b; }
  if (op === '-') { a = Math.floor(Math.random()*50)+10; b = Math.floor(Math.random()*a)+1;  answer = a-b; }
  if (op === '*') { a = Math.floor(Math.random()*12)+2;  b = Math.floor(Math.random()*12)+2; answer = a*b; }
  return { display: `${a} ${op} ${b}`, answer };
}

function startGame(gameType, players) {
  const gameId = `${gameType}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const [idA, idB] = players;

  if (gameType === 'ttt') {
    const state = newTTTState(players);
    gameRooms.set(gameId, { type: gameType, players, state });
    // FIX: emit "game:start" (matches client listener), include full state with currentTurnSocketId
    io.to(idA).emit('game:start', {
      gameId, gameType,
      role: 'X',
      opponentId: idB,
      state: { board: state.board, currentTurnSocketId: state.currentTurnSocketId },
    });
    io.to(idB).emit('game:start', {
      gameId, gameType,
      role: 'O',
      opponentId: idA,
      state: { board: state.board, currentTurnSocketId: state.currentTurnSocketId },
    });
  } else if (gameType === 'rps') {
    const state = { choices: {} };
    gameRooms.set(gameId, { type: gameType, players, state });
    players.forEach(id =>
      io.to(id).emit('game:start', { gameId, gameType, opponentId: players.find(p => p !== id) })
    );
  } else if (gameType === 'math') {
    const question = generateMathQuestion();
    const state    = { question, answered: false };
    gameRooms.set(gameId, { type: gameType, players, state });
    players.forEach(id =>
      io.to(id).emit('game:start', { gameId, gameType, opponentId: players.find(p => p !== id), state: { question } })
    );
  }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("CONNECTED:", socket.id);

  socket.onAny((event, ...args) => {
    console.log("EVENT:", event);
  });
  // NOTE: do NOT broadcastOnlineCount() here — user hasn't set name yet

  // ── setName ──────────────────────────────────────────────────────────────
  socket.on('setName', ({ name, token, powAnswer, webdriver }) => {
    if (webdriver) { socket.disconnect(); return; }

    const ch = challenges.get(token);
    if (!ch || ch.expires < Date.now()) { socket.emit('tokenInvalid'); return; }
    const expected = (ch.nonce * 31 + ch.nonce % 97);
    challenges.delete(token);
    if (powAnswer !== expected) { socket.emit('tokenInvalid'); return; }

    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed || trimmed.length < 2) { socket.emit('nameError', 'Invalid name'); return; }

    const key = trimmed.toLowerCase();

    // Check for name collision with a live socket
    const existing = nameIndex.get(key);
    if (existing && existing !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existing);
      if (existingSocket && existingSocket.connected) {
        socket.emit('nameTaken');
        return;
      }
      users.delete(existing);
      nameIndex.delete(key);
    }

    // Check pending reconnect
    const recon = pendingRecon.get(key);
    if (recon) {
      clearTimeout(recon.timer);
      pendingRecon.delete(key);

      const userObj = { name: trimmed, bio: recon.bio || '', blocks: new Set(), blockCount: 0 };
      users.set(socket.id, userObj);
      nameIndex.set(key, socket.id);
      broadcastOnlineCount();

      const partnerId  = recon.partnerId;
      const partnerObj = users.get(partnerId);
      if (partnerObj) {
        pairs.set(socket.id, partnerId);
        pairs.set(partnerId, socket.id);
        socket.emit('nameAccepted', trimmed);
        socket.emit('partnerRestored', { name: partnerObj.name });
        io.to(partnerId).emit('partnerReconnected', { name: trimmed });
      } else {
        socket.emit('nameAccepted', trimmed);
      }
      return;
    }

    // Fresh registration
    const userObj = { name: trimmed, bio: '', blocks: new Set(), blockCount: 0 };
    users.set(socket.id, userObj);
    nameIndex.set(key, socket.id);
    socket.emit('nameAccepted', trimmed);
    broadcastOnlineCount();
  });

// ── changeName ───────────────────────────────────────────────────────────
socket.on('changeName', (newName) => {

  const user = users.get(socket.id);
  if (!user) return;

  const trimmed = (newName || '').trim().slice(0, 20);

  if (!trimmed || trimmed.length < 2) {
    socket.emit('nameError', 'Invalid name');
    return;
  }

  const newKey = trimmed.toLowerCase();
  const oldKey = user.name.toLowerCase();

  // same name
  if (newKey === oldKey) return;

  // already used
  const existing = nameIndex.get(newKey);

  if (existing && existing !== socket.id) {

    const existingSocket = io.sockets.sockets.get(existing);

    if (existingSocket && existingSocket.connected) {
      socket.emit('nameTaken');
      return;
    }

    users.delete(existing);
    nameIndex.delete(newKey);
  }

  // update name index
  nameIndex.delete(oldKey);

  user.name = trimmed;

  nameIndex.set(newKey, socket.id);

  // update self
  socket.emit('nameChanged', {
    name: trimmed
  });

  // update partner
  const partnerId = pairs.get(socket.id);

  if (partnerId) {
    io.to(partnerId).emit('partnerNameChanged', {
      name: trimmed
    });
  }

  console.log(`NAME CHANGE: ${oldKey} -> ${newKey}`);
});

  // ── setBio ────────────────────────────────────────────────────────────────
  socket.on('setBio', (bio) => {
    const u = users.get(socket.id);
    if (u) u.bio = String(bio || '').slice(0, 60);
  });

  // ── findPartner ───────────────────────────────────────────────────────────
  socket.on('findPartner', () => {
    const u = users.get(socket.id);
    if (!u) return;
    if (pairs.has(socket.id)) disconnectPartner(socket.id);
    removeFromQueue(socket.id);
    queue.push(socket.id);
    socket.emit('waitingForPartner');
    tryMatchQueue();
  });

  // ── next ──────────────────────────────────────────────────────────────────
  socket.on('next', () => {
    disconnectPartner(socket.id);
    removeFromQueue(socket.id);
  });

  // ── message ───────────────────────────────────────────────────────────────
  socket.on('message', ({ text, messageId, replyTo }) => {
    const u = users.get(socket.id);
    if (!u) return;
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;

    const cleaned = String(text || '').trim().slice(0, 2000);
    if (!cleaned) return;

    if (/https?:\/\/|www\./i.test(cleaned)) {
      socket.emit('linkKicked');
      io.to(partnerId).emit('partnerLinkKicked');
      disconnectPartner(socket.id);
      return;
    }

    io.to(partnerId).emit('message', { text: cleaned, messageId, replyTo: replyTo || null });
  });

  // ── typing ────────────────────────────────────────────────────────────────
  socket.on('typing', (isTyping) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('partnerTyping', isTyping);
  });

  // ── seen ──────────────────────────────────────────────────────────────────
  socket.on('seen', ({ messageId }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('partnerSeen', { messageId });
  });

  // ── react ─────────────────────────────────────────────────────────────────
  socket.on('react', ({ messageId, emoji }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('reacted', { messageId, emoji });
  });

  // ── gif ───────────────────────────────────────────────────────────────────
  socket.on('gif', ({ url, preview }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('gif', { url, preview });
  });

  // ── sendQuestion ──────────────────────────────────────────────────────────
  socket.on('sendQuestion', ({ text }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('partnerQuestion', { text });
  });

  // ── voice message (base64 audio) ──────────────────────────────────────────
  // Client sends: { audioData: <base64 string>, duration: <seconds> }
  socket.on('voiceMessage', ({ audioData, duration }) => {
    const u = users.get(socket.id);
    if (!u) return;
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;
    // Basic size guard: base64 of 3 MB raw ≈ 4 MB string
    if (!audioData || typeof audioData !== 'string' || audioData.length > 4_000_000) return;
    const clampedDuration = Math.min(Number(duration) || 0, 120);
    io.to(partnerId).emit('voiceMessage', { audioData, duration: clampedDuration });
  });

  // ── blockUser ─────────────────────────────────────────────────────────────
  socket.on('blockUser', ({ targetName }) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (u.blockCount >= BLOCK_LIMIT) { socket.emit('blockLimitReached'); return; }

    const targetKey = String(targetName || '').toLowerCase();
    const targetId  = nameIndex.get(targetKey);

    u.blocks.add(targetKey);
    u.blockCount++;

    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      pairs.delete(socket.id);
      pairs.delete(partnerId);
      io.to(partnerId).emit('youWereBlocked', { name: u.name });
    }

    socket.emit('userBlocked', { name: targetName });
  });

  // ── Games ─────────────────────────────────────────────────────────────────

  socket.on('game:request', ({ gameType }) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit('game:invite', { gameType, fromId: socket.id, isRematch: false });
  });

  // FIX: client sends "game:response" (not "game:accept"/"game:decline")
  socket.on('game:response', ({ accepted, gameType, toId }) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId || partnerId !== toId) return;

    if (!accepted) {
      io.to(toId).emit('game:declined');
      return;
    }

    // Both are paired — start the game
    startGame(gameType, [toId, socket.id]);
  });

  socket.on('game:move', (data) => {
    let room = null, gameId = null;
    for (const [gid, r] of gameRooms) {
      if (r.players.includes(socket.id)) { room = r; gameId = gid; break; }
    }
    if (!room) return;

    const { type, players, state } = room;
    const opponentId = players.find(id => id !== socket.id);

    if (type === 'ttt') {
      // FIX: client sends "index" not "cell"
      const idx = data.index;
      if (typeof idx !== 'number' || idx < 0 || idx > 8) return;
      if (state.currentTurnSocketId !== socket.id) return;
      if (state.board[idx]) return;

      const mark = players[0] === socket.id ? 'X' : 'O';
      state.board[idx] = mark;

      const result = tttWinner(state.board);
      const draw   = !result && state.board.every(c => c);

      // Switch turn
      state.currentTurnSocketId = opponentId;

      const update = {
        board: state.board,
        currentTurnSocketId: state.currentTurnSocketId,
      };

      if (result) {
        update.winnerSocketId = socket.id;
        update.winLine        = result.line;
        gameRooms.delete(gameId);
      } else if (draw) {
        update.draw = true;
        gameRooms.delete(gameId);
      }

      players.forEach(id => io.to(id).emit('game:update', update));

    } else if (type === 'rps') {
      const { choice } = data;
      if (!['rock','paper','scissors'].includes(choice)) return;
      if (state.choices[socket.id]) return;
      state.choices[socket.id] = choice;

      if (opponentId) io.to(opponentId).emit('game:update', { opponentChose: true });

      if (Object.keys(state.choices).length === 2) {
        const [idA, idB] = players;
        const cA = state.choices[idA], cB = state.choices[idB];
        const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
        let winnerSocketId = null;
        if (cA !== cB) winnerSocketId = beats[cA] === cB ? idA : idB;
        const res = { choices: state.choices, winnerSocketId, draw: !winnerSocketId };
        players.forEach(id => io.to(id).emit('game:update', res));
        gameRooms.delete(gameId);
      }

    } else if (type === 'math') {
      if (state.answered) return;
      const { answer } = data;
      if (answer === state.question.answer) {
        state.answered = true;
        const res = { winnerSocketId: socket.id, answer, question: state.question };
        players.forEach(id => io.to(id).emit('game:update', res));
        gameRooms.delete(gameId);
      } else {
        socket.emit('game:update', { wrong: true });
      }
    }
  });

  socket.on('game:rematch', ({ gameType, toId }) => {
    if (!pairs.get(socket.id)) return;
    io.to(toId).emit('game:invite', { gameType, fromId: socket.id, isRematch: true });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[-] disconnect ${socket.id} (${reason})`);
    const u = users.get(socket.id);
    if (!u) return; // never completed setName — no cleanup needed

    const key       = u.name.toLowerCase();
    const partnerId = pairs.get(socket.id);

    removeFromQueue(socket.id);

    if (partnerId) {
      pairs.delete(socket.id);
      pairs.delete(partnerId);

      const timer = setTimeout(() => {
        pendingRecon.delete(key);
        io.to(partnerId).emit('partnerDisconnected', { name: u.name });
      }, RECONNECT_TTL);

      pendingRecon.set(key, { partnerId, timer, bio: u.bio });
      io.to(partnerId).emit('partnerReconnecting', { name: u.name });
    }

    // Clean up game rooms
    for (const [gameId, room] of gameRooms) {
      if (room.players.includes(socket.id)) {
        const opp = room.players.find(id => id !== socket.id);
        if (opp) io.to(opp).emit('game:partnerLeft');
        gameRooms.delete(gameId);
      }
    }

    users.delete(socket.id);
    if (nameIndex.get(key) === socket.id) nameIndex.delete(key);
    broadcastOnlineCount();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ GAICANI running at http://localhost:${PORT}`);
});
