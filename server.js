const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));

// 役職定義
const ROLES = {
    villager: { name: '村人', team: 'villager', description: '特殊能力はありません。人狼を見つけ出しましょう' },
    seer: { name: '占い師', team: 'villager', description: '毎夜一人を占い、人狼か否かを知ることができます' },
    medium: { name: '霊能者', team: 'villager', description: '処刑された人の正体を知ることができます' },
    knight: { name: '狩人', team: 'villager', description: '毎夜一人を人狼の襲撃から守ることができます' },
    werewolf: { name: '人狼', team: 'werewolf', description: '毎夜村人を一人襲撃します。正体がバレないよう気をつけましょう' }
};

// ゲームの状態管理
class WerewolfGame {
    constructor() {
        this.players = new Map();
        this.gameState = 'waiting'; // waiting, night, day, voting, ended
        this.dayCount = 1;
        this.votes = new Map();
        this.nightActions = new Map();
        this.gameTimer = null;
        this.phaseTimeLimit = 120; // 2分
        this.timeRemaining = 0;
        this.lastExecuted = null;
        this.nightResult = null;
    }

    // プレイヤー追加
    addPlayer(playerId, name) {
        if (this.gameState !== 'waiting') return false;
        
        const player = {
            id: playerId,
            name: name,
            role: null,
            isAlive: true,
            deathReason: null,
            lastWords: null
        };
        
        this.players.set(playerId, player);
        return true;
    }

    // プレイヤー削除
    removePlayer(playerId) {
        this.players.delete(playerId);
        this.votes.delete(playerId);
        this.nightActions.delete(playerId);
    }

    // 役職の配布
    assignRoles() {
        const playerCount = this.players.size;
        const playerIds = Array.from(this.players.keys());
        
        // 人数に応じた役職配置
        let werewolfCount = Math.floor(playerCount / 3);
        if (werewolfCount === 0) werewolfCount = 1;
        
        const roles = [];
        
        // 人狼
        for (let i = 0; i < werewolfCount; i++) {
            roles.push('werewolf');
        }
        
        // 特殊役職
        if (playerCount >= 4) roles.push('seer');
        if (playerCount >= 5) roles.push('medium');
        if (playerCount >= 6) roles.push('knight');
        
        // 残りは村人
        while (roles.length < playerCount) {
            roles.push('villager');
        }
        
        // シャッフル
        for (let i = roles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [roles[i], roles[j]] = [roles[j], roles[i]];
        }
        
        // 役職を配布
        playerIds.forEach((playerId, index) => {
            const player = this.players.get(playerId);
            player.role = roles[index];
        });
    }

    // ゲーム開始
    startGame() {
        if (this.players.size < 4) return false;
        
        this.assignRoles();
        this.gameState = 'night';
        this.dayCount = 1;
        this.startPhaseTimer();
        return true;
    }

    // フェーズタイマー開始
    startPhaseTimer() {
        this.timeRemaining = this.phaseTimeLimit;
        this.gameTimer = setInterval(() => {
            this.timeRemaining--;
            io.emit('timer-update', { timeRemaining: this.timeRemaining });
            
            if (this.timeRemaining <= 0) {
                this.nextPhase();
            }
        }, 1000);
    }

    // 次のフェーズへ
    nextPhase() {
        clearInterval(this.gameTimer);
        
        if (this.gameState === 'night') {
            this.processNightActions();
            this.gameState = 'day';
        } else if (this.gameState === 'day') {
            this.gameState = 'voting';
        } else if (this.gameState === 'voting') {
            this.processVotes();
            if (this.checkGameEnd()) {
                this.gameState = 'ended';
                return;
            }
            this.gameState = 'night';
            this.dayCount++;
            this.nightActions.clear();
        }
        
        this.votes.clear();
        this.startPhaseTimer();
    }

    // 夜の行動処理
    processNightActions() {
        const actions = Array.from(this.nightActions.values());
        let attackTarget = null;
        let defendTarget = null;
        let seerTarget = null;
        
        // 人狼の襲撃
        const werewolfAttacks = actions.filter(a => a.type === 'attack');
        if (werewolfAttacks.length > 0) {
            // 複数の人狼がいる場合は投票で決定
            const attackVotes = {};
            werewolfAttacks.forEach(attack => {
                attackVotes[attack.target] = (attackVotes[attack.target] || 0) + 1;
            });
            
            let maxVotes = 0;
            let mostVotedTarget = null;
            for (const [target, votes] of Object.entries(attackVotes)) {
                if (votes > maxVotes) {
                    maxVotes = votes;
                    mostVotedTarget = target;
                }
            }
            attackTarget = mostVotedTarget;
        }
        
        // 狩人の護衛
        const knightDefense = actions.find(a => a.type === 'defend');
        if (knightDefense) {
            defendTarget = knightDefense.target;
        }
        
        // 占い師の占い
        const seerCheck = actions.find(a => a.type === 'divine');
        if (seerCheck) {
            seerTarget = seerCheck.target;
        }
        
        // 襲撃処理
        if (attackTarget && attackTarget !== defendTarget) {
            const target = this.players.get(attackTarget);
            if (target && target.isAlive) {
                target.isAlive = false;
                target.deathReason = '人狼に襲撃されました';
            }
        }
        
        // 占い結果の保存
        if (seerTarget) {
            const seer = Array.from(this.players.values()).find(p => p.role === 'seer' && p.isAlive);
            const target = this.players.get(seerTarget);
            if (seer && target) {
                const result = target.role === 'werewolf' ? '人狼' : '人狼ではない';
                this.nightResult = {
                    type: 'seer',
                    playerId: seer.id,
                    target: target.name,
                    result: result
                };
            }
        }
    }

    // 投票処理
    processVotes() {
        const voteCount = {};
        const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);
        
        // 投票集計
        for (const [voter, target] of this.votes) {
            const voterPlayer = this.players.get(voter);
            if (voterPlayer && voterPlayer.isAlive) {
                voteCount[target] = (voteCount[target] || 0) + 1;
            }
        }
        
        // 最多得票者を決定
        let maxVotes = 0;
        let executedPlayer = null;
        const tied = [];
        
        for (const [target, votes] of Object.entries(voteCount)) {
            if (votes > maxVotes) {
                maxVotes = votes;
                executedPlayer = target;
                tied.length = 0;
                tied.push(target);
            } else if (votes === maxVotes) {
                tied.push(target);
            }
        }
        
        // 同票の場合はランダム
        if (tied.length > 1) {
            executedPlayer = tied[Math.floor(Math.random() * tied.length)];
        }
        
        // 処刑実行
        if (executedPlayer && maxVotes > 0) {
            const player = this.players.get(executedPlayer);
            if (player) {
                player.isAlive = false;
                player.deathReason = '投票により処刑されました';
                this.lastExecuted = player;
            }
        }
    }

    // ゲーム終了判定
    checkGameEnd() {
        const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);
        const aliveWerewolves = alivePlayers.filter(p => p.role === 'werewolf');
        const aliveVillagers = alivePlayers.filter(p => p.role !== 'werewolf');
        
        if (aliveWerewolves.length === 0) {
            this.winner = 'villager';
            return true;
        }
        
        if (aliveWerewolves.length >= aliveVillagers.length) {
            this.winner = 'werewolf';
            return true;
        }
        
        return false;
    }

    // 夜の行動を受け付け
    setNightAction(playerId, action) {
        const player = this.players.get(playerId);
        if (!player || !player.isAlive || this.gameState !== 'night') return false;
        
        this.nightActions.set(playerId, { playerId, ...action });
        return true;
    }

    // 投票
    setVote(playerId, targetId) {
        const player = this.players.get(playerId);
        if (!player || !player.isAlive || this.gameState !== 'voting') return false;
        
        this.votes.set(playerId, targetId);
        return true;
    }

    // ゲーム状態の取得
    getGameState() {
        return {
            gameState: this.gameState,
            dayCount: this.dayCount,
            timeRemaining: this.timeRemaining,
            players: Array.from(this.players.values()),
            votes: Array.from(this.votes.entries()),
            winner: this.winner,
            lastExecuted: this.lastExecuted,
            nightResult: this.nightResult
        };
    }

    // プレイヤーの役職取得
    getPlayerRole(playerId) {
        const player = this.players.get(playerId);
        return player ? player.role : null;
    }

    // 人狼同士の情報取得
    getWerewolfInfo(playerId) {
        const player = this.players.get(playerId);
        if (!player || player.role !== 'werewolf') return null;
        
        return Array.from(this.players.values())
            .filter(p => p.role === 'werewolf' && p.id !== playerId)
            .map(p => ({ id: p.id, name: p.name }));
    }
}

// ゲームインスタンス
const game = new WerewolfGame();

// Socket.IO接続処理
io.on('connection', (socket) => {
    console.log('プレイヤーが接続しました:', socket.id);
    
    // プレイヤー参加
    socket.on('join-game', (data) => {
        const { name } = data;
        if (game.addPlayer(socket.id, name)) {
            socket.emit('joined', { 
                playerId: socket.id, 
                name: name,
                gameState: game.getGameState()
            });
            
            // 全プレイヤーに参加通知
            io.emit('player-joined', {
                playerId: socket.id,
                name: name,
                gameState: game.getGameState()
            });
        } else {
            socket.emit('join-failed', { reason: 'ゲームが開始されています' });
        }
    });
    
    // ゲーム開始
    socket.on('start-game', () => {
        if (game.startGame()) {
            // 各プレイヤーに役職を通知
            for (const [playerId, player] of game.players) {
                const playerSocket = io.sockets.sockets.get(playerId);
                if (playerSocket) {
                    playerSocket.emit('role-assigned', {
                        role: player.role,
                        roleInfo: ROLES[player.role],
                        werewolfInfo: game.getWerewolfInfo(playerId)
                    });
                }
            }
            
            io.emit('game-started', game.getGameState());
        } else {
            socket.emit('start-failed', { reason: '4人以上必要です' });
        }
    });
    
    // 夜の行動
    socket.on('night-action', (data) => {
        if (game.setNightAction(socket.id, data)) {
            socket.emit('action-accepted');
        } else {
            socket.emit('action-rejected');
        }
    });
    
    // 投票
    socket.on('vote', (data) => {
        const { targetId } = data;
        if (game.setVote(socket.id, targetId)) {
            socket.emit('vote-accepted');
            io.emit('vote-update', game.getGameState());
        } else {
            socket.emit('vote-rejected');
        }
    });
    
    // チャット
    socket.on('chat-message', (data) => {
        const { message } = data;
        const player = game.players.get(socket.id);
        if (player && player.isAlive) {
            io.emit('chat-message', {
                playerId: socket.id,
                name: player.name,
                message: message,
                timestamp: new Date().toISOString()
            });
        }
    });
    
    // 人狼チャット
    socket.on('werewolf-chat', (data) => {
        const { message } = data;
        const player = game.players.get(socket.id);
        if (player && player.role === 'werewolf' && player.isAlive) {
            // 人狼のみに送信
            for (const [playerId, p] of game.players) {
                if (p.role === 'werewolf' && p.isAlive) {
                    const playerSocket = io.sockets.sockets.get(playerId);
                    if (playerSocket) {
                        playerSocket.emit('werewolf-chat', {
                            playerId: socket.id,
                            name: player.name,
                            message: message,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
        }
    });
    
    // フェーズ移行
    socket.on('next-phase', () => {
        game.nextPhase();
        io.emit('phase-changed', game.getGameState());
        
        // 霊能者に結果を通知
        if (game.gameState === 'night' && game.lastExecuted) {
            const medium = Array.from(game.players.values()).find(p => p.role === 'medium' && p.isAlive);
            if (medium) {
                const mediumSocket = io.sockets.sockets.get(medium.id);
                if (mediumSocket) {
                    mediumSocket.emit('medium-result', {
                        target: game.lastExecuted.name,
                        result: game.lastExecuted.role === 'werewolf' ? '人狼' : '人狼ではない'
                    });
                }
            }
        }
        
        // 占い師に結果を通知
        if (game.gameState === 'day' && game.nightResult) {
            const seerSocket = io.sockets.sockets.get(game.nightResult.playerId);
            if (seerSocket) {
                seerSocket.emit('seer-result', game.nightResult);
            }
            game.nightResult = null;
        }
    });
    
    // 切断処理
    socket.on('disconnect', () => {
        console.log('プレイヤーが切断しました:', socket.id);
        game.removePlayer(socket.id);
        io.emit('player-left', {
            playerId: socket.id,
            gameState: game.getGameState()
        });
    });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`人狼ゲームサーバーがポート${PORT}で起動しました`);
});

// ルートページ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
