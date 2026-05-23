'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const crypto    = require('crypto');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const BLOCK_LIMIT    = 10;
const RECONNECT_TTL  = 30000; // 30 s reconnect window

// ── In-memory stores ───────────────────────────────────────────────────────────
const users        = new Map();   // socketId → userObj
const nameIndex    = new Map();   // name (lower) → socketId
const queue        = [];          // waiting socket ids
const pairs        = new Map();   // socketId → partnerId
const challenges   = new Map();   // token → { nonce, expires }
const pendingRecon = new Map();   // name (lower) → { partnerId, timer, bio }

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

// ── API routes ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Challenge token (proof-of-work anti-bot)
app.get('/api/challenge', (_req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const nonce = Math.floor(Math.random() * 100000);
  challenges.set(token, { nonce, expires: Date.now() + 60000 });
  // Clean up old tokens
  for (const [t, v] of challenges) if (v.expires < Date.now()) challenges.delete(t);
  res.json({ token, nonce });
});

// Random fact
app.get('/api/random-fact', (_req, res) => {
  res.json({ fact: FACTS[Math.floor(Math.random() * FACTS.length)] });
});

// Random question
app.get('/api/random-question', (_req, res) => {
  res.json({ question: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] });
});

// GIF proxy (Tenor) — set TENOR_API_KEY env var for real GIFs
app.get('/api/gifs', async (req, res) => {
  const TENOR_KEY = process.env.TENOR_API_KEY || '';
  const q         = req.query.q || '';
  if (!TENOR_KEY) {
    // Return empty results if no key configured
    return res.json({ results: [] });
  }
  try {
    const endpoint = q
      ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=20&media_filter=gif,tinygif`
      : `https://tenor.googleapis.com/v2/featured?key=${TENOR_KEY}&limit=20&media_filter=gif,tinygif`;
    const r    = await fetch(endpoint);
    const data = await r.json();
    res.json(data);
  } catch {
    res.json({ results: [] });
  }
});

// Fallback for SPA routes
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    if (!uA || !uB) continue; // stale entry — try next pair

    pairs.set(idA, idB);
    pairs.set(idB, idA);

    io.to(idA).emit('partnerFound', { name: uB.name, partnerBio: uB.bio || '' });
    io.to(idB).emit('partnerFound', { name: uA.name, partnerBio: uA.bio || '' });
  }
}

function disconnectPartner(socketId, reason) {
  const partnerId = pairs.get(socketId);
  if (!partnerId) return;
  pairs.delete(socketId);
  pairs.delete(partnerId);
  const uSelf = users.get(socketId);
  io.to(partnerId).emit('partnerDisconnected', { name: uSelf ? uSelf.name : '' });
}

// ── Game state ────────────────────────────────────────────────────────────────
const gameRooms = new Map(); // gameId → { type, players: [id,id], state }

function newTTTState() {
  return { board: Array(9).fill(null), turn: 0 }; // turn index into players[]
}

function tttWinner(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function generateMathQuestion() {
  const ops  = ['+', '-', '*'];
  const op   = ops[Math.floor(Math.random() * ops.length)];
  let a, b, answer;
  if (op === '+') { a = Math.floor(Math.random()*50)+1; b = Math.floor(Math.random()*50)+1; answer = a+b; }
  if (op === '-') { a = Math.floor(Math.random()*50)+10; b = Math.floor(Math.random()*a)+1; answer = a-b; }
  if (op === '*') { a = Math.floor(Math.random()*12)+2; b = Math.floor(Math.random()*12)+2; answer = a*b; }
  return { display: `${a} ${op} ${b}`, answer };
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] connect ${socket.id}`);
  broadcastOnlineCount();

  // ── setName ──────────────────────────────────────────────────────────────
  socket.on('setName', ({ name, token, powAnswer, webdriver }) => {
    if (webdriver) { socket.disconnect(); return; }

    // Validate challenge token
    const ch = challenges.get(token);
    if (!ch || ch.expires < Date.now()) {
      socket.emit('tokenInvalid');
      return;
    }
    const expected = (ch.nonce * 31 + ch.nonce % 97);
    challenges.delete(token);
    if (powAnswer !== expected) { socket.emit('tokenInvalid'); return; }

    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed || trimmed.length < 2) { socket.emit('nameError', 'Invalid name'); return; }

    const key = trimmed.toLowerCase();

    // Check for reconnect (same name re-joining within TTL)
    const existing = nameIndex.get(key);
    if (existing && existing !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existing);
      if (existingSocket && existingSocket.connected) {
        socket.emit('nameTaken');
        return;
      }
      // Old socket is gone — take over the name
      users.delete(existing);
      nameIndex.delete(key);
    }

    // Check pending reconnect (partner is waiting for us)
    const recon = pendingRecon.get(key);
    if (recon) {
      clearTimeout(recon.timer);
      pendingRecon.delete(key);

      // Re-register user
      const userObj = { name: trimmed, bio: recon.bio || '', blocks: new Set(), blockCount: 0 };
      users.set(socket.id, userObj);
      nameIndex.set(key, socket.id);

      const partnerId = recon.partnerId;
      const partnerObj = users.get(partnerId);

      if (partnerObj) {
        pairs.set(socket.id, partnerId);
        pairs.set(partnerId, socket.id);
        socket.emit('nameAccepted', trimmed);
        socket.emit('partnerRestored', { name: partnerObj.name });
        io.to(partnerId).emit('partnerReconnected', { name: trimmed });
        return;
      }
    }

    // Normal registration
    const userObj = { name: trimmed, bio: '', blocks: new Set(), blockCount: 0 };
    users.set(socket.id, userObj);
    nameIndex.set(key, socket.id);
    socket.emit('nameAccepted', trimmed);
    broadcastOnlineCount();
  });

  // ── setBio ───────────────────────────────────────────────────────────────
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

    // Simple link detection — kick sender
    if (/https?:\/\/|www\./i.test(cleaned)) {
      io.to(socket.id).emit('linkKicked');
      io.to(partnerId).emit('partnerLinkKicked');
      disconnectPartner(socket.id);
      removeFromQueue(socket.id);
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

  // ── blockUser ─────────────────────────────────────────────────────────────
  socket.on('blockUser', ({ targetName }) => {
    const u = users.get(socket.id);
    if (!u) return;

    if (u.blockCount >= BLOCK_LIMIT) {
      socket.emit('blockLimitReached');
      return;
    }

    const targetKey = String(targetName || '').toLowerCase();
    const targetId  = nameIndex.get(targetKey);

    u.blocks.add(targetKey);
    u.blockCount++;

    // Disconnect from partner if it's the same person
    const partnerId = pairs.get(socket.id);
    if (partnerId === targetId || (!targetId && partnerId)) {
      const partnerObj = users.get(partnerId);
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

  socket.on('game:accept', ({ gameType, fromId }) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId || partnerId !== fromId) return;

    const gameId = `${gameType}_${socket.id}_${Date.now()}`;
    const players = [fromId, socket.id];
    let state;

    if (gameType === 'ttt') {
      state = newTTTState();
      gameRooms.set(gameId, { type: gameType, players, state });
      io.to(players[0]).emit('game:started', { gameId, gameType, role: 'X', yourTurn: true });
      io.to(players[1]).emit('game:started', { gameId, gameType, role: 'O', yourTurn: false });
    } else if (gameType === 'rps') {
      state = { choices: {}, ready: 0 };
      gameRooms.set(gameId, { type: gameType, players, state });
      players.forEach(id => io.to(id).emit('game:started', { gameId, gameType }));
    } else if (gameType === 'math') {
      const question = generateMathQuestion();
      state = { question, answered: false };
      gameRooms.set(gameId, { type: gameType, players, state });
      players.forEach(id => io.to(id).emit('game:started', { gameId, gameType, question }));
    }
  });

  socket.on('game:decline', ({ fromId }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(fromId).emit('game:declined');
  });

  socket.on('game:move', (data) => {
    // Find game this socket is in
    let room = null, gameId = null;
    for (const [gid, r] of gameRooms) {
      if (r.players.includes(socket.id)) { room = r; gameId = gid; break; }
    }
    if (!room) return;

    const { type, players, state } = room;
    const opponentId = players.find(id => id !== socket.id);

    if (type === 'ttt') {
      const { cell } = data;
      if (typeof cell !== 'number') return;
      if (players[state.turn] !== socket.id) return; // not your turn
      if (state.board[cell]) return; // cell taken
      const mark = state.turn === 0 ? 'X' : 'O';
      state.board[cell] = mark;
      const winner = tttWinner(state.board);
      const draw   = !winner && state.board.every(c => c);
      state.turn   = 1 - state.turn;

      const update = { board: state.board, turn: state.turn };
      if (winner) {
        update.winnerSocketId = socket.id;
        gameRooms.delete(gameId);
      } else if (draw) {
        update.draw = true;
        gameRooms.delete(gameId);
      }
      players.forEach(id => io.to(id).emit('game:update', update));

    } else if (type === 'rps') {
      const { choice } = data;
      if (!['rock','paper','scissors'].includes(choice)) return;
      if (state.choices[socket.id]) return; // already chose
      state.choices[socket.id] = choice;
      // Notify opponent that this player chose (but don't reveal)
      if (opponentId) io.to(opponentId).emit('game:update', { opponentChose: true });

      if (Object.keys(state.choices).length === 2) {
        // Both chose — determine winner
        const [idA, idB] = players;
        const cA = state.choices[idA], cB = state.choices[idB];
        const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
        let winnerSocketId = null;
        if (cA !== cB) winnerSocketId = beats[cA] === cB ? idA : idB;
        const result = { choices: state.choices, winnerSocketId, draw: !winnerSocketId };
        players.forEach(id => io.to(id).emit('game:update', result));
        gameRooms.delete(gameId);
      }

    } else if (type === 'math') {
      if (state.answered) return;
      const { answer } = data;
      if (answer === state.question.answer) {
        state.answered = true;
        const result = { winnerSocketId: socket.id, answer, question: state.question };
        players.forEach(id => io.to(id).emit('game:update', result));
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
    if (!u) { broadcastOnlineCount(); return; }

    const key       = u.name.toLowerCase();
    const partnerId = pairs.get(socket.id);

    removeFromQueue(socket.id);

    if (partnerId) {
      // Start reconnect grace period
      pairs.delete(socket.id);
      pairs.delete(partnerId);

      const timer = setTimeout(() => {
        pendingRecon.delete(key);
        io.to(partnerId).emit('partnerDisconnected', { name: u.name });
      }, RECONNECT_TTL);

      pendingRecon.set(key, { partnerId, timer, bio: u.bio });
      io.to(partnerId).emit('partnerReconnecting', { name: u.name });
    }

    // Clean up any game rooms
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