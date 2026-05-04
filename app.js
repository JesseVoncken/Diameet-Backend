require('dotenv').config(); // MUST be the first line
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// --- 1. CONFIGURATION ---
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_random_string'; 
const PORT = process.env.PORT || 4000;
// Use the Atlas URI from .env, fallback to local if not found
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/diameet';

const io = require('socket.io')(http, {
  cors: {
    origin: ["http://localhost:3000", "https://your-github-username.github.io"], // Add your GH Pages URL later
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// --- 2. DATABASE & MODELS ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log("🚀 Connected to MongoDB Atlas Cloud!"))
  .catch(err => {
    console.error("❌ Could not connect to MongoDB:", err);
    process.exit(1);
  });

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatar: { type: String, default: 'https://i.pravatar.cc/150' }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  id: String, 
  user: String,
  text: String,
  image: String, 
  channel: String,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// --- 3. API ROUTES ---

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ message: "User created!" });
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: "Login error" });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, 'username avatar'); 
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// --- 4. SOCKET LOGIC ---

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join-channel', async (channelName) => {
        socket.rooms.forEach(room => {
            if (room !== socket.id) socket.leave(room);
        });
        socket.join(channelName);

        try {
            const history = await Message.find({ channel: channelName })
                                         .sort({ timestamp: -1 })
                                         .limit(50);
            socket.emit('load-history', history.reverse());
        } catch (err) {
            console.error("Error fetching history:", err);
        }
    });

    socket.on('chat-message', async (data) => {
        try {
            const exists = await Message.findOne({ id: data.id });
            if (exists) return;

            const newMessage = new Message({
                id: data.id,
                user: data.user,
                text: data.text || null,
                image: data.image || null,
                channel: data.channel,
                timestamp: data.timestamp || new Date()
            });

            await newMessage.save();
            io.to(data.channel).emit('chat-message', newMessage);
        } catch (err) {
            console.error("Error handling chat-message:", err);
        }
    });

    socket.on('clear-channel-perm', async (channelName) => {
        try {
            await Message.deleteMany({ channel: channelName });
            io.to(channelName).emit('channel-cleared-perm');
        } catch (err) {
            console.error("Error clearing channel:", err);
        }
    });

    socket.on('disconnect', () => console.log('User disconnected'));
});

http.listen(PORT, () => {
    console.log(`Server live at http://localhost:${PORT}`);
});