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

// UI files serve karne ke liye
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

    const { cookies, thread_id, time_delay, sender_name } = req.body;
    const file = req.file;

    if (!cookies || !thread_id || !file) {
        return res.json({ status: "error", message: "Saari fields bharna zaroori hai!" });
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
    runSenderProcess(cookies, thread_id, parseInt(time_delay), sender_name, file.path);
});

// Helper: MQTT Ready hone ka wait karega (Fixed)
function waitForMqtt(api, maxRetries = 10) {
    return new Promise((resolve) => {
        let attempts = 0;
        addLog("📡 Initializing MQTT listener (Waiting for connection)...");
        
        try {
            api.setOptions({ listenEvents: true }); // Events enable rakhna zaroori hai
            const mqttInstance = api.listenMqtt((err, event) => {
                if (err) {
                    addLog(`⚠️ MQTT Warning: ${err?.message || "Unknown error"}`);
                }
            });

            // Har 2 second mein check karega ki MQTT connect hua ya nahi
            const interval = setInterval(() => {
                attempts++;
                // .connected property use hoti hai mqtt client mein
                if (api._mqttClient && api._mqttClient.connected) {
                    clearInterval(interval);
                    addLog("✅ MQTT Client Ready and Connected!");
                    resolve(mqttInstance);
                } else if (attempts >= maxRetries) {
                    clearInterval(interval);
                    addLog("⚠️ MQTT connection timeout. Proceeding with HTTP fallback...");
                    resolve(mqttInstance); // Proceed anyway so messaging doesn't block
                }
            }, 2000);

        } catch (e) {
            addLog(`⚠️ MQTT Setup Exception: ${e.message}`);
            resolve(null);
        }
    });
}

async function runSenderProcess(cookiesRaw, threadId, delay, senderName, filePath) {
    let api;
    let mqttInstance = null;

    try {
        // 1. Cookies Parse
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

        // 2. Login
        addLog("🔐 Logging into Facebook...");
        api = await new Promise((resolve, reject) => {
            login({ appState: appState }, (err, api) => {
                if (err) return reject(err);
                resolve(api);
            });
        });

        addLog(`✅ Login Successful! UID: ${api.getCurrentUserID()}`);

        // 3. MQTT Wait
        mqttInstance = await waitForMqtt(api);
        
        // 4. Buffer Time
        addLog("⏳ Waiting 2 seconds for stabilization...");
        await new Promise(r => setTimeout(r, 2000));

        serverState.status = "Sending Messages...";

        // 5. Messages Read
        const messages = fs.readFileSync(filePath, 'utf-8')
            .split('\n')
            .map(m => m.trim())
            .filter(m => m.length > 0);

        if (messages.length === 0) throw new Error("File khali hai.");

        addLog(`📁 Total ${messages.length} messages. Delay: ${delay}s`);

        // 6. Sending Loop
        for (let i = 0; i < messages.length; i++) {
            if (serverState.stopRequested) {
                addLog("🛑 Loop stopped by user.");
                break;
            }

            const finalMessage = `${messages[i]}\n— ${senderName}`;
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
                        addLog(`⚠️ MQTT not ready yet. Retrying (${attempt + 1}/${retries})...`);
                        await new Promise(r => setTimeout(r, 2000));
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

            // Delay
            if (!serverState.stopRequested && i < messages.length - 1) {
                await new Promise(r => setTimeout(r, delay * 1000));
            }
        }

    } catch (error) {
        addLog(`❌ System Error: ${error.message || error}`);
        serverState.status = "Failed";
    } finally {
        if (mqttInstance && typeof mqttInstance.stopListeningAsync === 'function') {
            try { await mqttInstance.stopListeningAsync(); } catch (e) {}
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
