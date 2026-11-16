const express = require('express');
const multer = require('multer');
const login = require('@dongdev/fca-unofficial');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });
const upload = multer({ dest: 'uploads/' });

let serverState = {
    isRunning: false,
    status: "Idle",
    logs: [],
    totalSent: 0,
    totalFailed: 0,
    stopRequested: false
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

    const { cookie_pool, thread_id, time_delay, sender_name } = req.body;
    const file = req.file;

    if (!cookie_pool || !thread_id || !file) {
        return res.json({ status: "error", message: "Cookie Pool, Group UID aur File bharna zaroori hai!" });
    }

    serverState = {
        isRunning: true, status: "Initializing...", logs: [],
        totalSent: 0, totalFailed: 0, stopRequested: false
    };

    res.json({ status: "success", message: "Server chalu ho gaya!" });
    runSenderProcess(cookie_pool, thread_id, parseInt(time_delay), sender_name, file.path);
});

function parsePool(poolRaw) {
    return poolRaw.split('---').map(c => c.trim()).filter(c => c !== '');
}

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
    const api = await new Promise((resolve, reject) => {
        login({ appState: appState }, (err, api) => {
            if (err) return reject(err);
            resolve(api);
        });
    });

    api.setOptions({ listenEvents: false, selfListen: false, forceLogin: true, autoMarkRead: false });
    const mqttInstance = api.listenMqtt((err) => {
        if (err) addLog(`⚠️ MQTT Error: ${err.message || err}`);
    });

    // Fast MQTT wait (10ms check)
    await new Promise((resolve) => {
        let checks = 0;
        const interval = setInterval(() => {
            checks++;
            if (api._mqttClient?.connected || api.mqttClient?.connected || checks >= 100) {
                clearInterval(interval);
                resolve();
            }
        }, 10); 
    });

    return { api, mqttInstance };
}

async function getWorkingApi(cookiePool, startIndex) {
    for (let i = startIndex; i < cookiePool.length; i++) {
        try {
            const appState = parseCookies(cookiePool[i]);
            addLog(`🔐 Trying Cookie #${i + 1}...`);
            const session = await setupFcaSession(appState);
            addLog(`✅ Cookie #${i + 1} Login Successful!`);
            return { api: session.api, mqtt: session.mqttInstance, poolIndex: i };
        } catch (err) {
            addLog(`❌ Cookie #${i + 1} Failed.`);
        }
    }
    throw new Error("Saari cookies dead hain!");
}

async function runSenderProcess(cookiePoolRaw, threadId, delay, senderName, filePath) {
    const cookiePool = parsePool(cookiePoolRaw);
    let api = null, mqttInstance = null, currentPoolIndex = 0;

    try {
        const initial = await getWorkingApi(cookiePool, currentPoolIndex);
        api = initial.api; mqttInstance = initial.mqtt; currentPoolIndex = initial.poolIndex;

        serverState.status = "Sending Messages...";
        addLog("🚀 Started Sending Non-Stop!");

        const messages = fs.readFileSync(filePath, 'utf-8').split('\n').map(m => m.trim()).filter(m => m.length > 0);
        if (messages.length === 0) throw new Error("File khali hai.");

        addLog(`📁 Total ${messages.length} messages. Delay: ${delay}s`);

        for (let i = 0; i < messages.length; i++) {
            if (serverState.stopRequested) break;

            const finalMessage = `${senderName}\n${messages[i]}`;
            let success = false;

            for (let attempt = 0; attempt < 3; attempt++) {
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
                        addLog(`⚠️ Cookie #${currentPoolIndex + 1} Dead! Rotating...`);
                        if (mqttInstance && typeof mqttInstance.stopListening === 'function') mqttInstance.stopListening();

                        try {
                            const newSession = await getWorkingApi(cookiePool, currentPoolIndex + 1);
                            api = newSession.api; mqttInstance = newSession.mqtt; currentPoolIndex = newSession.poolIndex;
                            attempt = -1; 
                            continue;
                        } catch (rotateErr) {
                            throw new Error("All cookies dead.");
                        }
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
        if (mqttInstance && typeof mqttInstance.stopListening === 'function') mqttInstance.stopListening();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        serverState.isRunning = false;
        serverState.status = serverState.stopRequested ? "Stopped" : "Completed";
    }
}

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
