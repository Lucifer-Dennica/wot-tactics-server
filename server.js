const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const rooms = {};

const server = http.createServer((req, res) => {
    if (req.url === '/ping' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New client');

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
            // ---------- НОВЫЕ ТИПЫ СООБЩЕНИЙ ----------
            case 'draw_freehand': {
                if (!ws.room || !rooms[ws.room]) return;
                const { payload } = data; // { points, color, lineWidth }
                rooms[ws.room].drawings.push({ type: 'freehand', ...payload });
                rooms[ws.room].players.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'draw_freehand', payload }));
                    }
                });
                break;
            }
            case 'update_icon': {
                if (!ws.room || !rooms[ws.room]) return;
                const { index, newX, newY } = data; // index в массиве drawings
                const drawing = rooms[ws.room].drawings[index];
                if (drawing && drawing.type === 'icon') {
                    drawing.x = newX;
                    drawing.y = newY;
                    rooms[ws.room].players.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'update_icon', index, newX, newY }));
                        }
                    });
                }
                break;
            }
            // Старые типы (draw, clear, load_map) оставляем для совместимости
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
            // ===== НОВЫЙ ОБРАБОТЧИК ДЛЯ sync_drawings =====
            case 'sync_drawings': {
                if (!ws.room || !rooms[ws.room]) return;
                const { drawings } = data;
                // Проверяем, что drawings — массив
                if (!Array.isArray(drawings)) return;
                // Заменяем рисунки в комнате
                rooms[ws.room].drawings = drawings;
                // Рассылаем всем в комнате, включая отправителя? Лучше всем, кроме отправителя, но отправитель уже обновил локально.
                // Однако чтобы синхронизировать всех, разошлём всем.
                rooms[ws.room].players.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'sync_drawings', drawings }));
                    }
                });
                // Также отправим самому отправителю подтверждение (опционально), но он уже знает.
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
                // Можно удалить пустую комнату, но оставим
            }
            broadcastRoomList();
        }
    });
});

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

function startKeepAlive() {
    const pingUrl = `http://localhost:${PORT}/ping`;
    setInterval(() => {
        fetch(pingUrl)
            .then(res => {
                if (res.ok) console.log('[keep-alive] Ping OK');
                else console.warn('[keep-alive] Ping failed');
            })
            .catch(err => console.warn('[keep-alive] Ping error:', err.message));
    }, 5 * 60 * 1000);
}

server.listen(PORT, () => {
    console.log(`✅ HTTP + WebSocket сервер запущен на порту ${PORT}`);
    startKeepAlive();
});
