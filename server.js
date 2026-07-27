const WebSocket = require('ws');
const http = require('http');

// ---------- Настройка порта ----------
const PORT = process.env.PORT || 8080;

// ---------- Хранилище комнат ----------
const rooms = {};

// ---------- Создаём HTTP-сервер (для пингов и статуса) ----------
const server = http.createServer((req, res) => {
    if (req.url === '/ping' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// ---------- Создаём WebSocket-сервер поверх HTTP ----------
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Новый клиент');

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch { return; }

        switch (data.type) {
            case 'get_rooms': {
                const list = Object.keys(rooms).map(name => ({
                    name,
                    creatorId: rooms[name].creatorId,
                    playerCount: rooms[name].players.size,
                    hasPassword: !!rooms[name].password
                }));
                ws.send(JSON.stringify({ type: 'room_list', rooms: list }));
                break;
            }
            case 'create_room': {
                const { name, password, creatorId } = data;
                if (rooms[name]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Комната уже существует' }));
                    return;
                }
                rooms[name] = {
                    password: password || null,
                    creatorId,
                    players: new Set(),
                    drawings: [],
                    map: 'prokhorovka',
                    mode: 'стандарт'
                };
                broadcastRoomList();
                ws.send(JSON.stringify({ type: 'create_success', roomName: name }));
                break;
            }
            case 'delete_room': {
                const { roomName, deleterId } = data;
                if (!rooms[roomName]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
                    return;
                }
                if (rooms[roomName].creatorId !== deleterId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Только создатель может удалить' }));
                    return;
                }
                rooms[roomName].players.forEach(client => {
                    if (client.readyState === WebSocket.OPEN)
                        client.send(JSON.stringify({ type: 'room_closed' }));
                });
                delete rooms[roomName];
                broadcastRoomList();
                ws.send(JSON.stringify({ type: 'delete_success' }));
                break;
            }
            case 'join_room': {
                const { roomName, playerId } = data;
                if (!rooms[roomName]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Комната не существует' }));
                    return;
                }
                rooms[roomName].players.add(ws);
                ws.room = roomName;
                ws.playerId = playerId;
                const room = rooms[roomName];
                ws.send(JSON.stringify({
                    type: 'join_success',
                    roomName,
                    map: room.map,
                    mode: room.mode,
                    drawings: room.drawings
                }));
                room.players.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'player_joined', playerId }));
                    }
                });
                broadcastRoomList();
                break;
            }
            case 'draw': {
                if (!ws.room || !rooms[ws.room]) return;
                const { payload } = data;
                rooms[ws.room].drawings.push(payload);
                rooms[ws.room].players.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'draw', payload }));
                    }
                });
                break;
            }
            case 'clear': {
                if (!ws.room || !rooms[ws.room]) return;
                rooms[ws.room].drawings = [];
                rooms[ws.room].players.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'clear' }));
                    }
                });
                break;
            }
            case 'load_map': {
                if (!ws.room || !rooms[ws.room]) return;
                const { map, mode } = data;
                rooms[ws.room].map = map;
                rooms[ws.room].mode = mode;
                rooms[ws.room].players.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'load_map', map, mode }));
                    }
                });
                break;
            }
            default:
                console.warn('Неизвестный тип:', data.type);
        }
    });

    ws.on('close', () => {
        if (ws.room && rooms[ws.room]) {
            rooms[ws.room].players.delete(ws);
            if (rooms[ws.room].players.size === 0) {
                // Можно удалить пустую комнату, но оставим для истории
            }
            broadcastRoomList();
        }
    });
});

// ---------- Функция рассылки списка комнат ----------
function broadcastRoomList() {
    const list = Object.keys(rooms).map(name => ({
        name,
        creatorId: rooms[name].creatorId,
        playerCount: rooms[name].players.size,
        hasPassword: !!rooms[name].password
    }));
    const msg = JSON.stringify({ type: 'room_list', rooms: list });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

// ---------- Автопинг для предотвращения засыпания ----------
function startKeepAlive() {
    // Пингуем сами себя каждые 5 минут через HTTP-запрос
    const pingUrl = `http://localhost:${PORT}/ping`;
    setInterval(() => {
        fetch(pingUrl)
            .then(res => {
                if (res.ok) console.log('[keep-alive] Пинг успешен');
                else console.warn('[keep-alive] Ответ не OK');
            })
            .catch(err => console.warn('[keep-alive] Ошибка пинга:', err.message));
    }, 5 * 60 * 1000); // 5 минут
}

// ---------- Запуск сервера ----------
server.listen(PORT, () => {
    console.log(`✅ HTTP сервер запущен на порту ${PORT}`);
    console.log(`✅ WebSocket сервер запущен на порту ${PORT}`);
    // Запускаем автопинг
    startKeepAlive();
});