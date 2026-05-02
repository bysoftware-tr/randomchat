const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

// Statik dosyaları sun (index.html vs.)
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════
//  KUYRUK & AKTIF EŞLEŞMELER
// ═══════════════════════════════════════════════

// Bekleyen kullanıcılar: { socketId → { gender, pref, country } }
const waitingQueue = new Map();

// Aktif eşleşmeler: { socketId → partnerId }
const activePairs = new Map();

// ═══════════════════════════════════════════════
//  YARDIMCI FONKSİYONLAR
// ═══════════════════════════════════════════════

// İki kullanıcı eşleşir mi?
function isMatch(a, b) {
  // Aynı kişi olamaz
  if (a.id === b.id) return false;

  // Ülke filtresi
  if (a.country !== 'any' && b.country !== 'any' && a.country !== b.country) return false;

  // Cinsiyet tercihi (pref)
  // 'opposite' → karşı cinsiyeti ister
  // 'same'     → aynı cinsiyeti ister
  // 'any'      → herkesi ister

  const aWantsB = checkPref(a.pref, a.gender, b.gender);
  const bWantsA = checkPref(b.pref, b.gender, a.gender);

  return aWantsB && bWantsA;
}

function checkPref(pref, myGender, theirGender) {
  if (pref === 'any') return true;
  if (pref === 'opposite') {
    return (myGender === 'male'   && theirGender === 'female') ||
           (myGender === 'female' && theirGender === 'male');
  }
  if (pref === 'same') return myGender === theirGender;
  return true;
}

// Kuyruktaki en uygun eşi bul
function findMatch(newUser) {
  for (const [id, user] of waitingQueue.entries()) {
    if (isMatch(newUser, user)) {
      return { id, user };
    }
  }
  return null;
}

// Çevrimiçi sayısını herkese yayınla
function broadcastOnlineCount() {
  const count = io.engine.clientsCount;
  io.emit('onlineCount', count);
}

// ═══════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[+] Bağlandı: ${socket.id}`);
  broadcastOnlineCount();

  // ── Arama başlat ──────────────────────────────
  socket.on('search', (data) => {
    const { gender, pref, country } = data;

    // Aktif eşleşmeden çıkar (varsa)
    leavePair(socket);

    const me = { id: socket.id, gender, pref, country };
    const match = findMatch(me);

    if (match) {
      // Eşleşme bulundu!
      waitingQueue.delete(match.id);

      activePairs.set(socket.id, match.id);
      activePairs.set(match.id, socket.id);

      // Her ikisine de bildir
      // socket.id → initiator (offer yapacak)
      socket.emit('matched', {
        partnerId: match.id,
        gender:    match.user.gender,
        country:   match.user.country,
        initiator: true
      });

      io.to(match.id).emit('matched', {
        partnerId: socket.id,
        gender,
        country,
        initiator: false
      });

      console.log(`[=] Eşleşti: ${socket.id} ↔ ${match.id}`);
    } else {
      // Kuyruğa ekle
      waitingQueue.set(socket.id, me);
      console.log(`[?] Kuyruğa eklendi: ${socket.id} (${gender}, ${pref}, ${country})`);
    }
  });

  // ── WebRTC Sinyal iletimi ─────────────────────
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // ── Metin mesajı ─────────────────────────────
  socket.on('chat', ({ to, text }) => {
    // Güvenlik: sadece gerçek partnere ilet
    if (activePairs.get(socket.id) === to) {
      const clean = String(text).slice(0, 300); // max 300 karakter
      io.to(to).emit('chat', { text: clean });
    }
  });

  // ── Sonraki kişi / iptal ──────────────────────
  socket.on('next', () => {
    leavePair(socket);
    waitingQueue.delete(socket.id);
  });

  socket.on('cancel', () => {
    waitingQueue.delete(socket.id);
    leavePair(socket);
  });

  socket.on('leave', () => {
    waitingQueue.delete(socket.id);
    leavePair(socket);
  });

  // ── Bağlantı kesildi ─────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Ayrıldı: ${socket.id}`);
    waitingQueue.delete(socket.id);
    leavePair(socket);
    broadcastOnlineCount();
  });
});

// ─────────────────────────────────────────────
// Eşi varsa partnere haber ver, pairs'ten sil
function leavePair(socket) {
  const partnerId = activePairs.get(socket.id);
  if (partnerId) {
    io.to(partnerId).emit('partnerLeft');
    activePairs.delete(partnerId);
    activePairs.delete(socket.id);
    console.log(`[x] Ayrıldı: ${socket.id} → partner ${partnerId} bildirildi`);
  }
}

// ═══════════════════════════════════════════════
//  SUNUCUYU BAŞLAT
// ═══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Sunucu çalışıyor → http://localhost:${PORT}`);
});
