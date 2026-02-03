const fs = require('fs');
const path = require('path');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 4000;

// --- Create AppState Directory ---
const APPSTATE_DIR = path.join(__dirname, 'appstates');
if (!fs.existsSync(APPSTATE_DIR)) {
  fs.mkdirSync(APPSTATE_DIR, { recursive: true });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let config = {
  delay: 30,
  running: false,
  cookies: [],
  saveAppState: true
};

let messageData = {
  threadIDs: [],
  messages: [],
  currentMessageIndex: 0,
  currentThreadIndex: 0,
  currentAccountIndex: 0,
  loopCount: 0,
  totalMessagesSent: 0,
  hatersName: ['']
};

// --- APPSTATE MANAGER ---
class AppStateManager {
  constructor() {
    this.appStateDir = APPSTATE_DIR;
  }

  saveAppState(accountId, appState) {
    try {
      const filePath = path.join(this.appStateDir, `${accountId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(appState, null, 2));
      console.log(`💾 AppState saved: ${accountId}`);
      return true;
    } catch (error) {
      console.log(`❌ Save failed: ${error.message}`);
      return false;
    }
  }

  loadAppState(accountId) {
    try {
      const filePath = path.join(this.appStateDir, `${accountId}.json`);
      if (fs.existsSync(filePath)) {
        const appState = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        console.log(`✅ AppState loaded: ${accountId}`);
        return appState;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  getAllSavedAccounts() {
    try {
      const files = fs.readdirSync(this.appStateDir);
      return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    } catch (error) {
      return [];
    }
  }

  deleteAppState(accountId) {
    try {
      const filePath = path.join(this.appStateDir, `${accountId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted: ${accountId}`);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }
}

const appStateManager = new AppStateManager();

// --- SESSION MANAGER ---
class MultiIDSessionManager {
  constructor() {
    this.sessions = new Map();
    this.sessionQueue = [];
    this.currentSessionIndex = 0;
  }

  async createAllSessions(cookies, useAppState = true) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Creating ${cookies.length} sessions...`);
    console.log(`${'='.repeat(60)}\n`);
    
    this.sessions.clear();
    this.sessionQueue = [];
    this.currentSessionIndex = 0;

    for (let i = 0; i < cookies.length; i++) {
      console.log(`📍 Account ${i + 1}/${cookies.length}...`);
      await this.createSession(cookies[i], i, useAppState);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    const healthyCount = this.sessionQueue.length;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Ready: ${healthyCount}/${cookies.length} sessions`);
    console.log(`${'='.repeat(60)}\n`);
    
    return healthyCount > 0;
  }

  async createSession(cookieContent, index, useAppState) {
    return new Promise((resolve) => {
      wiegine.login(cookieContent, { 
        logLevel: "silent",
        forceLogin: true,
        selfListen: false
      }, async (err, api) => {
        if (err || !api) {
          console.log(`❌ Session ${index + 1} failed`);
          this.sessions.set(index, { 
            api: null, 
            healthy: false, 
            accountName: 'Failed',
            userId: null
          });
          resolve(false);
          return;
        }

        try {
          const userId = api.getCurrentUserID();
          
          if (useAppState && config.saveAppState) {
            const appState = api.getAppState();
            appStateManager.saveAppState(userId, appState);
          }

          let accountName = await this.getAccountName(api, userId);
          
          if (accountName === 'Unknown User') {
            accountName = `User_${userId.substring(0, 8)}`;
          }

          const canAccess = await this.testAccess(api);
          
          if (canAccess) {
            this.sessions.set(index, { 
              api, 
              healthy: true, 
              accountName,
              userId
            });
            this.sessionQueue.push(index);
            console.log(`✅ ${accountName} (${userId})`);
            resolve(true);
          } else {
            this.sessions.set(index, { 
              api, 
              healthy: false, 
              accountName,
              userId
            });
            console.log(`⚠️ ${accountName} - No access`);
            resolve(false);
          }
        } catch (error) {
          console.log(`❌ Error: ${error.message}`);
          resolve(false);
        }
      });
    });
  }
  async getAccountName(api, userId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve('Unknown User'), 10000);
      
      api.getUserInfo(userId, (err, userInfo) => {
        clearTimeout(timeout);
        if (!err && userInfo && userInfo[userId]) {
          resolve(userInfo[userId].name || `User_${userId.substring(0, 8)}`);
        } else {
          resolve(`User_${userId.substring(0, 8)}`);
        }
      });
    });
  }

  async testAccess(api) {
    if (messageData.threadIDs.length === 0) return false;
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      
      api.getThreadInfo(messageData.threadIDs[0], (err, info) => {
        clearTimeout(timeout);
        resolve(!err && info);
      });
    });
  }

  getNextSession() {
    if (this.sessionQueue.length === 0) return null;

    const sessionIndex = this.sessionQueue[this.currentSessionIndex];
    this.currentSessionIndex = (this.currentSessionIndex + 1) % this.sessionQueue.length;
    
    const session = this.sessions.get(sessionIndex);
    
    if (!session || !session.healthy) {
      return this.getNextSession();
    }

    return {
      api: session.api,
      index: sessionIndex,
      accountName: session.accountName,
      userId: session.userId
    };
  }

  getHealthyCount() {
    return this.sessionQueue.length;
  }

  getTotalSessions() {
    return this.sessions.size;
  }

  getCurrentAccountInfo() {
    if (this.sessionQueue.length === 0) return { name: 'None', userId: null };
    const sessionIndex = this.sessionQueue[this.currentSessionIndex];
    const session = this.sessions.get(sessionIndex);
    return { 
      name: session ? session.accountName : 'Unknown',
      userId: session ? session.userId : null
    };
  }

  markSessionUnhealthy(index) {
    const session = this.sessions.get(index);
    if (session) {
      session.healthy = false;
      const queueIndex = this.sessionQueue.indexOf(index);
      if (queueIndex > -1) {
        this.sessionQueue.splice(queueIndex, 1);
      }
      
      if (this.currentSessionIndex >= this.sessionQueue.length && this.sessionQueue.length > 0) {
        this.currentSessionIndex = 0;
      }
    }
  }

  getAllSessionsInfo() {
    const info = [];
    this.sessions.forEach((session, index) => {
      info.push({
        index: index + 1,
        accountName: session.accountName,
        userId: session.userId,
        healthy: session.healthy,
        isNext: this.sessionQueue[this.currentSessionIndex] === index
      });
    });
    return info;
  }
}

const sessionManager = new MultiIDSessionManager();

// --- MESSAGE SENDER ---
class MessageSender {
  async sendMessage(api, message, threadID, accountName) {
    return new Promise((resolve) => {
      api.sendMessage(message, threadID, (err) => {
        if (!err) {
          resolve({ success: true, accountName });
        } else {
          console.log(`❌ Send error: ${err.error}`);
          resolve({ success: false, accountName, error: err.error });
        }
      });
    });
  }

  async sendToCurrentTarget(message) {
    const sessionInfo = sessionManager.getNextSession();
    
    if (!sessionInfo) {
      console.log('❌ No healthy sessions');
      return false;
    }

    const currentThreadID = messageData.threadIDs[messageData.currentThreadIndex];

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📤 Account: ${sessionInfo.accountName}`);
    console.log(`📍 Group: ${messageData.currentThreadIndex + 1}/${messageData.threadIDs.length}`);
    console.log(`💬 Message: ${messageData.currentMessageIndex + 1}/${messageData.messages.length}`);
    console.log(`🎯 Thread: ${currentThreadID}`);
    console.log(`${'─'.repeat(50)}`);
    
    const result = await this.sendMessage(
      sessionInfo.api, 
      message, 
      currentThreadID,
      sessionInfo.accountName
    );
    
    if (result.success) {
      console.log(`✅ Sent from ${result.accountName}`);
      messageData.totalMessagesSent++;
    }
    
    return result.success;
  }
}

const messageSender = new MessageSender();

// --- GROUP EXTRACTOR ---
class GroupExtractor {
  async extractGroups(api) {
    return new Promise((resolve) => {
      api.getThreadList(100, null, ['INBOX'], (err, threads) => {
        if (err) {
          resolve([]);
          return;
        }

        const groups = threads
          .filter(thread => thread.isGroup)
          .map(thread => ({
            threadID: thread.threadID,
            name: thread.name || 'Unnamed Group',
            members: thread.participantIDs ? thread.participantIDs.length : 0,
            messages: thread.messageCount || 0
          }));

        resolve(groups);
      });
    });
  }
}

const groupExtractor = new GroupExtractor();
// --- MAIN LOOP - FIXED FOR GROUP ROTATION ---
async function runMessageLoop() {
  if (!config.running) {
    console.log('⏸️ Stopped');
    return;
  }

  try {
    const healthyCount = sessionManager.getHealthyCount();
    
    if (healthyCount === 0) {
      console.log('🚫 No healthy sessions');
      config.running = false;
      return;
    }

    // Get current message and thread
    const rawMessage = messageData.messages[messageData.currentMessageIndex];
    const prefix = messageData.hatersName[0].trim();
    const finalMessage = prefix ? `${prefix} ${rawMessage}` : rawMessage;

    const nextAccount = sessionManager.getCurrentAccountInfo();
    
    console.log(`\n📨 Sending...`);
    console.log(`📍 Group ${messageData.currentThreadIndex + 1}/${messageData.threadIDs.length}`);
    console.log(`💬 Message ${messageData.currentMessageIndex + 1}/${messageData.messages.length}`);
    console.log(`🔄 Loop: ${messageData.loopCount + 1}`);
    console.log(`👤 Next: ${nextAccount.name}`);

    const success = await messageSender.sendToCurrentTarget(finalMessage);

    if (success) {
      // FIXED: Move to next group after each message
      messageData.currentThreadIndex++;
      
      // If all groups covered, move to next message
      if (messageData.currentThreadIndex >= messageData.threadIDs.length) {
        messageData.currentThreadIndex = 0;
        messageData.currentMessageIndex++;
        
        // If all messages sent, complete loop
        if (messageData.currentMessageIndex >= messageData.messages.length) {
          messageData.currentMessageIndex = 0;
          messageData.loopCount++;
          
          console.log(`\n${'═'.repeat(60)}`);
          console.log(`🔄 LOOP #${messageData.loopCount} COMPLETED`);
          console.log(`📊 Total Messages Sent: ${messageData.totalMessagesSent}`);
          console.log(`${'═'.repeat(60)}\n`);
        }
      }
    }

    const randomDelay = config.delay + Math.floor(Math.random() * 5);
    console.log(`⏳ Next in ${randomDelay}s...\n`);
    setTimeout(runMessageLoop, randomDelay * 1000);

  } catch (error) {
    console.log(`💥 Error: ${error.message}`);
    setTimeout(runMessageLoop, 10000);
  }
}

// --- API ENDPOINTS ---

app.post('/api/start', async (req, res) => {
  const { cookies, threadIDs, messages, delay, hatersName, saveAppState } = req.body;

  if (!cookies || !threadIDs || !messages) {
    return res.status(400).json({ 
      success: false, 
      message: 'Cookies, Thread IDs, and Messages required!' 
    });
  }

  config.cookies = cookies.split('\n').map(c => c.trim()).filter(c => c.length > 0);
  messageData.threadIDs = threadIDs.split('\n').map(t => t.trim()).filter(t => t.length > 0);
  messageData.messages = messages.split('\n').map(m => m.trim()).filter(m => m.length > 0);

  if (config.cookies.length === 0 || messageData.threadIDs.length === 0 || messageData.messages.length === 0) {
    return res.status(400).json({ success: false, message: 'All fields required!' });
  }

  config.delay = parseInt(delay) || 30;
  messageData.hatersName = hatersName ? [hatersName.trim()] : [''];
  config.saveAppState = saveAppState !== false;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ STARTING BOT`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`📋 Accounts: ${config.cookies.length}`);
  console.log(`📍 Groups: ${messageData.threadIDs.length}`);
  console.log(`📝 Messages: ${messageData.messages.length}`);
  console.log(`⏱️  Delay: ${config.delay}s`);
  console.log(`${'═'.repeat(60)}\n`);

  const started = await startBot();

  if (started) {
    res.json({ 
      success: true, 
      message: `Started with ${sessionManager.getHealthyCount()} accounts!`,
      activeSessions: sessionManager.getHealthyCount(),
      totalGroups: messageData.threadIDs.length
    });
  } else {
    res.json({ success: false, message: 'Failed to start' });
  }
});

async function startBot() {
  config.running = false;
  messageData.currentMessageIndex = 0;
  messageData.currentThreadIndex = 0;
  messageData.loopCount = 0;
  messageData.totalMessagesSent = 0;

  const success = await sessionManager.createAllSessions(config.cookies, config.saveAppState);

  if (success) {
    config.running = true;
    setTimeout(() => runMessageLoop(), 2000);
    return true;
  }
  return false;
}

app.post('/api/stop', (req, res) => {
  config.running = false;
  console.log('\n🛑 Stopped\n');
  res.json({ success: true, message: 'Stopped' });
});

app.get('/api/status', (req, res) => {
  const sessionsInfo = sessionManager.getAllSessionsInfo();
  const nextAccount = sessionManager.getCurrentAccountInfo();

  res.json({
    running: config.running,
    currentMessageIndex: messageData.currentMessageIndex,
    currentThreadIndex: messageData.currentThreadIndex,
    totalMessages: messageData.messages.length,
    totalGroups: messageData.threadIDs.length,
    loopCount: messageData.loopCount,
    healthySessions: sessionManager.getHealthyCount(),
    totalCookies: sessionManager.getTotalSessions(),
    sessions: sessionsInfo,
    nextAccount: nextAccount.name,
    totalMessagesSent: messageData.totalMessagesSent
  });
});
app.post('/api/extract-groups', async (req, res) => {
  const { cookie } = req.body;

  if (!cookie) {
    return res.status(400).json({ success: false, message: 'Cookie required!' });
  }

  wiegine.login(cookie, { logLevel: "silent" }, async (err, api) => {
    if (err || !api) {
      return res.status(400).json({ success: false, message: 'Login failed' });
    }

    const groups = await groupExtractor.extractGroups(api);
    res.json({ success: true, groups, count: groups.length });
  });
});

app.get('/api/saved-accounts', (req, res) => {
  const accounts = appStateManager.getAllSavedAccounts();
  res.json({ success: true, accounts, count: accounts.length });
});

app.post('/api/delete-account', (req, res) => {
  const { accountId } = req.body;
  const deleted = appStateManager.deleteAppState(accountId);
  res.json({ success: deleted, message: deleted ? 'Deleted' : 'Not found' });
});

// --- DASHBOARD ---
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 Multi-Group Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            min-height: 100vh;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        }
        h1 {
            color: #667eea;
            text-align: center;
            margin-bottom: 10px;
            font-size: 32px;
        }
        .subtitle {
            text-align: center;
            color: #666;
            margin-bottom: 20px;
            font-size: 14px;
        }
        .feature-box {
            background: linear-gradient(135deg, #f5f7fa, #c3cfe2);
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
            font-weight: 600;
            color: #333;
        }
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #e1e5e9;
        }
        .tab {
            padding: 12px 24px;
            background: transparent;
            border: none;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            color: #666;
            border-bottom: 3px solid transparent;
        }
        .tab.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .form-group { margin-bottom: 20px; }
        label {
            display: block;
            font-weight: 600;
            margin-bottom: 8px;
            color: #333;
        }
        textarea, input {
            width: 100%;
            padding: 12px;
            border: 2px solid #e1e5e9;
            border-radius: 8px;
            font-size: 14px;
        }
        textarea {
            min-height: 80px;
            resize: vertical;
            font-family: 'Courier New', monospace;
        }
        textarea:focus, input:focus {
            outline: none;
            border-color: #667eea;
        }
        .help-text {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
            font-style: italic;
        }
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 10px;
        }
        input[type="checkbox"] {
            width: 18px;
            height: 18px;
        }
        .controls {
            display: flex;
            gap: 15px;
            margin-top: 20px;
            flex-wrap: wrap;
        }
        button {
            flex: 1;
            min-width: 150px;
            padding: 14px;
            border: none;
            border-radius: 8px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
        }
        .btn-primary {
            background: linear-gradient(135deg, #4CAF50, #45a049);
            color: white;
        }
        .btn-danger {
            background: linear-gradient(135deg, #f44336, #da190b);
            color: white;
        }
        .btn-info {
            background: linear-gradient(135deg, #2196F3, #0b7dda);
            color: white;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        #statusBox {
            margin-top: 30px;
            padding: 20px;
            background: linear-gradient(135deg, #f5f7fa, #c3cfe2);
            border-radius: 12px;
        }
        .status-item {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid rgba(0,0,0,0.1);
        }
        .status-item:last-child { border-bottom: none; }
        .sessions-list {
            margin-top: 20px;
            padding: 15px;
            background: white;
            border-radius: 8px;
        }
        .session-item {
            padding: 10px;
            margin: 5px 0;
            background: #f9f9f9;
            border-radius: 6px;
            font-size: 13px;
        }
        .session-healthy { border-left: 4px solid #4CAF50; }
        .session-unhealthy { border-left: 4px solid #f44336; }
        .session-next {
            border-left: 4px solid #FF9800;
            background: #fff3e0;
        }
        .badge {
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: bold;
            margin-left: 8px;
        }
        .badge-success { background: #4CAF50; color: white; }
        .badge-danger { background: #f44336; color: white; }
        .badge-next { background: #FF9800; color: white; }
        .groups-list {
            max-height: 300px;
            overflow-y: auto;
            background: #f9f9f9;
            padding: 10px;
            border-radius: 6px;
            margin-top: 10px;
        }
        .group-item {
            padding: 10px;
            margin: 5px 0;
            background: white;
            border-radius: 4px;
            cursor: pointer;
        }
        .group-item:hover {
            background: #e3f2fd;
            transform: translateX(5px);
        }
        .group-item.selected {
            background: #bbdefb;
            border-left: 3px solid #2196F3;
        }
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        .loading.active { display: block; }
        .spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Multi-Group Bot</h1>
        <div class="subtitle">Each Message → Different Group Rotation</div>
        
        <div class="feature-box">
            ✅ Msg1→Group1 | Msg2→Group2 | Msg3→Group3 | Msg4→Group1 (rotation)
        </div>

        <div class="tabs">
            <button class="tab active" onclick="switchTab('main')">🤖 Bot</button>
            <button class="tab" onclick="switchTab('extractor')">🔍 Extractor</button>
            <button class="tab" onclick="switchTab('saved')">💾 Saved</button>
        </div>

        <!-- MAIN TAB -->
        <div id="main-tab" class="tab-content active">
            <form id="botForm">
                <div class="form-group">
                    <label>Facebook Cookies (Multi-Account)</label>
                    <textarea id="cookies" name="cookies" rows="4" placeholder="Cookie 1
Cookie 2
Cookie 3" required></textarea>
                    <div class="checkbox-group">
                        <input type="checkbox" id="saveAppState" checked>
                        <label style="margin:0;">💾 Save for 30+ days reuse</label>
                    </div>
                </div>
                
                <div class="form-group">
                    <label>Group Thread IDs (Multi-Group)</label>
                    <textarea id="threadIDs" name="threadIDs" rows="4" placeholder="Thread ID 1
Thread ID 2
Thread ID 3" required></textarea>
                    <div class="help-text">📍 Each message goes to next group in rotation</div>
                </div>
                
                <div class="form-group">
                    <label>Messages</label>
                    <textarea id="messages" name="messages" rows="4" placeholder="Message 1
Message 2
Message 3" required></textarea>
                </div>
                
                <div class="form-group">
                    <label>Delay (seconds)</label>
                    <input type="number" id="delay" name="delay" value="30" min="10">
                </div>
                
                <div class="form-group">
                    <label>Prefix (Optional)</label>
                    <input type="text" id="hatersName" name="hatersName" placeholder="[BOT]">
                </div>
                
                <div class="controls">
                    <button type="button" class="btn-primary" onclick="startBot()">▶️ Start</button>
                    <button type="button" class="btn-danger" onclick="stopBot()">⏹️ Stop</button>
                </div>
            </form>
        </div>

        <!-- EXTRACTOR TAB -->
        <div id="extractor-tab" class="tab-content">
            <div class="form-group">
                <label>Cookie for Extraction</label>
                <textarea id="extractorCookie" rows="3" required></textarea>
            </div>
            <button class="btn-info" onclick="extractGroups()" style="width: 100%;">🔍 Extract Groups</button>
            
            <div class="loading" id="loading">
                <div class="spinner"></div>
                <p>Extracting...</p>
            </div>

            <div id="groupsContainer" style="display:none;">
                <h4 style="margin-top:20px; color:#667eea;">Found Groups</h4>
                <div class="groups-list" id="groupsList"></div>
                <div class="controls" style="margin-top:15px;">
                    <button class="btn-primary" onclick="copySelected()">📋 Copy Selected</button>
                    <button class="btn-info" onclick="copyAll()">📋 Copy All</button>
                </div>
            </div>
        </div>

        <!-- SAVED TAB -->
        <div id="saved-tab" class="tab-content">
            <h4 style="color:#667eea; margin-bottom:15px;">
            💾 Saved Accounts</h4>
            <button class="btn-info" onclick="refreshSaved()" style="width:100%; margin-bottom:15px;">🔄 Refresh</button>
            <div id="savedList" style="background:#f9f9f9; padding:15px; border-radius:8px;">
                <p style="text-align:center; color:#999;">No saved accounts</p>
            </div>
        </div>

        <!-- STATUS -->
        <div id="statusBox">
            <h3 style="margin-bottom:15px;">📊 Live Status</h3>
            <div class="status-item"><strong>Status:</strong> <span id="status">🔴 Stopped</span></div>
            <div class="status-item"><strong>Current Message:</strong> <span id="messageCount">0/0</span></div>
            <div class="status-item"><strong>Current Group:</strong> <span id="groupCount">0/0</span></div>
            <div class="status-item"><strong>Loop:</strong> <span id="loopCount">0</span></div>
            <div class="status-item"><strong>Active Accounts:</strong> <span id="healthySessions">0/0</span></div>
            <div class="status-item"><strong>Total Sent:</strong> <span id="totalSent">0</span></div>
            
            <div class="sessions-list">
                <h4 style="color:#667eea; margin-bottom:10px;">👥 Accounts</h4>
                <div id="sessionsContainer">
                    <p style="text-align:center; color:#999;">No sessions</p>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let selectedGroups = new Set();
        let allGroups = [];

        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(tab + '-tab').classList.add('active');
        }

        async function startBot() {
            const formData = new FormData(document.getElementById('botForm'));
            const data = Object.fromEntries(formData.entries());
            data.saveAppState = document.getElementById('saveAppState').checked;
            
            try {
                const res = await fetch('/api/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                
                if(result.success) {
                    alert(\`✅ Started!\\n\\nAccounts: \${result.activeSessions}\\nGroups: \${result.totalGroups}\`);
                } else {
                    alert('❌ ' + result.message);
                }
            } catch(err) {
                alert('❌ Error: ' + err.message);
            }
        }

        async function stopBot() {
            if(!confirm('Stop bot?')) return;
            const res = await fetch('/api/stop', { method: 'POST' });
            const result = await res.json();
            alert('🛑 ' + result.message);
        }

        async function extractGroups() {
            const cookie = document.getElementById('extractorCookie').value.trim();
            if(!cookie) {
                alert('❌ Enter cookie!');
                return;
            }

            const loading = document.getElementById('loading');
            const container = document.getElementById('groupsContainer');
            
            loading.classList.add('active');
            container.style.display = 'none';
            selectedGroups.clear();
            
            try {
                const res = await fetch('/api/extract-groups', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookie })
                });
                const result = await res.json();
                
                if(result.success && result.groups.length > 0) {
                    allGroups = result.groups;
                    displayGroups(result.groups);
                    container.style.display = 'block';
                    alert(\`✅ Found \${result.count} groups!\`);
                } else {
                    alert('❌ No groups found');
                }
            } catch(err) {
                alert('❌ Error: ' + err.message);
            } finally {
                loading.classList.remove('active');
            }
        }

        function displayGroups(groups) {
            const list = document.getElementById('groupsList');
            list.innerHTML = groups.map((g, i) => \`
                <div class="group-item" id="group-\${i}" onclick="toggleGroup(\${i})">
                    <div style="font-weight:bold;">\${g.name}</div>
                    <div style="font-size:11px; color:#666; font-family:monospace;">
                        \${g.threadID}
                    </div>
                    <div style="font-size:11px; color:#999;">
                        👥 \${g.members} | 💬 \${g.messages}
                    </div>
                </div>
            \`).join('');
        }

        function toggleGroup(i) {
            const elem = document.getElementById(\`group-\${i}\`);
            const threadID = allGroups[i].threadID;
            
            if(selectedGroups.has(threadID)) {
                selectedGroups.delete(threadID);
                elem.classList.remove('selected');
            } else {
                selectedGroups.add(threadID);
                elem.classList.add('selected');
            }
        }

        function copySelected() {
            if(selectedGroups.size === 0) {
                alert('❌ Select groups first!');
                return;
            }
            const ids = Array.from(selectedGroups).join('\\n');
            navigator.clipboard.writeText(ids);
            alert(\`✅ Copied \${selectedGroups.size} Thread IDs!\`);
        }

        function copyAll() {
            const ids = allGroups.map(g => g.threadID).join('\\n');
            navigator.clipboard.writeText(ids);
            alert(\`✅ Copied all \${allGroups.length} Thread IDs!\`);
        }

        async function refreshSaved() {
            try {
                const res = await fetch('/api/saved-accounts');
                const result = await res.json();
                const list = document.getElementById('savedList');
                
                if(result.success && result.accounts.length > 0) {
                    list.innerHTML = result.accounts.map(acc => \`
                        <div style="padding:10px; background:white; margin:5px 0; border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
                            <div style="font-family:monospace; font-weight:bold;">\${acc}</div>
                            <button class="btn-danger" style="padding:6px 12px; font-size:12px; min-width:auto;" onclick="deleteAcc('\${acc}')">🗑️</button>
                        </div>
                    \`).join('');
                } else {
                    list.innerHTML = '<p style="text-align:center; color:#999;">No saved accounts</p>';
                }
            } catch(err) {
                console.error(err);
            }
        }

        async function deleteAcc(id) {
            if(!confirm(\`Delete \${id}?\`)) return;
            
            try {
                await fetch('/api/delete-account', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accountId: id })
                });
                alert('✅ Deleted!');
                refreshSaved();
            } catch(err) {
                alert('❌ Error: ' + err.message);
            }
        }

        async function updateStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('status').textContent = data.running ? '🟢 Running' : '🔴 Stopped';
                document.getElementById('messageCount').textContent = (data.currentMessageIndex + 1) + '/' + data.totalMessages;
                document.getElementById('groupCount').textContent = (data.currentThreadIndex + 1) + '/' + data.totalGroups;
                document.getElementById('loopCount').textContent = data.loopCount;
                document.getElementById('healthySessions').textContent = data.healthySessions + '/' + data.totalCookies;
                document.getElementById('totalSent').textContent = data.totalMessagesSent || 0;
                
                const container = document.getElementById('sessionsContainer');
                if(data.sessions && data.sessions.length > 0) {
                    container.innerHTML = data.sessions.map(s => {
                        let cls = s.healthy ? 'session-healthy' : 'session-unhealthy';
                        let badge = s.healthy 
                            ? '<span class="badge badge-success">Active</span>' 
                            : '<span class="badge badge-danger">Inactive</span>';
                        
                        if(s.isNext && s.healthy) {
                            cls = 'session-next';
                            badge = '<span class="badge badge-next">⬅ NEXT</span>';
                        }
                        
                        return \`<div class="session-item \${cls}">
                            <div style="font-weight:bold;">Session \${s.index}: \${s.accountName} \${badge}</div>
                            <div style="font-size:11px; color:#666; font-family:monospace;">\${s.userId || 'N/A'}</div>
                        </div>\`;
                    }).join('');
                } else {
                    container.innerHTML = '<p style="text-align:center; color:#999;">No sessions</p>';
                }
            } catch(err) {
                console.error(err);
            }
        }

        setInterval(updateStatus, 2000);
        updateStatus();
        refreshSaved();
    </script>
</body>
</html>
  `);
});
const server = app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🚀 MULTI-GROUP BOT - FIXED ROTATION`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`📡 Dashboard: http://localhost:${PORT}`);
  console.log(`\n🔥 HOW IT WORKS:`);
  console.log(`   Message 1 → Group 1`);
  console.log(`   Message 2 → Group 2`);
  console.log(`   Message 3 → Group 3`);
  console.log(`   Message 4 → Group 1 (rotation restarts)`);
  console.log(`\n✅ FEATURES:`);
  console.log(`   ✅ Multi-Account Rotation`);
  console.log(`   ✅ Multi-Group with proper rotation`);
  console.log(`   ✅ Group UID Extractor`);
  console.log(`   ✅ AppState (30+ days)`);
  console.log(`   ✅ Account Management`);
  console.log(`${'═'.repeat(70)}\n`);
});

process.on('uncaughtException', (err) => {
  console.log('🛡️ Error:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.log('🛡️ Promise error:', err.message);
});
