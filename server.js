const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('joinGame', (playerData) => {
    // Create a new player with user data
    players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      color: playerData.color || '#' + Math.floor(Math.random()*16777215).toString(16),
      name: playerData.name || 'Player',
      angle: 0,
      speed: 0
    };

    // Send current players to the new player
    socket.emit('currentPlayers', players);

    // Broadcast new player to other players
    socket.broadcast.emit('newPlayer', { playerId: socket.id, playerInfo: players[socket.id] });
  });

  socket.on('playerMovement', (movementData) => {
    if (players[socket.id]) {
      players[socket.id].x = movementData.x;
      players[socket.id].y = movementData.y;
      players[socket.id].angle = movementData.angle;
      
      socket.broadcast.emit('playerMoved', {
        playerId: socket.id,
        x: players[socket.id].x,
        y: players[socket.id].y,
        angle: players[socket.id].angle
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
