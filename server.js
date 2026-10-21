const express = require('express');
const multer = require('multer');
const login = require('@dongdev/fca-unofficial');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

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
    if (serverState.logs.length > 150) serverState.logs.shift();
    console.log(logMsg);
}

app.get('/api/status', (req, res) => {
    res.json(serverState);
});

app.post('/api/stop', (req, res) => {
    if (!serverState.isRunning) return res.json({ status: "error", message: "Server pehle se band hai." });
    serverState.stopRequested = true;
    serverState.status = "Stopping...";
    addLog("🛑 STOP signal received.");
    res.json({ status: "success", message: "Stop signal bhej diya gaya." });
});

app.post('/api/start', upload.single('message_file'), async (req, res) => {
    if (serverState.isRunning) {
        return res.json({ status: "error", message: "Server pehle se chal raha hai!" });
    }

    const { cookies, backup_cookies, thread_id, time_delay, sender_name } = req.body;
    const file = req.file;

    if (!cookies || !thread_id || !file) {
        return res.json({ status: "error", message: "Primary Cookies, Group UID aur File bharna zaroori hai!" });
    }

    serverState = {
        isRunning: true,
        status: "Starting...",
        logs: [],
        totalSent: 0,
        totalFailed: 0,
        stopRequested: false
    };

    res.json({ status: "success", message: "Server chalu ho gaya!" });
    
    // Process Start
    runSenderProcess(cookies, backup_cookies, thread_id, parseInt(time_delay), sender_name, file.path);
});

// ✅ Helper: Cookies ko parse karega (JSON ya String format)
function parseCookies(cookiesRaw) {
    let appState = [];
    if (!cookiesRaw || cookiesRaw.trim() === '') return appState;
    
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

// ✅ Helper: FCA Login + MQTT Setup
async function setupFcaSession(cookiesRaw) {
    const appState = parseCookies(cookiesRaw);
    if (appState.length === 0) throw new Error("Invalid or empty cookies");

    const api = await new Promise((resolve, reject) => {
        login({ appState: appState }, (err, api) => {
            if (err) return reject(err);
            resolve(api);
        });
    });

    api.setOptions({ listenEvents: true });
    const mqttInstance = api.listenMqtt((err) => {
        if (err) addLog(`⚠️ MQTT Internal Error: ${err.message || err}`);
    });

    // MQTT Connect hone ka wait
    await new Promise((resolve) => {
        let checkCount = 0;
        const interval = setInterval(() => {
            checkCount++;
            if (api._mqttClient?.connected || api.mqttClient?.connected || checkCount >= 8) {
                clearInterval(interval);
                resolve();
            }
        }, 2000);
    });

    return { api, mqttInstance };
}

async function runSenderProcess(primaryCookies, backupCookies, threadId, delay, senderName, filePath) {
    let api = null;
    let mqttInstance = null;

    try {
        // 🔐 1. Try Primary Cookies
        addLog("🔐 Attempting login with PRIMARY cookies...");
        try {
            const session = await setupFcaSession(primaryCookies);
            api = session.api;
            mqttInstance = session.mqttInstance;
            addLog(`✅ Primary Login Successful! UID: ${api.getCurrentUserID()}`);
        } catch (err) {
            addLog(`❌ Primary Cookies Failed: ${err.message || err}`);
            
            // 🔄 2. Try Backup Cookies (Agar diye hain toh)
            if (backupCookies && backupCookies.trim() !== "") {
                addLog("🔄 Switching to BACKUP cookies...");
                try {
                    const session = await setupFcaSession(backupCookies);
                    api = session.api;
                    mqttInstance = session.mqttInstance;
                    addLog(`✅ Backup Login Successful! UID: ${api.getCurrentUserID()}`);
                } catch (err2) {
                    addLog(`❌ Backup Cookies also Failed: ${err2.message || err2}`);
                    throw new Error("Both Primary and Backup cookies failed. Stopping Server.");
                }
            } else {
                throw new Error("Primary cookies failed and no backup was provided. Stopping Server.");
            }
        }

        addLog("⏳ Waiting 2 seconds for stabilization...");
        await new Promise(r => setTimeout(r, 2000));

        serverState.status = "Sending Messages...";

        // Read Messages
        const messages = fs.readFileSync(filePath, 'utf-8')
            .split('\n')
            .map(m => m.trim())
            .filter(m => m.length > 0);

        if (messages.length === 0) throw new Error("File khali hai.");

        addLog(`📁 Total ${messages.length} messages. Delay: ${delay}s`);

        // Sending Loop
        for (let i = 0; i < messages.length; i++) {
            if (serverState.stopRequested) {
                addLog("🛑 Loop stopped by user.");
                break;
            }

            // ✅ YAHAN PAR FORMAT FIX HUA HAI (Name Upar, Message Niche)
            const finalMessage = `${senderName}\n${messages[i]}`;
            
            let success = false;
            let retries = 3;

            for (let attempt = 0; attempt < retries; attempt++) {
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
                    if (errorMsg.includes("MQTT client is not initialized") && attempt < retries - 1) {
                        addLog(`⚠️ MQTT not fully ready. Retrying (${attempt + 1}/${retries})...`);
                        await new Promise(r => setTimeout(r, 3000));
                    } else {
                        addLog(`❌ [${i + 1}/${messages.length}] Error: ${errorMsg}`);
                        break;
                    }
                }
            }

            if (success) {
                serverState.totalSent++;
                addLog(`✅ [${i + 1}/${messages.length}] Sent: ${messages[i].substring(0, 30)}...`);
            } else {
                serverState.totalFailed++;
            }

            if (!serverState.stopRequested && i < messages.length - 1) {
                await new Promise(r => setTimeout(r, delay * 1000));
            }
        }

    } catch (error) {
        addLog(`❌ System Error: ${error.message || error}`);
        serverState.status = "Failed";
    } finally {
        if (mqttInstance) {
            try { 
                if (typeof mqttInstance.stopListeningAsync === 'function') await mqttInstance.stopListeningAsync(); 
                else if (typeof mqttInstance.stopListening === 'function') mqttInstance.stopListening();
            } catch (e) {}
        }
        
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        serverState.isRunning = false;
        if (serverState.stopRequested) serverState.status = "Stopped by User";
        else if (serverState.totalSent > 0) {
            serverState.status = "Completed";
            addLog("🎉 Process complete!");
        } else {
            serverState.status = "Failed";
        }
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
