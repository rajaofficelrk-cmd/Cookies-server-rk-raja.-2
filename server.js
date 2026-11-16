const express = require('express');
const multer = require('multer');
const login = require('@dongdev/fca-unofficial');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });
const upload = multer({ dest: 'uploads/' });

let serverState = { isRunning: false, status: "Idle", logs: [], totalSent: 0, totalFailed: 0, stopRequested: false };

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] ${msg}`;
    serverState.logs.push(logMsg);
    if (serverState.logs.length > 200) serverState.logs.shift();
    console.log(logMsg);
}

app.get('/api/status', (req, res) => res.json(serverState));

app.post('/api/stop', (req, res) => {
    if (!serverState.isRunning) return res.json({ status: "error", message: "Server pehle se band hai." });
    serverState.stopRequested = true;
    serverState.status = "Stopping...";
    addLog("🛑 STOP signal received.");
    res.json({ status: "success", message: "Stop signal bhej diya gaya." });
});

app.post('/api/start', upload.single('message_file'), async (req, res) => {
    if (serverState.isRunning) return res.json({ status: "error", message: "Server pehle se chal raha hai!" });

    const cookie_pool = req.body.cookie_pool;
    const thread_id = req.body.thread_id;
    const time_delay = req.body.time_delay;
    const sender_name = req.body.sender_name;
    const file = req.file;

    if (!cookie_pool || cookie_pool.trim() === '') return res.json({ status: "error", message: "❌ Cookie Pool khali hai!" });
    if (!thread_id || thread_id.trim() === '') return res.json({ status: "error", message: "❌ Group UID dalna bhool gaye ho!" });
    if (!file) return res.json({ status: "error", message: "❌ Message File upload nahi hui hai!" });

    serverState = { isRunning: true, status: "Initializing...", logs: [], totalSent: 0, totalFailed: 0, stopRequested: false };

    res.json({ status: "success", message: "Server chalu ho gaya!" });
    runSenderProcess(cookie_pool, thread_id, parseInt(time_delay), sender_name, file.path);
});

function parsePool(poolRaw) { return poolRaw.split('---').map(c => c.trim()).filter(c => c !== ''); }

function parseCookies(cookiesRaw) {
    let appState = [];
    try {
        const parsed = JSON.parse(cookiesRaw);
        appState = parsed.map(c => ({ key: c.key, value: c.value, domain: "facebook.com", path: "/" }));
    } catch (e) {
        cookiesRaw.split(';').forEach(pair => {
            const [k, v] = pair.split('=');
            if (k && v) appState.push({ key: k.trim(), value: v.trim(), domain: "facebook.com", path: "/" });
        });
    }
    return appState;
}

async function setupFcaSession(appState) {
    // Bina proxy ke direct login
    const loginPromise = new Promise((resolve, reject) => {
        login({ appState: appState }, (err, api) => {
            if (err) return reject(err);
            resolve(api);
        });
    });

    // Agar 10 second me login nahi hua toh timeout
    const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout - Cookie dead ya IP blocked")), 10000)
    );

    const api = await Promise.race([loginPromise, timeoutPromise]);

    api.setOptions({ listenEvents: false, selfListen: false, forceLogin: true, autoMarkRead: false });
    api.listenMqtt((err) => { if (err) console.log(`MQTT Error: ${err.message}`); });

    return { api };
}

async function getWorkingApi(cookiePool, startIndex) {
    for (let i = startIndex; i < cookiePool.length; i++) {
        try {
            const appState = parseCookies(cookiePool[i]);
            addLog(`🔐 Trying Cookie #${i + 1}...`);
            const session = await setupFcaSession(appState);
            addLog(`✅ Cookie #${i + 1} Login Successful!`);
            return { api: session.api, poolIndex: i };
        } catch (err) {
            addLog(`❌ Cookie #${i + 1} Failed: ${err.message}`);
        }
    }
    throw new Error("Saari cookies dead hain ya timeout ho gayi!");
}

async function runSenderProcess(cookiePoolRaw, threadId, delay, senderName, filePath) {
    const cookiePool = parsePool(cookiePoolRaw);
    let api = null, currentPoolIndex = 0;

    try {
        const initial = await getWorkingApi(cookiePool, currentPoolIndex);
        api = initial.api; currentPoolIndex = initial.poolIndex;

        serverState.status = "Sending Messages...";
        addLog("🚀 Started Sending Non-Stop!");

        const messages = fs.readFileSync(filePath, 'utf-8').split('\n').map(m => m.trim()).filter(m => m.length > 0);
        if (messages.length === 0) throw new Error("File khali hai.");

        for (let i = 0; i < messages.length; i++) {
            if (serverState.stopRequested) break;

            const finalMessage = `${senderName}\n${messages[i]}`;
            let success = false;

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await new Promise((resolve, reject) => {
                        api.sendMessage(finalMessage, threadId, (err) => {
                            if (err) return reject(err);
                            resolve();
                        });
                    });
                    success = true;
                    break;
                } catch (err) {
                    const errorMsg = err?.message || String(err);
                    if (errorMsg.includes("login") || errorMsg.includes("checkpoint") || errorMsg.includes("session") || errorMsg.includes("MQTT")) {
                        addLog(`⚠️ Cookie Dead mid-process! Rotating...`);
                        try {
                            const newSession = await getWorkingApi(cookiePool, currentPoolIndex + 1);
                            api = newSession.api; currentPoolIndex = newSession.poolIndex;
                            attempt = -1; 
                            continue;
                        } catch (rotateErr) { throw new Error("All cookies dead."); }
                    } else {
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            }

            if (success) {
                serverState.totalSent++;
                addLog(`✅ [${i + 1}/${messages.length}] Sent`);
            } else {
                serverState.totalFailed++;
            }

            if (!serverState.stopRequested && i < messages.length - 1) {
                await new Promise(r => setTimeout(r, delay * 1000));
            }
        }
    } catch (error) {
        addLog(`❌ Error: ${error.message}`);
        serverState.status = "Failed";
    } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        serverState.isRunning = false;
        serverState.status = serverState.stopRequested ? "Stopped" : "Completed";
    }
}

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
