// server.js - Complete Backend for Counter App
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('../frontend')); // Serve frontend from parent folder

// Database (In-memory for simplicity)
const users = [];
const wallets = {};
const transactions = [];
const JWT_SECRET = process.env.JWT_SECRET || 'narayan-counter-secret-2024';

// Auth Middleware
const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// Routes
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: '../frontend' });
});

// Register User
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        // Check if user exists
        if (users.find(u => u.email === email)) {
            return res.status(400).json({ error: 'User already exists' });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = {
            id: Date.now().toString(),
            name,
            email,
            password: hashedPassword,
            createdAt: new Date(),
            lastLogin: new Date()
        };
        
        users.push(user);
        
        // Create wallet
        wallets[user.id] = {
            userId: user.id,
            coins: 0,
            balance: 0,
            totalEarned: 0,
            totalWithdrawn: 0,
            createdAt: new Date()
        };
        
        // Generate token
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.status(201).json({
            success: true,
            message: 'Registration successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Login User
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = users.find(u => u.email === email);
        
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }
        
        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid password' });
        }
        
        // Update last login
        user.lastLogin = new Date();
        
        // Generate token
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get User Profile
app.get('/api/profile', auth, (req, res) => {
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const wallet = wallets[user.id] || { coins: 0, balance: 0 };
    
    res.json({
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin
        },
        wallet
    });
});

// Get Wallet Balance
app.get('/api/wallet', auth, (req, res) => {
    const wallet = wallets[req.user.id];
    if (!wallet) {
        wallets[req.user.id] = {
            userId: req.user.id,
            coins: 0,
            balance: 0,
            totalEarned: 0,
            totalWithdrawn: 0,
            createdAt: new Date()
        };
    }
    
    res.json(wallets[req.user.id]);
});

// Add Coins
app.post('/api/add-coins', auth, (req, res) => {
    const { coins = 1, source = 'voice' } = req.body;
    const userId = req.user.id;
    
    if (!wallets[userId]) {
        wallets[userId] = {
            userId,
            coins: 0,
            balance: 0,
            totalEarned: 0,
            totalWithdrawn: 0,
            createdAt: new Date()
        };
    }
    
    // Add coins
    wallets[userId].coins += parseInt(coins);
    wallets[userId].balance = wallets[userId].coins / 100;
    wallets[userId].totalEarned += parseInt(coins);
    
    // Create transaction record
    const transaction = {
        id: Date.now().toString(),
        userId,
        type: 'credit',
        amount: coins,
        source,
        description: source === 'voice' ? 'Voice detection: Narayan' : 'Manual addition',
        date: new Date(),
        balance: wallets[userId].coins
    };
    
    transactions.push(transaction);
    
    // Real-time update
    io.emit('wallet-update', {
        userId,
        wallet: wallets[userId],
        transaction
    });
    
    res.json({
        success: true,
        message: `${coins} coin(s) added successfully`,
        wallet: wallets[userId],
        transaction
    });
});

// Withdraw Money
app.post('/api/withdraw', auth, (req, res) => {
    const { amount, method, upiId, accountNumber, ifscCode, accountName } = req.body;
    const userId = req.user.id;
    const wallet = wallets[userId];
    
    if (!wallet) {
        return res.status(400).json({ error: 'Wallet not found' });
    }
    
    // Validate amount
    const amountNum = parseFloat(amount);
    if (amountNum < 50 || amountNum > 500) {
        return res.status(400).json({ 
            error: 'Withdrawal amount must be between ₹50 and ₹500' 
        });
    }
    
    // Calculate coins needed
    const coinsNeeded = amountNum * 100;
    if (wallet.coins < coinsNeeded) {
        return res.status(400).json({ 
            error: 'Insufficient coins',
            required: coinsNeeded,
            available: wallet.coins
        });
    }
    
    // Process withdrawal
    wallet.coins -= coinsNeeded;
    wallet.balance = wallet.coins / 100;
    wallet.totalWithdrawn += amountNum;
    
    // Create withdrawal transaction
    const transaction = {
        id: Date.now().toString(),
        userId,
        type: 'debit',
        amount: amountNum,
        coinsUsed: coinsNeeded,
        method,
        status: 'pending',
        date: new Date(),
        upiId: method === 'upi' ? upiId : null,
        accountNumber: method === 'bank' ? accountNumber : null,
        ifscCode: method === 'bank' ? ifscCode : null,
        accountName: method === 'bank' ? accountName : null,
        balance: wallet.coins
    };
    
    transactions.push(transaction);
    
    // Real-time updates
    io.emit('wallet-update', { userId, wallet });
    io.emit('transaction', transaction);
    
    res.json({
        success: true,
        message: 'Withdrawal request submitted successfully',
        transaction,
        wallet
    });
});

// Get Transactions
app.get('/api/transactions', auth, (req, res) => {
    const userTransactions = transactions
        .filter(t => t.userId === req.user.id)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    
    res.json(userTransactions);
});

// Get Leaderboard
app.get('/api/leaderboard', (req, res) => {
    const leaderboard = Object.values(wallets)
        .map(wallet => ({
            userId: wallet.userId,
            userName: users.find(u => u.id === wallet.userId)?.name || 'Unknown',
            coins: wallet.coins,
            balance: wallet.balance,
            totalEarned: wallet.totalEarned
        }))
        .sort((a, b) => b.coins - a.coins)
        .slice(0, 10);
    
    res.json(leaderboard);
});

// Get Stats
app.get('/api/stats', auth, (req, res) => {
    const userId = req.user.id;
    const wallet = wallets[userId] || { coins: 0, balance: 0, totalEarned: 0 };
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayCoins = transactions
        .filter(t => 
            t.userId === userId && 
            t.type === 'credit' &&
            new Date(t.date) >= today
        )
        .reduce((sum, t) => sum + t.amount, 0);
    
    const totalUsers = users.length;
    const totalCoins = Object.values(wallets).reduce((sum, w) => sum + w.coins, 0);
    const totalWithdrawn = Object.values(wallets).reduce((sum, w) => sum + w.totalWithdrawn, 0);
    
    res.json({
        personal: {
            todayCoins,
            totalEarned: wallet.totalEarned,
            totalWithdrawn: wallet.totalWithdrawn || 0,
            joinDate: users.find(u => u.id === userId)?.createdAt || new Date()
        },
        global: {
            totalUsers,
            totalCoins,
            totalWithdrawn,
            totalValue: totalCoins / 100
        }
    });
});

// Update Transaction Status (Admin - for demo)
app.post('/api/transaction/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    const transaction = transactions.find(t => t.id === id);
    if (!transaction) {
        return res.status(404).json({ error: 'Transaction not found' });
    }
    
    transaction.status = status;
    transaction.updatedAt = new Date();
    
    if (status === 'completed') {
        io.emit('withdrawal-completed', transaction);
    }
    
    res.json({ success: true, transaction });
});

// Voice Detection Endpoint (Alternative to browser speech recognition)
app.post('/api/detect-voice', auth, (req, res) => {
    const { text } = req.body;
    
    if (text && text.toLowerCase().includes('narayan')) {
        // Add coin via API call
        const userId = req.user.id;
        
        if (!wallets[userId]) {
            wallets[userId] = {
                userId,
                coins: 0,
                balance: 0,
                totalEarned: 0,
                totalWithdrawn: 0,
                createdAt: new Date()
            };
        }
        
        wallets[userId].coins += 1;
        wallets[userId].balance = wallets[userId].coins / 100;
        wallets[userId].totalEarned += 1;
        
        const transaction = {
            id: Date.now().toString(),
            userId,
            type: 'credit',
            amount: 1,
            source: 'voice-api',
            description: 'Voice detection: Narayan',
            date: new Date(),
            balance: wallets[userId].coins
        };
        
        transactions.push(transaction);
        
        io.emit('wallet-update', {
            userId,
            wallet: wallets[userId],
            transaction
        });
        
        io.emit('voice-detected', {
            userId,
            name: users.find(u => u.id === userId)?.name,
            timestamp: new Date()
        });
        
        return res.json({
            success: true,
            detected: true,
            message: 'Narayan detected! 1 coin added',
            coinsAdded: 1,
            totalCoins: wallets[userId].coins
        });
    }
    
    res.json({
        success: true,
        detected: false,
        message: 'No keyword detected'
    });
});

// WebSocket Connection
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    socket.on('join', (userId) => {
        socket.join(`user-${userId}`);
        console.log(`User ${userId} joined room`);
    });
    
    socket.on('voice-detection-start', (userId) => {
        io.emit('user-listening', {
            userId,
            timestamp: new Date()
        });
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Admin Endpoints (for monitoring)
app.get('/api/admin/stats', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== 'admin123') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    res.json({
        users: users.length,
        wallets: Object.keys(wallets).length,
        transactions: transactions.length,
        totalCoins: Object.values(wallets).reduce((sum, w) => sum + w.coins, 0),
        totalBalance: Object.values(wallets).reduce((sum, w) => sum + w.balance, 0),
        activeConnections: io.engine.clientsCount
    });
});

// Reset for demo (use with caution)
app.post('/api/admin/reset-demo', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== 'admin123') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Keep only the first user (admin) for demo
    if (users.length > 0) {
        const adminUser = users[0];
        users.length = 0;
        users.push(adminUser);
        
        const adminId = adminUser.id;
        const adminWallet = wallets[adminId] || { coins: 0, balance: 0 };
        
        // Reset all wallets except admin
        Object.keys(wallets).forEach(id => {
            if (id !== adminId) delete wallets[id];
        });
        
        // Reset transactions except admin's
        const adminTransactions = transactions.filter(t => t.userId === adminId);
        transactions.length = 0;
        transactions.push(...adminTransactions);
        
        // Reset admin wallet
        wallets[adminId] = {
            userId: adminId,
            coins: 1000, // Give admin some coins for demo
            balance: 10,
            totalEarned: 1000,
            totalWithdrawn: 0,
            createdAt: new Date()
        };
    }
    
    res.json({ success: true, message: 'Demo reset successfully' });
});

// Serve frontend files
app.get('*', (req, res) => {
    res.sendFile(req.path, { root: '../frontend' }, (err) => {
        if (err) {
            res.status(404).json({ error: 'File not found' });
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        error: 'Something went wrong!',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ====================================
      NARAYAN COUNTER BACKEND RUNNING
    ====================================
    Local: http://localhost:${PORT}
    Network: http://${require('os').networkInterfaces().eth0?.[0]?.address || 'localhost'}:${PORT}
    
    Features:
    - Authentication (JWT)
    - Real-time WebSocket updates
    - Voice detection API
    - Wallet system (100 coins = ₹1)
    - Withdrawal system (₹50-₹500)
    - Transaction history
    - Leaderboard
    - Admin panel
    - Demo reset endpoint
    ====================================
    `);
    
    // Create demo admin user if none exists
    if (users.length === 0) {
        bcrypt.hash('admin123', 10).then(hashedPassword => {
            const adminUser = {
                id: 'admin-001',
                name: 'Admin User',
                email: 'admin@narayan.com',
                password: hashedPassword,
                createdAt: new Date(),
                lastLogin: new Date(),
                isAdmin: true
            };
            users.push(adminUser);
            
            wallets[adminUser.id] = {
                userId: adminUser.id,
                coins: 1000,
                balance: 10,
                totalEarned: 1000,
                totalWithdrawn: 0,
                createdAt: new Date()
            };
            
            console.log('Demo admin user created:');
            console.log('Email: admin@narayan.com');
            console.log('Password: admin123');
        });
    }
});
