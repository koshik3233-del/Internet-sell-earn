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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// In-memory storage (replace with database in production)
let users = [];
let wallets = {};
let transactions = [];

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(400).json({ error: 'Invalid token' });
  }
};

// Routes
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(),
      name,
      email,
      password: hashedPassword,
      createdAt: new Date()
    };

    users.push(user);
    
    // Initialize wallet
    wallets[user.id] = {
      userId: user.id,
      coins: 0,
      balance: 0,
      totalEarned: 0
    };

    const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '7d' });
    
    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { id: user.id, name, email }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/wallet', authenticate, (req, res) => {
  const wallet = wallets[req.user.id] || { coins: 0, balance: 0 };
  res.json(wallet);
});

app.post('/api/add-coins', authenticate, (req, res) => {
  const userId = req.user.id;
  const coinsToAdd = req.body.coins || 1;
  
  if (!wallets[userId]) {
    wallets[userId] = {
      userId,
      coins: 0,
      balance: 0,
      totalEarned: 0
    };
  }

  wallets[userId].coins += coinsToAdd;
  wallets[userId].balance = wallets[userId].coins / 100; // 100 coins = 1 Rs
  wallets[userId].totalEarned += coinsToAdd;

  // Emit real-time update
  io.emit('wallet-update', { userId, wallet: wallets[userId] });

  res.json({
    message: `Added ${coinsToAdd} coin(s)`,
    wallet: wallets[userId]
  });
});

app.post('/api/withdraw', authenticate, (req, res) => {
  const { amount, method, upiId, accountNumber } = req.body;
  const userId = req.user.id;
  const wallet = wallets[userId];

  if (!wallet) {
    return res.status(400).json({ error: 'Wallet not found' });
  }

  const amountInRs = parseFloat(amount);
  
  // Validate withdrawal amount
  if (amountInRs < 50 || amountInRs > 500) {
    return res.status(400).json({ 
      error: 'Withdrawal amount must be between ₹50 and ₹500' 
    });
  }

  const coinsNeeded = amountInRs * 100;
  
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

  const transaction = {
    id: Date.now().toString(),
    userId,
    amount: amountInRs,
    method,
    status: 'pending',
    date: new Date(),
    upiId: method === 'upi' ? upiId : null,
    accountNumber: method === 'bank' ? accountNumber : null
  };

  transactions.push(transaction);

  io.emit('wallet-update', { userId, wallet });
  io.emit('transaction', transaction);

  res.json({
    message: 'Withdrawal request submitted',
    transaction,
    wallet
  });
});

app.get('/api/transactions', authenticate, (req, res) => {
  const userTransactions = transactions.filter(t => t.userId === req.user.id);
  res.json(userTransactions);
});

// WebSocket for real-time updates
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});