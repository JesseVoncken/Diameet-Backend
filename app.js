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
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/diameet';

// --- FIXED CORS SETTINGS ---
const allowedOrigins = [
  "http://localhost:3000", 
  "https://jessevoncken.github.io",
  "https://app.diameet.nl",
];

// FIND THIS BLOCK IN YOUR BACKEND app.js:
const io = require('socket.io')(http, {
  cors: {
    origin: allowedOrigins, 
    methods: ["GET", "POST"],
    credentials: true
  },
  // ADD THIS LINE HERE (Allows up to 50MB image payloads through sockets)
  maxHttpBufferSize: 5e7 
});

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Increased limits for Base64 image strings
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
  avatar: { type: String, default: '' }, // Leave empty so fallback triggers correctly
  role: { type: String, default: '🩸 Diabeet' },
  interests: { type: [String], default: [] },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  id: String, 
  user: String,
  avatar: String,  
  role: String,    
  text: String,
  image: String,
  channel: String,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// --- JWT AUTHENTICATION MIDDLEWARE (FIXED) ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // FIXED: Correctly splits "Bearer <token>" to grab the token item at index 1
  const token = authHeader && authHeader.split(' ')[1]; 

  if (!token) return res.status(401).json({ error: "Access token missing" });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = decoded;
    next();
  });
};

// --- 3. API ROUTES ---

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, avatar, role, interests } = req.body;
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ 
      username, 
      password: hashedPassword,
      avatar: avatar || '', // Storing clean or empty string
      role: role || '🩸 Diabeet',
      interests: interests || []
    });
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
    
    res.json({ 
      token, 
      username: user.username,
      avatar: user.avatar,
      role: user.role
    });
  } catch (err) {
    res.status(500).json({ error: "Login error" });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, 'username avatar role'); 
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// --- FRIENDSHIP: Model + Endpoints ---
const friendRequestSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const FriendRequest = mongoose.model('FriendRequest', friendRequestSchema);

// Send friend request
app.post('/api/friends/request', authenticateToken, async (req, res) => {
  try {
    const senderId = req.user.id;
    const { recipientUsername } = req.body;
    if (!recipientUsername) return res.status(400).json({ error: 'recipientUsername required' });

    const recipient = await User.findOne({ username: recipientUsername });
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
    if (recipient._id.equals(senderId)) return res.status(400).json({ error: 'Cannot friend yourself' });

    const sender = await User.findById(senderId);
    if (sender.friends && sender.friends.some(f => f.equals(recipient._id))) {
      return res.status(400).json({ error: 'Already friends' });
    }

    const existing = await FriendRequest.findOne({
      $or: [
        { sender: senderId, recipient: recipient._id, status: 'pending' },
        { sender: recipient._id, recipient: senderId, status: 'pending' }
      ]
    });
    if (existing) return res.status(400).json({ error: 'Friend request already pending' });

    const fr = new FriendRequest({ sender: senderId, recipient: recipient._id });
    await fr.save();
    res.json({ ok: true, message: 'Request sent' });
  } catch (err) {
    console.error('Friend request error:', err);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});

// List pending incoming friend requests
app.get('/api/friends/requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const requests = await FriendRequest.find({ recipient: userId, status: 'pending' })
      .populate('sender', '_id username role avatar')
      .sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    console.error('Fetch friend requests error:', err);
    res.status(500).json({ error: 'Failed to fetch friend requests' });
  }
});

// List friends
app.get('/api/friends/list', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).populate('friends', 'username avatar role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.friends || []);
  } catch (err) {
    console.error('Fetch friends error:', err);
    res.status(500).json({ error: 'Failed to fetch friends' });
  }
});

// Accept friend request
app.post('/api/friends/accept', authenticateToken, async (req, res) => {
  try {
    const recipientId = req.user.id;
    const { senderId } = req.body;
    if (!senderId) return res.status(400).json({ error: 'senderId required' });

    const fr = await FriendRequest.findOne({ sender: senderId, recipient: recipientId, status: 'pending' });
    if (!fr) return res.status(404).json({ error: 'Friend request not found' });

    const [sender, recipient] = await Promise.all([
      User.findById(senderId),
      User.findById(recipientId)
    ]);
    if (!sender || !recipient) return res.status(404).json({ error: 'User not found' });

    sender.friends = sender.friends || [];
    recipient.friends = recipient.friends || [];

    if (!sender.friends.some(f => f.equals(recipient._id))) sender.friends.push(recipient._id);
    if (!recipient.friends.some(f => f.equals(sender._id))) recipient.friends.push(sender._id);

    await Promise.all([sender.save(), recipient.save()]);

    fr.status = 'accepted';
    await fr.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('Accept friend request error:', err);
    res.status(500).json({ error: 'Failed to accept friend request' });
  }
});

// Reject friend request
app.post('/api/friends/reject', authenticateToken, async (req, res) => {
  try {
    const recipientId = req.user.id;
    const { senderId } = req.body;
    if (!senderId) return res.status(400).json({ error: 'senderId required' });

    const fr = await FriendRequest.findOne({ sender: senderId, recipient: recipientId, status: 'pending' });
    if (!fr) return res.status(404).json({ error: 'Friend request not found' });

    fr.status = 'rejected';
    await fr.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('Reject friend request error:', err);
    res.status(500).json({ error: 'Failed to reject friend request' });
  }
});

app.delete('/api/users/delete', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    await User.findByIdAndDelete(userId);
    res.json({ success: true, message: "Account profile successfully dropped." });
  } catch (err) {
    console.error("Account deletion error:", err);
    res.status(500).json({ error: "Failed to erase account profiles." });
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
                avatar: data.avatar || '',
                role: data.role || '🩸 Diabeet',
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