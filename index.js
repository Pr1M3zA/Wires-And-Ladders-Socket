const express = require("express");
const cors = require('cors');
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const server = createServer(app);
const SOCKET_PORT = 3001;

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  transports: ['websocket'],
});

const rooms = {}; // Almacenará la información de las salas: { roomCode: { users: [], creatorSocketId: '', maxUsers: 6 } }
const MAX_USERS_PER_ROOM = 6;

io.on('connection', (socket) => {
  const { dbUserId, userName } = socket.handshake.query; // Obtener info del usuario
  console.log(`Usuario conectado: ${userName} (dbID: ${dbUserId}, socketID: ${socket.id})`);

  socket.on('createRoom', ({ roomCode, user }) => {
    if (!roomCode || !user || !user.id || !user.userName) {
      console.log(`RoomCode: ${roomCode}, User: ${JSON.stringify(user)}`)
      socket.emit('createRoomError', { message: 'Datos incompletos para crear la sala.' });
      return;
    }
    if (rooms[roomCode]) {
      socket.emit('createRoomError', { message: 'Este código de sala ya está en uso. Intenta con otro.' });
      return;
    }
    const creatorUser = {socketId: socket.id, dbUserId: user.id, userName: user.userName}
    rooms[roomCode] = {
      users: [creatorUser],
      creatorSocketId: socket.id,
      maxUsers: MAX_USERS_PER_ROOM,
      nextGuestId: -1,
    };
    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, users: rooms[roomCode].users, isCreator: true });
  });

  socket.on('joinRoom', ({ roomCode, user }) => {
    if (!roomCode || !user) {
      socket.emit('joinError', { message: 'Datos incompletos para unirse a la sala.' });
      return;
    }
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('joinError', { message: 'La sala no existe.' });
      return;
    }
    if (room.users.length >= room.maxUsers) {
      socket.emit('roomFull', { message: 'La sala está llena.' });
      return;
    }

    if (user.id < 1) {
      user.id = room.nextGuestId; // Asignar ID de invitado secuencial negativo
      user.userName = `guest${user.id}`; // Asignar nombre de invitado
      room.nextGuestId--; // Decrementar para el próximo invitado
    } 

    // Evitar que un usuario se una dos veces con el mismo dbUserId (si es una restricción deseada)
    if (room.users.some(u => u.dbUserId === user.id)) {
      socket.emit('joinError', { message: 'Ya estás en esta sala.' });
      return;
    }

    room.users.push({ socketId: socket.id, dbUserId: user.id, userName: user.userName });
    socket.join(roomCode);
    console.log(`Usuario ${user.userName} se unió a la sala: ${roomCode}`);

    // Notificar al usuario que se unió
    socket.emit('joinedRoom', { roomCode, users: room.users });
    // Notificar a todos en la sala (incluido el nuevo) sobre la actualización del grupo
    io.to(roomCode).emit('groupUpdate', { users: room.users });
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.creatorSocketId === socket.id) {
      if (room.users.length < 2) { // O tu mínimo de jugadores
        socket.emit('startGameError', { message: 'No hay suficientes jugadores para iniciar.' }); // Podrías manejar esto en el cliente también
        return;
      }
      console.log(`Iniciando juego en la sala: ${roomCode}`);
      const gameId = `game_${roomCode}_${Date.now()}`; // Un ID de juego simple
      room.gameId = gameId; // Podrías almacenar el ID del juego en la sala
      io.to(roomCode).emit('gameStarting', { gameId });
      // Aquí podrías tener lógica adicional, como guardar el estado del juego en una BD.
    } else {
      socket.emit('startGameError', { message: 'No autorizado o la sala no existe.' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${userName} (dbID: ${dbUserId}, socketID: ${socket.id})`);
    // Encontrar la sala en la que estaba el usuario y eliminarlo
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const userIndex = room.users.findIndex(u => u.socketId === socket.id);

      if (userIndex !== -1) {
        room.users.splice(userIndex, 1);
        console.log(`Usuario ${userName} salió de la sala: ${roomCode}`);

        if (room.creatorSocketId === socket.id) {
          // El creador se fue, notificar a los demás y eliminar la sala
          console.log(`El creador de la sala ${roomCode} se desconectó. Disolviendo sala.`);
          socket.to(roomCode).emit('creatorLeft', { message: 'El creador ha abandonado la sala. La sala se cerrará.' });
          // Asegurarse de que todos los sockets abandonen la sala antes de eliminarla
          const clientsInRoom = io.sockets.adapter.rooms.get(roomCode);
          if (clientsInRoom) {
            clientsInRoom.forEach(clientId => {
              io.sockets.sockets.get(clientId).leave(roomCode);
            });
          }
          delete rooms[roomCode];
        } else if (room.users.length === 0) {
          // La sala está vacía, eliminarla
          console.log(`La sala ${roomCode} está vacía. Eliminando sala.`);
          delete rooms[roomCode];
        } else {
          // Notificar a los demás usuarios en la sala sobre la actualización
          io.to(roomCode).emit('groupUpdate', { users: room.users });
        }
        break; // Salir del bucle una vez que se encuentra y procesa la sala
      }
    }
  });

  socket.on('joinBoardGameRoom', ({ roomCode }) => {
    if (rooms[roomCode]) {
      socket.join(roomCode); // El socket se une a la sala del juego
    } else {
      console.warn(`Intento de unirse a sala de juego inexistente: ${roomCode} por socket ${socket.id}`);
      socket.emit('errorJoiningGameRoom', { message: 'La sala de juego no existe.' });
    }
  });

  socket.on('broadcastGameState', ({ roomCode, gameState }) => {
    if (rooms[roomCode]) {
      // Almacenar el estado del juego en el servidor (opcional pero bueno para reconexiones)
      rooms[roomCode].gameState = gameState;
      console.log(`Gamestate (${roomCode}): PlayerIdx: ${gameState.currentPlayerIndex} LastDiceResult: ${gameState.lastDiceResult}`)
      console.log("gamers state: ", gameState.playersState.map(p => p.userName + ' ' + p.currentTile + ' ' + p.targetTile).join(', '));
      // Retransmitir el estado del juego a todos los demás en la sala, excepto al remitente original
      socket.to(roomCode).emit('gameStateUpdated', gameState);
    }
  });

});

app.get("/", (req, res) => res.send("MyAPI - Socket.IO - (v1.7)"));

server.listen(SOCKET_PORT , () => {
  console.log(`Servidor Socket.IO escuchando en el puerto ${SOCKET_PORT}`);
});
