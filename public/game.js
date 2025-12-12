const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

canvas.width = 800;
canvas.height = 600;

const socket = io();

// Game State
let gameState = 'MENU'; // MENU, PLAYING, GAME_OVER, BUILDER, LOCAL_1VS1, RACE, TIME_TRIAL
let players = {};
let cpuCars = [];
let audioCtx;
let soundEnabled = true;
let gameMap = []; // Array of {x, y, w, h}
let gameCheckpoints = []; // Array of {x, y, w, h, order}
let gameNitro = []; // Array of {x, y, w, h}
let gameStartPoint = null; // {x, y, w, h}
let gameFinishPoint = null; // {x, y, w, h}
let builderTool = 'WALL'; // WALL, ERASE, CHECKPOINT, START, FINISH, NITRO
let isMouseDown = false;
const TILE_SIZE = 20;

// Race State
let raceState = {
    startTime: 0,
    currentLap: 1,
    totalLaps: 3,
    finished: false
};

// Player Car (P1 - Arrows)
const myCar = {
    x: 600,
    y: 300,
    angle: 0,
    speed: 0,
    maxSpeed: 4,
    baseMaxSpeed: 4,
    acceleration: 0.15,
    friction: 0.05,
    turnSpeed: 0.05,
    color: '#33f',
    name: 'P1',
    lives: 3,
    invulnerable: false,
    invulnerableTimer: 0,
    // Race specific
    lap: 1,
    nextCheckpointIndex: 0, // 0..N, then Finish
    finished: false,
    finishTime: 0,
    nitroTimer: 0
};

// Local Player 2 (P2 - WSAD)
const localPlayer2 = {
    x: 200,
    y: 300,
    angle: 0,
    speed: 0,
    maxSpeed: 4,
    acceleration: 0.15,
    friction: 0.05,
    turnSpeed: 0.05,
    color: '#f33',
    name: 'P2',
    lives: 3,
    invulnerable: false,
    invulnerableTimer: 0
};

// Input
let keys = {
    ArrowUp: false,
    ArrowDown: false,
    ArrowLeft: false,
    ArrowRight: false,
    KeyW: false,
    KeyS: false,
    KeyA: false,
    KeyD: false
};

// Sound Manager
const SoundManager = {
    engineOsc: null,
    engineMod: null,
    engineGain: null,
    
    init: function() {
        if (!soundEnabled) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContext();
            
            // Engine sound setup (FM Synthesis for better engine sound)
            this.engineOsc = audioCtx.createOscillator();
            this.engineMod = audioCtx.createOscillator();
            this.engineGain = audioCtx.createGain();
            
            // Carrier
            this.engineOsc.type = 'sawtooth';
            this.engineOsc.frequency.value = 60;
            
            // Modulator
            this.engineMod.type = 'square';
            this.engineMod.frequency.value = 30;
            
            // Modulator gain
            const modGain = audioCtx.createGain();
            modGain.gain.value = 50;
            
            this.engineMod.connect(modGain);
            modGain.connect(this.engineOsc.frequency);
            
            this.engineOsc.connect(this.engineGain);
            this.engineGain.connect(audioCtx.destination);
            
            this.engineGain.gain.value = 0;
            
            this.engineOsc.start();
            this.engineMod.start();
        } catch (e) {
            console.error('Audio init failed', e);
        }
    },

    updateEngine: function(speed) {
        if (!audioCtx || !soundEnabled) return;
        const absSpeed = Math.abs(speed);
        
        // Pitch modulation based on speed
        const baseFreq = 60 + (absSpeed * 20);
        this.engineOsc.frequency.setTargetAtTime(baseFreq, audioCtx.currentTime, 0.1);
        this.engineMod.frequency.setTargetAtTime(baseFreq / 2, audioCtx.currentTime, 0.1);
        
        // Volume modulation
        const vol = absSpeed > 0.1 ? 0.15 : 0.05; // Idle sound vs running
        this.engineGain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.1);
    },

    playCollision: function() {
        if (!audioCtx || !soundEnabled) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        
        // Noise-like effect using random frequency modulation could be better, 
        // but simple saw/square with rapid drop works for 8-bit style
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(10, audioCtx.currentTime + 0.3);
        
        gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
    }
};

// CPU Car Class
class CpuCar {
    constructor(id) {
        this.id = id;
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.angle = Math.random() * Math.PI * 2;
        this.speed = 0;
        this.maxSpeed = 3 + Math.random() * 2;
        this.baseMaxSpeed = this.maxSpeed;
        this.color = '#' + Math.floor(Math.random()*16777215).toString(16);
        this.turnSpeed = 0.03 + Math.random() * 0.02;
        this.targetX = Math.random() * canvas.width;
        this.targetY = Math.random() * canvas.height;
        this.changeTargetTimer = 0;
        this.lives = 3;
        this.invulnerable = false;
        this.invulnerableTimer = 0;
        // Race specific
        this.lap = 1;
        this.nextCheckpointIndex = 0;
        this.finished = false;
        this.nitroTimer = 0;
    }

    update() {
        if (this.lives <= 0) return; // Dead

        if (this.invulnerable) {
            this.invulnerableTimer--;
            if (this.invulnerableTimer <= 0) this.invulnerable = false;
        }
        
        // Nitro Logic
        if (this.nitroTimer > 0) {
            this.nitroTimer--;
            this.maxSpeed = this.baseMaxSpeed * 1.25;
        } else {
            this.maxSpeed = this.baseMaxSpeed;
        }

        // Race Logic for CPU
        if (gameState === 'RACE' && (gameCheckpoints.length > 0 || gameFinishPoint)) {
            if (this.finished) {
                this.speed *= 0.95; // Slow down
                return;
            }
            
            // Target Logic
            let targetCp = null;
            
            if (this.nextCheckpointIndex < gameCheckpoints.length) {
                targetCp = gameCheckpoints[this.nextCheckpointIndex];
            } else if (gameFinishPoint) {
                targetCp = gameFinishPoint;
            } else if (gameStartPoint) {
                // Loop back to start if no finish point (shouldn't happen in new logic but fallback)
                targetCp = gameStartPoint;
            }

            if (targetCp) {
                // Add some randomness to target within checkpoint
                this.targetX = targetCp.x + targetCp.w/2;
                this.targetY = targetCp.y + targetCp.h/2;
            }
            
        } else {
            // Simple AI: Drive towards random waypoints (Battle Mode)
            this.changeTargetTimer++;
            if (this.changeTargetTimer > 200) {
                this.targetX = Math.random() * canvas.width;
                this.targetY = Math.random() * canvas.height;
                this.changeTargetTimer = 0;
            }
        }

        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const targetAngle = Math.atan2(dy, dx) + Math.PI / 2; // +90 deg because 0 is up
        
        // Normalize angle difference
        let diff = targetAngle - this.angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;

        if (diff > 0.1) this.angle += this.turnSpeed;
        if (diff < -0.1) this.angle -= this.turnSpeed;

        this.speed = Math.min(this.speed + 0.1, this.maxSpeed);

        this.x += Math.sin(this.angle) * this.speed;
        this.y -= Math.cos(this.angle) * this.speed;

        // Bounds
        if (this.x < 0) this.x = 0;
        if (this.x > canvas.width) this.x = canvas.width;
        if (this.y < 0) this.y = 0;
        if (this.y > canvas.height) this.y = canvas.height;
    }

    draw() {
        if (this.lives <= 0) return;
        if (this.invulnerable && Math.floor(Date.now() / 100) % 2 === 0) return;
        drawCar(this.x, this.y, this.angle, this.color, 'CPU');
    }
}

// Event Listeners
window.addEventListener('keydown', (e) => {
    if (keys.hasOwnProperty(e.code)) keys[e.code] = true;
});

window.addEventListener('keyup', (e) => {
    if (keys.hasOwnProperty(e.code)) keys[e.code] = false;
});

// Builder Mouse Events
canvas.addEventListener('mousedown', (e) => {
    if (gameState !== 'BUILDER') return;
    isMouseDown = true;
    handleBuilderClick(e);
});

canvas.addEventListener('mousemove', (e) => {
    if (gameState !== 'BUILDER' || !isMouseDown) return;
    handleBuilderClick(e);
});

canvas.addEventListener('mouseup', () => {
    isMouseDown = false;
});

function handleBuilderClick(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const gridX = Math.floor(x / TILE_SIZE) * TILE_SIZE;
    const gridY = Math.floor(y / TILE_SIZE) * TILE_SIZE;

    if (builderTool === 'WALL') {
        // Check if wall exists
        const exists = gameMap.some(w => w.x === gridX && w.y === gridY);
        if (!exists) {
            gameMap.push({x: gridX, y: gridY, w: TILE_SIZE, h: TILE_SIZE});
        }
    } else if (builderTool === 'CHECKPOINT') {
        // Check if checkpoint exists
        const exists = gameCheckpoints.some(c => c.x === gridX && c.y === gridY);
        if (!exists) {
            gameCheckpoints.push({x: gridX, y: gridY, w: TILE_SIZE, h: TILE_SIZE, order: gameCheckpoints.length});
        }
    } else if (builderTool === 'START') {
        gameStartPoint = {x: gridX, y: gridY, w: TILE_SIZE, h: TILE_SIZE};
    } else if (builderTool === 'FINISH') {
        gameFinishPoint = {x: gridX, y: gridY, w: TILE_SIZE, h: TILE_SIZE};
    } else if (builderTool === 'NITRO') {
        const exists = gameNitro.some(n => n.x === gridX && n.y === gridY);
        if (!exists) {
            gameNitro.push({x: gridX, y: gridY, w: TILE_SIZE, h: TILE_SIZE});
        }
    } else if (builderTool === 'ERASE') {
        gameMap = gameMap.filter(w => !(w.x === gridX && w.y === gridY));
        gameCheckpoints = gameCheckpoints.filter(c => !(c.x === gridX && c.y === gridY));
        gameNitro = gameNitro.filter(n => !(n.x === gridX && n.y === gridY));
        if (gameStartPoint && gameStartPoint.x === gridX && gameStartPoint.y === gridY) gameStartPoint = null;
        if (gameFinishPoint && gameFinishPoint.x === gridX && gameFinishPoint.y === gridY) gameFinishPoint = null;
    }
}

// Builder UI Events
document.getElementById('builderBtn').addEventListener('click', () => {
    gameState = 'BUILDER';
    document.getElementById('menu').style.display = 'none';
    document.getElementById('game-container').style.display = 'block';
    document.getElementById('builder-ui').style.display = 'flex';
    document.getElementById('ui-layer').style.display = 'none';
    // gameMap = []; // Removed to keep existing map
});

document.getElementById('toolWall').addEventListener('click', (e) => {
    builderTool = 'WALL';
    updateBuilderToolsUI();
});

document.getElementById('toolStart').addEventListener('click', (e) => {
    builderTool = 'START';
    updateBuilderToolsUI();
});

document.getElementById('toolFinish').addEventListener('click', (e) => {
    builderTool = 'FINISH';
    updateBuilderToolsUI();
});

document.getElementById('toolCheckpoint').addEventListener('click', (e) => {
    builderTool = 'CHECKPOINT';
    updateBuilderToolsUI();
});

document.getElementById('toolNitro').addEventListener('click', (e) => {
    builderTool = 'NITRO';
    updateBuilderToolsUI();
});

document.getElementById('toolErase').addEventListener('click', (e) => {
    builderTool = 'ERASE';
    updateBuilderToolsUI();
});

document.getElementById('btnResize').addEventListener('click', () => {
    const w = parseInt(document.getElementById('mapWidth').value);
    const h = parseInt(document.getElementById('mapHeight').value);
    
    if (w > 0 && h > 0) {
        canvas.width = w;
        canvas.height = h;
        // Clear map walls that are out of bounds? Or keep them?
        // Let's keep them, user might resize back.
    }
});

document.getElementById('btnExport').addEventListener('click', () => {
    const data = {
        width: canvas.width,
        height: canvas.height,
        map: gameMap,
        checkpoints: gameCheckpoints,
        nitro: gameNitro,
        start: gameStartPoint,
        finish: gameFinishPoint
    };
    const json = JSON.stringify(data);
    console.log('Map Data:', json);
    alert('Mapa wyeksportowana do konsoli (F12 -> Console). Skopiuj ją stamtąd.');
});

document.getElementById('btnImport').addEventListener('click', () => {
    const json = prompt('Wklej kod mapy (JSON):');
    if (json) {
        try {
            const data = JSON.parse(json);
            if (data.map) {
                gameMap = data.map;
                if (data.checkpoints) gameCheckpoints = data.checkpoints;
                if (data.nitro) gameNitro = data.nitro;
                if (data.start) gameStartPoint = data.start;
                if (data.finish) gameFinishPoint = data.finish;
                if (data.width) canvas.width = data.width;
                if (data.height) canvas.height = data.height;
                
                // Update inputs
                document.getElementById('mapWidth').value = canvas.width;
                document.getElementById('mapHeight').value = canvas.height;
            } else {
                // Legacy format support (just array)
                if (Array.isArray(data)) {
                    gameMap = data;
                }
            }
        } catch (e) {
            alert('Błąd parsowania JSON');
        }
    }
});

document.getElementById('btnPlayMap').addEventListener('click', () => {
    // Start game with current map
    gameState = 'PLAYING';
    document.getElementById('builder-ui').style.display = 'none';
    document.getElementById('ui-layer').style.display = 'block';
    
    // Reset car
    myCar.x = 100;
    myCar.y = 100;
    myCar.speed = 0;
    myCar.lives = 3;
    updateLivesUI();
    
    // Init Sound
    SoundManager.init();
});

document.getElementById('btnExitBuilder').addEventListener('click', () => {
    gameState = 'MENU';
    document.getElementById('builder-ui').style.display = 'none';
    document.getElementById('game-container').style.display = 'none';
    document.getElementById('menu').style.display = 'block';
});

function updateBuilderToolsUI() {
    document.getElementById('toolWall').classList.toggle('active', builderTool === 'WALL');
    document.getElementById('toolStart').classList.toggle('active', builderTool === 'START');
    document.getElementById('toolFinish').classList.toggle('active', builderTool === 'FINISH');
    document.getElementById('toolCheckpoint').classList.toggle('active', builderTool === 'CHECKPOINT');
    document.getElementById('toolNitro').classList.toggle('active', builderTool === 'NITRO');
    document.getElementById('toolErase').classList.toggle('active', builderTool === 'ERASE');
}

document.getElementById('menuImportMapBtn').addEventListener('click', () => {
    const json = prompt('Wklej kod mapy (JSON):');
    if (json) {
        try {
            const data = JSON.parse(json);
            if (data.map) {
                gameMap = data.map;
                if (data.checkpoints) gameCheckpoints = data.checkpoints;
                if (data.nitro) gameNitro = data.nitro;
                if (data.start) gameStartPoint = data.start;
                if (data.finish) gameFinishPoint = data.finish;
                if (data.width) canvas.width = data.width;
                if (data.height) canvas.height = data.height;
                alert('Mapa wczytana pomyślnie! Możesz teraz uruchomić grę.');
            } else if (Array.isArray(data)) {
                gameMap = data;
                alert('Mapa wczytana pomyślnie! Możesz teraz uruchomić grę.');
            } else {
                alert('Nieprawidłowy format mapy.');
            }
        } catch (e) {
            alert('Błąd parsowania JSON');
        }
    }
});

document.getElementById('startBtn').addEventListener('click', () => {
    startGame('PLAYING');
});

document.getElementById('raceBtn').addEventListener('click', () => {
    if (!gameStartPoint && gameCheckpoints.length === 0) {
        alert('Musisz najpierw stworzyć/wczytać mapę z punktem START!');
        return;
    }
    startGame('RACE');
});

document.getElementById('timeTrialBtn').addEventListener('click', () => {
    if (!gameStartPoint && gameCheckpoints.length === 0) {
        alert('Musisz najpierw stworzyć/wczytać mapę z punktem START!');
        return;
    }
    startGame('TIME_TRIAL');
});

function startGame(mode) {
    const nick = document.getElementById('nickname').value;
    const color = document.getElementById('colorPicker').value;
    const cpuCount = parseInt(document.getElementById('cpuCount').value);
    soundEnabled = document.getElementById('soundToggle').checked;

    myCar.color = color;
    myCar.name = nick;
    myCar.lives = 3;
    
    // Reset Race Stats
    myCar.lap = 1;
    myCar.nextCheckpointIndex = 0;
    myCar.finished = false;
    myCar.nitroTimer = 0;
    raceState.startTime = Date.now();
    raceState.currentLap = 1;
    raceState.finished = false;

    // Spawn at Start Point
    if (gameStartPoint) {
        myCar.x = gameStartPoint.x + TILE_SIZE/2;
        myCar.y = gameStartPoint.y + TILE_SIZE/2;
    } else if (gameCheckpoints.length > 0) {
        // Fallback to old logic
        myCar.x = gameCheckpoints[0].x + TILE_SIZE/2;
        myCar.y = gameCheckpoints[0].y + TILE_SIZE/2;
    } else {
        myCar.x = 400;
        myCar.y = 300;
    }
    
    updateLivesUI();

    // Init Sound
    SoundManager.init();

    // Init CPU
    cpuCars = [];
    if (mode !== 'TIME_TRIAL') {
        for(let i=0; i<cpuCount; i++) {
            const cpu = new CpuCar(i);
            if (gameStartPoint) {
                cpu.x = gameStartPoint.x + TILE_SIZE/2;
                cpu.y = gameStartPoint.y + TILE_SIZE/2;
            } else if (gameCheckpoints.length > 0) {
                cpu.x = gameCheckpoints[0].x + TILE_SIZE/2;
                cpu.y = gameCheckpoints[0].y + TILE_SIZE/2;
            }
            cpuCars.push(cpu);
        }
    }

    // Join Server Game (Only for PLAYING/RACE)
    if (mode !== 'TIME_TRIAL') {
        socket.emit('joinGame', {
            name: nick,
            color: color
        });
    }

    // UI Switch
    document.getElementById('menu').style.display = 'none';
    document.getElementById('game-container').style.display = 'block';
    document.getElementById('game-over').style.display = 'none';
    document.getElementById('lives-container-p2').innerHTML = ''; // Clear P2 UI
    
    // Race UI
    if (mode === 'RACE' || mode === 'TIME_TRIAL') {
        document.getElementById('race-ui').style.display = 'block';
        document.getElementById('lives-container').style.display = 'none';
    } else {
        document.getElementById('race-ui').style.display = 'none';
        document.getElementById('lives-container').style.display = 'block';
    }

    gameState = mode;
}

document.getElementById('localBtn').addEventListener('click', () => {
    soundEnabled = document.getElementById('soundToggle').checked;
    
    // Reset P1
    myCar.x = 600;
    myCar.y = 300;
    myCar.speed = 0;
    myCar.lives = 3;
    myCar.color = '#33f';
    myCar.name = 'P1 (Arrows)';
    
    // Reset P2
    localPlayer2.x = 200;
    localPlayer2.y = 300;
    localPlayer2.speed = 0;
    localPlayer2.lives = 3;
    localPlayer2.color = '#f33';
    localPlayer2.name = 'P2 (WSAD)';

    updateLivesUI();
    updateLivesUIP2();

    SoundManager.init();
    cpuCars = []; // No CPU in local 1vs1 for now

    document.getElementById('menu').style.display = 'none';
    document.getElementById('game-container').style.display = 'block';
    document.getElementById('game-over').style.display = 'none';
    gameState = 'LOCAL_1VS1';
});

// Socket Events
socket.on('currentPlayers', (serverPlayers) => {
    players = serverPlayers;
    if (players[socket.id]) {
        myCar.x = players[socket.id].x;
        myCar.y = players[socket.id].y;
    }
});

socket.on('newPlayer', (playerInfo) => {
    players[playerInfo.playerId] = playerInfo.playerInfo;
});

socket.on('playerDisconnected', (playerId) => {
    delete players[playerId];
});

socket.on('playerMoved', (playerInfo) => {
    if (players[playerInfo.playerId]) {
        players[playerInfo.playerId].x = playerInfo.x;
        players[playerInfo.playerId].y = playerInfo.y;
        players[playerInfo.playerId].angle = playerInfo.angle;
    }
});

function updateLivesUI() {
    const container = document.getElementById('lives-container');
    let hearts = '';
    for(let i=0; i<myCar.lives; i++) {
        hearts += '<div class="pixel-heart"></div>';
    }
    container.innerHTML = hearts;
}

function updateLivesUIP2() {
    const container = document.getElementById('lives-container-p2');
    let hearts = '';
    for(let i=0; i<localPlayer2.lives; i++) {
        hearts += '<div class="pixel-heart"></div>';
    }
    container.innerHTML = hearts;
}

function isFrontalHit(attacker, victim) {
    // Vector from attacker to victim
    const dx = victim.x - attacker.x;
    const dy = victim.y - attacker.y;
    
    // Attacker's forward vector
    // In canvas: 0 is Up (0, -1), PI/2 is Right (1, 0)
    // But here we use sin/cos for movement: x += sin(angle), y -= cos(angle)
    const ax = Math.sin(attacker.angle);
    const ay = -Math.cos(attacker.angle);

    // Normalize distance vector
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist === 0) return false;
    const nx = dx / dist;
    const ny = dy / dist;

    // Dot product
    const dot = ax * nx + ay * ny;
    
    // If dot > 0.5 (approx 60 degrees cone), it's a frontal hit
    return dot > 0.5;
}

function checkCollisions() {
    const carRadius = 20;

    // 1. Check vs Map Walls (MyCar)
    checkCarVsMap(myCar);
    if (gameState === 'LOCAL_1VS1') {
        checkCarVsMap(localPlayer2);
    }

    // 2. Check MyCar vs Players (Online)
    if (gameState === 'PLAYING') {
        if (myCar.invulnerable) return;
        Object.keys(players).forEach((id) => {
            if (id === socket.id) return;
            const p = players[id];
            const dx = myCar.x - p.x;
            const dy = myCar.y - p.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            if (dist < carRadius * 2) {
                resolveCollision(myCar, p, dist, dx, dy);
                
                if (isFrontalHit(p, myCar) && !myCar.invulnerable) {
                    myCar.lives--;
                    updateLivesUI();
                    myCar.invulnerable = true;
                    myCar.invulnerableTimer = 180;
                    if (myCar.lives <= 0) gameOver();
                }
            }
        });
    }

    // 3. Check MyCar vs CPU
    if (gameState === 'PLAYING') {
        cpuCars.forEach(cpu => {
            if (cpu.lives <= 0) return;
            const dx = myCar.x - cpu.x;
            const dy = myCar.y - cpu.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            if (dist < carRadius * 2) {
                resolveCollision(myCar, cpu, dist, dx, dy);

                if (isFrontalHit(cpu, myCar) && !myCar.invulnerable) {
                    myCar.lives--;
                    updateLivesUI();
                    myCar.invulnerable = true;
                    myCar.invulnerableTimer = 180;
                    if (myCar.lives <= 0) gameOver();
                }

                if (isFrontalHit(myCar, cpu) && !cpu.invulnerable) {
                    cpu.lives--;
                    cpu.invulnerable = true;
                    cpu.invulnerableTimer = 180;
                }
            }
        });
    }

    // 4. Check CPU vs CPU
    if (gameState === 'PLAYING') {
        for (let i = 0; i < cpuCars.length; i++) {
            for (let j = i + 1; j < cpuCars.length; j++) {
                const c1 = cpuCars[i];
                const c2 = cpuCars[j];
                if (c1.lives <= 0 || c2.lives <= 0) continue;

                const dx = c1.x - c2.x;
                const dy = c1.y - c2.y;
                const dist = Math.sqrt(dx*dx + dy*dy);

                if (dist < carRadius * 2) {
                    const angle = Math.atan2(dy, dx);
                    const push = (40 - dist) / 2;
                    c1.x += Math.cos(angle) * push;
                    c1.y += Math.sin(angle) * push;
                    c2.x -= Math.cos(angle) * push;
                    c2.y -= Math.sin(angle) * push;
                    
                    if (isFrontalHit(c1, c2) && !c2.invulnerable) {
                        c2.lives--;
                        c2.invulnerable = true;
                        c2.invulnerableTimer = 180;
                    }
                    if (isFrontalHit(c2, c1) && !c1.invulnerable) {
                        c1.lives--;
                        c1.invulnerable = true;
                        c1.invulnerableTimer = 180;
                    }
                }
            }
        }
    }

    // 5. Local 1vs1 Collision
    if (gameState === 'LOCAL_1VS1') {
        const dx = myCar.x - localPlayer2.x;
        const dy = myCar.y - localPlayer2.y;
        const dist = Math.sqrt(dx*dx + dy*dy);

        if (dist < carRadius * 2) {
            // Push both
            const angle = Math.atan2(dy, dx);
            const push = (40 - dist) / 2;
            
            myCar.x += Math.cos(angle) * push;
            myCar.y += Math.sin(angle) * push;
            localPlayer2.x -= Math.cos(angle) * push;
            localPlayer2.y -= Math.sin(angle) * push;
            
            myCar.speed *= -0.5;
            localPlayer2.speed *= -0.5;
            
            SoundManager.playCollision();

            // Check Hits
            if (isFrontalHit(localPlayer2, myCar) && !myCar.invulnerable) {
                myCar.lives--;
                updateLivesUI();
                myCar.invulnerable = true;
                myCar.invulnerableTimer = 180;
                if (myCar.lives <= 0) gameOver();
            }
            if (isFrontalHit(myCar, localPlayer2) && !localPlayer2.invulnerable) {
                localPlayer2.lives--;
                updateLivesUIP2();
                localPlayer2.invulnerable = true;
                localPlayer2.invulnerableTimer = 180;
                if (localPlayer2.lives <= 0) gameOver();
            }
        }
    }
}

function checkCarVsMap(car) {
    for (let wall of gameMap) {
        let closestX = Math.max(wall.x, Math.min(car.x, wall.x + wall.w));
        let closestY = Math.max(wall.y, Math.min(car.y, wall.y + wall.h));
        let dx = car.x - closestX;
        let dy = car.y - closestY;
        let distSq = dx*dx + dy*dy;

        if (distSq < (15 * 15)) {
            car.speed *= -0.5;
            let angle = Math.atan2(dy, dx);
            if (distSq === 0) angle = Math.random() * Math.PI * 2;
            const push = 16 - Math.sqrt(distSq);
            car.x += Math.cos(angle) * push;
            car.y += Math.sin(angle) * push;
        }
    }
}

function resolveCollision(c1, c2, dist, dx, dy) {
    const angle = Math.atan2(dy, dx);
    const push = (40 - dist); 
    
    // Push c1 away from c2 (assuming c2 is heavier/static for this calculation or we just push self)
    // Actually for MyCar vs Others, we only move MyCar usually, unless it's local CPU
    
    if (c2 instanceof CpuCar) {
        // Push both
        const halfPush = push / 2;
        c1.x += Math.cos(angle) * halfPush;
        c1.y += Math.sin(angle) * halfPush;
        c2.x -= Math.cos(angle) * halfPush;
        c2.y -= Math.sin(angle) * halfPush;
        
        c1.speed *= -0.5;
        c2.speed *= -0.5;
    } else {
        // c2 is remote player, treat as static wall for push purposes (can't move them)
        c1.x += Math.cos(angle) * push;
        c1.y += Math.sin(angle) * push;
        c1.speed *= -0.5;
    }
    
    SoundManager.playCollision();
}

function gameOver() {
    gameState = 'GAME_OVER';
    document.getElementById('game-over').style.display = 'block';
    if (audioCtx) audioCtx.close();
}

function update() {
    if (gameState !== 'PLAYING' && gameState !== 'LOCAL_1VS1' && gameState !== 'RACE' && gameState !== 'TIME_TRIAL') return;

    // Race Logic Update
    if (gameState === 'RACE' || gameState === 'TIME_TRIAL') {
        if (!myCar.finished) {
            const elapsed = Date.now() - raceState.startTime;
            const mins = Math.floor(elapsed / 60000);
            const secs = Math.floor((elapsed % 60000) / 1000);
            const ms = Math.floor((elapsed % 1000) / 10);
            document.getElementById('race-timer').innerText = 
                `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
            document.getElementById('lap-counter').innerText = `LAP: ${myCar.lap}/${raceState.totalLaps}`;
        }
    }

    // --- Player 1 (Arrows) ---
    if (myCar.lives > 0) {
        if (myCar.invulnerable) {
            myCar.invulnerableTimer--;
            if (myCar.invulnerableTimer <= 0) myCar.invulnerable = false;
        }

        // Input P1
        if (keys.ArrowUp) myCar.speed += myCar.acceleration;
        if (keys.ArrowDown) myCar.speed -= myCar.acceleration;
        
        // Friction P1
        if (myCar.speed > 0) myCar.speed -= myCar.friction;
        else if (myCar.speed < 0) myCar.speed += myCar.friction;
        if (Math.abs(myCar.speed) < myCar.friction) myCar.speed = 0;

        // Max Speed P1
        if (myCar.speed > myCar.maxSpeed) myCar.speed = myCar.maxSpeed;
        if (myCar.speed < -myCar.maxSpeed/2) myCar.speed = -myCar.maxSpeed/2;

        // Turning P1
        if (Math.abs(myCar.speed) > 0.1) {
            if (keys.ArrowLeft) myCar.angle -= myCar.turnSpeed * Math.sign(myCar.speed);
            if (keys.ArrowRight) myCar.angle += myCar.turnSpeed * Math.sign(myCar.speed);
        }

        // Move P1
        myCar.x += Math.sin(myCar.angle) * myCar.speed;
        myCar.y -= Math.cos(myCar.angle) * myCar.speed;

        // Bounds P1
        if (myCar.x < 0) myCar.x = 0;
        if (myCar.x > canvas.width) myCar.x = canvas.width;
        if (myCar.y < 0) myCar.y = 0;
        if (myCar.y > canvas.height) myCar.y = canvas.height;
    }

    // --- Player 2 (WSAD) - Only in LOCAL_1VS1 ---
    if (gameState === 'LOCAL_1VS1' && localPlayer2.lives > 0) {
        if (localPlayer2.invulnerable) {
            localPlayer2.invulnerableTimer--;
            if (localPlayer2.invulnerableTimer <= 0) localPlayer2.invulnerable = false;
        }

        // Input P2
        if (keys.KeyW) localPlayer2.speed += localPlayer2.acceleration;
        if (keys.KeyS) localPlayer2.speed -= localPlayer2.acceleration;
        
        // Friction P2
        if (localPlayer2.speed > 0) localPlayer2.speed -= localPlayer2.friction;
        else if (localPlayer2.speed < 0) localPlayer2.speed += localPlayer2.friction;
        if (Math.abs(localPlayer2.speed) < localPlayer2.friction) localPlayer2.speed = 0;

        // Max Speed P2
        if (localPlayer2.speed > localPlayer2.maxSpeed) localPlayer2.speed = localPlayer2.maxSpeed;
        if (localPlayer2.speed < -localPlayer2.maxSpeed/2) localPlayer2.speed = -localPlayer2.maxSpeed/2;

        // Turning P2
        if (Math.abs(localPlayer2.speed) > 0.1) {
            if (keys.KeyA) localPlayer2.angle -= localPlayer2.turnSpeed * Math.sign(localPlayer2.speed);
            if (keys.KeyD) localPlayer2.angle += localPlayer2.turnSpeed * Math.sign(localPlayer2.speed);
        }

        // Move P2
        localPlayer2.x += Math.sin(localPlayer2.angle) * localPlayer2.speed;
        localPlayer2.y -= Math.cos(localPlayer2.angle) * localPlayer2.speed;

        // Bounds P2
        if (localPlayer2.x < 0) localPlayer2.x = 0;
        if (localPlayer2.x > canvas.width) localPlayer2.x = canvas.width;
        if (localPlayer2.y < 0) localPlayer2.y = 0;
        if (localPlayer2.y > canvas.height) localPlayer2.y = canvas.height;
    }

    // CPU Updates
    if (gameState === 'PLAYING' || gameState === 'RACE') {
        cpuCars.forEach(cpu => cpu.update());
    }

    // Collisions
    checkCollisions();
    checkCheckpoints(myCar);
    checkNitro(myCar);
    if (gameState === 'RACE') {
        cpuCars.forEach(cpu => {
            checkCheckpoints(cpu);
            checkNitro(cpu);
        });
    }

    // Sound (Mix speeds)
    let maxSpeed = Math.abs(myCar.speed);
    if (gameState === 'LOCAL_1VS1') {
        maxSpeed = Math.max(maxSpeed, Math.abs(localPlayer2.speed));
    }
    SoundManager.updateEngine(maxSpeed);

    // Network (Only P1 sends data if online)
    if (gameState === 'PLAYING' || gameState === 'RACE') {
        socket.emit('playerMovement', {
            x: myCar.x,
            y: myCar.y,
            angle: myCar.angle
        });
        
        // Local update for rendering
        if (players[socket.id]) {
            players[socket.id].x = myCar.x;
            players[socket.id].y = myCar.y;
            players[socket.id].angle = myCar.angle;
            players[socket.id].color = myCar.color; 
        }
    }
}

function checkNitro(car) {
    if (gameNitro.length === 0) return;
    
    for (let n of gameNitro) {
        if (car.x > n.x && car.x < n.x + n.w &&
            car.y > n.y && car.y < n.y + n.h) {
            car.nitroTimer = 60; // 1 second
        }
    }
}

function checkCheckpoints(car) {
    if (car.finished) return;

    // Determine target
    let targetCp = null;
    let isFinishLine = false;

    if (car.nextCheckpointIndex < gameCheckpoints.length) {
        targetCp = gameCheckpoints[car.nextCheckpointIndex];
    } else if (gameFinishPoint) {
        targetCp = gameFinishPoint;
        isFinishLine = true;
    } else if (gameStartPoint) {
        // Loop back to start if no finish point
        targetCp = gameStartPoint;
        isFinishLine = true;
    }

    if (!targetCp) return;

    // Check collision with target
    if (car.x > targetCp.x && car.x < targetCp.x + targetCp.w &&
        car.y > targetCp.y && car.y < targetCp.y + targetCp.h) {
        
        if (isFinishLine) {
            // Lap Complete
            if (car.lap < raceState.totalLaps) {
                car.lap++;
                car.nextCheckpointIndex = 0; // Reset to first CP
            } else {
                car.finished = true;
                if (car === myCar) {
                    alert('META! Twój czas: ' + document.getElementById('race-timer').innerText);
                }
            }
        } else {
            // Intermediate CP hit
            car.nextCheckpointIndex++;
        }
    }
}

function drawCar(x, y, angle, color, label, invulnerable) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    
    // Blink if invulnerable
    if (invulnerable && Math.floor(Date.now() / 100) % 2 === 0) {
        ctx.globalAlpha = 0.5;
    }

    ctx.fillStyle = color;
    ctx.fillRect(-10, -20, 20, 40);
    
    // Lights
    ctx.fillStyle = '#ffff00';
    ctx.fillRect(-8, -20, 4, 4);
    ctx.fillRect(4, -20, 4, 4);
    
    // Windshield
    ctx.fillStyle = '#000';
    ctx.fillRect(-8, -10, 16, 8);

    ctx.restore();

    // Label
    if (label) {
        ctx.fillStyle = '#fff';
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, y - 30);
    }
}

function draw() {
    if (gameState !== 'PLAYING' && gameState !== 'GAME_OVER' && gameState !== 'BUILDER' && gameState !== 'LOCAL_1VS1' && gameState !== 'RACE' && gameState !== 'TIME_TRIAL') return;

    // BG
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    const gridSize = gameState === 'BUILDER' ? TILE_SIZE : 50;
    for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    // Draw Map
    ctx.fillStyle = '#888';
    for (let wall of gameMap) {
        ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
        // Bevel effect
        ctx.strokeStyle = '#aaa';
        ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);
    }

    // Draw Checkpoints
    gameCheckpoints.forEach((cp, index) => {
        ctx.fillStyle = 'rgba(255, 255, 0, 0.3)';
        ctx.fillRect(cp.x, cp.y, cp.w, cp.h);
        
        if (gameState === 'BUILDER') {
            ctx.fillStyle = '#fff';
            ctx.font = '12px Arial';
            ctx.fillText(index + 1, cp.x + 10, cp.y + 25);
        }
    });

    // Draw Start
    if (gameStartPoint) {
        ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
        ctx.fillRect(gameStartPoint.x, gameStartPoint.y, gameStartPoint.w, gameStartPoint.h);
        if (gameState === 'BUILDER') {
            ctx.fillStyle = '#fff';
            ctx.font = '12px Arial';
            ctx.fillText('S', gameStartPoint.x + 15, gameStartPoint.y + 25);
        }
    }

    // Draw Finish
    if (gameFinishPoint) {
        ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
        ctx.fillRect(gameFinishPoint.x, gameFinishPoint.y, gameFinishPoint.w, gameFinishPoint.h);
        // Checkerboard pattern
        ctx.fillStyle = '#fff';
        ctx.fillRect(gameFinishPoint.x, gameFinishPoint.y, 20, 20);
        ctx.fillRect(gameFinishPoint.x + 20, gameFinishPoint.y + 20, 20, 20);
        if (gameState === 'BUILDER') {
            ctx.fillStyle = '#000';
            ctx.font = '12px Arial';
            ctx.fillText('M', gameFinishPoint.x + 15, gameFinishPoint.y + 25);
        }
    }

    // Draw Nitro
    ctx.fillStyle = 'rgba(0, 0, 255, 0.5)';
    for (let n of gameNitro) {
        ctx.fillRect(n.x, n.y, n.w, n.h);
        // Arrow
        ctx.strokeStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(n.x + 10, n.y + 30);
        ctx.lineTo(n.x + 20, n.y + 10);
        ctx.lineTo(n.x + 30, n.y + 30);
        ctx.stroke();
    }

    if (gameState === 'BUILDER') {
        return; 
    }

    // Draw CPU
    if (gameState === 'PLAYING' || gameState === 'RACE') {
        cpuCars.forEach(cpu => cpu.draw());
    }

    // Draw Players (Online)
    if (gameState === 'PLAYING' || gameState === 'RACE') {
        Object.keys(players).forEach((id) => {
            const p = players[id];
            if (id === socket.id) {
                drawCar(myCar.x, myCar.y, myCar.angle, myCar.color, myCar.name, myCar.invulnerable);
            } else {
                drawCar(p.x, p.y, p.angle, p.color, p.name, false);
            }
        });
    }

    // Draw Local 1vs1
    if (gameState === 'LOCAL_1VS1') {
        if (myCar.lives > 0) {
            drawCar(myCar.x, myCar.y, myCar.angle, myCar.color, myCar.name, myCar.invulnerable);
        }
        if (localPlayer2.lives > 0) {
            drawCar(localPlayer2.x, localPlayer2.y, localPlayer2.angle, localPlayer2.color, localPlayer2.name, localPlayer2.invulnerable);
        }
    }
    // Draw Time Trial
    if (gameState === 'TIME_TRIAL') {
        drawCar(myCar.x, myCar.y, myCar.angle, myCar.color, myCar.name, myCar.invulnerable);
    }
}

function gameLoop() {
    update();
    draw();
    requestAnimationFrame(gameLoop);
}

gameLoop();
